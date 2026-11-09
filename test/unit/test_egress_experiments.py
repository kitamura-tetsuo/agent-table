import os
import signal
import stat
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest

from scripts.egress_experiments import (
    DnsCollisionError,
    SafeExperimentSession,
    TunnelCollisionError,
    TunnelUpdateError,
)


@pytest.fixture
def mock_cf_cmd():
    with patch("scripts.egress_experiments.run_cf_cmd") as mock:
        yield mock


def test_dns_collision_aborts_without_deleting_existing(mock_cf_cmd):
    """Verify that existing DNS records are not deleted on collision and DnsCollisionError is raised."""
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    # Simulate existing DNS record
    mock_cf_cmd.return_value = [{"id": "existing-rec-999", "name": "collide.example.com"}]

    with pytest.raises(DnsCollisionError, match="DNS record collision"):
        session.create_dns_record("A", "collide.example.com", "127.0.0.1", proxied=False)

    # Verify no delete command was issued for the existing record
    for c in mock_cf_cmd.call_args_list:
        args = c[0][0]
        assert "delete" not in args


def test_dns_record_creation_and_session_tracking(mock_cf_cmd):
    """Verify that only created DNS records are tracked and deleted."""
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    # 1. list returns empty (no collision)
    # 2. create returns new id
    mock_cf_cmd.side_effect = [
        [],  # list_dns_records
        {"id": "new-rec-101"},  # create_dns_record
        {},  # delete_dns_record
    ]

    rec_id = session.create_dns_record("A", "new.example.com", "127.0.0.1", proxied=False)
    assert rec_id == "new-rec-101"
    assert "new-rec-101" in session.created_dns_records

    # Untracked record deletion is refused
    session.delete_dns_record("untracked-rec-888")
    assert "new-rec-101" in session.created_dns_records

    # Tracked record deletion succeeds
    session.delete_dns_record("new-rec-101")
    assert "new-rec-101" not in session.created_dns_records


def test_tunnel_ingress_snapshot_and_restore(mock_cf_cmd):
    """Verify tunnel ingress is properly snapshotted, temporary rule inserted before catch-all, and restored."""
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    initial_config = {
        "config": {
            "ingress": [
                {"hostname": "probe.example.com", "service": "http://127.0.0.1:8790"},
                {"service": "http_status:404"},
            ]
        }
    }
    mock_cf_cmd.side_effect = [
        initial_config,  # get tunnel config
        {},  # update tunnel config with temp rule
        {},  # restore tunnel config
    ]

    session.add_temporary_tunnel_rule("temp.example.com", "http://127.0.0.1:8790")

    # Check update call: temp rule must be inserted before catch-all
    update_call = mock_cf_cmd.call_args_list[1]
    assert update_call[0][0][0:3] == ["tunnels", "config", "update"]
    import json
    body_idx = update_call[0][0].index("--body") + 1
    sent_body = json.loads(update_call[0][0][body_idx])
    expected_ingress = [
        {"hostname": "probe.example.com", "service": "http://127.0.0.1:8790"},
        {"hostname": "temp.example.com", "service": "http://127.0.0.1:8790"},
        {"service": "http_status:404"},
    ]
    assert sent_body["config"]["ingress"] == expected_ingress

    # Restore
    session.restore_tunnel_ingress()
    restore_call = mock_cf_cmd.call_args_list[2]
    restore_body_idx = restore_call[0][0].index("--body") + 1
    restored_body = json.loads(restore_call[0][0][restore_body_idx])
    assert restored_body["config"]["ingress"] == initial_config["config"]["ingress"]


def test_tunnel_rule_collision_aborts(mock_cf_cmd):
    """Verify that adding an already existing tunnel hostname raises TunnelCollisionError."""
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    initial_config = {
        "config": {
            "ingress": [
                {"hostname": "probe.example.com", "service": "http://127.0.0.1:8790"},
                {"service": "http_status:404"},
            ]
        }
    }
    mock_cf_cmd.return_value = initial_config

    with pytest.raises(TunnelCollisionError, match="Tunnel ingress collision"):
        session.add_temporary_tunnel_rule("probe.example.com", "http://127.0.0.1:8790")


def test_dev_vars_preservation_and_file_mode(tmp_path):
    """Verify that existing .dev.vars is preserved and restored, and permissions are 0600."""
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    test_vars = tmp_path / ".dev.vars"
    session.dev_vars_path = test_vars

    # Case 1: Pre-existing .dev.vars
    test_vars.write_text("PRE_EXISTING_SECRET=keep_me\n")
    os.chmod(test_vars, 0o600)

    session.prepare_dev_vars("tok123", "https://call.example.com", "https://call.example.com", "/")
    assert "PROBE_AUTH_TOKEN" in test_vars.read_text()
    file_mode = stat.S_IMODE(test_vars.stat().st_mode)
    assert file_mode == 0o600

    session.restore_dev_vars()
    assert test_vars.read_text() == "PRE_EXISTING_SECRET=keep_me\n"

    # Case 2: No pre-existing file -> deleted on restore
    test_vars.unlink()
    session.prepare_dev_vars("tok456", "https://call.example.com", "https://call.example.com", "/")
    assert test_vars.exists()
    session.restore_dev_vars()
    assert not test_vars.exists()


def test_session_rollback_on_fault_injection(mock_cf_cmd, tmp_path):
    """Fault injection: Verify full rollback when an unhandled exception or API failure occurs."""
    test_vars = tmp_path / ".dev.vars"
    test_vars.write_text("ORIGINAL_CONTENT\n")

    initial_config = {
        "config": {
            "ingress": [
                {"hostname": "probe.example.com", "service": "http://127.0.0.1:8790"},
                {"service": "http_status:404"},
            ]
        }
    }

    mock_cf_cmd.side_effect = [
        initial_config,  # snapshot
        {},  # update tunnel
        [],  # list records (no collision)
        {"id": "rec-fault-1"},  # create record
        {},  # delete record in rollback
        {},  # restore tunnel in rollback
    ]

    mock_proc = MagicMock(spec=subprocess.Popen)
    mock_proc.pid = 99999
    mock_proc.poll.return_value = None

    with patch("os.killpg") as mock_killpg, patch("os.getpgid", return_value=99999):
        with pytest.raises(ValueError, match="Simulated experiment failure"):
            with SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123") as session:
                session.dev_vars_path = test_vars
                session.add_temporary_tunnel_rule("temp.example.com", "http://127.0.0.1:8790")
                rec_id = session.create_dns_record("A", "temp.example.com", "127.0.0.1", False)
                session.prepare_dev_vars("tok", "https://temp.example.com", "https://temp.example.com", "/")
                session.active_processes.append(mock_proc)

                # Fault injected here!
                raise ValueError("Simulated experiment failure")

        # Verify process group was killed with SIGKILL in rollback
        mock_killpg.assert_called_with(99999, signal.SIGKILL)
        # Verify dev vars was restored
        assert test_vars.read_text() == "ORIGINAL_CONTENT\n"


def test_rollback_resilience_on_cleanup_failure(mock_cf_cmd):
    """Verify that a failure in one cleanup step (e.g. DNS delete fails) does not prevent tunnel restore."""
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    session.created_dns_records.add("broken-rec-1")
    session.saved_tunnel_ingress = [{"service": "http_status:404"}]

    # Deleting broken-rec-1 raises RuntimeError
    def cf_mock(args):
        if "delete" in args:
            raise RuntimeError("Cloudflare API 500: cannot delete record")
        return {}

    mock_cf_cmd.side_effect = cf_mock

    # Rollback should catch and log the DNS delete error, then proceed to restore tunnel ingress
    session.rollback()

    # Tunnel restore must have been attempted
    update_calls = [c for c in mock_cf_cmd.call_args_list if "update" in c[0][0]]
    assert len(update_calls) == 1

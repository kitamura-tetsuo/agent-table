import copy
import json
import os
import signal
import stat
import subprocess
import sys
from unittest.mock import MagicMock, patch

import pytest

from scripts.egress_experiments import (
    DnsCollisionError,
    SafeExperimentSession,
    run_probe,
    wait_for_dns,
    TunnelCollisionError,
    TunnelUpdateError,
)


@pytest.fixture
def mock_cf_cmd():
    with patch("scripts.egress_experiments.run_cf_cmd") as mock:
        yield mock


def initial_tunnel_config():
    return {
        "ingress": [
            {
                "hostname": "probe.example.com",
                "service": "http://127.0.0.1:8790",
                "originRequest": {"noTLSVerify": False},
            },
            {"service": "http_status:404"},
        ],
        "originRequest": {
            "connectTimeout": "30s",
            "noTLSVerify": False,
            "httpHostHeader": "original.example.com",
        },
        "warp-routing": {"enabled": False},
    }


def mock_tunnel_api(mock_cf_cmd):
    remote = {"config": copy.deepcopy(initial_tunnel_config())}
    update_bodies = []

    def call_cf(args):
        if args[:3] == ["tunnels", "config", "get"]:
            return copy.deepcopy(remote)
        if args[:3] == ["tunnels", "config", "update"]:
            body = json.loads(args[args.index("--body") + 1])
            update_bodies.append(copy.deepcopy(body))
            remote["config"] = copy.deepcopy(body["config"])
            return {}
        raise AssertionError(f"Unexpected Cloudflare command: {args}")

    mock_cf_cmd.side_effect = call_cf
    return remote, update_bodies


def test_dns_collision_aborts_without_deleting_existing(mock_cf_cmd):
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    mock_cf_cmd.return_value = [{"id": "existing", "name": "taken.example.com"}]
    with pytest.raises(DnsCollisionError):
        session.create_dns_record("A", "taken.example.com", "127.0.0.1", False)
    assert all("delete" not in call.args[0] for call in mock_cf_cmd.call_args_list)


def test_dns_record_creation_and_session_tracking(mock_cf_cmd):
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    mock_cf_cmd.side_effect = [[], {"id": "new-rec-101"}, {}]
    assert session.create_dns_record("A", "new.example.com", "127.0.0.1", False) == "new-rec-101"
    session.delete_dns_record("untracked-rec-888")
    assert "new-rec-101" in session.created_dns_records
    session.delete_dns_record("new-rec-101")
    assert not session.created_dns_records


def test_dns_create_without_returned_id_never_claims_a_concurrent_record(mock_cf_cmd):
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    mock_cf_cmd.side_effect = [[], {}]
    with pytest.raises(RuntimeError, match="created DNS record ID"):
        session.create_dns_record("A", "new.example.com", "127.0.0.1", False)
    assert session.created_dns_records == set()
    assert len(mock_cf_cmd.call_args_list) == 2
    assert all("delete" not in call.args[0] for call in mock_cf_cmd.call_args_list)


def test_tunnel_full_snapshot_update_and_restore(mock_cf_cmd):
    """A replace-style API update must preserve all non-ingress fields in both directions."""
    remote, updates = mock_tunnel_api(mock_cf_cmd)
    original = copy.deepcopy(remote["config"])
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")

    session.add_temporary_tunnel_rule("temp.example.com", "http://127.0.0.1:8790")
    assert len(updates) == 1
    assert updates[0]["config"]["originRequest"] == original["originRequest"]
    assert updates[0]["config"]["warp-routing"] == original["warp-routing"]
    assert updates[0]["config"]["ingress"] == [
        original["ingress"][0],
        {"service": "http://127.0.0.1:8790", "hostname": "temp.example.com"},
        original["ingress"][-1],
    ]
    assert original == session.saved_tunnel_config

    session.restore_tunnel_ingress()
    assert len(updates) == 2
    assert updates[-1] == {"config": original}
    assert remote["config"] == original
    assert session.saved_tunnel_config is None


def test_tunnel_rule_collision_aborts(mock_cf_cmd):
    remote, updates = mock_tunnel_api(mock_cf_cmd)
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    with pytest.raises(TunnelCollisionError, match="collision"):
        session.add_temporary_tunnel_rule("probe.example.com", "http://127.0.0.1:8790")
    assert not updates
    assert remote["config"] == initial_tunnel_config()


def test_tunnel_external_change_before_update_is_not_overwritten(mock_cf_cmd):
    remote, updates = mock_tunnel_api(mock_cf_cmd)
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    session.snapshot_tunnel_ingress()
    remote["config"]["originRequest"]["connectTimeout"] = "15s"
    with pytest.raises(TunnelCollisionError, match="changed"):
        session.add_temporary_tunnel_rule("temp.example.com", "http://127.0.0.1:8790")
    assert not updates
    assert remote["config"]["originRequest"]["connectTimeout"] == "15s"


def test_tunnel_external_change_after_update_blocks_rollback(mock_cf_cmd):
    remote, updates = mock_tunnel_api(mock_cf_cmd)
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    session.add_temporary_tunnel_rule("temp.example.com", "http://127.0.0.1:8790")
    remote["config"]["originRequest"]["connectTimeout"] = "15s"
    with pytest.raises(TunnelCollisionError, match="concurrently"):
        session.restore_tunnel_ingress()
    assert len(updates) == 1
    assert remote["config"]["originRequest"]["connectTimeout"] == "15s"
    assert session.saved_tunnel_config is not None


def test_tunnel_failed_update_then_unmodified_snapshot_needs_no_restore(mock_cf_cmd):
    original = initial_tunnel_config()

    def call_cf(args):
        if args[:3] == ["tunnels", "config", "get"]:
            return {"config": copy.deepcopy(original)}
        if args[:3] == ["tunnels", "config", "update"]:
            raise RuntimeError("remote update failed")
        raise AssertionError(args)

    mock_cf_cmd.side_effect = call_cf
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    with pytest.raises(TunnelUpdateError):
        session.add_temporary_tunnel_rule("temp.example.com", "http://127.0.0.1:8790")
    session.restore_tunnel_ingress()
    assert session.saved_tunnel_config is None
    assert sum("update" in call.args[0] for call in mock_cf_cmd.call_args_list) == 1


def test_dev_vars_permissive_existing_file_never_exposes_probe_token(tmp_path):
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    path = tmp_path / ".dev.vars"
    session.dev_vars_path = path
    path.write_text("PRE_EXISTING_SECRET=keep_me\n")
    os.chmod(path, 0o644)
    original = path.read_bytes()
    old_inode = path.stat().st_ino

    session.prepare_dev_vars("tok123", "https://call.example.com", "https://call.example.com", "/")
    assert "PROBE_AUTH_TOKEN" in path.read_text()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert path.stat().st_ino != old_inode
    session.restore_dev_vars()
    assert path.read_bytes() == original
    assert stat.S_IMODE(path.stat().st_mode) == 0o600

    path.unlink()
    session.prepare_dev_vars("tok456", "https://call.example.com", "https://call.example.com", "/")
    session.restore_dev_vars()
    assert not path.exists()


def test_dev_vars_symlink_is_rejected_without_mutating_target(tmp_path):
    target = tmp_path / "other-user-secret"
    target.write_text("USER_SECRET=untouched\n")
    path = tmp_path / ".dev.vars"
    path.symlink_to(target)
    session = SafeExperimentSession()
    session.dev_vars_path = path
    with pytest.raises(RuntimeError, match="unsafe"):
        session.prepare_dev_vars("token", "https://call.example.com", "https://call.example.com", "/")
    assert path.is_symlink()
    assert target.read_text() == "USER_SECRET=untouched\n"


def test_dev_vars_atomic_replace_failure_keeps_original_and_cleans_temps(tmp_path):
    path = tmp_path / ".dev.vars"
    path.write_text("ORIGINAL=preserved\n")
    os.chmod(path, 0o600)
    original_inode = path.stat().st_ino
    session = SafeExperimentSession()
    session.dev_vars_path = path
    with patch("scripts.egress_experiments.os.replace", side_effect=OSError("fault")):
        with pytest.raises(OSError, match="fault"):
            session.prepare_dev_vars("token", "https://call.example.com", "https://call.example.com", "/")
    assert path.read_text() == "ORIGINAL=preserved\n"
    assert path.stat().st_ino == original_inode
    assert not list(tmp_path.glob(".egress-vars-*"))
    assert session.dev_vars_modified is False


def test_dev_vars_concurrent_edit_is_not_clobbered(tmp_path):
    path = tmp_path / ".dev.vars"
    path.write_text("ORIGINAL=preserved\n")
    session = SafeExperimentSession()
    session.dev_vars_path = path
    session.prepare_dev_vars("token", "https://call.example.com", "https://call.example.com", "/")
    # An in-place overwrite retains inode identity; the content digest must catch it.
    path.write_text("EXTERNAL_CHANGE=do_not_clobber\n")
    with pytest.raises(RuntimeError, match="changed concurrently"):
        session.restore_dev_vars()
    assert path.read_text() == "EXTERNAL_CHANGE=do_not_clobber\n"


def test_session_rollback_after_fault_preserves_remote_and_local_state(mock_cf_cmd, tmp_path):
    remote = {"config": copy.deepcopy(initial_tunnel_config())}
    original_tunnel = copy.deepcopy(remote["config"])
    records = set()

    def cf_call(args):
        if args[:3] == ["tunnels", "config", "get"]:
            return copy.deepcopy(remote)
        if args[:3] == ["tunnels", "config", "update"]:
            remote["config"] = json.loads(args[args.index("--body") + 1])["config"]
            return {}
        if args[:3] == ["dns", "records", "list"]:
            return []
        if args[:3] == ["dns", "records", "create"]:
            records.add("rec-fault-1")
            return {"id": "rec-fault-1"}
        if args[:3] == ["dns", "records", "delete"]:
            records.discard("rec-fault-1")
            return {}
        raise AssertionError(args)

    mock_cf_cmd.side_effect = cf_call
    path = tmp_path / ".dev.vars"
    path.write_text("ORIGINAL_CONTENT\n")
    mock_proc = MagicMock(spec=subprocess.Popen)
    mock_proc.pid = 99999
    mock_proc.poll.return_value = None
    with patch("os.killpg") as killpg, patch("os.getpgid", return_value=99999):
        with pytest.raises(ValueError, match="Simulated experiment failure"):
            with SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123") as session:
                session.dev_vars_path = path
                session.add_temporary_tunnel_rule("temp.example.com", "http://127.0.0.1:8790")
                session.create_dns_record("A", "temp.example.com", "127.0.0.1", False)
                session.prepare_dev_vars("tok", "https://temp.example.com", "https://temp.example.com", "/")
                session.active_processes.append(mock_proc)
                raise ValueError("Simulated experiment failure")
        killpg.assert_called_with(99999, signal.SIGKILL)
    assert not records
    assert remote["config"] == original_tunnel
    assert path.read_text() == "ORIGINAL_CONTENT\n"


def test_rollback_continues_tunnel_restore_after_dns_failure(mock_cf_cmd):
    session = SafeExperimentSession(zone="example.com", tunnel_id="tunnel-123")
    original = initial_tunnel_config()
    applied = copy.deepcopy(original)
    applied["ingress"].insert(-1, {"hostname": "temp.example.com", "service": "http://127.0.0.1:8790"})
    session.saved_tunnel_config = original
    session.applied_tunnel_config = applied

    def cf_call(args):
        if args[:3] == ["dns", "records", "delete"]:
            raise RuntimeError("simulated DNS cleanup failure")
        if args[:3] == ["tunnels", "config", "get"]:
            return {"config": copy.deepcopy(applied)}
        if args[:3] == ["tunnels", "config", "update"]:
            return {}
        raise AssertionError(args)

    mock_cf_cmd.side_effect = cf_call
    session.created_dns_records.add("broken-rec")
    session.rollback()
    assert sum("update" in call.args[0] for call in mock_cf_cmd.call_args_list) == 1




def test_authoritative_dns_requires_exact_expected_address():
    """An unrelated/partial A reply must not authorize an adversarial DNS probe."""
    clock = iter([0.0, 0.0, 2.0])
    reply = MagicMock(returncode=0, stdout="127.0.0.12\\n")
    with (
        patch("scripts.egress_experiments.time.monotonic", side_effect=lambda: next(clock)),
        patch("scripts.egress_experiments.time.sleep"),
        patch("scripts.egress_experiments.subprocess.run", return_value=reply) as dig,
    ):
        with pytest.raises(TimeoutError, match="did not converge"):
            wait_for_dns("switch.example.com", "127.0.0.1", max_wait=1)

    dig.assert_called_once()
    assert dig.call_args.args[0] == [
        "dig", "@jimmy.ns.cloudflare.com", "+short", "A", "switch.example.com"
    ]
    assert dig.call_args.kwargs["timeout"] == 5


def test_authoritative_dns_exact_answer_allows_probe_to_proceed():
    reply = MagicMock(returncode=0, stdout="127.0.0.1\\n")
    with (
        patch("scripts.egress_experiments.time.monotonic", side_effect=[0.0, 0.0]),
        patch("scripts.egress_experiments.subprocess.run", return_value=reply),
    ):
        assert wait_for_dns("switch.example.com", "127.0.0.1", max_wait=1) is None


def test_authoritative_dns_zero_wait_fails_closed():
    with pytest.raises(TimeoutError, match="did not converge"):
        wait_for_dns("switch.example.com", "127.0.0.1", max_wait=0)


def test_probe_parses_crlf_from_real_text_mode_subprocess():
    """Real subprocess text mode normalizes CRLF; a successful probe must survive it."""
    raw_response = (
        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n"
        b'{"result":"success","upstreamStatus":204}'
    )
    actual_run = subprocess.run
    inputs = []
    token = "synthetic-secret"
    fixture_code = f"import sys; sys.stdout.buffer.write({raw_response!r})"

    def text_mode_curl_fixture(cmd, **kwargs):
        assert cmd[0] == "curl"
        assert token not in repr(cmd)
        assert kwargs["text"] is True
        inputs.append(kwargs["input"])
        response = actual_run(
            [sys.executable, "-c", fixture_code],
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
        assert "\r\n" not in response.stdout
        assert "\n\n" in response.stdout
        return response

    with patch(
        "scripts.egress_experiments.subprocess.run", side_effect=text_mode_curl_fixture
    ):
        result = run_probe("real-text-mode", token)

    assert result == {"result": "success", "upstreamStatus": 204}
    assert len(inputs) == 1
    assert token in inputs[0]



def test_probe_credentials_use_stdin_and_untrusted_output_is_not_returned():
    """No bearer token in argv, stderr, logged data, or raw diagnostic fallback."""
    mock_response = MagicMock()
    mock_response.returncode = 0
    mock_response.stdout = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"result":"success","upstreamStatus":204}'
    token = "synthetic-secret-that-must-not-reach-argv"
    with patch("scripts.egress_experiments.subprocess.run", return_value=mock_response) as run:
        assert run_probe("synthetic", token) == {"result": "success", "upstreamStatus": 204}
    args, kwargs = run.call_args
    assert token not in repr(args)
    assert token in kwargs["input"]
    assert "--max-time" in args[0]
    assert kwargs["timeout"] == 20

    mock_response.stdout = "HTTP/1.1 500 Error\r\n\r\nPRIVATE_SOURCE_ERROR_TEXT"
    with patch("scripts.egress_experiments.subprocess.run", return_value=mock_response):
        with patch("scripts.egress_experiments.time.sleep"):
            result = run_probe("synthetic", token)
    assert result == {"result": "failure", "category": "invalid-probe-response"}

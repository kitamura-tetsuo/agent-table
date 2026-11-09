import copy
import hashlib
import json
import os
import re
import secrets
import signal
import stat
import subprocess
import sys
import time
import tempfile
from pathlib import Path
from loguru import logger

LOG_FILE = Path("test-results/egress-experiments.log")
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
logger.remove()
logger.add(
    sys.stdout,
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | {message}",
    level="INFO",
)
logger.add(
    LOG_FILE,
    format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {message}",
    level="DEBUG",
    rotation="10 MB",
)

ZONE = "outliner-online.com"
TUNNEL_ID = "469ea721-e109-4081-b6ac-d8abc6152879"
TUNNEL_CNAME_TARGET = f"{TUNNEL_ID}.cfargotunnel.com"


class DnsCollisionError(RuntimeError):
    """Raised when a DNS record unexpectedly pre-exists."""


class TunnelCollisionError(RuntimeError):
    """Raised when a tunnel ingress rule unexpectedly pre-exists."""


class TunnelUpdateError(RuntimeError):
    """Raised when tunnel configuration update fails."""


def run_cf_cmd(args: list[str]) -> dict | list | str:
    cmd = ["cf"] + args
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        logger.error(f"Cloudflare CLI operation failed: {args[0] if args else 'unknown'} (exit {res.returncode})")
        raise RuntimeError("Cloudflare CLI operation failed; inspect authenticated CLI logs locally")
    out = res.stdout.strip()
    match = re.search(r"(\[.*\]|\{.*\})", out, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception:
            pass
    return out


class SafeExperimentSession:
    """Manages transactional lifecycle of DNS records, tunnel ingress, Wrangler processes, and dev vars."""

    def __init__(self, zone: str = ZONE, tunnel_id: str = TUNNEL_ID):
        self.zone = zone
        self.tunnel_id = tunnel_id
        self.created_dns_records: set[str] = set()
        self.saved_tunnel_config: dict | None = None
        self.applied_tunnel_config: dict | None = None
        self.active_processes: list[subprocess.Popen] = []
        self.dev_vars_path = Path("test/egress/.dev.vars")
        self.saved_dev_vars_content: bytes | None = None
        self.saved_dev_vars_mode: int | None = None
        self.written_dev_vars_identity: tuple[int, int] | None = None
        self.written_dev_vars_digest: bytes | None = None
        self.dev_vars_modified: bool = False
        self._installed_signals = False

    def __enter__(self):
        self._install_signal_handlers()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.rollback()
        return False

    def _install_signal_handlers(self):
        if not self._installed_signals:
            try:
                signal.signal(signal.SIGINT, self._handle_signal)
                signal.signal(signal.SIGTERM, self._handle_signal)
                self._installed_signals = True
            except (ValueError, AttributeError):
                # May fail if running outside the main thread (e.g. in test runners)
                pass

    def _handle_signal(self, signum, frame):
        logger.warning(f"Received signal {signum}. Initiating emergency rollback...")
        self.rollback()
        sys.exit(128 + signum)

    # --- DNS operations ---

    def list_dns_records(self, name: str) -> list[dict]:
        res = run_cf_cmd(["dns", "records", "list", "--zone", self.zone, "--name", name])
        if isinstance(res, list):
            return res
        return []

    def create_dns_record(
        self, record_type: str, name: str, content: str, proxied: bool, ttl: int = 60
    ) -> str:
        # P0 safety: verify collision before creation
        existing = self.list_dns_records(name)
        if existing:
            msg = f"DNS record collision: {len(existing)} record(s) already exist for {name}"
            logger.error(msg)
            raise DnsCollisionError(msg)

        body = {
            "type": record_type,
            "name": name,
            "content": content,
            "proxied": proxied,
            "ttl": 1 if proxied else ttl,
        }
        logger.info(
            f"Creating DNS record: type={record_type}, name={name}, proxied={proxied}, ttl={ttl}"
        )
        created = run_cf_cmd(
            ["dns", "records", "create", "--zone", self.zone, "--body", json.dumps(body)]
        )
        record_id = None
        if isinstance(created, dict) and "id" in created:
            record_id = str(created["id"])
        elif isinstance(created, list) and len(created) > 0 and "id" in created[0]:
            record_id = str(created[0]["id"])
        # Never infer ownership from a later DNS lookup. Another actor may have
        # created a record after the collision precheck; such an ID is not ours.
        if not record_id:
            raise RuntimeError(
                "Cloudflare did not return the created DNS record ID; "
                "leave remote state untouched and investigate manually"
            )

        self.created_dns_records.add(record_id)
        return record_id

    def delete_dns_record(self, record_id: str):
        if record_id not in self.created_dns_records:
            logger.warning(
                f"Refusing to delete untracked record ID: {record_id} (not created in this session)"
            )
            return
        logger.info(f"Deleting session DNS record: {record_id}")
        run_cf_cmd(["dns", "records", "delete", record_id, "--zone", self.zone, "--force"])
        self.created_dns_records.discard(record_id)

    # --- Tunnel ingress operations ---

    def get_tunnel_config(self) -> dict:
        cfg = run_cf_cmd(["tunnels", "config", "get", self.tunnel_id])
        if isinstance(cfg, dict):
            return cfg
        raise RuntimeError("Failed to retrieve valid JSON tunnel configuration")

    def snapshot_tunnel_ingress(self):
        """Capture the complete mutable tunnel config, including originRequest and other fields."""
        if self.saved_tunnel_config is not None:
            return
        full = self.get_tunnel_config()
        config = full.get("config")
        if not isinstance(config, dict) or not isinstance(config.get("ingress"), list):
            raise TunnelUpdateError("Tunnel config has no valid config.ingress list")
        self.saved_tunnel_config = copy.deepcopy(config)
        logger.info(f"Captured tunnel config with {len(config['ingress'])} ingress rules")

    def _assert_tunnel_config_equals(self, expected: dict):
        """Best-effort optimistic check; the CLI offers no atomic compare-and-swap."""
        actual = self.get_tunnel_config().get("config")
        if actual != expected:
            raise TunnelCollisionError(
                "Tunnel config changed since this session's snapshot; refusing to overwrite"
            )

    def add_temporary_tunnel_rule(self, hostname: str, service: str):
        self.snapshot_tunnel_ingress()
        assert self.saved_tunnel_config is not None
        rules = copy.deepcopy(self.saved_tunnel_config["ingress"])
        if any(rule.get("hostname") == hostname for rule in rules):
            raise TunnelCollisionError(f"Tunnel ingress collision for {hostname}")

        # Preserve all sibling fields and insert before the catch-all rule.
        if not rules or "hostname" in rules[-1]:
            raise TunnelUpdateError("Expected an explicit terminal tunnel catch-all rule")
        updated = copy.deepcopy(self.saved_tunnel_config)
        updated["ingress"] = rules[:-1] + [{"service": service, "hostname": hostname}] + rules[-1:]

        # Do not overwrite changes observed before our write. Cloudflare's update
        # endpoint replaces config; it has no exposed conditional-update token here.
        self._assert_tunnel_config_equals(self.saved_tunnel_config)
        self.applied_tunnel_config = copy.deepcopy(updated)
        logger.info(f"Applying temporary tunnel ingress rule for {hostname}")
        self._update_tunnel_config(updated)

    def _update_tunnel_config(self, config: dict):
        """Send every mutable config field, not an ingress-only replacement."""
        body = {"config": copy.deepcopy(config)}
        try:
            run_cf_cmd(
                ["tunnels", "config", "update", self.tunnel_id, "--body", json.dumps(body)]
            )
        except Exception as e:
            logger.error(f"Tunnel configuration update failed: {type(e).__name__}")
            raise TunnelUpdateError("Tunnel configuration update failed") from e

    def restore_tunnel_ingress(self):
        if self.saved_tunnel_config is None:
            return
        original = self.saved_tunnel_config
        current = self.get_tunnel_config().get("config")
        if current == original:
            # A failed write may not have reached the remote API.
            self.saved_tunnel_config = None
            self.applied_tunnel_config = None
            return
        if self.applied_tunnel_config is None or current != self.applied_tunnel_config:
            raise TunnelCollisionError(
                "Tunnel configuration changed concurrently; refusing destructive rollback"
            )
        logger.info("Restoring the complete original tunnel configuration")
        self._update_tunnel_config(original)
        self.saved_tunnel_config = None
        self.applied_tunnel_config = None

    # --- Dev vars & secret management ---

    def _atomic_replace_dev_vars(self, contents: bytes, mode: int) -> None:
        """Replace the file via a same-directory 0600 temp; never truncate it in place."""
        parent = self.dev_vars_path.parent
        parent.mkdir(parents=True, exist_ok=True)
        parent_stat = parent.lstat()
        if not stat.S_ISDIR(parent_stat.st_mode) or parent.is_symlink():
            raise RuntimeError("Refusing an unsafe .dev.vars directory")
        # An original permissive file is deliberately restored as private (at most 0600).
        fd, temporary_name = tempfile.mkstemp(prefix=".egress-vars-", dir=parent)
        try:
            os.fchmod(fd, mode & 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
            # os.replace never follows a destination symlink. The caller additionally
            # rejects pre-existing symlinks and verifies our own inode on restoration.
            os.replace(temporary_name, self.dev_vars_path)
        finally:
            if os.path.lexists(temporary_name):
                os.unlink(temporary_name)

    def _read_regular_dev_vars(self) -> tuple[bytes, int] | None:
        try:
            fd = os.open(self.dev_vars_path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        except OSError as e:
            raise RuntimeError("Refusing unsafe .dev.vars path") from e
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError("Refusing non-regular .dev.vars")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                contents = stream.read()
            # Recheck that the path is still the opened regular file.
            current = self.dev_vars_path.lstat()
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
                raise RuntimeError(".dev.vars changed during snapshot")
            return contents, stat.S_IMODE(info.st_mode)
        finally:
            os.close(fd)

    def _assert_written_dev_vars_unchanged(self) -> None:
        if self.written_dev_vars_identity is None or self.written_dev_vars_digest is None:
            raise RuntimeError("No managed .dev.vars contents to restore")
        try:
            current = self.dev_vars_path.lstat()
        except FileNotFoundError as e:
            raise RuntimeError("Managed .dev.vars disappeared; refusing rollback overwrite") from e
        if (
            not stat.S_ISREG(current.st_mode)
            or (current.st_dev, current.st_ino) != self.written_dev_vars_identity
        ):
            raise RuntimeError(".dev.vars changed concurrently; refusing destructive rollback")
        # In-place edits can preserve inode identity, so check content too.
        snapshot = self._read_regular_dev_vars()
        if snapshot is None or hashlib.sha256(snapshot[0]).digest() != self.written_dev_vars_digest:
            raise RuntimeError(".dev.vars content changed concurrently; refusing rollback")

    def prepare_dev_vars(
        self, token: str, callback_url: str, origin: str, path_prefix: str
    ):
        if self.dev_vars_modified:
            self._assert_written_dev_vars_unchanged()
        else:
            original = self._read_regular_dev_vars()
            if original is not None:
                self.saved_dev_vars_content, self.saved_dev_vars_mode = original
                logger.info("Preserving the original .dev.vars contents in memory")
            elif self.dev_vars_path.is_symlink():
                raise RuntimeError("Refusing symlink .dev.vars")

        vars_content = (
            f'PROBE_AUTH_TOKEN="{token}"\n'
            f'PROBE_CALLBACK_URL="{callback_url}"\n'
            f'PROBE_REVIEWED_ORIGIN="{origin}"\n'
            f'PROBE_REVIEWED_PATH_PREFIX="{path_prefix}"\n'
        )
        self._atomic_replace_dev_vars(vars_content.encode("utf-8"), 0o600)
        current = self.dev_vars_path.lstat()
        self.written_dev_vars_identity = (current.st_dev, current.st_ino)
        self.written_dev_vars_digest = hashlib.sha256(vars_content.encode("utf-8")).digest()
        self.dev_vars_modified = True
        logger.info("Atomically installed temporary .dev.vars with mode 0600")

    def restore_dev_vars(self):
        if not self.dev_vars_modified:
            return
        try:
            self._assert_written_dev_vars_unchanged()
            if self.saved_dev_vars_content is not None:
                self._atomic_replace_dev_vars(
                    self.saved_dev_vars_content,
                    self.saved_dev_vars_mode if self.saved_dev_vars_mode is not None else 0o600,
                )
                logger.info("Restored original .dev.vars contents atomically")
            else:
                self.dev_vars_path.unlink()
                logger.info("Removed temporary .dev.vars")
        except Exception as e:
            # Retain snapshot on failure so a subsequent explicit retry is possible.
            logger.error(f"Failed to restore .dev.vars: {type(e).__name__}")
            raise
        self.saved_dev_vars_content = None
        self.saved_dev_vars_mode = None
        self.written_dev_vars_identity = None
        self.written_dev_vars_digest = None
        self.dev_vars_modified = False

    # --- Process management (no pkill) ---

    def start_wrangler(
        self, token: str, callback_url: str, origin: str, path_prefix: str
    ) -> subprocess.Popen:
        self.prepare_dev_vars(token, callback_url, origin, path_prefix)

        logger.info(f"Starting Wrangler Remote Preview on 127.0.0.1:8788 (origin={origin})")
        # Launch in dedicated process group (start_new_session=True) so we can kill child processes cleanly
        proc = subprocess.Popen(
            [
                "npx",
                "wrangler",
                "dev",
                "--remote",
                "--config",
                "test/egress/wrangler.jsonc",
                "--ip",
                "127.0.0.1",
                "--port",
                "8788",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        self.active_processes.append(proc)

        # Wait for probe readiness
        deadline = time.time() + 30
        ready = False
        while time.time() < deadline:
            check = subprocess.run(
                [
                    "curl",
                    "-s",
                    "-o",
                    "/dev/null",
                    "-w",
                    "%{http_code}",
                    "http://127.0.0.1:8788/__egress_probe",
                ],
                capture_output=True,
                text=True,
            )
            if check.stdout.strip() == "404":
                ready = True
                break
            time.sleep(1)

        if not ready:
            self.stop_wrangler(proc)
            raise TimeoutError("Wrangler dev server failed to start within 30 seconds")

        time.sleep(2)
        logger.info("Wrangler Remote Preview is ready")
        return proc

    def stop_wrangler(self, proc: subprocess.Popen):
        logger.info("Stopping Wrangler Remote Preview process group")
        if proc in self.active_processes:
            self.active_processes.remove(proc)

        if proc.poll() is None:
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGTERM)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    logger.warning("Wrangler did not exit on SIGTERM; sending SIGKILL to process group")
                    os.killpg(pgid, signal.SIGKILL)
                    proc.wait(timeout=5)
            except ProcessLookupError:
                pass
            except Exception as e:
                logger.error(f"Error stopping process group {proc.pid}: {e}")

        self.restore_dev_vars()

    # --- Complete rollback ---

    def rollback(self):
        logger.info("Executing session rollback for all managed resources...")
        # 1. Stop all active child processes
        while self.active_processes:
            p = self.active_processes.pop()
            try:
                if p.poll() is None:
                    pgid = os.getpgid(p.pid)
                    os.killpg(pgid, signal.SIGKILL)
                    p.wait(timeout=3)
            except Exception as e:
                logger.error(f"Error terminating process {p.pid} in rollback: {e}")

        # 2. Delete all created DNS records
        for record_id in list(self.created_dns_records):
            try:
                logger.info(f"Rollback: deleting DNS record {record_id}")
                run_cf_cmd(
                    ["dns", "records", "delete", record_id, "--zone", self.zone, "--force"]
                )
                self.created_dns_records.discard(record_id)
            except Exception as e:
                logger.error(f"Failed to delete DNS record {record_id} in rollback: {e}")

        # 3. Restore tunnel ingress
        try:
            self.restore_tunnel_ingress()
        except Exception as e:
            logger.error(f"Failed to restore tunnel ingress in rollback: {e}")

        # 4. Restore dev vars
        try:
            self.restore_dev_vars()
        except Exception as e:
            logger.error(f"Failed to restore .dev.vars in rollback: {e}")

        logger.info("Session rollback complete")


def wait_for_dns(
    hostname: str, expected_content: str | None = None, max_wait: int = 30
) -> None:
    """Abort the experiment if authoritative DNS has not reached the expected state."""
    logger.info(f"Waiting for authoritative DNS propagation for {hostname}...")
    start = time.monotonic()
    while time.monotonic() - start < max_wait:
        try:
            res = subprocess.run(
                ["dig", "@jimmy.ns.cloudflare.com", "+short", "A", hostname],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
        except subprocess.TimeoutExpired:
            time.sleep(2)
            continue
        answers = {line.strip() for line in res.stdout.splitlines() if line.strip()}
        if res.returncode == 0 and answers and (
            expected_content is None or expected_content in answers
        ):
            logger.info("Authoritative DNS answer confirmed for experiment hostname")
            return
        time.sleep(2)
    raise TimeoutError("Authoritative DNS state did not converge; aborting experiment")


def record_dns_lookup(hostname: str) -> dict:
    dns_res = {}
    for resolver in ["jimmy.ns.cloudflare.com", "1.1.1.1", "8.8.8.8"]:
        res = subprocess.run(
            ["dig", f"@{resolver}", "+noall", "+answer", "+comments", hostname],
            capture_output=True,
            text=True,
        )
        dns_res[resolver] = res.stdout.strip()
    return dns_res


def run_probe(test_id: str, probe_token: str) -> dict:
    """Pass credentials over stdin, never in process arguments or retained output."""
    url = "http://127.0.0.1:8788/__egress_probe"
    cmd = [
        "curl",
        "--silent",
        "--show-error",
        "--include",
        "--request",
        "POST",
        "--header",
        f"x-probe-test-id: {test_id}",
        "--config",
        "-",
        "--max-time",
        "15",
        url,
    ]
    # Curl accepts one config directive per line. This token is not placed in
    # argv, environment variables, or a temporary file.
    config = f'header = "Authorization: Bearer {probe_token}"\n'
    for _ in range(3):
        try:
            res = subprocess.run(
                cmd, input=config, capture_output=True, text=True, check=False, timeout=20
            )
        except subprocess.TimeoutExpired:
            continue
        if res.returncode != 0:
            continue
        # text=True normalizes subprocess CRLF output to LF; also accept test fakes with CRLF.
        parts = res.stdout.replace("\r\n", "\n").split("\n\n", 1)
        if len(parts) != 2:
            continue
        try:
            parsed = json.loads(parts[1].strip())
            if isinstance(parsed, dict):
                return parsed
        except (ValueError, TypeError):
            pass
        time.sleep(2)
    return {"result": "failure", "category": "invalid-probe-response"}


def run_task_a():
    logger.info("==================================================")
    logger.info("TASK A: Identifying root cause of HTTP 530")
    logger.info("==================================================")

    results = {}
    token = secrets.token_hex(32)

    with SafeExperimentSession() as session:
        # 1. DNS-only pointing to 127.0.0.1
        diag_loopback_host = "egress-diag-loopback.outliner-online.com"
        logger.info(f"Setting up {diag_loopback_host} -> 127.0.0.1 (DNS-only, TTL 60)")
        rec_id_127 = session.create_dns_record(
            "A", diag_loopback_host, "127.0.0.1", proxied=False, ttl=60
        )
        wait_for_dns(diag_loopback_host, "127.0.0.1")
        dns_obs_127 = record_dns_lookup(diag_loopback_host)

        wrangler_proc = session.start_wrangler(
            token=token,
            callback_url=f"https://{diag_loopback_host}/egress-check/positive",
            origin=f"https://{diag_loopback_host}",
            path_prefix="/egress-check",
        )
        try:
            probe_res_127 = run_probe("task-a-diag-127", token)
            logger.info(
                f"Observed probe result for 127.0.0.1: status={probe_res_127.get('upstreamStatus')} cfErrorCode={probe_res_127.get('cfErrorCode')}"
            )
            results["diag_loopback"] = {
                "dns": dns_obs_127,
                "probe": probe_res_127,
            }
        finally:
            session.stop_wrangler(wrangler_proc)
            session.delete_dns_record(rec_id_127)
            time.sleep(2)

        # 2. DNS-only pointing to RFC 1918 10.0.0.1
        diag_rfc1918_host = "egress-diag-rfc1918.outliner-online.com"
        logger.info(f"Setting up {diag_rfc1918_host} -> 10.0.0.1 (DNS-only, TTL 60)")
        rec_id_10 = session.create_dns_record(
            "A", diag_rfc1918_host, "10.0.0.1", proxied=False, ttl=60
        )
        wait_for_dns(diag_rfc1918_host, "10.0.0.1")
        dns_obs_10 = record_dns_lookup(diag_rfc1918_host)

        wrangler_proc = session.start_wrangler(
            token=token,
            callback_url=f"https://{diag_rfc1918_host}/egress-check/positive",
            origin=f"https://{diag_rfc1918_host}",
            path_prefix="/egress-check",
        )
        try:
            probe_res_10 = run_probe("task-a-diag-rfc1918", token)
            logger.info(
                f"Observed probe result for 10.0.0.1: status={probe_res_10.get('upstreamStatus')} cfErrorCode={probe_res_10.get('cfErrorCode')}"
            )
            results["diag_rfc1918"] = {
                "dns": dns_obs_10,
                "probe": probe_res_10,
            }
        finally:
            session.stop_wrangler(wrangler_proc)
            session.delete_dns_record(rec_id_10)
            time.sleep(2)

        # 3. Non-existent domain (NXDOMAIN)
        diag_nxdomain_host = "egress-diag-nxdomain-nonexistent.outliner-online.com"
        logger.info(f"Testing non-existent host: {diag_nxdomain_host}")
        dns_obs_nx = record_dns_lookup(diag_nxdomain_host)

        wrangler_proc = session.start_wrangler(
            token=token,
            callback_url=f"https://{diag_nxdomain_host}/egress-check/positive",
            origin=f"https://{diag_nxdomain_host}",
            path_prefix="/egress-check",
        )
        try:
            probe_res_nx = run_probe("task-a-diag-nxdomain", token)
            logger.info(
                f"Observed probe result for NXDOMAIN: status={probe_res_nx.get('upstreamStatus')} cfErrorCode={probe_res_nx.get('cfErrorCode')}"
            )
            results["diag_nxdomain"] = {
                "dns": dns_obs_nx,
                "probe": probe_res_nx,
            }
        finally:
            session.stop_wrangler(wrangler_proc)

    return results


def run_task_b():
    logger.info("==================================================")
    logger.info("TASK B: Public IP -> Private IP DNS Switch Test")
    logger.info("==================================================")

    switch_host = "egress-switch-issue19.outliner-online.com"
    token = secrets.token_hex(32)
    results = {}

    with SafeExperimentSession() as session:
        # Step 1: Positive Control Baseline on temporary hostname
        logger.info(f"Step 1: Positive control baseline on {switch_host}")
        session.add_temporary_tunnel_rule(switch_host, "http://127.0.0.1:8790")
        time.sleep(2)

        cname_id = session.create_dns_record(
            "CNAME", switch_host, TUNNEL_CNAME_TARGET, proxied=True
        )
        wait_for_dns(switch_host)
        time.sleep(3)  # wait for edge cert and routing

        # Edge test
        curl_test = subprocess.run(
            [
                "curl",
                "-s",
                "-i",
                "-X",
                "POST",
                "-H",
                "Content-Type: application/json",
                "--data",
                '{"probe":"agent-table-egress","value":"synthetic"}',
                f"https://{switch_host}/egress-check/positive",
            ],
            capture_output=True,
            text=True,
        )
        logger.info(
            f"Step 1: Direct edge test status: {curl_test.stdout.splitlines()[:1] if curl_test.stdout else 'no output'}"
        )

        wrangler_proc = session.start_wrangler(
            token=token,
            callback_url=f"https://{switch_host}/egress-check/positive",
            origin=f"https://{switch_host}",
            path_prefix="/egress-check",
        )
        try:
            step1_probe = run_probe("switch-step1-positive", token)
            logger.info(
                f"Step 1: Worker probe result: result={step1_probe.get('result')}"
            )
            results["step1_positive"] = step1_probe
        finally:
            session.stop_wrangler(wrangler_proc)

        # Step 2: Switch same hostname to Private IP (127.0.0.1, proxied: false, TTL 60)
        logger.info(f"Step 2: Switching {switch_host} DNS to 127.0.0.1")
        session.delete_dns_record(cname_id)
        time.sleep(2)

        a_id_127 = session.create_dns_record(
            "A", switch_host, "127.0.0.1", proxied=False, ttl=60
        )
        wait_for_dns(switch_host, "127.0.0.1")

        # Step 3: Record TTL, cache, DNS responses
        logger.info("Step 3: Recording TTL, cache, and DNS responses")
        step3_dns = record_dns_lookup(switch_host)
        results["step3_dns"] = step3_dns

        # Step 4: Send via same sendVerifiedHttps()
        logger.info("Step 4: Executing sendVerifiedHttps() against private IP DNS")
        wrangler_proc = session.start_wrangler(
            token=token,
            callback_url=f"https://{switch_host}/egress-check/positive",
            origin=f"https://{switch_host}",
            path_prefix="/egress-check",
        )
        try:
            step4_probe = run_probe("switch-step4-private-127", token)
            logger.info(
                f"Step 4: Worker probe result: status={step4_probe.get('upstreamStatus')} cfErrorCode={step4_probe.get('cfErrorCode')}"
            )
            results["step4_private_127"] = step4_probe
        finally:
            session.stop_wrangler(wrangler_proc)
            session.delete_dns_record(a_id_127)
            time.sleep(2)

        # Step 5: Test RFC 1918 switch on same hostname
        logger.info(f"Step 5: Switching {switch_host} to RFC 1918 10.0.0.1")
        a_id_10 = session.create_dns_record(
            "A", switch_host, "10.0.0.1", proxied=False, ttl=60
        )
        wait_for_dns(switch_host, "10.0.0.1")

        wrangler_proc = session.start_wrangler(
            token=token,
            callback_url=f"https://{switch_host}/egress-check/positive",
            origin=f"https://{switch_host}",
            path_prefix="/egress-check",
        )
        try:
            step5_probe = run_probe("switch-step5-private-rfc1918", token)
            logger.info(
                f"Step 5: Worker probe result: status={step5_probe.get('upstreamStatus')} cfErrorCode={step5_probe.get('cfErrorCode')}"
            )
            results["step5_private_10"] = step5_probe
        finally:
            session.stop_wrangler(wrangler_proc)
            session.delete_dns_record(a_id_10)
            time.sleep(2)

        # Step 6: Restoration handled by session.__exit__ (tunnel restore, dev vars restore)

    # Verify post-clean DNS
    with SafeExperimentSession() as session:
        post_clean = session.list_dns_records(switch_host)
        logger.info(f"Confirming DNS record {switch_host} is removed: {len(post_clean) == 0}")
        results["step6_cleaned"] = len(post_clean) == 0

    # Verify baseline health
    base_check = subprocess.run(
        [
            "curl",
            "-s",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "--data",
            '{"probe":"agent-table-egress","value":"synthetic"}',
            "https://probe.outliner-online.com/egress-check/positive",
        ],
        capture_output=True,
        text=True,
    )
    logger.info(f"Baseline probe.outliner-online.com status: {base_check.stdout.strip()}")
    results["step6_baseline_healthy"] = base_check.stdout.strip() == "204"

    return results


if __name__ == "__main__":
    if os.environ.get("AGENT_TABLE_ALLOW_LIVE_EGRESS_EXPERIMENT") != "yes":
        raise SystemExit(
            "Refusing DNS/tunnel mutation: set AGENT_TABLE_ALLOW_LIVE_EGRESS_EXPERIMENT=yes "
            "only for an explicitly authorized isolated experiment"
        )
    task_a_res = run_task_a()
    task_b_res = run_task_b()
    summary = {"task_a": task_a_res, "task_b": task_b_res}
    Path("test-results/egress-results.json").write_text(json.dumps(summary, indent=2))
    logger.info("All tasks completed. Results written to test-results/egress-results.json")

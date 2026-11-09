import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
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
        logger.error(f"cf command failed: {args[0] if args else ''}: {res.stderr.strip()[:200]}")
        raise RuntimeError(f"cf command failed: {res.stderr.strip()[:200]}")
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
        self.saved_tunnel_ingress: list[dict] | None = None
        self.active_processes: list[subprocess.Popen] = []
        self.dev_vars_path = Path("test/egress/.dev.vars")
        self.saved_dev_vars_content: str | None = None
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
        else:
            recs = self.list_dns_records(name)
            if recs:
                record_id = str(recs[0]["id"])

        if not record_id:
            raise RuntimeError(f"Failed to obtain record ID for created DNS record {name}")

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
        if self.saved_tunnel_ingress is None:
            full_config = self.get_tunnel_config()
            ingress = full_config.get("config", {}).get("ingress", [])
            self.saved_tunnel_ingress = [dict(rule) for rule in ingress]
            logger.info(
                f"Captured snapshot of current tunnel ingress ({len(self.saved_tunnel_ingress)} rules)"
            )

    def add_temporary_tunnel_rule(self, hostname: str, service: str):
        self.snapshot_tunnel_ingress()
        assert self.saved_tunnel_ingress is not None

        # Check for rule collision
        for rule in self.saved_tunnel_ingress:
            if rule.get("hostname") == hostname:
                msg = f"Tunnel ingress collision: rule for {hostname} already exists"
                logger.error(msg)
                raise TunnelCollisionError(msg)

        # Insert temporary rule before the catch-all (last) rule
        temp_rule = {"service": service, "hostname": hostname}
        if len(self.saved_tunnel_ingress) > 0:
            new_rules = (
                self.saved_tunnel_ingress[:-1]
                + [temp_rule]
                + self.saved_tunnel_ingress[-1:]
            )
        else:
            new_rules = [temp_rule, {"service": "http_status:404"}]

        logger.info(f"Applying temporary tunnel ingress rule for {hostname}")
        self._update_tunnel_ingress(new_rules)

    def _update_tunnel_ingress(self, rules: list[dict]):
        body = {"config": {"ingress": rules}}
        try:
            run_cf_cmd(
                ["tunnels", "config", "update", self.tunnel_id, "--body", json.dumps(body)]
            )
        except Exception as e:
            logger.error(f"Failed to update tunnel ingress: {e}")
            raise TunnelUpdateError(f"Tunnel update failed: {e}") from e

    def restore_tunnel_ingress(self):
        if self.saved_tunnel_ingress is not None:
            logger.info("Restoring original tunnel ingress rules from snapshot")
            self._update_tunnel_ingress(self.saved_tunnel_ingress)
            self.saved_tunnel_ingress = None

    # --- Dev vars & secret management ---

    def prepare_dev_vars(
        self, token: str, callback_url: str, origin: str, path_prefix: str
    ):
        if not self.dev_vars_modified:
            if self.dev_vars_path.exists():
                self.saved_dev_vars_content = self.dev_vars_path.read_text()
                logger.info("Preserving existing .dev.vars content in memory")
            self.dev_vars_modified = True

        vars_content = (
            f'PROBE_AUTH_TOKEN="{token}"\n'
            f'PROBE_CALLBACK_URL="{callback_url}"\n'
            f'PROBE_REVIEWED_ORIGIN="{origin}"\n'
            f'PROBE_REVIEWED_PATH_PREFIX="{path_prefix}"\n'
        )

        # Atomic create with 0600 permissions
        self.dev_vars_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(
            self.dev_vars_path,
            os.O_CREAT | os.O_WRONLY | os.O_TRUNC,
            0o600,
        )
        with open(fd, "w") as f:
            f.write(vars_content)
        logger.info("Created temporary .dev.vars with restricted permissions (0600)")

    def restore_dev_vars(self):
        if not self.dev_vars_modified:
            return
        try:
            if self.saved_dev_vars_content is not None:
                fd = os.open(
                    self.dev_vars_path,
                    os.O_CREAT | os.O_WRONLY | os.O_TRUNC,
                    0o600,
                )
                with open(fd, "w") as f:
                    f.write(self.saved_dev_vars_content)
                logger.info("Restored original .dev.vars file")
            else:
                if self.dev_vars_path.exists():
                    self.dev_vars_path.unlink()
                    logger.info("Removed temporary .dev.vars file")
        except Exception as e:
            logger.error(f"Error restoring .dev.vars: {e}")
        finally:
            self.saved_dev_vars_content = None
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
) -> bool:
    logger.info(f"Waiting for DNS propagation on authoritative NS for {hostname}...")
    start = time.time()
    while time.time() - start < max_wait:
        res = subprocess.run(
            ["dig", "@jimmy.ns.cloudflare.com", "+short", hostname],
            capture_output=True,
            text=True,
        )
        out = res.stdout.strip()
        if out:
            if expected_content is None or expected_content in out:
                logger.info(f"DNS authoritative reply: {out}")
                return True
        time.sleep(2)
    return False


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
    url = "http://127.0.0.1:8788/__egress_probe"
    cmd = [
        "curl",
        "-s",
        "-i",
        "-X",
        "POST",
        "-H",
        f"Authorization: Bearer {probe_token}",
        "-H",
        f"x-probe-test-id: {test_id}",
        url,
    ]
    out = ""
    for attempt in range(3):
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
        out = res.stdout.strip()
        if out:
            parts = out.split("\r\n\r\n", 1)
            body = parts[-1].strip() if len(parts) > 1 else out
            try:
                return json.loads(body)
            except Exception:
                pass
        time.sleep(2)
    return {"raw": out}


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
    task_a_res = run_task_a()
    task_b_res = run_task_b()
    summary = {"task_a": task_a_res, "task_b": task_b_res}
    Path("test-results/egress-results.json").write_text(json.dumps(summary, indent=2))
    logger.info("All tasks completed. Results written to test-results/egress-results.json")

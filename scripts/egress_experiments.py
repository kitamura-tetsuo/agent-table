import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path
from loguru import logger

# Configure loguru: stdout and file output without sensitive info
LOG_FILE = Path("test-results/egress-experiments.log")
LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
logger.remove()
logger.add(sys.stdout, format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | {message}", level="INFO")
logger.add(LOG_FILE, format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {message}", level="DEBUG", rotation="10 MB")

ZONE = "outliner-online.com"
TUNNEL_ID = "469ea721-e109-4081-b6ac-d8abc6152879"
TUNNEL_CNAME_TARGET = f"{TUNNEL_ID}.cfargotunnel.com"

def run_cf_cmd(args: list[str]) -> dict | list | str:
    cmd = ["cf"] + args
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        logger.error(f"cf command failed: {cmd}: {res.stderr.strip()}")
        raise RuntimeError(f"cf command failed: {res.stderr.strip()}")
    # parse json output if possible
    # cf outputs decorative lines before/after JSON; extract JSON payload
    out = res.stdout.strip()
    match = re.search(r"(\[.*\]|\{.*\})", out, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception:
            pass
    return out

def list_dns_record(name: str):
    res = run_cf_cmd(["dns", "records", "list", "--zone", ZONE, "--name", name])
    if isinstance(res, list):
        return res
    return []

def delete_dns_record(record_id: str):
    logger.info(f"Deleting DNS record: {record_id}")
    run_cf_cmd(["dns", "records", "delete", record_id, "--zone", ZONE, "--force"])

def create_dns_record(record_type: str, name: str, content: str, proxied: bool, ttl: int = 60):
    body = {
        "type": record_type,
        "name": name,
        "content": content,
        "proxied": proxied,
        "ttl": 1 if proxied else ttl,
    }
    logger.info(f"Creating DNS record: type={record_type}, name={name}, proxied={proxied}, ttl={ttl}")
    return run_cf_cmd(["dns", "records", "create", "--zone", ZONE, "--body", json.dumps(body)])

def update_tunnel_ingress(rules: list[dict]):
    body = {
        "config": {
            "ingress": rules
        }
    }
    logger.info("Updating tunnel ingress configuration")
    return run_cf_cmd(["tunnels", "config", "update", TUNNEL_ID, "--body", json.dumps(body)])

def wait_for_dns(hostname: str, expected_content: str | None = None, max_wait: int = 30) -> bool:
    logger.info(f"Waiting for DNS propagation on authoritative NS for {hostname}...")
    start = time.time()
    while time.time() - start < max_wait:
        res = subprocess.run(["dig", "@jimmy.ns.cloudflare.com", "+short", hostname], capture_output=True, text=True)
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
        res = subprocess.run(["dig", f"@{resolver}", "+noall", "+answer", "+comments", hostname], capture_output=True, text=True)
        dns_res[resolver] = res.stdout.strip()
    return dns_res

def run_probe(test_id: str, probe_token: str) -> dict:
    url = "http://127.0.0.1:8788/__egress_probe"
    cmd = [
        "curl", "-s", "-i", "-X", "POST",
        "-H", f"Authorization: Bearer {probe_token}",
        "-H", f"x-probe-test-id: {test_id}",
        url
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

def start_wrangler(token: str, callback_url: str, origin: str, path_prefix: str) -> subprocess.Popen:
    vars_file = Path("test/egress/.dev.vars")
    vars_content = f'PROBE_AUTH_TOKEN="{token}"\nPROBE_CALLBACK_URL="{callback_url}"\nPROBE_REVIEWED_ORIGIN="{origin}"\nPROBE_REVIEWED_PATH_PREFIX="{path_prefix}"\n'
    vars_file.write_text(vars_content)
    os.chmod(vars_file, 0o600)
    
    subprocess.run(["pkill", "-f", "wrangler dev --remote"], check=False)
    time.sleep(1)
    
    logger.info(f"Starting Wrangler Remote Preview on 127.0.0.1:8788 (origin={origin})")
    proc = subprocess.Popen(
        ["npx", "wrangler", "dev", "--remote", "--config", "test/egress/wrangler.jsonc", "--ip", "127.0.0.1", "--port", "8788"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(5)
    deadline = time.time() + 25
    ready = False
    while time.time() < deadline:
        check = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:8788/__egress_probe"], capture_output=True, text=True)
        if check.stdout.strip() == "404":
            ready = True
            break
        time.sleep(1)
    if not ready:
        stop_wrangler(proc)
        raise TimeoutError("Wrangler dev server failed to start within 25 seconds")
    time.sleep(2)
    logger.info("Wrangler Remote Preview is ready")
    return proc

def stop_wrangler(proc: subprocess.Popen):
    logger.info("Stopping Wrangler Remote Preview")
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    subprocess.run(["pkill", "-f", "wrangler dev --remote"], check=False)
    time.sleep(2)

def record_dns_lookup(hostname: str) -> dict:
    dns_res = {}
    for resolver in ["jimmy.ns.cloudflare.com", "1.1.1.1", "8.8.8.8"]:
        res = subprocess.run(["dig", f"@{resolver}", "+noall", "+answer", "+comments", hostname], capture_output=True, text=True)
        dns_res[resolver] = res.stdout.strip()
    return dns_res


def run_task_a():
    logger.info("==================================================")
    logger.info("TASK A: Identifying root cause of HTTP 530")
    logger.info("==================================================")
    
    results = {}
    token = secrets.token_hex(32)
    
    # 1. DNS-only pointing to 127.0.0.1
    diag_loopback_host = "egress-diag-loopback.outliner-online.com"
    logger.info(f"Setting up {diag_loopback_host} -> 127.0.0.1 (DNS-only, TTL 60)")
    created_rec = create_dns_record("A", diag_loopback_host, "127.0.0.1", proxied=False, ttl=60)
    rec_id = None
    if isinstance(created_rec, dict) and "id" in created_rec:
        rec_id = created_rec["id"]
    elif isinstance(created_rec, list) and len(created_rec) > 0 and "id" in created_rec[0]:
        rec_id = created_rec[0]["id"]
    else:
        # lookup record id
        recs = list_dns_record(diag_loopback_host)
        if recs:
            rec_id = recs[0]["id"]
            
    wait_for_dns(diag_loopback_host, "127.0.0.1")
    dns_obs_127 = record_dns_lookup(diag_loopback_host)
    logger.info(f"DNS lookup for {diag_loopback_host}:\n{dns_obs_127['jimmy.ns.cloudflare.com']}")
    
    wrangler_proc = start_wrangler(
        token=token,
        callback_url=f"https://{diag_loopback_host}/egress-check/positive",
        origin=f"https://{diag_loopback_host}",
        path_prefix="/egress-check"
    )
    try:
        probe_res_127 = run_probe("task-a-diag-127", token)
        logger.info(f"Observed probe result for 127.0.0.1: {probe_res_127}")
        results["diag_loopback"] = {
            "dns": dns_obs_127,
            "probe": probe_res_127,
        }
    finally:
        stop_wrangler(wrangler_proc)
        if rec_id:
            delete_dns_record(rec_id)
            time.sleep(2)

    # 2. DNS-only pointing to RFC 1918 10.0.0.1
    diag_rfc1918_host = "egress-diag-rfc1918.outliner-online.com"
    logger.info(f"Setting up {diag_rfc1918_host} -> 10.0.0.1 (DNS-only, TTL 60)")
    created_rec = create_dns_record("A", diag_rfc1918_host, "10.0.0.1", proxied=False, ttl=60)
    rec_id = None
    if isinstance(created_rec, dict) and "id" in created_rec:
        rec_id = created_rec["id"]
    else:
        recs = list_dns_record(diag_rfc1918_host)
        if recs:
            rec_id = recs[0]["id"]
            
    wait_for_dns(diag_rfc1918_host, "10.0.0.1")
    dns_obs_10 = record_dns_lookup(diag_rfc1918_host)
    logger.info(f"DNS lookup for {diag_rfc1918_host}:\n{dns_obs_10['jimmy.ns.cloudflare.com']}")
    
    wrangler_proc = start_wrangler(
        token=token,
        callback_url=f"https://{diag_rfc1918_host}/egress-check/positive",
        origin=f"https://{diag_rfc1918_host}",
        path_prefix="/egress-check"
    )
    try:
        probe_res_10 = run_probe("task-a-diag-rfc1918", token)
        logger.info(f"Observed probe result for 10.0.0.1: {probe_res_10}")
        results["diag_rfc1918"] = {
            "dns": dns_obs_10,
            "probe": probe_res_10,
        }
    finally:
        stop_wrangler(wrangler_proc)
        if rec_id:
            delete_dns_record(rec_id)
            time.sleep(2)

    # 3. Non-existent domain (NXDOMAIN)
    diag_nxdomain_host = "egress-diag-nxdomain-nonexistent.outliner-online.com"
    logger.info(f"Testing non-existent host: {diag_nxdomain_host}")
    dns_obs_nx = record_dns_lookup(diag_nxdomain_host)
    
    wrangler_proc = start_wrangler(
        token=token,
        callback_url=f"https://{diag_nxdomain_host}/egress-check/positive",
        origin=f"https://{diag_nxdomain_host}",
        path_prefix="/egress-check"
    )
    try:
        probe_res_nx = run_probe("task-a-diag-nxdomain", token)
        logger.info(f"Observed probe result for NXDOMAIN: {probe_res_nx}")
        results["diag_nxdomain"] = {
            "dns": dns_obs_nx,
            "probe": probe_res_nx,
        }
    finally:
        stop_wrangler(wrangler_proc)

    return results

def run_task_b():
    logger.info("==================================================")
    logger.info("TASK B: Public IP -> Private IP DNS Switch Test")
    logger.info("==================================================")
    
    switch_host = "egress-switch-issue19.outliner-online.com"
    token = secrets.token_hex(32)
    results = {}
    
    # 0. Clean slate check
    existing = list_dns_record(switch_host)
    if existing:
        for r in existing:
            delete_dns_record(r["id"])
        time.sleep(2)
        
    # Step 1: Positive Control Baseline on the temporary hostname
    logger.info(f"Step 1: Positive control baseline on {switch_host}")
    # Add ingress rule to tunnel
    tunnel_rules_with_switch = [
        {"service": "http://127.0.0.1:8790", "hostname": "probe.outliner-online.com"},
        {"service": "http://127.0.0.1:8790", "hostname": switch_host},
        {"service": "http_status:404"}
    ]
    update_tunnel_ingress(tunnel_rules_with_switch)
    time.sleep(2)
    
    # Create CNAME proxied: true
    cname_rec = create_dns_record("CNAME", switch_host, TUNNEL_CNAME_TARGET, proxied=True)
    cname_id = None
    if isinstance(cname_rec, dict) and "id" in cname_rec:
        cname_id = cname_rec["id"]
    else:
        recs = list_dns_record(switch_host)
        if recs:
            cname_id = recs[0]["id"]
            
    wait_for_dns(switch_host)
    time.sleep(3) # wait for tunnel routing and edge cert
    
    # Verify local reachability via tunnel first
    curl_test = subprocess.run([
        "curl", "-s", "-i", "-X", "POST",
        "-H", "Content-Type: application/json",
        "--data", '{"probe":"agent-table-egress","value":"synthetic"}',
        f"https://{switch_host}/egress-check/positive"
    ], capture_output=True, text=True)
    logger.info(f"Step 1: Direct edge test status: {curl_test.stdout.splitlines()[:2] if curl_test.stdout else 'no output'}")
    
    # Start wrangler for positive control
    wrangler_proc = start_wrangler(
        token=token,
        callback_url=f"https://{switch_host}/egress-check/positive",
        origin=f"https://{switch_host}",
        path_prefix="/egress-check"
    )
    try:
        step1_probe = run_probe("switch-step1-positive", token)
        logger.info(f"Step 1: Worker probe result (Positive Control): {step1_probe}")
        results["step1_positive"] = step1_probe
    finally:
        stop_wrangler(wrangler_proc)

    # Step 2: Switch SAME hostname to Private IP (127.0.0.1, proxied: false, TTL 60)
    logger.info(f"Step 2: Switching {switch_host} DNS to 127.0.0.1 (proxied: false, TTL 60)")
    if cname_id:
        delete_dns_record(cname_id)
        time.sleep(2)
    
    a_rec = create_dns_record("A", switch_host, "127.0.0.1", proxied=False, ttl=60)
    a_id = None
    if isinstance(a_rec, dict) and "id" in a_rec:
        a_id = a_rec["id"]
    else:
        recs = list_dns_record(switch_host)
        if recs:
            a_id = recs[0]["id"]
            
    wait_for_dns(switch_host, "127.0.0.1")
    
    # Step 3: Record TTL, cache, DNS response
    logger.info("Step 3: Recording TTL, cache, and DNS responses")
    step3_dns = record_dns_lookup(switch_host)
    logger.info(f"Step 3 DNS jimmy:\n{step3_dns['jimmy.ns.cloudflare.com']}")
    logger.info(f"Step 3 DNS 1.1.1.1:\n{step3_dns['1.1.1.1']}")
    logger.info(f"Step 3 DNS 8.8.8.8:\n{step3_dns['8.8.8.8']}")
    results["step3_dns"] = step3_dns
    
    # Step 4: Send via same sendVerifiedHttps()
    logger.info("Step 4: Executing sendVerifiedHttps() against private IP DNS")
    wrangler_proc = start_wrangler(
        token=token,
        callback_url=f"https://{switch_host}/egress-check/positive",
        origin=f"https://{switch_host}",
        path_prefix="/egress-check"
    )
    try:
        step4_probe = run_probe("switch-step4-private-127", token)
        logger.info(f"Step 4: Worker probe result: {step4_probe}")
        results["step4_private_127"] = step4_probe
    finally:
        stop_wrangler(wrangler_proc)

    # Step 5: Test RFC 1918 switch on same hostname
    logger.info(f"Step 5: Switching {switch_host} to RFC 1918 10.0.0.1")
    if a_id:
        delete_dns_record(a_id)
        time.sleep(2)
    a_rec_10 = create_dns_record("A", switch_host, "10.0.0.1", proxied=False, ttl=60)
    a_id_10 = None
    if isinstance(a_rec_10, dict) and "id" in a_rec_10:
        a_id_10 = a_rec_10["id"]
    else:
        recs = list_dns_record(switch_host)
        if recs:
            a_id_10 = recs[0]["id"]
    wait_for_dns(switch_host, "10.0.0.1")
    
    wrangler_proc = start_wrangler(
        token=token,
        callback_url=f"https://{switch_host}/egress-check/positive",
        origin=f"https://{switch_host}",
        path_prefix="/egress-check"
    )
    try:
        step5_probe = run_probe("switch-step5-private-rfc1918", token)
        logger.info(f"Step 5: Worker probe result (RFC 1918): {step5_probe}")
        results["step5_private_10"] = step5_probe
    finally:
        stop_wrangler(wrangler_proc)
        if a_id_10:
            delete_dns_record(a_id_10)
            time.sleep(2)

    # Step 6: Restoration and verification
    logger.info("Step 6: Restoring DNS and tunnel ingress configuration")
    # restore tunnel
    clean_tunnel_rules = [
        {"service": "http://127.0.0.1:8790", "hostname": "probe.outliner-online.com"},
        {"service": "http_status:404"}
    ]
    update_tunnel_ingress(clean_tunnel_rules)
    time.sleep(2)
    
    # verify DNS cleanup
    post_clean = list_dns_record(switch_host)
    logger.info(f"Step 6: Confirming DNS record {switch_host} is removed: {post_clean}")
    results["step6_cleaned"] = (len(post_clean) == 0)
    
    # verify baseline probe.outliner-online.com still operational
    base_check = subprocess.run([
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "-X", "POST",
        "-H", "Content-Type: application/json",
        "--data", '{"probe":"agent-table-egress","value":"synthetic"}',
        "https://probe.outliner-online.com/egress-check/positive"
    ], capture_output=True, text=True)
    logger.info(f"Step 6: Baseline probe.outliner-online.com status: {base_check.stdout.strip()}")
    results["step6_baseline_healthy"] = (base_check.stdout.strip() == "204")
    
    return results

if __name__ == "__main__":
    task_a_res = run_task_a()
    task_b_res = run_task_b()
    summary = {
        "task_a": task_a_res,
        "task_b": task_b_res
    }
    Path("test-results/egress-results.json").write_text(json.dumps(summary, indent=2))
    logger.info("All tasks completed. Results written to test-results/egress-results.json")


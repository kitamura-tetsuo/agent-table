import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER = "agent-table-pr51-recovery-staging";
const ACCOUNT = "0fbaae27d3ff021bc17109f1493d0b2d";
const LOCAL_URL = "http://localhost/__private_clearance";
const RESULT_HEADER = "X-Private-Clearance-Transport";
const MAX_ENVELOPE_BYTES = 4_096;

class PrivateClearanceTransportError extends Error {}
function requireTransport(value, code) {
  if (!value) throw new PrivateClearanceTransportError(code);
}

async function boundedLifecycle(pending, timeoutMs, code) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new PrivateClearanceTransportError(code)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// This function is also embedded verbatim in the local Worker. All target
// requests are checked on both sides of the loopback transport boundary.
function validEnvelope(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "body,headers,method,url,version" ||
    value.version !== 1 ||
    typeof value.url !== "string" ||
    typeof value.body !== "string" ||
    !Array.isArray(value.headers)
  )
    return false;
  const origin =
    "https://agent-table-pr51-recovery-staging.kitamura-tetsuo.workers.dev";
  const uuid =
    "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
  const session = new RegExp(
    `^__Host-agent_table_session=v1\\.${uuid}\\.${uuid}\\.[A-Za-z0-9_-]{43}$`,
  );
  let url;
  try {
    url = new URL(value.url);
  } catch {
    return false;
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.href !== value.url
  )
    return false;
  const headers = new Map();
  for (const entry of value.headers) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      entry[0] !== entry[0].toLowerCase() ||
      headers.has(entry[0]) ||
      !["cookie", "origin", "sec-fetch-site", "content-type"].includes(
        entry[0],
      ) ||
      /[\r\n]/.test(entry[1])
    )
      return false;
    headers.set(...entry);
  }
  if (value.method === "GET") {
    if (value.body !== "") return false;
    if (["/health", "/guest"].includes(url.pathname))
      return url.search === "" && headers.size === 0;
    if (
      url.pathname !== "/guest/me" &&
      !(
        url.pathname === "/guest/table" &&
        new RegExp(`^\\?table_id=${uuid}$`).test(url.search)
      )
    )
      return false;
    return (
      (url.pathname !== "/guest/me" || url.search === "") &&
      headers.size === 1 &&
      session.test(headers.get("cookie") ?? "")
    );
  }
  if (
    value.method !== "POST" ||
    url.pathname !== "/guest/session" ||
    url.search !== "" ||
    headers.size !== 4 ||
    headers.get("origin") !== origin ||
    headers.get("sec-fetch-site") !== "same-origin" ||
    headers.get("content-type") !== "application/x-www-form-urlencoded"
  )
    return false;
  const form = new URLSearchParams(value.body);
  if ([...form.keys()].sort().join(",") !== "choice,csrf") return false;
  const csrf = form.get("csrf");
  if (!/^[A-Za-z0-9_-]{43}$/.test(csrf ?? "")) return false;
  const cookie = headers.get("cookie");
  const csrfCookie = `__Host-agent_table_csrf=${csrf}`;
  if (form.get("choice") === "new") return cookie === csrfCookie;
  return (
    form.get("choice") === "reuse" &&
    cookie?.startsWith(`${csrfCookie}; `) &&
    session.test(cookie.slice(csrfCookie.length + 2))
  );
}

async function localWorkerFetch(request, env) {
  const resultHeader = "X-Private-Clearance-Transport";
  const rejected = (status = 400) =>
    new Response("Private clearance transport rejected", {
      status,
      headers: { "Cache-Control": "no-store", [resultHeader]: "rejected" },
    });
  let timer;
  let reader;
  try {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/__private_clearance" ||
      url.search ||
      request.headers.has("Origin") ||
      request.headers.has("Cookie") ||
      request.headers.get("Content-Type") !== "application/json" ||
      request.headers.get("X-Private-Clearance-Token") !==
        env.PRIVATE_CLEARANCE_TRANSPORT_TOKEN ||
      !/^[A-Za-z0-9_-]{43}$/.test(env.PRIVATE_CLEARANCE_TRANSPORT_TOKEN ?? "")
    )
      return rejected(403);
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline")), 15_000);
    });
    reader = request.body?.getReader();
    if (!reader) return rejected();
    let length = 0;
    const parts = [];
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > 4_096) return rejected(413);
      parts.push(value);
    }
    clearTimeout(timer);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const envelope = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!validEnvelope(envelope)) return rejected();
    // The HTTPS URL, Origin and browser cookies are constructed inside Workerd,
    // after the local proxy's Origin guard. The security guard stays enabled.
    const response = await env.APPLICATION.fetch(envelope.url, {
      method: envelope.method,
      headers: envelope.headers,
      body: envelope.method === "POST" ? envelope.body : undefined,
      redirect: "manual",
      signal: request.signal,
    });
    const headers = new Headers(response.headers);
    headers.set(resultHeader, "forwarded");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    // Never expose remote binding errors, credentials, or request bodies.
    return rejected(502);
  } finally {
    clearTimeout(timer);
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

const LOCAL_WORKER_SOURCE = [
  `const validEnvelope = ${validEnvelope.toString()};`,
  `const localWorkerFetch = ${localWorkerFetch.toString()};`,
  "export default { fetch: localWorkerFetch };",
].join("\n");

/**
 * Use only the caller's pinned Wrangler 4.158 unstable_dev factory. This starts
 * an ephemeral local Worker with one authenticated remote Service binding; it
 * does not deploy a wrapper or alter the target Worker's configuration.
 * Record this module's SHA-256 with the retry execution provenance.
 */
export async function createPrivateClearanceTransport({ unstable_dev }) {
  requireTransport(
    typeof unstable_dev === "function",
    "private-clearance-transport-factory-required",
  );
  const directory = await mkdtemp(
    join(tmpdir(), "agent-table-clearance-relay-"),
  );
  const path = join(directory, "wrangler.json");
  const script = join(directory, "worker.mjs");
  const token = randomBytes(32).toString("base64url");
  const lifecycle = new AbortController();
  let dev;
  let disposed = false;
  const stop = (runtime) =>
    boundedLifecycle(
      Promise.resolve().then(() => runtime.stop()),
      10_000,
      "private-clearance-transport-dispose-deadline",
    );
  async function dispose() {
    if (disposed) return;
    disposed = true;
    lifecycle.abort();
    try {
      if (dev) await stop(dev);
    } catch {
      throw new PrivateClearanceTransportError(
        "private-clearance-transport-dispose-failed",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    await writeFile(script, LOCAL_WORKER_SOURCE, { flag: "wx", mode: 0o600 });
    await writeFile(
      path,
      JSON.stringify({
        name: "agent-table-private-clearance-relay",
        account_id: ACCOUNT,
        compatibility_date: "2026-11-07",
        workers_dev: false,
        preview_urls: false,
        routes: [],
        vars: { PRIVATE_CLEARANCE_TRANSPORT_TOKEN: token },
        services: [{ binding: "APPLICATION", service: WORKER, remote: true }],
      }),
      { flag: "wx", mode: 0o600 },
    );
    // Wrangler's default keeps this Worker local and permits remote bindings.
    // Explicit local:true instead disables remote Service bindings entirely.
    const starting = Promise.resolve().then(() =>
      unstable_dev(script, {
        config: path,
        envFiles: [],
        ip: "127.0.0.1",
        port: 0,
        inspectorPort: 0,
        localProtocol: "http",
        persist: false,
        inspect: false,
        logLevel: "none",
        experimental: {
          disableExperimentalWarning: true,
          disableDevRegistry: true,
          showInteractiveDevSession: false,
          watch: false,
          enableContainers: false,
          liveReload: false,
        },
      }),
    );
    // A startup timeout must return control to the controller's rollback path.
    // If startup completes late, stop that local process without reusing it.
    void starting
      .then((runtime) => {
        dev = runtime;
        if (disposed) void stop(runtime).catch(() => undefined);
      })
      .catch(() => undefined);
    dev = await boundedLifecycle(
      starting,
      45_000,
      "private-clearance-transport-start-deadline",
    );
    requireTransport(
      dev?.address === "127.0.0.1" &&
        typeof dev.fetch === "function" &&
        typeof dev.stop === "function",
      "private-clearance-transport-invalid-local-runtime",
    );
  } catch {
    await dispose().catch(() => undefined);
    throw new PrivateClearanceTransportError(
      "private-clearance-transport-start-failed",
    );
  }
  const application = {
    async fetch(input, init = {}) {
      let signal;
      let onAbort;
      try {
        requireTransport(!disposed, "private-clearance-transport-disposed");
        requireTransport(
          (typeof input === "string" || input instanceof URL) &&
            init.redirect === "manual" &&
            init.signal instanceof AbortSignal &&
            Object.keys(init).every((key) =>
              ["method", "headers", "body", "redirect", "signal"].includes(key),
            ),
          "private-clearance-transport-invalid-request",
        );
        const envelope = {
          version: 1,
          url: String(input),
          method: init.method ?? "GET",
          headers: [...new Headers(init.headers).entries()],
          body: init.body ?? "",
        };
        requireTransport(
          validEnvelope(envelope),
          "private-clearance-transport-out-of-scope-request",
        );
        const body = JSON.stringify(envelope);
        requireTransport(
          new TextEncoder().encode(body).byteLength <= MAX_ENVELOPE_BYTES,
          "private-clearance-transport-oversized-request",
        );
        signal = AbortSignal.any([init.signal, lifecycle.signal]);
        requireTransport(
          !signal.aborted,
          "private-clearance-transport-aborted",
        );
        const aborted = new Promise((_, reject) => {
          onAbort = () =>
            reject(
              new PrivateClearanceTransportError(
                "private-clearance-transport-aborted",
              ),
            );
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const pending = Promise.resolve().then(() =>
          dev.fetch(LOCAL_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Private-Clearance-Token": token,
            },
            body,
            redirect: "manual",
            signal,
          }),
        );
        void pending
          .then((response) => {
            if (signal.aborted)
              void response.body?.cancel().catch(() => undefined);
          })
          .catch(() => undefined);
        const response = await Promise.race([pending, aborted]);
        if (response.headers.get(RESULT_HEADER) !== "forwarded") {
          void response.body?.cancel().catch(() => undefined);
          throw new PrivateClearanceTransportError(
            `private-clearance-transport-local-response:${response.status}`,
          );
        }
        return response;
      } catch (error) {
        if (error instanceof PrivateClearanceTransportError) throw error;
        throw new PrivateClearanceTransportError(
          "private-clearance-transport-request-failed",
        );
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    },
  };
  return { application, dispose };
}

/**
 * Authenticated-relay HTTPS boundary. Library only: importing does not listen.
 * TLS material/handler are injected by an approved operator entry point.
 * Never logs headers, envelopes, callback URLs, private keys or exceptions.
 */
import https from "node:https";

const MAX_BODY = 32768;
const MAX_CONNECTIONS = 128;
const fixed = (response, status, code) => {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  response.end(JSON.stringify({ code }));
};
const exactlyOne = (request, name) =>
  request.rawHeaders.filter(
    (_, index) =>
      index % 2 === 0 && request.rawHeaders[index].toLowerCase() === name,
  ).length === 1;

export function createRelayHttpsServer({ key, cert, handler }) {
  if (!key || !cert || typeof handler !== "function")
    throw new Error("invalid-listener-configuration");
  let draining = false;
  const sockets = new Set();
  const inflight = new Set();
  const server = https.createServer(
    {
      key,
      cert,
      minVersion: "TLSv1.2",
      maxHeaderSize: 8192,
      requestTimeout: 15000,
      headersTimeout: 5000,
      keepAliveTimeout: 1000,
    },
    (request, response) => {
      if (draining) {
        fixed(response, 503, "unavailable");
        return;
      }
      if (
        request.method !== "POST" ||
        !["/relay/v1", "/relay/v1/status"].includes(request.url)
      ) {
        fixed(response, 404, "unavailable");
        return;
      }
      if (
        ![
          "x-agent-table-caller",
          "x-agent-table-signature",
          "content-type",
        ].every((name) => exactlyOne(request, name)) ||
        request.headers["content-type"] !== "application/json" ||
        request.headers["content-encoding"] !== undefined ||
        request.headers.expect !== undefined
      ) {
        fixed(response, 400, "invalid-request");
        return;
      }
      const callerId = request.headers["x-agent-table-caller"];
      const signature = request.headers["x-agent-table-signature"];
      if (
        typeof callerId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(callerId) ||
        typeof signature !== "string" ||
        signature.length !== 88
      ) {
        fixed(response, 401, "unauthorized");
        return;
      }
      const maxBody = request.url === "/relay/v1/status" ? 1024 : MAX_BODY;
      const length = request.headers["content-length"];
      if (
        length !== undefined &&
        (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maxBody)
      ) {
        fixed(response, 413, "invalid-request");
        return;
      }
      const chunks = [];
      let bytes = 0,
        ended = false;
      const stop = () => {
        ended = true;
        chunks.length = 0;
      };
      request.once("aborted", stop);
      request.once("error", () => {
        stop();
        fixed(response, 400, "invalid-request");
      });
      request.on("data", (chunk) => {
        if (ended) return;
        bytes += chunk.length;
        if (bytes > maxBody) {
          stop();
          fixed(response, 413, "invalid-request");
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      request.once("end", () => {
        if (ended) return;
        ended = true;
        const body = Buffer.concat(chunks);
        chunks.length = 0;
        const task = (async () => {
          try {
            const output = await handler({
              method: "POST",
              path: request.url,
              callerId,
              signature,
              bytes: body,
            });
            if (response.destroyed || response.writableEnded) return;
            const statuses = new Set([
              200, 400, 401, 404, 409, 413, 429, 502, 503,
            ]);
            if (!output || !statuses.has(output.status))
              throw new Error("invalid-handler-output");
            const wire = JSON.stringify(output.body);
            // Bounded base64 callback challenge response, or fixed error metadata.
            if (typeof wire !== "string" || Buffer.byteLength(wire) > 90000)
              throw new Error("invalid-handler-output");
            response.writeHead(output.status, {
              "content-type": "application/json",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            });
            response.end(wire);
          } catch {
            fixed(response, 502, "delivery-failed");
          }
        })();
        inflight.add(task);
        void task.finally(() => inflight.delete(task));
      });
    },
  );
  server.maxRequestsPerSocket = 100;
  server.on("connection", (socket) => {
    if (draining || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  server.on("tlsClientError", () => {}); // Do not emit certificate/endpoint text.
  server.on("checkContinue", (_request, response) =>
    fixed(response, 400, "invalid-request"),
  );
  return {
    server,
    async close(timeoutMs = 15000) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
        throw new Error("invalid-shutdown-timeout");
      draining = true;
      return await new Promise((resolve) => {
        let transportClosed = false;
        const settle = () => {
          if (transportClosed && inflight.size === 0) {
            clearTimeout(timer);
            resolve({ settled: true });
          }
        };
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          resolve({ settled: false });
        }, timeoutMs);
        for (const task of inflight) void task.finally(settle);
        server.close(() => {
          transportClosed = true;
          settle();
        });
        server.closeIdleConnections();
      });
    },
  };
}

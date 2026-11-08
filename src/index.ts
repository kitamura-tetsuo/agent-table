import { handleMcp } from "./mcp/server";

export { GuestDO } from "./objects/guest";
export { TableDO } from "./objects/table";

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Table — Runtime Scaffold</title>
  </head>
  <body>
    <main>
      <h1>Agent Table</h1>
      <p>The Worker runtime is available. Guest admission and private tables are not yet implemented.</p>
    </main>
  </body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }
    if (url.pathname === "/health") {
      return new Response(
        request.method === "HEAD" ? null : JSON.stringify({ status: "ok" }),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
    }
    if (url.pathname === "/") {
      return new Response(request.method === "HEAD" ? null : page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'",
        },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

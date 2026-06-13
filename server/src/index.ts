import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new Hono();

app.use("*", async (c, next) => {
  const t = Date.now();
  await next();
  const ms = Date.now() - t;
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} -> ${c.res.status} (${ms}ms)`);
});

app.route("/api", api);

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

// In a built install (`pnpm build && pnpm start`) the Vite output sits at
// dist/client/ relative to the project root. Serve it from `/` so users hit a
// single port. In dev (tsx watch) the dir doesn't exist yet — Vite's own dev
// server proxies /api here, so this branch just no-ops.
const clientDir = resolve(__dirname, "../../dist/client");
if (existsSync(clientDir)) {
  app.use("/*", serveStatic({ root: clientDir }));
  // SPA fallback — any unknown path that didn't match /api or a static file
  // gets index.html so client-side routing keeps working.
  app.notFound((c) => {
    const indexPath = resolve(clientDir, "index.html");
    if (existsSync(indexPath)) return c.redirect("/");
    return c.text("Not Found", 404);
  });
  console.log(`[server] serving built client from ${clientDir}`);
} else {
  console.log(`[server] no built client at ${clientDir} (dev mode — Vite serves it)`);
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
});

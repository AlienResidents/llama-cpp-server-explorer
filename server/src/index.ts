import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { api } from "./routes.js";

const app = new Hono();

app.use("*", async (c, next) => {
  const t = Date.now();
  await next();
  const ms = Date.now() - t;
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
});

app.route("/api", api);

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
});

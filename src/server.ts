/**
 * The production web server (ROLE=web): Next.js behind a plain Node HTTP server, so the client address is settled
 * before Next sees the request. X-Forwarded-For is believed only from TRUSTED_PROXY (the reverse proxy, Caddy);
 * without it the connection's own address is used and a client-supplied header is replaced.
 */
import { createServer } from "node:http";
import next from "next";
import { parseTrustedProxies, setForwardedFor } from "./lib/client-ip";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const trusted = parseTrustedProxies(process.env.TRUSTED_PROXY);

const app = next({ dev: false, hostname: host, port });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  setForwardedFor(req, trusted);
  void handle(req, res);
});
server.listen(port, host, () => {
  console.log(`Extra Duty web listening on http://${host}:${port}${trusted ? " (trusting X-Forwarded-For from TRUSTED_PROXY)" : ""}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

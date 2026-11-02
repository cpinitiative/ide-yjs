import * as http from "http";
import logger from "./logger";

// Plain http only. In production, Caddy sits in front on :80/:443, handles
// TLS (and renews the certificate itself), and proxies to this port, so the
// app never needs root or access to the certificate files.
const host = process.env.HOST || "localhost";
const port = Number(process.env.PORT || 1234);

export default function createServer(app) {
  const server = http.createServer(app);
  server.listen(port, host, () => {
    logger.info(`running at '${host}' on port ${port}`);
  });
  return server;
}

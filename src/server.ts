import * as dotenv from "dotenv";
import path from "path";

dotenv.config({
  path: path.resolve(__dirname, ".env"),
});

import * as WebSocket from "ws";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
const wss = new WebSocket.Server({ noServer: true });
const setupWSConnection = require("./utils.js").setupWSConnection;

const host = process.env.HOST || "localhost";
const port = process.env.PORT || 1234;

let server;
if (process.env.NODE_ENV === "production") {
  server = https.createServer();

  const readCertsSync = () => {
    return {
      cert: fs.readFileSync(
        "/etc/letsencrypt/live/yjs.usaco.guide/fullchain.pem",
        "utf8"
      ),
      key: fs.readFileSync(
        "/etc/letsencrypt/live/yjs.usaco.guide/privkey.pem",
        "utf8"
      ),
    };
  };

  server = https.createServer(readCertsSync(), (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("okay");
  });
  server.listen(443, () => {
    console.log(
      "https server running on :443. Note that when NODE_ENV is prod, HOST and PORT are ignored"
    );
  });

  let waitForCertAndFullChainToGetUpdatedTooTimeout;
  fs.watch("/etc/letsencrypt/live/yjs.usaco.guide/fullchain.pem", () => {
    clearTimeout(waitForCertAndFullChainToGetUpdatedTooTimeout);
    waitForCertAndFullChainToGetUpdatedTooTimeout = setTimeout(() => {
      server.setSecureContext(readCertsSync());
    }, 1000);
  });
} else {
  server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("okay");
  });

  // @ts-ignore later issue smh
  server.listen(port, host, () => {
    console.log(`running at '${host}' on port ${port}`);
  });
}

wss.on("connection", setupWSConnection);
server.on("upgrade", (request, socket, head) => {
  // You may check auth of request here..
  // See https://github.com/websockets/ws#client-authentication
  /**
   * @param {any} ws
   */
  const handleAuth = (ws) => {
    wss.emit("connection", ws, request);
  };
  wss.handleUpgrade(request, socket, head, handleAuth);
});

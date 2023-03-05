import * as dotenv from "dotenv";
import path from "path";
import express from "express";

dotenv.config({
  path: path.resolve(__dirname, ".env"),
});

import * as WebSocket from "ws";
import createServer from "./server";
import ldb from "./ldb-persistence";
const Y = require("yjs");
const wss = new WebSocket.Server({ noServer: true });
const setupWSConnection = require("./utils.js").setupWSConnection;

const app = express();
app.use(express.json());
const server = createServer(app);

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

app.get("/", (req, res) => {
  res.send("Hello!");
});

app.post("/copyFile", (req, res) => {
  (async () => {
    const { sourceFile, targetFile, securityKey } = req.body;
    if (
      securityKey !== process.env.SECURITY_KEY &&
      process.env.NODE_ENV === "production"
    ) {
      res.status(401).send("Unauthorized");
      return;
    }

    if (!sourceFile.match(/^[a-zA-Z0-9_\-\.]+$/)) {
      res.status(400).send("Invalid source file name");
      return;
    }

    if (!targetFile.match(/^[a-zA-Z0-9_\-\.]+$/)) {
      res.status(400).send("Invalid target file name");
      return;
    }

    const sourceDoc = await ldb.getYDoc(sourceFile);
    if (!sourceDoc.getMap("isInitialized").get("isInitialized")) {
      res.status(400).send("Source file doesn't exist");
      return;
    }

    const targetDoc = await ldb.getYDoc(targetFile);
    if (targetDoc.getMap("isInitialized").get("isInitialized")) {
      res.status(400).send("Target document already exists");
      return;
    }

    await ldb.storeUpdate(targetFile, Y.encodeStateAsUpdate(sourceDoc));

    return res.status(200).send("OK");
  })();
});

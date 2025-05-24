import "./tracer";
import * as dotenv from "dotenv";
import path from "path";
import express from "express";

dotenv.config({
  path: path.resolve(__dirname, ".env"),
});

// Set max event emitter listeners
require("events").EventEmitter.defaultMaxListeners = 100;

import * as WebSocket from "ws";
import createServer from "./server";
import sqlite_persistence from "./sqlite-persistence";
import { dogstatsd } from "./datadog";
import logger from "./logger";
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
      dogstatsd.increment("yjs.api.copy_file", 1, ["result:unauthorized"]);
      res.status(401).send("Unauthorized");
      return;
    }

    if (!sourceFile.match(/^[a-zA-Z0-9_\-\.]+$/)) {
      dogstatsd.increment("yjs.api.copy_file", 1, [
        "result:invalid-source-file-name",
      ]);
      res.status(400).send("Invalid source file name");
      return;
    }

    if (!targetFile.match(/^[a-zA-Z0-9_\-\.]+$/)) {
      dogstatsd.increment("yjs.api.copy_file", 1, [
        "result:invalid-target-file-name",
      ]);
      res.status(400).send("Invalid target file name");
      return;
    }

    const sourceDoc = await sqlite_persistence.loadYDoc(sourceFile);
    if (!sourceDoc.getMap("isInitialized").get("isInitialized")) {
      dogstatsd.increment("yjs.api.copy_file", 1, [
        "result:source-file-doesnt-exist",
      ]);
      res.status(400).send("Source file doesn't exist");
      return;
    }

    const targetDoc = await sqlite_persistence.loadYDoc(targetFile);
    if (targetDoc.getMap("isInitialized").get("isInitialized")) {
      dogstatsd.increment("yjs.api.copy_file", 1, [
        "result:target-file-already-exists",
      ]);
      res.status(400).send("Target document already exists");
      return;
    }

    await sqlite_persistence.storeYDoc(
      targetFile,
      Y.encodeStateAsUpdate(sourceDoc)
    );

    dogstatsd.increment("yjs.api.copy_file", 1, ["result:ok"]);
    return res.status(200).send("OK");
  })();
});

process.on("exit", () => sqlite_persistence.close());
process.on("SIGHUP", () => process.exit(128 + 1));
process.on("SIGINT", () => process.exit(128 + 2));
process.on("SIGTERM", () => process.exit(128 + 15));
process.on("uncaughtException", function (err) {
  logger.error("Caught exception: " + err);
});

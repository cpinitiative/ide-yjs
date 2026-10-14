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
const { setupWSConnection, saveAllDocsSync } = require("./utils.js");

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

// Save open docs before exiting, so restarts (including PM2's
// max_memory_restart) don't lose the last few seconds of edits.
const shutdown = (signal: string, code: number) => {
  const saved = saveAllDocsSync();
  logger.info(`Received ${signal}, saved ${saved} open docs, exiting`);
  process.exit(code);
};

process.on("exit", () => sqlite_persistence.close());
process.on("SIGHUP", () => shutdown("SIGHUP", 128 + 1));
process.on("SIGINT", () => shutdown("SIGINT", 128 + 2));
process.on("SIGTERM", () => shutdown("SIGTERM", 128 + 15));
process.on("uncaughtException", function (err) {
  logger.error("Caught exception: " + err);
});

import path from "path";
import { dogstatsd } from "./datadog";
const Y = require("yjs");
const syncProtocol = require("y-protocols/dist/sync.cjs");
const awarenessProtocol = require("y-protocols/dist/awareness.cjs");

const encoding = require("lib0/dist/encoding.cjs");
const decoding = require("lib0/dist/decoding.cjs");
const map = require("lib0/dist/map.cjs");

const debounce = require("lodash.debounce");

const callbackHandler = require("./callback.js").callbackHandler;
const isCallbackSet = require("./callback.js").isCallbackSet;

const CALLBACK_DEBOUNCE_WAIT = parseInt(
  process.env.CALLBACK_DEBOUNCE_WAIT || "2000"
);
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(
  process.env.CALLBACK_DEBOUNCE_MAXWAIT || "10000"
);

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2; // eslint-disable-line
const wsReadyStateClosed = 3; // eslint-disable-line

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== "false" && process.env.GC !== "0";
import sqlite_persistence from "./sqlite-persistence";
import tracer from "./tracer";

/**
 * @type {Map<string,WSSharedDoc>}
 */
const docs = new Map();
// exporting docs so that others can use it
exports.docs = docs;

// report size of docs map to Datadog once every 2 seconds
setInterval(() => {
  dogstatsd.gauge("yjs.doc_map_size", docs.size);
}, 2000);

const messageSync = 0;
const messageAwareness = 1;
// const messageAuth = 2
const messageSaved = 100;

/**
 * @param {Uint8Array} update
 * @param {any} origin
 * @param {WSSharedDoc} doc
 */
const updateHandler = (update, origin, doc) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};

class WSSharedDoc extends Y.Doc {
  /**
   * @param {string} name
   */
  constructor(name) {
    super({ gc: gcEnabled });
    this.name = name;
    /**
     * Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
     * @type {Map<Object, Set<number>>}
     */
    this.conns = new Map();
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);
    /**
     * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
     * @param {Object | null} conn Origin is the connection that made the change
     */
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed);
      if (conn !== null) {
        const connControlledIDs =
          /** @type {Set<number>} */ this.conns.get(conn);
        if (connControlledIDs !== undefined) {
          added.forEach((clientID) => {
            connControlledIDs.add(clientID);
          });
          removed.forEach((clientID) => {
            connControlledIDs.delete(clientID);
          });
        }
      }
      // broadcast awareness update
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      const buff = encoding.toUint8Array(encoder);
      this.conns.forEach((_, c) => {
        send(this, c, buff);
      });
    };
    this.awareness.on("update", awarenessChangeHandler);
    this.on("update", updateHandler);
    if (isCallbackSet) {
      this.on(
        "update",
        debounce(callbackHandler, CALLBACK_DEBOUNCE_WAIT, {
          maxWait: CALLBACK_DEBOUNCE_MAXWAIT,
        })
      );
    }
  }

  private throttledPersistDoc: any | null = null;

  bindDocToPersistence = async (docName) => {
    const persistedYdoc = await tracer.trace(
      "get_doc",
      { resource: "doc" },
      () => {
        return sqlite_persistence.loadYDoc(docName);
      }
    );
    // const newUpdates = Y.encodeStateAsUpdate(ydoc);
    // ldb.storeUpdate(docName, newUpdates);

    Y.applyUpdate(this, Y.encodeStateAsUpdate(persistedYdoc));

    // Wait for two seconds of inactivity before persisting
    // Persist at least every 5 seconds
    this.throttledPersistDoc = debounce(
      () => {
        sqlite_persistence.storeYDoc(docName, this);

        // Send message saying doc was saved
        this.conns.forEach((_, c) => {
          send(this, c, new Uint8Array([messageSaved]));
        });
      },
      2000,
      {
        maxWait: 5000,
      }
    );

    this.on("update", (_update) => {
      this.throttledPersistDoc();
    });
  };

  saveDoc = async () => {
    if (!this.throttledPersistDoc) {
      console.error("Called saveDoc before bindDocToPersistence");
      return;
    }
    this.throttledPersistDoc?.flush();
  };
}

/**
 * Gets a Y.Doc by name, whether in memory or on disk
 *
 * @param {string} docname - the name of the Y.Doc to find or create
 * @param {boolean} gc - whether to allow gc on the doc (applies only when created)
 * @return {doc: WSSharedDoc, docLoadedPromise: Promise<any>|null} docLoadedPromise resolves then leveldb loaded the doc
 */
const getYDoc = (
  docname,
  gc = true
): {
  doc: WSSharedDoc;
  docLoadedPromise: Promise<any> | null;
} => {
  let doc = docs.get(docname);
  let docLoadedPromise = null;
  if (doc === undefined) {
    doc = new WSSharedDoc(docname);
    doc.gc = gc;

    // we need await here to load the doc from the persisted disk
    // before syncing the doc to the user
    docLoadedPromise = doc.bindDocToPersistence(docname);
    docs.set(docname, doc);
  }
  // todo: I think docLoadedPromise also needs to be put into the docs map
  return { doc, docLoadedPromise };
};

/**
 * @param {any} conn
 * @param {WSSharedDoc} doc
 * @param {Uint8Array} message
 */
const messageListener = (conn, doc, message) => {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);

        // If the `encoder` only contains the type of reply message and no
        // message, there is no need to send the message. When `encoder` only
        // contains the type of reply, its length is 1.
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;
      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
        break;
      }
    }
  } catch (err) {
    console.error(err);
    doc.emit("error", [err]);
  }
};

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    /**
     * @type {Set<number>}
     */
    // @ts-ignore
    const controlledIds = doc.conns.get(conn);
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(controlledIds),
      null
    );
    if (doc.conns.size === 0) {
      // if persisted, we store state and destroy ydocument
      const persistStartTime = Date.now();
      doc.saveDoc().then(() => {
        const persistEndTime = Date.now();
        dogstatsd.distribution(
          "yjs.persist_doc_duration",
          persistEndTime - persistStartTime
        );
        const docSize = Y.encodeStateAsUpdate(doc).byteLength;
        dogstatsd.distribution("yjs.doc_size", docSize);
        doc.destroy();
      });
      docs.delete(doc.name);
    }
  }
  conn.close();
};

/**
 * @param {WSSharedDoc} doc
 * @param {any} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
  if (
    conn.readyState !== wsReadyStateConnecting &&
    conn.readyState !== wsReadyStateOpen
  ) {
    closeConn(doc, conn);
  }
  try {
    conn.send(
      m,
      /** @param {any} err */ (err) => {
        err != null && closeConn(doc, conn);
      }
    );
  } catch (e) {
    closeConn(doc, conn);
  }
};

const pingTimeout = 30000;

/**
 * @param {any} conn
 * @param {any} req
 * @param {any} opts
 */
exports.setupWSConnection = (
  conn,
  req,
  { docName = req.url.slice(1).split("?")[0], gc = true } = {}
) => {
  tracer.trace("ws.connection", { resource: docName }, () => {
    dogstatsd.increment("yjs.ws_connection", 1);
    const requestStartTime = Date.now();

    conn.binaryType = "arraybuffer";
    // get doc, initialize if it does not exist yet
    const { doc, docLoadedPromise } = getYDoc(docName, gc);
    doc.conns.set(conn, new Set());

    // it might take some time to load the doc from leveldb
    // but before then we still need to listen for websocket events
    let isDocLoaded = docLoadedPromise ? false : true;
    let queuedMessages: Uint8Array[] | null = [];
    let isConnectionAlive = true;

    // listen and reply to events
    conn.on(
      "message",
      /** @param {ArrayBuffer} message */ (message) => {
        if (isDocLoaded) messageListener(conn, doc, new Uint8Array(message));
        else queuedMessages!.push(new Uint8Array(message));
      }
    );

    // Check if connection is still alive
    let pongReceived = true;
    const pingInterval = setInterval(() => {
      if (!pongReceived) {
        if (doc.conns.has(conn)) {
          closeConn(doc, conn);
          isConnectionAlive = false;
        }
        clearInterval(pingInterval);
      } else if (doc.conns.has(conn)) {
        pongReceived = false;
        try {
          conn.ping();
        } catch (e) {
          closeConn(doc, conn);
          isConnectionAlive = false;
          clearInterval(pingInterval);
        }
      }
    }, pingTimeout);
    conn.on("close", () => {
      closeConn(doc, conn);
      isConnectionAlive = false;
      clearInterval(pingInterval);
    });
    conn.on("pong", () => {
      pongReceived = true;
    });

    // put the following in a variables in a block so the interval handlers don't keep in in
    // scope
    const sendSyncStep1 = () => {
      // send sync step 1
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeSyncStep1(encoder, doc);
      send(doc, conn, encoding.toUint8Array(encoder));
      const awarenessStates = doc.awareness.getStates();
      if (awarenessStates.size > 0) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(
            doc.awareness,
            Array.from(awarenessStates.keys())
          )
        );
        send(doc, conn, encoding.toUint8Array(encoder));
      }
    };

    if (docLoadedPromise) {
      return tracer
        .trace("load_doc", { resource: "doc" }, () => docLoadedPromise)
        .then(() => {
          if (!isConnectionAlive) return;
          const docLoadedTime = Date.now();
          const duration = docLoadedTime - requestStartTime;
          dogstatsd.distribution("yjs.doc_load_time", duration);

          isDocLoaded = true;
          queuedMessages!.forEach((message) =>
            messageListener(conn, doc, message)
          );
          queuedMessages = null;
          sendSyncStep1();
        });
    }
    // todo: else we should still send sync step 1
  });
};

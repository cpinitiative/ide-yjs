// End-to-end smoke test: builds nothing itself, run `npm run build` first
// (`npm test` does both).
//
// Runs dist/ from a temporary directory so the server's database
// (../yjs.db relative to dist) and logs never touch the real ones, starts it
// on a free port, then checks that two websocket clients sync edits, that
// docs persist across a restart, and that /copyFile works.
const { test } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const WebSocket = require("ws");
const Y = require("yjs");
const syncProtocol = require("y-protocols/dist/sync.cjs");
const encoding = require("lib0/dist/encoding.cjs");
const decoding = require("lib0/dist/decoding.cjs");

const repoRoot = path.join(__dirname, "..");
const messageSync = 0;

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (fn, what, timeout = 10000) => {
  const start = Date.now();
  for (;;) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {}
    if (Date.now() - start > timeout) throw new Error("Timed out: " + what);
    await sleep(50);
  }
};

const makeSandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-yjs-test-"));
  fs.cpSync(path.join(repoRoot, "dist"), path.join(dir, "dist"), {
    recursive: true,
  });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(dir, "node_modules"),
    "dir"
  );
  return dir;
};

const startServer = async (dir, port) => {
  const child = spawn(process.execPath, [path.join(dir, "dist/index.js")], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      DD_TRACE_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.output = () => output;
  await waitFor(async () => {
    if (child.exitCode !== null)
      throw new Error("server exited early:\n" + output);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    return (await res.text()) === "Hello!";
  }, "server to start");
  return child;
};

const stopServer = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on("exit", resolve);
    child.kill("SIGTERM");
  });

// A minimal y-websocket client: syncs a Y.Doc with the server.
const connect = (port, docName) =>
  new Promise((resolve, reject) => {
    const doc = new Y.Doc();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${docName}`);
    ws.binaryType = "arraybuffer";
    let synced = false;
    ws.on("message", (data) => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(decoder);
      if (type !== messageSync) return; // awareness / saved messages
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      const syncType = syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      if (syncType === syncProtocol.messageYjsSyncStep2 && !synced) {
        synced = true;
        resolve({ doc, ws });
      }
    });
    ws.on("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeSyncStep1(encoder, doc);
      ws.send(encoding.toUint8Array(encoder));
    });
    ws.on("error", reject);
    doc.on("update", (update, origin) => {
      if (origin === ws) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      ws.send(encoding.toUint8Array(encoder));
    });
  });

const close = ({ ws }) =>
  new Promise((resolve) => {
    ws.on("close", resolve);
    ws.close();
  });

test("server syncs, persists and copies docs", async (t) => {
  const dir = makeSandbox();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await getFreePort();

  let server = await startServer(dir, port);
  t.after(() => stopServer(server));

  // A new .cpp doc starts with the default template
  const a = await connect(port, "smoke.cpp");
  const textA = a.doc.getText("monaco");
  await waitFor(
    () => textA.toString().includes("usaco.guide"),
    "default code to load"
  );

  // Edits from one client reach another
  const b = await connect(port, "smoke.cpp");
  textA.insert(0, "// hello from a\n");
  const textB = b.doc.getText("monaco");
  await waitFor(
    () => textB.toString().startsWith("// hello from a\n"),
    "edit to reach client b"
  );
  b.doc.getText("monaco").insert(0, "// hello from b\n");
  await waitFor(
    () => textA.toString().startsWith("// hello from b\n"),
    "edit to reach client a"
  );
  const expected = textA.toString();

  // Closing the last connection saves the doc
  await close(a);
  await close(b);
  await sleep(500);

  // Docs survive a restart
  await stopServer(server);
  server = await startServer(dir, port);
  const c = await connect(port, "smoke.cpp");
  await waitFor(
    () => c.doc.getText("monaco").toString() === expected,
    "doc to load after restart"
  );
  await close(c);
  await sleep(500);

  // /copyFile copies an existing doc and rejects bad input
  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/copyFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  let res = await post({ sourceFile: "smoke.cpp", targetFile: "copy.cpp" });
  assert.strictEqual(res.status, 200, await res.text());
  res = await post({ sourceFile: "smoke.cpp", targetFile: "copy.cpp" });
  assert.strictEqual(res.status, 400);
  res = await post({ sourceFile: "../etc", targetFile: "x.cpp" });
  assert.strictEqual(res.status, 400);
  res = await post({ sourceFile: "missing.cpp", targetFile: "y.cpp" });
  assert.strictEqual(res.status, 400);
  res = await post({});
  assert.strictEqual(res.status, 400);
  res = await fetch(`http://127.0.0.1:${port}/copyFile`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not json",
    signal: AbortSignal.timeout(3000),
  });
  assert.strictEqual(res.status, 400);

  const d = await connect(port, "copy.cpp");
  await waitFor(
    () => d.doc.getText("monaco").toString() === expected,
    "copied doc to match"
  );
  await close(d);

  assert.ok(server.exitCode === null, "server crashed:\n" + server.output());
});

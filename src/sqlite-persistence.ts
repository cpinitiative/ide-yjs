import * as Y from "yjs";
import Database from "better-sqlite3";
import path from "path";
import tracer from "./tracer";

const db = new Database(path.join(__dirname, "../yjs.db"));

db.pragma("journal_mode = WAL");

db.exec("CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BLOB)");

const getStmt = db.prepare("SELECT data FROM files WHERE name = ?");
const insertStmt = db.prepare(
  "INSERT OR REPLACE INTO files (name, data) VALUES (?, ?)"
);

const sqlite_persistence = {
  loadYDoc: async (docName: string) => {
    return await tracer.trace("load_y_doc", { resource: docName }, async () => {
      const file = await tracer.trace(
        "get_from_sqlite",
        { resource: docName },
        () => getStmt.get(docName)
      );
      const ydoc = new Y.Doc();
      if (file) {
        Y.applyUpdate(ydoc, file.data);
      }
      return ydoc;
    });
  },
  // ydoc_state is Y.encodeStateAsUpdate(ydoc)
  storeYDoc: async (docName: string, ydoc_state: any) => {
    insertStmt.run(docName, ydoc_state);
  },
  close: () => {
    db.close();
  },
};

export default sqlite_persistence;

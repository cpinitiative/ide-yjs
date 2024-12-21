import * as Y from "yjs";
import Database from "better-sqlite3";
import path from "path";
import ldb from "./ldb-persistence";
import tracer from "./tracer";

const db = new Database(path.join(__dirname, "../yjs.db"));

db.pragma("journal_mode = WAL");

db.exec("CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BLOB)");

const getStmt = db.prepare("SELECT data FROM files WHERE name = ?");
const insertStmt = db.prepare(
  "INSERT OR REPLACE INTO files (name, data) VALUES (?, ?)"
);

setTimeout(() => {
  console.log("Beginning to convert ldb to sqlite");
  ldb.getLdb().then((real_ldb) => {
    ldb.getAllDocNames().then(async (names) => {
      names = names.filter(
        (name) =>
          name.endsWith(".cpp") ||
          name.endsWith(".py") ||
          name.endsWith(".java") ||
          name.endsWith(".scribble") ||
          name.endsWith(".input")
      );

      console.log("Received ", names.length, " names");

      for (let i = 0; i < names.length; i++) {
        if (getStmt.get(names[i])) {
          continue;
        }
        let doc = await ldb.getYDoc(names[i]);
        let update = Y.encodeStateAsUpdate(doc);
        if (update.length > 1024 * 1024 * 10) {
          console.warn("Skipping", names[i], update.length);
        } else {
          insertStmt.run(names[i], update);
        }
        if (i % 1000 === 0) {
          console.log(i, names.length);
        }
      }
      console.log("Done converting ldb to sqlite");
    });
  });
}, 5000);

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
      } else {
        // Legacy documents are stored in ldb
        const ldbDoc = await tracer.trace(
          "get_from_ldb",
          { resource: docName },
          () => ldb.getYDoc(docName)
        );
        if (ldbDoc) {
          return ldbDoc;
        }
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

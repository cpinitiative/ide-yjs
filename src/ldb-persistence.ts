import path from "path";
import * as Y from "yjs";

let persistenceDir = process.env.YPERSISTENCE;

if (typeof persistenceDir !== "string") {
  throw new Error("process.env.YPERSISTENCE needs to be defined");
}

persistenceDir = path.join(__dirname, persistenceDir);
console.info('Persisting documents to "' + persistenceDir + '"');
// @ts-ignore
const LeveldbPersistence = require("y-leveldb").LeveldbPersistence;
const real_ldb = new LeveldbPersistence(persistenceDir);

const ldb = {
  getYDoc: async (docName: string) => {
    return real_ldb.getYDoc(docName);
  },
  storeUpdate: async (docName: string, update: any, doc: any) => {
    real_ldb.storeUpdate(docName, update);
  },
};

export default ldb;

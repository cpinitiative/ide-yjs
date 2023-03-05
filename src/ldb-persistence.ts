import path from "path";

let persistenceDir = process.env.YPERSISTENCE;

if (typeof persistenceDir !== "string") {
  throw new Error("process.env.YPERSISTENCE needs to be defined");
}

persistenceDir = path.join(__dirname, persistenceDir);
console.info('Persisting documents to "' + persistenceDir + '"');
// @ts-ignore
const LeveldbPersistence = require("y-leveldb").LeveldbPersistence;
const ldb = new LeveldbPersistence(persistenceDir);

export default ldb;

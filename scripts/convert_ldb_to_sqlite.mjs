import * as Y from "yjs";
import path from "path";
import level from "level";

import * as encoding from 'lib0/encoding.js'
import * as decoding from 'lib0/decoding.js'

import * as yLeveldb from 'y-leveldb'

const LeveldbPersistence = yLeveldb.LeveldbPersistence;

const YEncodingString = 0
const YEncodingUint32 = 1

const valueEncoding = {
  buffer: true,
  type: 'y-value',
  encode: /** @param {any} data */ data => data,
  decode: /** @param {any} data */ data => data
}

const keyEncoding = {
  buffer: true,
  type: 'y-keys',
  /* istanbul ignore next */
  encode: /** @param {Array<string|number>} arr */  arr => {
    const encoder = encoding.createEncoder()
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]
      if (typeof v === 'string') {
        encoding.writeUint8(encoder, YEncodingString)
        encoding.writeVarString(encoder, v)
      } else /* istanbul ignore else */ if (typeof v === 'number') {
        encoding.writeUint8(encoder, YEncodingUint32)
        writeUint32BigEndian(encoder, v)
      } else {
        throw new Error('Unexpected key value')
      }
    }
    return Buffer.from(encoding.toUint8Array(encoder))
  },
  decode: /** @param {Uint8Array} buf */ buf => {
    const decoder = decoding.createDecoder(buf)
    const key = []
    while (decoding.hasContent(decoder)) {
      switch (decoding.readUint8(decoder)) {
        case YEncodingString:
          key.push(decoding.readVarString(decoder))
          break
        case YEncodingUint32:
          key.push(readUint32BigEndian(decoder))
          break
      }
    }
    return key
  }
}

import sqlite from "better-sqlite3";
const db = sqlite(path.join(new URL('.', import.meta.url).pathname, "../yjs.db"));

db.exec("CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, data BLOB)");

const getStmt = db.prepare("SELECT data FROM files WHERE name = ?");
const insertStmt = db.prepare(
  "INSERT OR REPLACE INTO files (name, data) VALUES (?, ?)"
);

(async () => {
  const actualLdb = level(path.join(new URL('.', import.meta.url).pathname, "../ypersistence2/ypersistence"), {
    valueEncoding,
    keyEncoding,
  });
  let keys = [];
  actualLdb.createReadStream(
    {
      gte: ["v1_sv"],
      lt: ["v1_sw"],
      keys: true,
      values: true,
    }
  ).on('data', /** @param {any} data */ data => {
    const key = data.key.toString().substring(6);
    
    if (!key.endsWith(".cpp") && !key.endsWith(".py") && !key.endsWith(".java") && !key.endsWith(".scribble")) return;
    if (!key.startsWith("-")) return;

    keys.push(key);
  }).on('end', () => {
    console.log("done");
    actualLdb.close().then(() => {
      const ldb = new LeveldbPersistence(path.join(new URL('.', import.meta.url).pathname, "../ypersistence2/ypersistence"));

      for (let i = 0; i < keys.length; i++) {
        ldb.getYDoc(keys[i]).then(doc => {
          let update = Y.encodeStateAsUpdate(doc);
          if (update.length > 1024 * 1024 * 10) {
            console.warn("Skipping", keys[i], update.length);
          } else {
            insertStmt.run(keys[i], update);
          }
          if (i % 1000 === 0) {
            console.log(i, keys.length);
          }
        });
      }
    });
  }).on('error', e => {
    console.error(e)
  })
})();

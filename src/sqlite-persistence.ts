import * as Y from "yjs";

const sqlite_persistence = {
  loadYDoc: async (docName: string) => {
    console.log("loadYDoc", docName);
    const ydoc = new Y.Doc();
    return ydoc;
  },
  storeYDoc: async (docName: string, doc: any) => {
    console.log("storeYDoc", docName, Y.encodeStateAsUpdate(doc));
  },
};

export default sqlite_persistence;

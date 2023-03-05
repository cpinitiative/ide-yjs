import * as http from "http";
import * as https from "https";
import * as fs from "fs";

const host = process.env.HOST || "localhost";
const port = process.env.PORT || 1234;

export default function createServer(app) {
  let server;
  if (process.env.NODE_ENV === "production") {
    const readCertsSync = () => {
      return {
        cert: fs.readFileSync(
          "/etc/letsencrypt/live/yjs.usaco.guide/fullchain.pem",
          "utf8"
        ),
        key: fs.readFileSync(
          "/etc/letsencrypt/live/yjs.usaco.guide/privkey.pem",
          "utf8"
        ),
      };
    };

    server = https.createServer(readCertsSync(), app);
    server.listen(443, () => {
      console.log(
        "https server running on :443. Note that when NODE_ENV is prod, HOST and PORT are ignored"
      );
    });

    let waitForCertAndFullChainToGetUpdatedTooTimeout;
    fs.watch("/etc/letsencrypt/live/yjs.usaco.guide/fullchain.pem", () => {
      clearTimeout(waitForCertAndFullChainToGetUpdatedTooTimeout);
      waitForCertAndFullChainToGetUpdatedTooTimeout = setTimeout(() => {
        server.setSecureContext(readCertsSync());
      }, 1000);
    });
  } else {
    server = http.createServer(app);

    // @ts-ignore later issue smh
    server.listen(port, host, () => {
      console.log(`running at '${host}' on port ${port}`);
    });
  }
  return server;
}

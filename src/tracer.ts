// server.ts
import "./tracer"; // must come before importing any instrumented module.

// tracer.ts
import tracer from "dd-trace";
tracer.init({
  service: "yjs",
}); // initialized in a different file to avoid hoisting.
export default tracer;

// Node HTTP server — for local dev and Scaleway Serverless Containers.
//
// Serves precomputed files from a local directory (default ./data) when present,
// and the dynamic/meta routes otherwise. Run the pipeline (bin/pipeline.js) to
// populate ./data, or rely on the dynamic /v1/last-hour/<CODE> endpoint.

import { createServer } from "node:http";
import { handleRequest } from "./src/handler.js";
import { fsStore } from "./src/storage.js";

const DEFAULT_PORT = 8000;
const HTTP_INTERNAL_ERROR = 500;

const PORT = Number(process.env.PORT || DEFAULT_PORT);
const DATA_DIR = process.env.DATA_DIR || "data";
const store = fsStore(DATA_DIR);

const server = createServer(async (req, res) => {
  try {
    const request = new Request(new URL(req.url, `http://localhost:${PORT}`), { method: req.method });
    const response = await handleRequest(request, process.env, store);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (err) {
    // The error text goes to the log, not to the caller. String(err) carries a
    // stack frame and the filesystem paths in it, which describes the
    // deployment to anyone who can provoke a 500 and gives them back nothing
    // they are owed (CodeQL js/stack-trace-exposure).
    console.error("carbon-intensity-api: unhandled request error:", err);
    res.writeHead(HTTP_INTERNAL_ERROR, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Internal error." }));
  }
});

server.listen(PORT, () => console.error(`carbon-intensity-api listening on :${PORT}`));

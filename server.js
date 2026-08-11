// Node HTTP server — for local dev and Scaleway Serverless Containers.
//
// Serves precomputed files from a local directory (default ./data) when present,
// and the dynamic/meta routes otherwise. Run the pipeline (bin/pipeline.js) to
// populate ./data, or rely on the dynamic /v1/last-hour/<CODE> endpoint.

import { createServer } from "node:http";
import { handleRequest } from "./src/handler.js";
import { fsStore } from "./src/storage.js";

const PORT = Number(process.env.PORT || 8000);
const DATA_DIR = process.env.DATA_DIR || "data";
const store = fsStore(DATA_DIR);

const server = createServer(async (req, res) => {
  try {
    const request = new Request(new URL(req.url, `http://localhost:${PORT}`), { method: req.method });
    const response = await handleRequest(request, process.env, store);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: String(err) }));
  }
});

server.listen(PORT, () => console.error(`carbon-intensity-api listening on :${PORT}`));

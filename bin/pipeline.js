#!/usr/bin/env node
// Pipeline runner: build the snapshot and write v1/latest.json plus per-country
// files (v1/last-hour/<CODE>, no extension) under a directory.
//
//   node bin/pipeline.js [--out data] [--no-live]

import { buildSnapshot, writeAll } from "../src/pipeline.js";
import { fsStore } from "../src/storage.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = arg("--out", "data");
const useLive = !process.argv.includes("--no-live");

const snapshot = await buildSnapshot({ useLive, env: process.env });
const out = fsStore(outDir);
const { written, skipped } = await writeAll(snapshot, out.put, out.get);
console.error(
  `wrote ${outDir}/latest.json + ${written} files (${skipped} annual unchanged) — `
  + `${snapshot.count} countries, ${snapshot.measured_count} measured, `
  + `generated_at=${snapshot.generated_at}`,
);

// mtime is load-bearing: `aws s3 sync` re-uploads whatever looks newer than its
// object, so rewriting a file with the bytes it already had costs a billable R2
// operation for nothing. These pin that put() leaves such a file alone — and
// still writes when the bytes differ, which is the half that must not regress.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fsStore } from "../src/storage.js";

async function scratch() {
  return await mkdtemp(join(tmpdir(), "storage-test-"));
}

test("put leaves the file untouched when the bytes are identical", async () => {
  const dir = await scratch();
  try {
    const store = fsStore(dir);
    await store.put("v2/IT/history/2026-09-10", "same");
    const before = await stat(join(dir, "v2/IT/history/2026-09-10"));

    // Back-date it: an unconditional write would stamp it "now" and the sync
    // would ship it again.
    const old = new Date(0);
    await (await import("node:fs/promises")).utimes(join(dir, "v2/IT/history/2026-09-10"), old, old);

    await store.put("v2/IT/history/2026-09-10", "same");
    const after = await stat(join(dir, "v2/IT/history/2026-09-10"));

    assert.equal(after.mtimeMs, old.getTime(), "identical content must not be rewritten");
    assert.ok(before.mtimeMs > after.mtimeMs, "sanity: the back-date took");
    assert.equal(await store.get("v2/IT/history/2026-09-10"), "same");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("put still writes when the bytes differ, and creates missing parents", async () => {
  const dir = await scratch();
  try {
    const store = fsStore(dir);
    await store.put("v1/latest.json", '{"intensity":412}');
    // Same length, different value — the case --size-only would miss, so this
    // one has to reach the disk.
    await store.put("v1/latest.json", '{"intensity":398}');
    assert.equal(await store.get("v1/latest.json"), '{"intensity":398}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

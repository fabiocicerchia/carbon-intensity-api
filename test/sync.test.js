// The two sync passes want opposite comparisons, and getting either backwards
// is invisible until the bill or the data goes wrong. Closed days are immutable,
// so --size-only there stops ~7k pointless re-uploads an hour; the mutable pass
// must NOT have it, or a reading that changes without changing length never
// reaches the bucket.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Command lines only — `aws s3 sync` is named in the comments too. Each pass is
// one backslash-continued command, so unfold before splitting.
const passes = readFileSync(new URL("../sync.sh", import.meta.url), "utf8")
  .replace(/\\\n\s*/g, " ")
  .split("\n")
  .filter((line) => line.startsWith("aws s3 sync"));

test("the mutable pass compares content, the closed-day pass compares size", () => {
  assert.equal(passes.length, 2, "expected exactly two sync passes");
  const [mutable, closed] = passes;
  assert.ok(!mutable.includes("--size-only"), "mutable pass must not skip same-size changes");
  assert.ok(closed.includes("--size-only"), "closed-day pass re-uploads the whole history without --size-only");
});

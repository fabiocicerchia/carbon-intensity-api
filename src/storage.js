// Storage adapter: { get(path), put(path, body) }.
//
// Filesystem only: nothing runs in front of the bucket — it is served directly,
// and the pipeline writes to a directory that is synced into it.

export function fsStore(baseDir) {
  return {
    async get(path) {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        return await readFile(join(baseDir, path), "utf8");
      } catch {
        return null;
      }
    },
    async put(path, body) {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join, dirname } = await import("node:path");
      const full = join(baseDir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body, "utf8");
    },
    // Retention deletes expired history days. Swallowing the miss like `get`
    // does keeps pruning idempotent: it is issued blind against a range of
    // dates, most of which are already gone.
    async del(path) {
      const { unlink } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        await unlink(join(baseDir, path));
        return true;
      } catch {
        return false;
      }
    },
  };
}

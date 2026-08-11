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
  };
}

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const injection = vi.hoisted(() => ({ target: "", grow: false }));
// Deterministically schedule a real competing append after the first descriptor
// read. All filesystem operations are real; only the race timing is controlled.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (args[0] !== injection.target) return handle;
    return {
      stat: handle.stat.bind(handle), close: handle.close.bind(handle),
      read: async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await handle.read(...readArgs);
        if (injection.grow) { injection.grow = false; await fs.appendFile(injection.target, "more bytes beyond the limit"); }
        return result;
      },
    };
  } };
});

it("bounds a file that grows after the initial stat and during descriptor reads", async () => {
  const { snapshot } = await import("../src/pipeline.js");
  const folder = await mkdtemp(path.join(tmpdir(), "snapshot-growth-"));
  injection.target = path.join(folder, "growing.png"); await writeFile(injection.target, "ok"); injection.grow = true;
  await expect(snapshot(injection.target, 4)).rejects.toThrow("exceeds 4 bytes");
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FolderWatcher, retryDelay, sameVersion } from "../src/watch.js";

describe("stable watch versions and retry policy", () => {
  it("compares content as well as size/times and bounds retry backoff", () => {
    const a = { size: 4, mtimeMs: 1, ctimeMs: 1, hash: "a" };
    expect(sameVersion(a, { ...a })).toBe(true);
    expect(sameVersion(a, { ...a, hash: "b" })).toBe(false);
    expect([1, 2, 3].map((n) => retryDelay(n, 10))).toEqual([10, 20, 40]);
  });
  it("requires a stable interval, retries up to the limit, and resets on changed content", async () => {
    const inbox = await mkdtemp(path.join(tmpdir(), "watch-unit-"));
    const file = path.join(inbox, "scan.png"); await writeFile(file, "part");
    let now = 0; let calls = 0; const errors: boolean[] = [];
    const watcher = new FolderWatcher(inbox, { now: () => now, stableMs: 100, retryMs: 20, maxAttempts: 2,
      process: async () => { calls++; throw new Error("broken"); }, onError: (_f, _e, permanent) => errors.push(permanent) });
    await watcher.sweep(); now = 99; await watcher.sweep(); expect(calls).toBe(0);
    await writeFile(file, "complete"); await watcher.sweep(); now = 198; await watcher.sweep(); expect(calls).toBe(0);
    now = 199; await watcher.sweep(); expect(calls).toBe(1);
    now = 218; await watcher.sweep(); expect(calls).toBe(1);
    now = 219; await watcher.sweep(); expect(calls).toBe(2);
    now = 1000; await watcher.sweep(); expect(calls).toBe(2); expect(errors).toEqual([false, true]);
    await writeFile(file, "new bytes"); await watcher.sweep(); now = 1100; await watcher.sweep(); expect(calls).toBe(3);
  });
  it("shares concurrent sweeps and never overlaps processing", async () => {
    const inbox = await mkdtemp(path.join(tmpdir(), "watch-serial-"));
    await writeFile(path.join(inbox, "scan.png"), "bytes");
    let now = 0; let calls = 0; let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const watcher = new FolderWatcher(inbox, { now: () => now, stableMs: 1, process: async () => { calls++; await blocked; }, onError: () => {} });
    await watcher.sweep(); now = 2;
    const a = watcher.sweep(); const b = watcher.sweep(); expect(a).toBe(b);
    release(); await Promise.all([a, b]); expect(calls).toBe(1);
  });
});

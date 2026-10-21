import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { recognize } from "../src/ocr.js";
import { processFile } from "../src/pipeline.js";
import { FolderWatcher } from "../src/watch.js";

async function waitFor(check: () => Promise<boolean>, timeout = 15_000): Promise<void> {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out waiting for watch outcome"); await delay(20); }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "watch-integration-"));
  const inbox = path.join(root, "inbox"); const out = path.join(root, "out"); await mkdir(inbox);
  return { root, inbox, out };
}
async function audit(out: string): Promise<any[]> {
  try { return (await readFile(path.join(out, "audit.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}
const sample = path.resolve("samples/northwind-multipage.pdf");

describe("watched-folder integration", () => {
  it("runs the real CLI through delayed writes, reused filenames and bounded observable permanent failure", async () => {
    const f = await fixture();
    const child = spawn(process.execPath, [path.resolve("dist/cli.js"), f.inbox, "--out", f.out, "--watch", "--poll-ms", "30", "--stable-ms", "200", "--retry-ms", "40", "--max-attempts", "2"], { windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (s) => { stdout += String(s); }); child.stderr.on("data", (s) => { stderr += String(s); });
    const closed = new Promise<void>((resolve, reject) => { child.on("close", () => resolve()); child.on("error", reject); });
    try {
      await waitFor(async () => stdout.includes("watching"));
      const bytes = await readFile(sample); const source = path.join(f.inbox, "drop.pdf");
      await writeFile(source, bytes.subarray(0, 100)); await delay(80);
      expect(await audit(f.out)).toEqual([]);
      await writeFile(source, bytes);
      await waitFor(async () => (await audit(f.out)).length === 1);
      expect((await audit(f.out))[0].outcome).toBe("filed");
      await writeFile(source, Buffer.concat([bytes, Buffer.from("\n% reused filename changed content\n")]));
      await waitFor(async () => (await audit(f.out)).length === 2);
      expect((await audit(f.out)).filter((e) => e.outcome === "review")).toHaveLength(1);
      await writeFile(path.join(f.inbox, "broken.pdf"), "not a pdf");
      await waitFor(async () => stderr.includes("error permanent  broken.pdf attempt=2"));
      const entries = await audit(f.out); expect(entries).toHaveLength(4);
      await delay(300); expect(await audit(f.out)).toHaveLength(4);
      expect(stderr).toContain("retry  broken.pdf attempt=1");
    } finally { child.kill("SIGTERM"); await closed; }
  });

  it("retries a transient extraction failure and serializes real filesystem processing", async () => {
    const f = await fixture(); await copyFile(sample, path.join(f.inbox, "a.pdf")); await copyFile(sample, path.join(f.inbox, "b.pdf"));
    let active = 0; let peak = 0; let calls = 0; const errors: boolean[] = [];
    const watcher = new FolderWatcher(f.inbox, { stableMs: 20, retryMs: 10, maxAttempts: 3,
      process: async (file) => {
        active++; peak = Math.max(peak, active);
        try {
          await delay(30);
          return await processFile(file, { outRoot: f.out, ocr: async (snapshot) => {
            calls++; if (calls === 1) throw new Error("transient image decoder unavailable");
            return recognize(snapshot);
          } });
        } finally { active--; }
      }, onError: (_file, _error, permanent) => errors.push(permanent),
    });
    await watcher.sweep(); await delay(25);
    await Promise.all(Array.from({ length: 12 }, () => watcher.sweep()));
    await delay(20); await Promise.all(Array.from({ length: 12 }, () => watcher.sweep()));
    const entries = await audit(f.out);
    expect(errors).toEqual([false]); expect(calls).toBe(3); expect(peak).toBe(1);
    expect(entries.map((e) => e.outcome).sort()).toEqual(["error", "filed", "review"]);
  });
});

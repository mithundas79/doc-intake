import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/audit.js";

const cli = path.resolve("dist/cli.js");
const sample = path.resolve("samples/northwind-multipage.pdf");
const expected = "filed/invoice/northwind-supplies_2026-08-12_nw-2026-0481.pdf";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cli-integration-"));
  const inbox = path.join(root, "inbox"); const out = path.join(root, "out"); await mkdir(inbox);
  const source = path.join(inbox, "invoice.pdf"); await copyFile(sample, source);
  return { root, inbox, out, source };
}
function invoke(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (s) => { stdout += String(s); }); child.stderr.on("data", (s) => { stderr += String(s); });
    child.on("error", reject); child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function audit(out: string): Promise<any[]> { return (await readFile(path.join(out, "audit.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(folder: string) {
    for (const n of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, n.name);
      if (n.isDirectory()) await visit(file); else result[path.relative(root, file)] = sha256(await readFile(file));
    }
  }
  await visit(root); return result;
}

describe("real filesystem CLI in separate processes", () => {
  it("preserves sources and detects exact and business duplicates after restart", async () => {
    const f = await fixture();
    expect(await invoke([f.inbox, "--out", f.out])).toMatchObject({ code: 0 });
    expect(await readFile(f.source)).toEqual(await readFile(sample));
    await rm(f.source); await copyFile(sample, path.join(f.inbox, "renamed.pdf"));
    const duplicate = await invoke([f.inbox, "--out", f.out]); expect(duplicate.code, duplicate.stderr).toBe(1); expect(duplicate.stdout).toContain("Duplicate");
    // PDF comments change bytes without changing the structured invoice.
    await writeFile(path.join(f.inbox, "renamed.pdf"), Buffer.concat([await readFile(sample), Buffer.from("\n% altered encoding\n")]));
    const business = await invoke([f.inbox, "--out", f.out]); expect(business.code, business.stderr).toBe(1);
    const entries = await audit(f.out); expect(entries.map((e) => e.outcome).sort()).toEqual(["filed", "review", "review"]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(3);
    for (const entry of entries) {
      const dest = path.join(f.out, entry.decision.relativePath);
      expect(sha256(await readFile(dest))).toBe(entry.sha256);
      expect(JSON.parse(await readFile(dest + ".json", "utf8")).id).toBe(entry.id);
    }
  });

  it("supports explicit move, legacy keep, and previews without any persisted changes", async () => {
    const f = await fixture();
    const before = await tree(f.root);
    expect((await invoke([f.inbox, "--out", f.out, "--dry-run", "--move"])).code).toBe(0);
    expect(await tree(f.root)).toEqual(before);
    expect((await invoke([f.inbox, "--out", f.out, "--keep"])).code).toBe(0);
    const committed = await tree(f.root);
    expect((await invoke([f.inbox, "--out", f.out, "--dry-run"])).code).toBe(1);
    expect(await tree(f.root)).toEqual(committed);
    const moveOut = path.join(f.root, "move-out");
    expect((await invoke([f.inbox, "--out", moveOut, "--move"])).code).toBe(0);
    expect(await readdir(f.inbox)).toEqual([]);
    expect((await audit(moveOut))[0].source_cleanup).toBe("moved");
  });

  it("preserves colliding filed/review files and sidecars with matching audit associations", async () => {
    const f = await fixture();
    await mkdir(path.dirname(path.join(f.out, expected)), { recursive: true });
    await writeFile(path.join(f.out, expected), "unrelated original");
    expect((await invoke([f.inbox, "--out", f.out])).code).toBe(0);
    expect(await readFile(path.join(f.out, expected), "utf8")).toBe("unrelated original");
    await mkdir(path.join(f.out, "review"));
    await writeFile(path.join(f.out, "review", "invoice.pdf"), "other review original");
    await writeFile(path.join(f.out, "review", "invoice.pdf.json"), "other sidecar");
    expect((await invoke([f.inbox, "--out", f.out])).code).toBe(1);
    expect(await readFile(path.join(f.out, "review", "invoice.pdf"), "utf8")).toBe("other review original");
    expect(await readFile(path.join(f.out, "review", "invoice.pdf.json"), "utf8")).toBe("other sidecar");
    const entries = await audit(f.out);
    for (const entry of entries) expect(JSON.parse(await readFile(path.join(f.out, entry.decision.relativePath) + ".json", "utf8")).sha256).toBe(entry.sha256);
  });

  it("audits failures, returns 2, and allows corrected bytes at the same filename", async () => {
    const f = await fixture(); await writeFile(f.source, "not a pdf");
    const failed = await invoke([f.inbox, "--out", f.out]); expect(failed.code).toBe(2); expect(failed.stderr).toContain("permanent");
    expect((await audit(f.out))[0]).toMatchObject({ outcome: "error", source: "invoice.pdf" });
    await copyFile(sample, f.source); expect((await invoke([f.inbox, "--out", f.out])).code).toBe(0);
    await writeFile(path.join(f.inbox, "corrupt.png"), "corrupt image");
    expect((await invoke([f.inbox, "--out", f.out])).code).toBe(2); // errors dominate review
    const oversized = path.join(f.inbox, "oversized.pdf"); await writeFile(oversized, ""); await truncate(oversized, 25 * 1024 * 1024 + 1);
    const result = await invoke([f.inbox, "--out", path.join(f.root, "oversize-out")]); expect(result.code).toBe(2); expect(result.stderr).toContain("no larger than");
    for (const args of [[], [f.inbox, "--wat"], [f.inbox, "--move", "--keep"], [f.inbox, "--out"], [f.inbox, "--watch", "--dry-run"]]) expect((await invoke(args)).code).toBe(2);
  });

  it("serializes concurrent processes without corrupting identity or audit", async () => {
    const f = await fixture(); const inbox2 = path.join(f.root, "inbox2"); await mkdir(inbox2); await copyFile(sample, path.join(inbox2, "second.pdf"));
    const results = await Promise.all([invoke([f.inbox, "--out", f.out]), invoke([inbox2, "--out", f.out])]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
    const entries = await audit(f.out); expect(entries).toHaveLength(2); expect(new Set(entries.map((e) => e.id)).size).toBe(2);
    await expect(stat(path.join(f.out, ".intake", "lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews and migrates legacy audit identities without changing legacy outputs", async () => {
    const f = await fixture(); expect((await invoke([f.inbox, "--out", f.out])).code).toBe(0);
    const current = (await audit(f.out))[0];
    const { id: _id, outcome: _outcome, source_cleanup: _cleanup, ...legacy } = current;
    await rm(path.join(f.out, ".intake"), { recursive: true });
    const original = JSON.stringify(legacy) + "\n"; await writeFile(path.join(f.out, "audit.jsonl"), original);
    const before = await tree(f.root);
    const preview = await invoke([f.inbox, "--out", f.out, "--dry-run"]); expect(preview.code, preview.stderr).toBe(1);
    expect(await tree(f.root)).toEqual(before);
    expect((await invoke([f.inbox, "--out", f.out])).code).toBe(1);
    expect(await readFile(path.join(f.out, ".intake", "legacy-audit.jsonl"), "utf8")).toBe(original);
    expect(await audit(f.out)).toHaveLength(2);
    expect(sha256(await readFile(path.join(f.out, current.decision.relativePath)))).toBe(current.sha256);

    const invalid = await fixture(); await mkdir(invalid.out); await writeFile(path.join(invalid.out, "audit.jsonl"), "unrelated non-JSON audit");
    const invalidBefore = await tree(invalid.root);
    const rejected = await invoke([invalid.inbox, "--out", invalid.out, "--dry-run"]);
    expect(rejected.code).toBe(2); expect(rejected.stderr).toContain("manual migration");
    expect(await tree(invalid.root)).toEqual(invalidBefore);
  });

  it("recovers a killed lock owner without consuming the interrupted document identity", async () => {
    const f = await fixture();
    const module = pathToFileURL(path.resolve("dist/pipeline.js")).href;
    const code = `import { processFile } from ${JSON.stringify(module)}; setInterval(()=>{},1000); await processFile(process.argv[1], {outRoot:process.argv[2], ocr:async()=>{console.log('ocr-started');return new Promise(()=>{});}});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.source, f.out], { windowsHide: true });
    const closed = new Promise<void>((resolve, reject) => { child.on("close", () => resolve()); child.on("error", reject); });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.on("data", (s) => { if (String(s).includes("ocr-started")) resolve(); }); child.once("exit", (c) => reject(new Error(`Child exited before OCR: ${c}`))); child.once("error", reject); });
    } finally { child.kill("SIGKILL"); await closed; }
    const next = await invoke([f.inbox, "--out", f.out]); expect(next.code, next.stderr).toBe(0);
    expect((await audit(f.out)).map((e) => e.outcome)).toEqual(["filed"]);
  });

  it("replays a pending transaction and quarantines an interrupted partial output safely", async () => {
    for (const partial of [false, true]) {
      const f = await fixture(); expect((await invoke([f.inbox, "--out", f.out])).code).toBe(0);
      const entry = (await audit(f.out))[0]; const eventFile = path.join(f.out, ".intake", "events", entry.id + ".json");
      const transaction = JSON.parse(await readFile(eventFile, "utf8"));
      await mkdir(path.join(f.out, ".intake", "staging"), { recursive: true });
      await copyFile(f.source, path.join(f.out, ".intake", "staging", entry.id));
      await writeFile(path.join(f.out, ".intake", "pending", entry.id + ".json"), JSON.stringify(transaction));
      await rm(eventFile); await rm(path.join(f.out, entry.decision.relativePath)); await rm(path.join(f.out, entry.decision.relativePath) + ".json");
      if (partial) await writeFile(path.join(f.out, entry.decision.relativePath), "interrupted partial bytes");
      const next = await invoke([f.inbox, "--out", f.out]); expect(next.code, next.stderr).toBe(partial ? 2 : 1);
      const events = await audit(f.out); expect(events).toHaveLength(2);
      if (partial) {
        expect(events.some((e) => e.outcome === "error" && e.error.includes("Recovery quarantined"))).toBe(true);
        expect(await readFile(path.join(f.out, entry.decision.relativePath), "utf8")).toBe("interrupted partial bytes");
        expect(await readdir(path.join(f.out, ".intake", "quarantine"))).toEqual([entry.id + ".json"]);
      } else expect(events.some((e) => e.id === entry.id)).toBe(true);
      expect(await readdir(path.join(f.out, ".intake", "pending"))).toEqual([]);
    }
  });

  it("commits a pending explicit move at startup with an empty inbox", async () => {
    const f = await fixture(); expect((await invoke([f.inbox, "--out", f.out])).code).toBe(0);
    const entry = (await audit(f.out))[0]; const event = path.join(f.out, ".intake", "events", entry.id + ".json");
    const transaction = JSON.parse(await readFile(event, "utf8")); transaction.moveSource = f.source;
    await copyFile(f.source, path.join(f.out, ".intake", "staging", entry.id));
    await writeFile(path.join(f.out, ".intake", "pending", entry.id + ".json"), JSON.stringify(transaction));
    await rm(event); await rm(f.source); // interruption after source deletion, before event commit
    const before = await tree(f.root);
    expect((await invoke([f.inbox, "--out", f.out, "--dry-run"])).code).toBe(0);
    expect(await tree(f.root)).toEqual(before);
    const resumed = await invoke([f.inbox, "--out", f.out]); expect(resumed.code, resumed.stderr).toBe(0);
    expect(await readdir(f.inbox)).toEqual([]);
    expect(await readdir(path.join(f.out, ".intake", "pending"))).toEqual([]);
    const committed = await audit(f.out); expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ id: entry.id, sha256: entry.sha256, source_cleanup: "source_missing" });
    const destination = path.join(f.out, committed[0].decision.relativePath);
    expect(sha256(await readFile(destination))).toBe(entry.sha256);
    expect(JSON.parse(await readFile(destination + ".json", "utf8")).id).toBe(entry.id);
    const fresh = await fixture(); await rm(fresh.source);
    expect((await invoke([fresh.inbox, "--out", fresh.out])).code).toBe(0);
    await expect(stat(fresh.out)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

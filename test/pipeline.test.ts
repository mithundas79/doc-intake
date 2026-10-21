import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { OcrFn } from "../src/ocr.js";
import { processFile } from "../src/pipeline.js";
import { SessionDuplicateStore } from "../src/types.js";

/*
 * Integration test with the OCR step injected: deterministic, fast, and it
 * exercises everything downstream of the engine - extraction, rules,
 * routing, the sidecar and the audit log. The real engine has its own
 * gated test in ocr.test.ts.
 */

const GOOD_TEXT = `Northwind Supplies
Invoice No: NW-2026-0481
Invoice Date: 12 Aug 2026
Filter cartridges 10 in 24 408.00
Sealing rings box of 50 6 171.00
Delivery 1 45.00
Subtotal 624.00
Tax 8.5% 53.04
Total Due 677.04`;

const BAD_TEXT = `Ridgeway Trading
Invoice No: RT-9912
Invoice Date: 03 Aug 2026
Pallet wrap 500m 12 216.00
Strapping tape 4 88.00
Subtotal 304.00
Tax 8.5% 25.84
Total Due 349.84`;

const fakeOcr = (text: string): OcrFn => async () => ({ text, lines: [], confidence: 91 });

let inbox: string;
let outRoot: string;

beforeEach(async () => {
  inbox = await mkdtemp(path.join(tmpdir(), "intake-in-"));
  outRoot = await mkdtemp(path.join(tmpdir(), "intake-out-"));
});

describe("processFile", () => {
  it("copies a clean document into filed/ with a sidecar and an audit line", async () => {
    const src = path.join(inbox, "scan.png");
    await writeFile(src, "png-bytes");

    const { decision } = await processFile(src, {
      outRoot,
      dupes: new SessionDuplicateStore(),
      ocr: fakeOcr(GOOD_TEXT),
    });

    expect(decision.action).toBe("file");
    const dest = path.join(outRoot, decision.relativePath);
    expect((await readdir(path.dirname(dest))).sort()).toEqual(
      [path.basename(dest), path.basename(dest) + ".json"].sort(),
    );
    expect(await readdir(inbox)).toEqual(["scan.png"]);

    const sidecar = JSON.parse(await readFile(dest + ".json", "utf8"));
    expect(sidecar.record.vendor).toBe("Northwind Supplies");
    expect(sidecar.sha256).toMatch(/^[0-9a-f]{64}$/);

    const audit = (await readFile(path.join(outRoot, "audit.jsonl"), "utf8")).trim().split("\n");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!).decision.action).toBe("file");
  });

  it("routes a failing document to review/ under its original name", async () => {
    const src = path.join(inbox, "IMG_9001.jpg");
    await writeFile(src, "jpg-bytes");

    const { decision } = await processFile(src, {
      outRoot,
      dupes: new SessionDuplicateStore(),
      ocr: fakeOcr(BAD_TEXT),
    });

    expect(decision.action).toBe("review");
    expect(decision.relativePath).toBe("review/IMG_9001.jpg");
    expect(decision.failures.map((f) => f.rule)).toContain("Subtotal plus tax equals the total");
  });

  it("catches the duplicate on the second run, not the first", async () => {
    const dupes = new SessionDuplicateStore();
    for (const name of ["a.png", "b.png"]) {
      await writeFile(path.join(inbox, name), name);
    }
    const first = await processFile(path.join(inbox, "a.png"), { outRoot, dupes, ocr: fakeOcr(GOOD_TEXT) });
    const second = await processFile(path.join(inbox, "b.png"), { outRoot, dupes, ocr: fakeOcr(GOOD_TEXT) });
    expect(first.decision.action).toBe("file");
    expect(second.decision.action).toBe("review");
  });

  it("keeps the original when asked to", async () => {
    const src = path.join(inbox, "keep.png");
    await writeFile(src, "bytes");
    await processFile(src, {
      outRoot,
      dupes: new SessionDuplicateStore(),
      ocr: fakeOcr(GOOD_TEXT),
      keepOriginal: true,
    });
    expect(await readdir(inbox)).toEqual(["keep.png"]);
  });

  it("moves only when explicitly requested, including legacy keepOriginal=false", async () => {
    for (const options of [{ move: true }, { keepOriginal: false }]) {
      const src = path.join(inbox, "move.png"); await writeFile(src, Math.random().toString());
      await processFile(src, { outRoot, ocr: fakeOcr(GOOD_TEXT), ...options });
      expect(await readdir(inbox)).toEqual([]);
    }
  });

  it("preserves changed move sources and does not poison the next transaction", async () => {
    const source = path.join(inbox, "changed.png"); await writeFile(source, "old bytes");
    const first = await processFile(source, { outRoot, move: true, ocr: async () => {
      await writeFile(source, "new bytes"); return fakeOcr(GOOD_TEXT)(source);
    } });
    expect(first.entry.source_cleanup).toBe("source_changed_preserved");
    expect(await readFile(source, "utf8")).toBe("new bytes");
    expect(await readdir(path.join(outRoot, ".intake", "pending"))).toEqual([]);
    const next = await processFile(source, { outRoot, ocr: fakeOcr(BAD_TEXT) });
    expect(next.entry.sha256).not.toBe(first.entry.sha256);
  });

  it("uses legacy seenBefore-only custom stores and refuses to mutate them in previews", async () => {
    const source = path.join(inbox, "legacy.png"); await writeFile(source, "legacy");
    let calls = 0;
    const dupes = { seenBefore: () => { calls++; return true; } };
    const result = await processFile(source, { outRoot, dupes, ocr: fakeOcr(GOOD_TEXT) });
    expect(result.decision.failures.some((c) => c.rule.startsWith("Duplicate"))).toBe(true);
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    await expect(processFile(source, { outRoot, dupes, dryRun: true, ocr: fakeOcr(GOOD_TEXT) })).rejects.toThrow("Dry-run requires DuplicateStore.has");
    expect(calls).toBe(before);
  });

  it("dry-run creates no outputs and consumes no identity", async () => {
    const source = path.join(inbox, "preview.png"); await writeFile(source, "preview bytes");
    const dupes = new SessionDuplicateStore();
    await processFile(source, { outRoot, dupes, dryRun: true, ocr: fakeOcr(GOOD_TEXT) });
    expect(await readdir(outRoot)).toEqual([]);
    expect((await processFile(source, { outRoot, dupes, ocr: fakeOcr(GOOD_TEXT) })).decision.action).toBe("file");
  });

  it("failed OCR does not claim duplicate identity and is audited as an error", async () => {
    const source = path.join(inbox, "retry.png"); await writeFile(source, "retry bytes");
    await expect(processFile(source, { outRoot, ocr: async () => { throw new Error("transient decoder error"); } })).rejects.toThrow("transient decoder error");
    const result = await processFile(source, { outRoot, ocr: fakeOcr(GOOD_TEXT) });
    expect(result.decision.action).toBe("file");
    const audit = (await readFile(path.join(outRoot, "audit.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    expect(audit.map((e) => e.outcome).sort()).toEqual(["error", "filed"]);
  });

  it("never overwrites a colliding original or orphan sidecar", async () => {
    const src = path.join(inbox, "review.png"); await writeFile(src, "new bytes");
    const folder = path.join(outRoot, "review");
    const { mkdir } = await import("node:fs/promises"); await mkdir(folder);
    await writeFile(path.join(folder, "review.png.json"), "unrelated sidecar");
    const result = await processFile(src, { outRoot, ocr: fakeOcr(BAD_TEXT) });
    expect(result.decision.relativePath).not.toBe("review/review.png");
    expect(await readFile(path.join(folder, "review.png.json"), "utf8")).toBe("unrelated sidecar");
    const sidecar = JSON.parse(await readFile(path.join(outRoot, result.decision.relativePath) + ".json", "utf8"));
    expect(sidecar.id).toBe(result.entry.id);
  });
});

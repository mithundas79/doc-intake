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
  it("moves a clean document into filed/ with a sidecar and an audit line", async () => {
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
    // moved, not copied
    expect(await readdir(inbox)).toEqual([]);

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
});

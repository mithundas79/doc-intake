import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { recognize, recognizeDocument } from "../src/ocr.js";
import { check } from "../src/rules.js";
import { SessionDuplicateStore } from "../src/types.js";

/*
 * The one test that runs the actual engine, against a committed sample
 * image with a fictional vendor. Slow (traineddata download on first run),
 * so it lives behind `npm run test:ocr` rather than in the default suite.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(here, "..", "samples", "northwind-invoice.png");

describe("real OCR on the sample invoice", () => {
  it("reads the document well enough for every rule to pass", async () => {
    const ocr = await recognize(SAMPLE);
    expect(ocr.confidence).toBeGreaterThan(60);

    const rec = extract(ocr.text, ocr.lines);
    expect(rec.vendor).toBe("Northwind Supplies");
    expect(rec.number).toBe("NW-2026-0481");
    expect(rec.total).toBe(677.04);

    const failures = check(rec, new SessionDuplicateStore()).filter((r) => !r.ok);
    expect(failures).toEqual([]);
  });
  it("extracts embedded text across multiple PDF pages without invoking OCR", async () => {
    const old = process.env.TESSERACT_BIN; process.env.TESSERACT_BIN = "intentionally-unavailable-tesseract";
    try {
      const result = await recognize(path.join(here, "..", "samples", "northwind-multipage.pdf"));
      const rec = extract(result.text); expect(rec.total).toBe(677.04); expect(rec.line_total).toBe(624);
      expect(check(rec, new SessionDuplicateStore()).filter((r) => !r.ok)).toEqual([]);
    } finally { if (old === undefined) delete process.env.TESSERACT_BIN; else process.env.TESSERACT_BIN = old; }
  });
  it("rasterizes and OCRs a real scanned PDF without a text layer", async () => {
    const result = await recognize(path.join(here, "..", "samples", "northwind-scanned.pdf"));
    const rec = extract(result.text); expect(rec.vendor).toBe("Northwind Supplies"); expect(rec.total).toBe(677.04);
    expect(check(rec, new SessionDuplicateStore()).filter((r) => !r.ok)).toEqual([]);
  });
  it("rejects PDF page and image pixel limits", async () => {
    await expect(recognize(path.join(here, "..", "samples", "over-page-limit.pdf"))).rejects.toThrow("PDF page limit");
    await expect(recognizeDocument(SAMPLE, { maxPixels: 100 })).rejects.toThrow("pixels");
  });
});

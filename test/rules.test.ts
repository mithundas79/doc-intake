import { describe, expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { check, duplicateKey } from "../src/rules.js";
import { SessionDuplicateStore } from "../src/types.js";

const GOOD = `Northwind Supplies
Invoice No: NW-2026-0481
Invoice Date: 12 Aug 2026
Filter cartridges 10 in 24 408.00
Sealing rings box of 50 6 171.00
Delivery 1 45.00
Subtotal 624.00
Tax 8.5% 53.04
Total Due 677.04`;

/* Ridgeway is the deliberate bad sample: 304.00 + 25.84 = 329.84, not 349.84. */
const BAD_TOTALS = `Ridgeway Trading
Invoice No: RT-9912
Invoice Date: 03 Aug 2026
Pallet wrap 500m 12 216.00
Strapping tape 4 88.00
Subtotal 304.00
Tax 8.5% 25.84
Total Due 349.84`;

describe("check", () => {
  it("passes every rule on a clean invoice", () => {
    const results = check(extract(GOOD), new SessionDuplicateStore());
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it("catches a total that does not foot", () => {
    const results = check(extract(BAD_TOTALS), new SessionDuplicateStore());
    const fail = results.find((r) => r.rule === "Subtotal plus tax equals the total");
    expect(fail?.ok).toBe(false);
    expect(fail?.detail).toContain("329.84");
  });

  it("refuses to pass a document with no number", () => {
    const rec = extract("Acme Ltd\nSubtotal 10.00\nTax 1.00\nTotal 11.00");
    const results = check(rec, new SessionDuplicateStore());
    expect(results.find((r) => r.rule === "No document number")?.ok).toBe(false);
  });

  it("flags the second sighting of the same document, not the first", () => {
    const store = new SessionDuplicateStore();
    const first = check(extract(GOOD), store);
    const second = check(extract(GOOD), store);
    expect(first.find((r) => r.rule.startsWith("Duplicate"))).toBeUndefined();
    expect(second.find((r) => r.rule.startsWith("Duplicate"))?.ok).toBe(false);
  });

  it("treats an unknown document type as a reason for review", () => {
    const rec = extract("Something Co\nRef No: X-100\nTotal 5.00");
    const results = check(rec, new SessionDuplicateStore());
    expect(results.find((r) => r.rule === "Document type unknown")?.ok).toBe(false);
  });

  it("keys duplicates on vendor, number and amount together", () => {
    const a = extract(GOOD);
    const b = { ...a, total: 999.99 };
    expect(duplicateKey(a)).not.toBe(duplicateKey(b));
  });
  it("separates currencies/types and normalizes vendor whitespace in identity", () => {
    const a = extract(GOOD);
    expect(duplicateKey(a)).toBe(duplicateKey({ ...a, vendor: "  NORTHWIND   Supplies " }));
    expect(duplicateKey(a)).not.toBe(duplicateKey({ ...a, currency: "INR" }));
    expect(duplicateKey(a)).not.toBe(duplicateKey({ ...a, document_type: "credit_note" }));
  });
  it("routes ambiguous numeric dates and mixed currencies to review", () => {
    const results = check(extract(GOOD.replace("12 Aug 2026", "03/04/2026") + "\nUSD INR"), new SessionDuplicateStore());
    expect(results.find((r) => r.rule === "Date not read")?.ok).toBe(false);
    expect(results.find((r) => r.rule === "Currency ambiguous")?.ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { extract } from "../src/extract.js";
import { decide } from "../src/route.js";
import { slug } from "../src/slug.js";
import { check } from "../src/rules.js";
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

describe("decide", () => {
  it("files a clean document under filed/<type> with the naming convention", () => {
    const rec = extract(GOOD);
    const d = decide(rec, check(rec, new SessionDuplicateStore()), "scan_001.png");
    expect(d.action).toBe("file");
    expect(d.relativePath).toBe("filed/invoice/northwind-supplies_2026-08-12_nw-2026-0481.png");
  });

  it("keeps the original name for anything sent to review", () => {
    const rec = extract("gibberish with no fields");
    const d = decide(rec, check(rec, new SessionDuplicateStore()), "IMG_4471.jpg");
    expect(d.action).toBe("review");
    expect(d.relativePath).toBe("review/IMG_4471.jpg");
    expect(d.failures.length).toBeGreaterThan(0);
  });
});

describe("slug", () => {
  it("makes file-safe names and falls back rather than emitting nothing", () => {
    expect(slug("Näst & Söner GmbH", "x")).toBe("n-st-s-ner-gmbh");
    expect(slug("///", "unknown-vendor")).toBe("unknown-vendor");
  });
});

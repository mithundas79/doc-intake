import { describe, expect, it } from "vitest";
import { amountsIn, detectType, extract, normDate, pickVendor } from "../src/extract.js";

const GOOD = `Northwind Supplies
Invoice No: NW-2026-0481
Invoice Date: 12 Aug 2026
Due Date: 11 Sep 2026
Filter cartridges 10 in 24 408.00
Sealing rings box of 50 6 171.00
Delivery 1 45.00
Subtotal 624.00
Tax 8.5% 53.04
Total Due 677.04`;

describe("extract", () => {
  it("reads every field from a clean invoice", () => {
    const r = extract(GOOD);
    expect(r.vendor).toBe("Northwind Supplies");
    expect(r.number).toBe("NW-2026-0481");
    expect(r.date).toBe("2026-08-12");
    expect(r.due_date).toBe("2026-09-11");
    expect(r.subtotal).toBe(624.0);
    expect(r.tax).toBe(53.04);
    expect(r.total).toBe(677.04);
    expect(r.line_total).toBe(624.0);
    expect(r.currency).toBe("USD");
    expect(r.document_type).toBe("invoice");
  });

  it("never mistakes a percentage for a money amount", () => {
    expect(amountsIn("Tax 8.5% 53.04")).toEqual([53.04]);
    expect(amountsIn("Discount 10.00% applied")).toEqual([]);
  });

  it("does not let Subtotal satisfy the Total match", () => {
    const r = extract("Acme Ltd\nInvoice No: A-1\nSubtotal 100.00\nTax 8.00\nTotal 108.00");
    expect(r.subtotal).toBe(100.0);
    expect(r.total).toBe(108.0);
  });

  it("takes the last amount on a line, so quantities are not read as money", () => {
    const r = extract("Vendor Co\nWidgets 12 1,240.50\nTotal 1,240.50");
    expect(r.line_total).toBe(1240.5);
  });

  it("detects currencies from symbols and codes", () => {
    expect(extract("Facture\nTotal 10.00 EUR").currency).toBe("EUR");
    expect(extract("Invoice\nTotal £10.00").currency).toBe("GBP");
  });

  it("accepts explicit INR indicators with valid Indian grouping", () => {
    for (const indicator of ["INR", "Rs.", "Rs", "₹"]) {
      const r = extract(`Acme India\nTotal ${indicator} 1,23,456.78`);
      expect(r.currency).toBe("INR"); expect(r.total).toBe(123456.78);
    }
    expect(amountsIn("1,234.56 12,34,567.89 123456.78")).toEqual([1234.56, 1234567.89, 123456.78]);
  });

  it("rejects ambiguous decimals, malformed grouping, percentages and overprecision as whole tokens", () => {
    for (const value of ["1.234,56", "123,45", "1,234,56", "123,45,678.90", "1,23.45", "12.345", "8.50%", "100.00.00"])
      expect(amountsIn(`Total ${value}`), value).toEqual([]);
    expect(amountsIn("GBP 1,234.56 EUR 456.78 USD 12.34")).toEqual([1234.56, 456.78, 12.34]);
    expect(extract("Total USD 12.00 INR").currency_ambiguous).toBe(true);
  });
});

describe("detectType", () => {
  it("credit note beats invoice, because credit notes mention invoices", () => {
    expect(detectType("Credit Note against invoice NW-1")).toBe("credit_note");
  });
  it("recognises receipts and statements", () => {
    expect(detectType("Payment RECEIPT")).toBe("receipt");
    expect(detectType("Monthly Statement of account")).toBe("statement");
  });
  it("returns unknown rather than guessing", () => {
    expect(detectType("hello world")).toBe("unknown");
  });
});

describe("pickVendor", () => {
  it("strips a merged document label instead of discarding the line", () => {
    expect(pickVendor(["Northwind Supplies INVOICE"])).toBe("Northwind Supplies");
  });
  it("skips addresses and table headers", () => {
    expect(pickVendor(["14 Harbour Road", "Description Qty Amount", "Ridgeway Trading"])).toBe(
      "Ridgeway Trading",
    );
  });
  it("prefers the tallest text near the top when layout is available", () => {
    const vendor = pickVendor([], [
      { text: "small print", bbox: { x0: 0, y0: 0, x1: 10, y1: 12 } },
      { text: "Big Vendor Co", bbox: { x0: 0, y0: 20, x1: 10, y1: 60 } },
      { text: "footer", bbox: { x0: 0, y0: 900, x1: 10, y1: 920 } },
    ]);
    expect(vendor).toBe("Big Vendor Co");
  });
});

describe("normDate", () => {
  it("normalises day-first and month-first long dates to ISO", () => {
    expect(normDate("12 Aug 2026")).toBe("2026-08-12");
    expect(normDate("Aug 12, 2026")).toBe("2026-08-12");
  });
  it("passes through formats it cannot be sure about", () => {
    expect(normDate("03/04/2026")).toBe("03/04/2026");
  });
  it("rejects impossible calendar dates and accepts explicit ISO dates", () => {
    expect(normDate("31 Feb 2026")).toBeNull();
    expect(normDate("2026-02-29")).toBeNull();
    expect(extract("Invoice Date: 2026-08-12").date).toBe("2026-08-12");
  });
});

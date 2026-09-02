import type { DocumentRecord, DocumentType, OcrLine } from "./types.js";

/*
 * Line-based extraction, not one big regex over the whole page.
 *
 * Money is only ever taken from a token with two decimals, so "Tax 8.5%"
 * can never become the tax amount, and "Total" is never matched inside
 * "Subtotal". These constraints came from real failures, not caution.
 */

const AMOUNT = /(-?\d[\d,]*\.\d{2})(?!\s*%)/g;

const money = (v: string): number => parseFloat(v.replace(/,/g, ""));

export const round2 = (n: number): number => Number(n.toFixed(2));

export function amountsIn(line: string): number[] {
  const out: number[] = [];
  AMOUNT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMOUNT.exec(line)) !== null) out.push(money(m[1]!));
  return out;
}

function lastAmount(line: string): number | null {
  const a = amountsIn(line);
  return a.length ? a[a.length - 1]! : null;
}

/*
 * Document-type words. Order matters: "credit note" must win over "invoice"
 * because credit notes usually contain the word invoice somewhere too, and a
 * credit note posted as a negative invoice is how ledgers rot.
 */
const DOC_LABEL =
  /\b(tax\s+)?(invoice|receipt|bill|statement|credit\s*(note|memo)|purchase\s*order|remittance)\b/i;

export function detectType(text: string): DocumentType {
  if (/credit\s*(note|memo)/i.test(text)) return "credit_note";
  if (/\bstatement\b/i.test(text)) return "statement";
  if (/\breceipt\b/i.test(text)) return "receipt";
  if (/\b(tax\s+)?invoice\b|\bbill\b/i.test(text)) return "invoice";
  return "unknown";
}

/*
 * The vendor is the biggest text near the top. OCR often merges columns, so
 * "Northwind Supplies INVOICE" arrives as one line: strip the document label
 * rather than discarding the line, which is what a naive keyword filter does.
 */
export function cleanVendorLine(t: string | null | undefined): string | null {
  let v = String(t ?? "").replace(/\s+/g, " ").trim();
  const m = v.match(DOC_LABEL);
  if (m && m.index !== undefined) v = v.slice(0, m.index).trim();
  v = v.replace(/[|,;:\-–—\s]+$/, "").trim();
  if (!/[A-Za-z]{3}/.test(v)) return null; // must still be a name
  if (/^\d/.test(v)) return null; // an address or a number, not a vendor
  if (/^(description|qty|quantity|amount|date|due|page|total|subtotal)\b/i.test(v)) return null;
  return v;
}

export function pickVendor(lines: string[], ocrLines?: OcrLine[] | null): string | null {
  if (ocrLines && ocrLines.length) {
    const page = Math.max(...ocrLines.map((l) => l.bbox?.y1 ?? 0), 1);
    const cands = ocrLines
      .filter((l) => l.bbox && l.bbox.y1 < page * 0.35)
      .map((l) => ({ v: cleanVendorLine(l.text), h: l.bbox!.y1 - l.bbox!.y0 }))
      .filter((c): c is { v: string; h: number } => c.v !== null)
      .sort((x, y) => y.h - x.h);
    if (cands.length) return cands[0]!.v;
  }
  for (const l of lines.slice(0, 6)) {
    const v = cleanVendorLine(l);
    if (v) return v;
  }
  return null;
}

function dateIn(l: string): string | null {
  const m = l.match(
    /(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/,
  );
  return m ? m[1]! : null;
}

function monthNum(name: string): string | null {
  const i = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
    name.slice(0, 3).toLowerCase(),
  );
  return i < 0 ? null : String(i + 1).padStart(2, "0");
}

/** Normalise "12 Aug 2026" / "Aug 12, 2026" to ISO; pass anything else through. */
export function normDate(v: string | null): string | null {
  if (!v) return null;
  let m = v.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (m) {
    const mm = monthNum(m[2]!);
    if (mm) return `${m[3]}-${mm}-${m[1]!.padStart(2, "0")}`;
  }
  m = v.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mm = monthNum(m[1]!);
    if (mm) return `${m[3]}-${mm}-${m[2]!.padStart(2, "0")}`;
  }
  return v;
}

/** Extract a structured record from OCR text (and layout lines when available). */
export function extract(text: string, ocrLines?: OcrLine[] | null): DocumentRecord {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rec: DocumentRecord = {
    vendor: pickVendor(lines, ocrLines),
    document_type: detectType(text),
    number: null,
    date: null,
    due_date: null,
    currency: /€|\bEUR\b/.test(text) ? "EUR" : /£|\bGBP\b/.test(text) ? "GBP" : "USD",
    subtotal: null,
    tax: null,
    total: null,
    line_total: null,
  };

  let lineItems = 0;
  let lineSum = 0;

  for (const raw of lines) {
    const l = raw.replace(/\s+/g, " ");
    const low = l.toLowerCase();

    if (!rec.number) {
      const m = l.match(/(?:invoice|receipt|statement|credit\s*note)\s*(?:no|number|#)?\s*[:.]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/i);
      if (m && !/date/i.test(m[1]!)) rec.number = m[1]!.trim();
    }
    if (!rec.date && /invoice\s*date|^date\b/i.test(low)) rec.date = normDate(dateIn(l));
    if (!rec.due_date && /due\s*date/i.test(low)) rec.due_date = normDate(dateIn(l));

    const amt = lastAmount(l);
    if (amt === null) continue;

    if (low.includes("subtotal") || low.includes("sub total")) { rec.subtotal = amt; continue; }
    if (/\b(tax|vat|gst)\b/.test(low)) { rec.tax = amt; continue; }
    if (/\btotal\b|\bbalance due\b|\bamount due\b/.test(low)) { rec.total = amt; continue; }
    if (/payment|terms|thank|page|invoice no|date/i.test(low)) continue;

    lineItems++;
    lineSum += amt; // an ordinary item row
  }

  if (lineItems) rec.line_total = round2(lineSum);
  if (rec.subtotal !== null) rec.subtotal = round2(rec.subtotal);
  if (rec.tax !== null) rec.tax = round2(rec.tax);
  if (rec.total !== null) rec.total = round2(rec.total);
  return rec;
}

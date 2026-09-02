import { round2 } from "./extract.js";
import type { DocumentRecord, DuplicateStore, RuleResult } from "./types.js";

/*
 * The rules layer. The extractor proposes; these decide.
 *
 * Every rule failing routes the document to a person instead of into the
 * books - which is the correct outcome, not an error state. A high extraction
 * accuracy with no rule layer is a liability, because the failures land
 * silently in the ledger.
 */

const near = (a: number | null, b: number | null, tol = 0.02): boolean =>
  a !== null && b !== null && Math.abs(a - b) <= tol;

/** The stable identity of a document for duplicate detection. */
export function duplicateKey(rec: DocumentRecord): string {
  return [rec.vendor, rec.number, rec.total].join("|").toLowerCase();
}

export function check(rec: DocumentRecord, dupes: DuplicateStore): RuleResult[] {
  const out: RuleResult[] = [];

  out.push(
    rec.vendor
      ? { ok: true, rule: "Vendor identified", detail: rec.vendor }
      : { ok: false, rule: "Vendor not identified", detail: "Nothing usable at the top of the document" },
  );

  out.push(
    rec.number
      ? { ok: true, rule: "Document number found", detail: rec.number }
      : { ok: false, rule: "No document number", detail: "Cannot be de-duplicated safely without one" },
  );

  out.push(
    rec.date
      ? { ok: true, rule: "Date read", detail: rec.date }
      : { ok: false, rule: "Date not read", detail: "A posting date must never be guessed" },
  );

  if (rec.subtotal !== null && rec.tax !== null && rec.total !== null) {
    const ok = near(round2(rec.subtotal + rec.tax), rec.total);
    out.push({
      ok,
      rule: "Subtotal plus tax equals the total",
      detail: `${rec.subtotal} + ${rec.tax} = ${round2(rec.subtotal + rec.tax)} vs stated ${rec.total}`,
    });
  } else {
    out.push({
      ok: false,
      rule: "Totals incomplete",
      detail: "One of subtotal, tax or total was not read",
    });
  }

  if (rec.line_total !== null && rec.subtotal !== null) {
    const ok = near(rec.line_total, rec.subtotal, 0.05);
    out.push({
      ok,
      rule: "Line items add up to the subtotal",
      detail: `lines ${rec.line_total} vs subtotal ${rec.subtotal}`,
    });
  } else {
    out.push({
      ok: false,
      rule: "Line items not summed",
      detail: "Not enough line amounts were read to check",
    });
  }

  const dup = rec.number !== null && dupes.seenBefore(duplicateKey(rec));
  out.push(
    dup
      ? { ok: false, rule: "Duplicate of a document already seen", detail: "Same vendor, number and amount" }
      : { ok: true, rule: "Not a duplicate", detail: "No match against documents already processed" },
  );

  out.push(
    rec.document_type === "credit_note"
      ? { ok: true, rule: "Recorded as a credit note", detail: "Reduces the payable; never posted as a negative invoice" }
      : rec.document_type === "unknown"
        ? { ok: false, rule: "Document type unknown", detail: "No recognisable document wording; a person should look" }
        : { ok: true, rule: `Recorded as ${rec.document_type.replace("_", " ")}`, detail: "Document type read from the wording" },
  );

  return out;
}

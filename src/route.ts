import path from "node:path";
import { slug } from "./slug.js";
import type { DocumentRecord, RouteDecision, RuleResult } from "./types.js";

/*
 * Routing: where a document goes and what it is called.
 *
 * The naming convention is boring on purpose - `vendor_date_number.ext` sorts
 * usefully in any file browser and survives being emailed, zipped and
 * restored. Anything that fails a rule keeps its original name under
 * `review/`, because renaming a document you don't yet trust destroys the
 * one identifier a person can still search their inbox for.
 */

export function decide(
  rec: DocumentRecord,
  checks: RuleResult[],
  sourceName: string,
): RouteDecision {
  const failures = checks.filter((c) => !c.ok);
  const ext = path.extname(sourceName) || "";

  if (failures.length > 0) {
    return {
      action: "review",
      relativePath: path.posix.join("review", path.basename(sourceName)),
      failures,
    };
  }

  const name = [
    slug(rec.vendor, "unknown-vendor"),
    rec.date ?? "undated",
    slug(rec.number, "no-number"),
  ].join("_");

  return {
    action: "file",
    relativePath: path.posix.join("filed", rec.document_type, `${name}${ext}`),
    failures: [],
  };
}

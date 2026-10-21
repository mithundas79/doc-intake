/** A single OCR line with its bounding box, used for layout-aware heuristics. */
export interface OcrLine {
  text: string;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

export type DocumentType =
  | "invoice"
  | "receipt"
  | "statement"
  | "credit_note"
  | "unknown";

/** The structured record extracted from one document. */
export interface DocumentRecord {
  vendor: string | null;
  document_type: DocumentType;
  number: string | null;
  /** ISO date (YYYY-MM-DD) where the source format allowed normalisation. */
  date: string | null;
  due_date: string | null;
  currency: "USD" | "EUR" | "GBP" | "INR";
  /** Ambiguous currency indicators require review. Absent on legacy caller records. */
  currency_ambiguous?: boolean;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  /** Sum of the ordinary line-item amounts, when any were read. */
  line_total: number | null;
}

/** One rule's outcome. `ok: false` routes the document to a person. */
export interface RuleResult {
  ok: boolean;
  rule: string;
  detail: string;
}

/** Where a document ends up, and under what name. */
export interface RouteDecision {
  action: "file" | "review";
  /** Relative path under the output root, e.g. `filed/invoice/acme_2026-08-12_A-1001.png`. */
  relativePath: string;
  /** Rules that failed, empty when action is `file`. */
  failures: RuleResult[];
}

/** One line of the append-only audit log (JSONL). */
export interface AuditEntry {
  id?: string;
  outcome?: "filed" | "review";
  source_cleanup?: "copied" | "moved" | "source_changed_preserved" | "source_missing";
  at: string;
  source: string;
  sha256: string;
  ocr_confidence: number | null;
  record: DocumentRecord;
  checks: RuleResult[];
  decision: RouteDecision;
}

/** Duplicate detection needs memory; the caller decides how durable it is. */
export interface DuplicateStore {
  /** Returns true if the key was already present; records it either way. */
  seenBefore(key: string): boolean;
  /** Non-mutating lookup used by previews. */
  has?(key: string): boolean;
}

/** In-memory store: duplicates within one run/session. */
export class SessionDuplicateStore implements DuplicateStore {
  private seen = new Set<string>();
  has(key: string): boolean { return this.seen.has(key); }
  seenBefore(key: string): boolean {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    return false;
  }
}

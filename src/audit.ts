import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AuditEntry } from "./types.js";

/*
 * The audit log answers "why is this document here?" months later.
 * Append-only JSONL: one line per document, written after the decision,
 * never rewritten. The hash ties the log line to the exact bytes processed,
 * so a re-submitted or renamed copy of the same file is still recognisable.
 */

export function sha256(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export const AUDIT_FILE = "audit.jsonl";

export async function appendAudit(outRoot: string, entry: AuditEntry): Promise<void> {
  await mkdir(outRoot, { recursive: true });
  await appendFile(path.join(outRoot, AUDIT_FILE), JSON.stringify(entry) + "\n", "utf8");
}

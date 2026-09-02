import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendAudit, sha256 } from "./audit.js";
import { extract } from "./extract.js";
import { recognize, type OcrFn } from "./ocr.js";
import { decide } from "./route.js";
import { check } from "./rules.js";
import type { AuditEntry, DuplicateStore, RouteDecision } from "./types.js";

/*
 * One document, end to end:
 *
 *   read bytes -> hash -> OCR -> extract -> rules -> route -> audit
 *
 * The original file is moved, never altered. Next to every filed document
 * lands a `.json` sidecar with the extracted record, so downstream tools
 * (or a person) never need to re-read the image to know what it said.
 */

export interface PipelineOptions {
  outRoot: string;
  dupes: DuplicateStore;
  /** Injectable for tests and for callers that already have text. */
  ocr?: OcrFn;
  /** Copy instead of move (useful for demos and dry runs). */
  keepOriginal?: boolean;
}

export interface PipelineResult {
  decision: RouteDecision;
  entry: AuditEntry;
}

export async function processFile(sourcePath: string, opts: PipelineOptions): Promise<PipelineResult> {
  const ocr = opts.ocr ?? recognize;
  const bytes = await readFile(sourcePath);
  const hash = sha256(bytes);

  const { text, lines, confidence } = await ocr(sourcePath);
  const record = extract(text, lines);
  const checks = check(record, opts.dupes);
  const decision = decide(record, checks, path.basename(sourcePath));

  const destPath = path.join(opts.outRoot, decision.relativePath);
  await mkdir(path.dirname(destPath), { recursive: true });

  if (opts.keepOriginal) {
    await copyFile(sourcePath, destPath);
  } else {
    await rename(sourcePath, destPath);
  }

  const sidecar = {
    source: path.basename(sourcePath),
    sha256: hash,
    ocr_confidence: confidence,
    record,
    checks,
  };
  await writeFile(destPath + ".json", JSON.stringify(sidecar, null, 2) + "\n", "utf8");

  const entry: AuditEntry = {
    at: new Date().toISOString(),
    source: path.basename(sourcePath),
    sha256: hash,
    ocr_confidence: confidence,
    record,
    checks,
    decision,
  };
  await appendAudit(opts.outRoot, entry);

  return { decision, entry };
}

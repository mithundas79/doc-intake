import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256 } from "./audit.js";
import { extract } from "./extract.js";
import { recognize, type OcrFn } from "./ocr.js";
import { decide } from "./route.js";
import { check, duplicateKey } from "./rules.js";
import { durableJson, readEvents, rebuildAudit, saveEvent, stateRoot, withStateLock, type Transaction } from "./state.js";
import type { AuditEntry, DuplicateStore, RouteDecision } from "./types.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff", ".pdf"]);
export interface PipelineOptions {
  outRoot: string;
  /** Additional session store. Durable output-local identity is always used. */
  dupes?: DuplicateStore;
  ocr?: OcrFn;
  /** Defaults to true. Explicit false retains the legacy move behavior. */
  keepOriginal?: boolean;
  move?: boolean;
  dryRun?: boolean;
  maxFileBytes?: number;
}
export interface PipelineResult { decision: RouteDecision; entry: AuditEntry; }

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

/** Bounded read through an open descriptor; reject growth beyond the limit. */
async function snapshot(source: string, maxBytes: number): Promise<Buffer> {
  const h = await open(source, "r");
  try {
    const before = await h.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error(`Input must be a regular file no larger than ${maxBytes} bytes`);
    const chunks: Buffer[] = []; let size = 0;
    while (true) {
      const b = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await h.read(b, 0, b.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes`);
      chunks.push(b.subarray(0, bytesRead));
    }
    const after = await h.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Input changed while being read; retry after the copy finishes");
    if (!size) throw new Error("Input is empty; retry after the copy finishes");
    return Buffer.concat(chunks);
  } finally { await h.close(); }
}

async function availablePath(root: string, relative: string, id: string): Promise<string> {
  let candidate = relative; let suffix = 0;
  while (await exists(path.join(root, candidate)) || await exists(path.join(root, candidate + ".json"))) {
    const ext = path.extname(relative);
    candidate = relative.slice(0, relative.length - ext.length) + `--${id}-${suffix++}` + ext;
  }
  return candidate;
}

async function finish(root: string, transaction: Transaction): Promise<void> {
  const dest = path.join(root, transaction.entry.decision.relativePath);
  const stage = path.join(stateRoot(root), "staging", transaction.id);
  await mkdir(path.dirname(dest), { recursive: true });
  try { await copyFile(stage, dest, constants.COPYFILE_EXCL); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (sha256(await readFile(dest)) !== transaction.entry.sha256) throw new Error(`Recovery collision at ${dest}; original preserved`);
  }
  const json = JSON.stringify(transaction.sidecar, null, 2) + "\n";
  const sideStage = stage + ".json";
  { const h = await open(sideStage, "w");
    try { await h.writeFile(json); await h.sync(); } finally { await h.close(); } }
  try { await copyFile(sideStage, dest + ".json", constants.COPYFILE_EXCL); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (await readFile(dest + ".json", "utf8") !== json) throw new Error(`Recovery sidecar collision at ${dest}.json; existing file preserved`);
  }
  for (const file of [dest, dest + ".json"]) { const h = await open(file, "r+"); try { await h.sync(); } finally { await h.close(); } }
  transaction.entry.source_cleanup = "copied";
  if (transaction.moveSource) {
    if (!await exists(transaction.moveSource)) transaction.entry.source_cleanup = "source_missing";
    else if (sha256(await readFile(transaction.moveSource)) !== transaction.entry.sha256) transaction.entry.source_cleanup = "source_changed_preserved";
    else { await unlink(transaction.moveSource); transaction.entry.source_cleanup = "moved"; }
  }
  await saveEvent(root, transaction);
  await rebuildAudit(root);
  await rm(path.join(stateRoot(root), "pending", transaction.id + ".json"), { force: true });
  await rm(stage, { force: true }); await rm(sideStage, { force: true });
}

export async function recover(root: string): Promise<void> {
  const folder = path.join(stateRoot(root), "pending");
  let names: string[];
  try { names = await readdir(folder); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { await rebuildAudit(root); return; } throw e; }
  for (const name of names.sort()) {
    if (name.endsWith(".json")) {
      const transaction = JSON.parse(await readFile(path.join(folder, name), "utf8")) as Transaction;
      try { await finish(root, transaction); }
      catch (error) {
        // An interrupted partial copy or externally changed destination must
        // never overwrite user data or block unrelated intake forever.
        await saveEvent(root, { id: randomUUID(), at: new Date().toISOString(), source: transaction.entry.source, sha256: transaction.entry.sha256, outcome: "error", error: `Recovery quarantined ${transaction.id}: ${error instanceof Error ? error.message : String(error)}` });
        const quarantine = path.join(stateRoot(root), "quarantine"); await mkdir(quarantine, { recursive: true });
        await rename(path.join(folder, name), path.join(quarantine, name));
      }
    }
  }
  await rebuildAudit(root);
}

export async function processFile(sourcePath: string, opts: PipelineOptions): Promise<PipelineResult> {
  const root = path.resolve(opts.outRoot); const source = path.resolve(sourcePath);
  let hash: string | null = null;
  const run = async (): Promise<PipelineResult> => {
    if (!opts.dryRun) await recover(root);
    const id = randomUUID();
    if (!SUPPORTED_EXTENSIONS.has(path.extname(source).toLowerCase())) throw new Error("Unsupported file type");
    const bytes = await snapshot(source, opts.maxFileBytes ?? MAX_FILE_BYTES);
    hash = sha256(bytes);
    const committed = (await readEvents(root)).filter((e): e is Transaction => "version" in e);
    const contentDuplicate = committed.some((t) => t.entry.sha256 === hash);
    const scratch = await mkdtemp(path.join(tmpdir(), "doc-intake-"));
    let ocrResult;
    try {
      const input = path.join(scratch, "input" + path.extname(source));
      await writeFile(input, bytes);
      ocrResult = await (opts.ocr ?? recognize)(input);
    } finally { await rm(scratch, { recursive: true, force: true }); }
    const { text, lines, confidence } = ocrResult;
    const record = extract(text, lines);
    const key = record.vendor && record.number && record.total !== null ? duplicateKey(record) : null;
    const identityMatch = key !== null && committed.some((t) => t.key === key);
    if (opts.dryRun && opts.dupes && !opts.dupes.has) throw new Error("Dry-run requires DuplicateStore.has for non-mutating lookup; omit the custom store or add has(key)");
    const checks = check(record, { seenBefore: (k) => identityMatch || (opts.dupes?.has ? opts.dupes.has(k) : !opts.dryRun && opts.dupes?.seenBefore(k)) || false });
    if (contentDuplicate && !checks.some((c) => !c.ok && c.rule.startsWith("Duplicate"))) checks.push({ ok: false, rule: "Duplicate content", detail: "Exact SHA-256 bytes were already committed, including review outcomes" });
    const decision = decide(record, checks, path.basename(source));
    decision.relativePath = await availablePath(root, decision.relativePath, id);
    const entry: AuditEntry = { id, at: new Date().toISOString(), source: path.basename(source), sha256: hash, ocr_confidence: confidence, record, checks, decision, outcome: decision.action === "file" ? "filed" : "review" };
    if (opts.dryRun) return { decision, entry };
    const stage = path.join(stateRoot(root), "staging", id);
    await mkdir(path.dirname(stage), { recursive: true });
    const h = await open(stage, "wx");
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
    const transaction: Transaction = {
      version: 1, id, key, entry,
      sidecar: { id, source: path.basename(source), sha256: hash, ocr_confidence: confidence, text, record, checks, decision },
      ...((opts.move || opts.keepOriginal === false) ? { moveSource: source } : {}),
    };
    await durableJson(path.join(stateRoot(root), "pending", id + ".json"), transaction);
    await finish(root, transaction);
    if (key) opts.dupes?.seenBefore(key);
    return { decision, entry };
  };
  if (opts.dryRun) return run();
  return withStateLock(root, async () => {
    try { return await run(); }
    catch (err) {
      const event = { id: randomUUID(), at: new Date().toISOString(), source: path.basename(source), sha256: hash, outcome: "error" as const, error: err instanceof Error ? err.message : String(err) };
      try { await saveEvent(root, event); await rebuildAudit(root); }
      catch (auditError) { throw new AggregateError([err, auditError], "Processing failed and the error audit could not be persisted"); }
      throw err;
    }
  });
}

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AUDIT_FILE, sha256 } from "./audit.js";
import { duplicateKey } from "./rules.js";
import type { AuditEntry } from "./types.js";

export interface FailureEntry {
  id: string; at: string; source: string; sha256: string | null;
  outcome: "error"; error: string;
}
export interface Transaction {
  version: 1; id: string; entry: AuditEntry; key: string | null;
  sidecar: Record<string, unknown>; moveSource?: string;
}
export type JournalEvent = Transaction | FailureEntry;
export const stateRoot = (root: string) => path.join(root, ".intake");

/** Sync file content before exposing a complete JSON record through rename. */
export async function durableJson(file: string, value: unknown): Promise<void> {
  const temporary = file + "." + randomUUID() + ".tmp";
  await mkdir(path.dirname(file), { recursive: true });
  const h = await open(temporary, "wx");
  try { await h.writeFile(JSON.stringify(value) + "\n"); await h.sync(); }
  finally { await h.close(); }
  await rename(temporary, file);
}

/** Local-machine lock. A live owner is never evicted just because OCR is slow. */
export async function withStateLock<T>(root: string, fn: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const base = stateRoot(root);
  await mkdir(base, { recursive: true });
  const lock = path.join(base, "lock");
  const token = randomUUID();
  const marker = `${process.pid}-${token}`;
  const candidate = path.join(base, "candidate-" + token);
  await mkdir(path.join(candidate, marker), { recursive: true });
  const started = Date.now();
  let acquired = false;
  try {
  while (true) {
    try {
      // Publish a nonempty directory atomically. No live owner ever exposes
      // an empty lock, so rmdir can safely recover an empty interrupted lock.
      await rename(candidate, lock);
      acquired = true; break;
    } catch (err) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      try {
        const owners = await readdir(lock);
        if (!owners.length) { await rmdir(lock); continue; }
        if (owners.length !== 1 || !/^\d+-[a-f0-9-]+$/.test(owners[0]!)) throw new Error("Invalid lock owner; inspect .intake/lock");
        const owner = owners[0]!;
        try { process.kill(Number(owner.split("-")[0]), 0); }
        catch (dead) {
          if ((dead as NodeJS.ErrnoException).code === "ESRCH") {
            // Only the contender that removes this exact dead token may
            // remove its parent. A new owner has a different nonempty token.
            await rmdir(path.join(lock, owner));
            try { await rmdir(lock); } catch (e) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
            continue;
          }
        }
      } catch (e) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      }
      if (Date.now() - started > timeoutMs) throw new Error("Output is busy: timed out waiting for intake lock");
      await delay(50);
    }
  }
  return await fn();
  }
  finally {
    if (acquired) {
      const released = path.join(base, "released-" + token);
      await rename(lock, released);
      await rm(released, { recursive: true });
    } else await rm(candidate, { recursive: true, force: true });
  }
}

export async function readEvents(root: string): Promise<JournalEvent[]> {
  const folder = path.join(stateRoot(root), "events");
  let names: string[];
  try { names = await readdir(folder); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") names = []; else throw err; }
  const events: JournalEvent[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const event: unknown = JSON.parse(await readFile(path.join(folder, name), "utf8"));
    if (!event || typeof event !== "object" || !("id" in event) || typeof event.id !== "string") throw new Error(`Corrupt journal event: ${name}`);
    if ("version" in event && event.version !== 1) throw new Error(`Unsupported journal version: ${name}`);
    events.push(event as JournalEvent);
  }
  if (!await hasStateFormat(root)) events.push(...await readLegacyEvents(root));
  return [...new Map(events.map((e) => [e.id, e])).values()];
}

export async function saveEvent(root: string, event: JournalEvent): Promise<void> {
  const file = path.join(stateRoot(root), "events", event.id + ".json");
  try {
    const existing = JSON.parse(await readFile(file, "utf8")) as JournalEvent;
    if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error(`Journal event is immutable: ${event.id}`);
    return;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await durableJson(file, event);
}

async function hasStateFormat(root: string): Promise<boolean> {
  try {
    const format = JSON.parse(await readFile(path.join(stateRoot(root), "format.json"), "utf8")) as { version: number };
    if (format.version !== 1) throw new Error("Unsupported intake state format");
    return true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return false;
}

async function readLegacyEvents(root: string): Promise<Transaction[]> {
  let lines: string[] = [];
  try { lines = (await readFile(path.join(stateRoot(root), "legacy-audit.jsonl"), "utf8")).split("\n").filter((l) => l.trim()); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    try { lines = (await readFile(path.join(root, AUDIT_FILE), "utf8")).split("\n").filter((l) => l.trim()); }
    catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
  }
  return lines.map((line, index) => {
    let entry: AuditEntry;
    try { entry = JSON.parse(line) as AuditEntry; }
    catch { throw new Error("Existing audit.jsonl is not a valid legacy audit; manual migration is required"); }
    if (!entry.record || !Array.isArray(entry.checks) || !entry.decision || !["file", "review"].includes(entry.decision.action) || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.at !== "string") throw new Error("Existing audit.jsonl has unsupported records; preserved legacy audit requires manual migration");
    const id = "legacy-" + sha256(Buffer.from(`${index}:${line}`));
    entry = { ...entry, id, outcome: entry.decision.action === "file" ? "filed" : "review" };
    const rec = entry.record;
    return { version: 1, id, entry, key: rec.vendor && rec.number && rec.total !== null ? duplicateKey(rec) : null, sidecar: { legacy_import: true } };
  });
}

async function initializeState(root: string): Promise<void> {
  if (await hasStateFormat(root)) return;
  const base = stateRoot(root);
  const legacy = path.join(base, "legacy-audit.jsonl");
  try { await copyFile(path.join(root, AUDIT_FILE), legacy, constants.COPYFILE_EXCL); }
  catch (e) { if (!["ENOENT", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
  const imports = await readLegacyEvents(root);
  for (const event of imports) await saveEvent(root, event);
  await durableJson(path.join(base, "format.json"), { version: 1 });
}

/** Audit is a recoverable projection of immutable events; never the identity authority. */
export async function rebuildAudit(root: string): Promise<void> {
  await initializeState(root);
  const events = await readEvents(root);
  const lines = events.map((e) => "version" in e ? e.entry : e)
    .sort((a, b) => a.at.localeCompare(b.at) || (a.id ?? "").localeCompare(b.id ?? ""));
  const temporary = path.join(root, AUDIT_FILE + "." + randomUUID() + ".tmp");
  const h = await open(temporary, "wx");
  try { await h.writeFile(lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "")); await h.sync(); }
  finally { await h.close(); }
  await rename(temporary, path.join(root, AUDIT_FILE));
}

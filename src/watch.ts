import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./audit.js";
import { MAX_FILE_BYTES, SUPPORTED_EXTENSIONS } from "./pipeline.js";

export interface FileVersion { size: number; mtimeMs: number; ctimeMs: number; hash: string; }
export function sameVersion(a: FileVersion, b: FileVersion): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.hash === b.hash;
}
export function retryDelay(attempt: number, baseMs: number): number { return baseMs * 2 ** Math.max(0, attempt - 1); }
export async function listInputs(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const file = path.join(dir, name);
    try { if ((await lstat(file)).isFile()) files.push(file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return files;
}
interface Observation { version: FileVersion; since: number; attempts: number; next: number; done: boolean; }
export interface WatchOptions {
  stableMs?: number; retryMs?: number; maxAttempts?: number;
  now?: () => number;
  process: (file: string) => Promise<unknown>;
  onError: (file: string, error: unknown, permanent: boolean, attempt: number) => void;
}

/** A single in-flight sweep is shared by concurrent callers. A completed or
 * exhausted version is retried only when file content/metadata changes. */
export class FolderWatcher {
  private observations = new Map<string, Observation>();
  private running?: Promise<void>;
  constructor(private inbox: string, private options: WatchOptions) {}
  sweep(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run(): Promise<void> {
    const files = await listInputs(this.inbox);
    const present = new Set(files);
    for (const key of this.observations.keys()) if (!present.has(key)) this.observations.delete(key);
    for (const file of files) {
      const now = (this.options.now ?? Date.now)();
      let version: FileVersion;
      try {
        const s = await lstat(file);
        // Oversized inputs need not be buffered just to detect a version.
        version = { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, hash: s.size <= MAX_FILE_BYTES ? sha256(await readFile(file)) : "oversized" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        // Stat/read failures are handled by the same bounded processing policy.
        const existing = this.observations.get(file);
        version = existing?.version ?? { size: -1, mtimeMs: -1, ctimeMs: -1, hash: "unreadable" };
      }
      let observed = this.observations.get(file);
      if (!observed || !sameVersion(observed.version, version)) {
        observed = { version, since: now, attempts: 0, next: now, done: false };
        this.observations.set(file, observed);
      }
      if (observed.done || now - observed.since < (this.options.stableMs ?? 1000) || now < observed.next) continue;
      observed.attempts++;
      try { await this.options.process(file); observed.done = true; }
      catch (error) {
        observed.done = observed.attempts >= (this.options.maxAttempts ?? 3);
        observed.next = now + retryDelay(observed.attempts, this.options.retryMs ?? 1000);
        this.options.onError(file, error, observed.done, observed.attempts);
      }
    }
  }
}

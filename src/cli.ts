#!/usr/bin/env node
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processFile } from "./pipeline.js";
import { FolderWatcher, listInputs } from "./watch.js";

const USAGE = "usage: doc-intake <inbox-dir> [--out <dir>] [--move | --keep] [--dry-run] [--watch] [--stable-ms N] [--poll-ms N] [--retry-ms N] [--max-attempts N]";
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let inbox: string | undefined; let outRoot = "out";
  let move = false; let keep = false; let dryRun = false; let watch = false;
  const numbers: Record<string, number> = { "--stable-ms": 1000, "--poll-ms": 1000, "--retry-ms": 1000, "--max-attempts": 3 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--out") { if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(USAGE); outRoot = args[++i]!; }
    else if (arg in numbers) {
      const n = Number(args[++i]); if (!Number.isSafeInteger(n) || n < 1 || n > 3_600_000) throw new Error(USAGE); numbers[arg] = n;
    } else if (arg === "--move") move = true;
    else if (arg === "--keep") keep = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--watch") watch = true;
    else if (arg.startsWith("-") || inbox) throw new Error(USAGE);
    else inbox = arg;
  }
  if (!inbox || move && keep || watch && dryRun) throw new Error(USAGE);
  let status = 0;
  const processOne = async (file: string) => {
    const { decision } = await processFile(file, { outRoot, move, dryRun });
    if (decision.action === "review") status = Math.max(status, 1);
    const why = decision.failures.map((f) => f.rule).join("; ");
    console.log(`${dryRun ? "preview " : ""}${decision.action === "file" ? "filed" : "review"}  ${path.basename(file)} -> ${decision.relativePath}${why ? ` (${why})` : ""}`);
  };
  const onError = (file: string, error: unknown, permanent = true, attempt = 1) => {
    if (permanent) status = 2;
    console.error(`${permanent ? "error permanent" : "retry"}  ${path.basename(file)} attempt=${attempt}: ${error instanceof Error ? error.message : String(error)}`);
  };
  if (!watch) {
    for (const file of await listInputs(inbox)) {
      try { await processOne(file); } catch (error) { onError(file, error); }
    }
    return status;
  }
  const watcher = new FolderWatcher(inbox, { process: processOne, onError, stableMs: numbers["--stable-ms"], retryMs: numbers["--retry-ms"], maxAttempts: numbers["--max-attempts"] });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  console.log(`watching ${inbox}; stable=${numbers["--stable-ms"]}ms attempts=${numbers["--max-attempts"]}`);
  try {
    while (!abort.signal.aborted) {
      await watcher.sweep();
      try { await delay(numbers["--poll-ms"], undefined, { signal: abort.signal }); }
      catch (error) { if (!abort.signal.aborted) throw error; }
    }
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
  return status;
}

void main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });

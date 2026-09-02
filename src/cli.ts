#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { processFile } from "./pipeline.js";
import { SessionDuplicateStore } from "./types.js";

/*
 * doc-intake <inbox> [--out <dir>] [--watch] [--keep]
 *
 *   --out    output root (default: ./out) - receives filed/, review/, audit.jsonl
 *   --watch  keep running; poll the inbox every few seconds for new files
 *   --keep   copy documents instead of moving them
 *
 * Exit code is 0 when everything filed cleanly, 1 when anything went to
 * review, 2 on usage or processing errors - so the tool composes with make,
 * cron and CI the way a unix tool should.
 */

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"]);
const POLL_MS = 3000;

function usage(): never {
  console.error("usage: doc-intake <inbox-dir> [--out <dir>] [--watch] [--keep]");
  process.exit(2);
}

async function listImages(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  const files: string[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    if (!IMAGE_EXT.has(path.extname(n).toLowerCase())) continue;
    if ((await stat(p)).isFile()) files.push(p);
  }
  return files.sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const inbox = positional[0];
  if (!inbox) usage();

  const outIdx = args.indexOf("--out");
  const outRoot = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : "out";
  const watch = args.includes("--watch");
  const keepOriginal = args.includes("--keep");

  const dupes = new SessionDuplicateStore();
  let sawReview = false;
  const processed = new Set<string>();

  const sweep = async (): Promise<void> => {
    for (const file of await listImages(inbox)) {
      if (processed.has(file)) continue;
      processed.add(file);
      try {
        const { decision } = await processFile(file, { outRoot, dupes, keepOriginal });
        if (decision.action === "review") {
          sawReview = true;
          const why = decision.failures.map((f) => f.rule).join("; ");
          console.log(`review  ${path.basename(file)}  (${why})`);
        } else {
          console.log(`filed   ${path.basename(file)} -> ${decision.relativePath}`);
        }
      } catch (err) {
        sawReview = true;
        console.error(`error   ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  await sweep();

  if (watch) {
    console.log(`watching ${inbox} (Ctrl+C to stop)`);
    // Polling rather than fs.watch: identical behaviour on every OS, and a
    // half-written file dropped into the inbox gets picked up on a later
    // sweep instead of being read mid-copy.
    setInterval(() => void sweep(), POLL_MS);
  } else {
    process.exit(sawReview ? 1 : 0);
  }
}

void main();

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { imageSize } from "image-size";
import type { OcrLine } from "./types.js";

export interface OcrResult { text: string; lines: OcrLine[]; confidence: number; }
export type OcrFn = (imagePath: string) => Promise<OcrResult>;
export interface ExtractionLimits { maxPages: number; maxPixels: number; commandTimeoutMs: number; maxFileBytes: number; }
export const DEFAULT_LIMITS: ExtractionLimits = { maxPages: 20, maxPixels: 25_000_000, commandTimeoutMs: 60_000, maxFileBytes: 25 * 1024 * 1024 };
const run = promisify(execFile);

async function command(binary: string, args: string[], timeout: number): Promise<string> {
  try { return (await run(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" })).stdout; }
  catch (e) { throw new Error(`${path.basename(binary)} failed (install Tesseract/Poppler and check input or resource limits): ${e instanceof Error ? e.message : String(e)}`); }
}

async function image(file: string, limits: ExtractionLimits): Promise<OcrResult> {
  const dimensions = imageSize(await readFile(file));
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > limits.maxPixels) throw new Error(`Image exceeds ${limits.maxPixels} pixels or has invalid dimensions`);
  const tsv = await command(process.env.TESSERACT_BIN ?? "tesseract", [file, "stdout", "-l", "eng", "tsv"], limits.commandTimeoutMs);
  const groups = new Map<string, { text: string[]; x0: number; y0: number; x1: number; y1: number }>();
  const confidences: number[] = [];
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const fields = row.split("\t");
    if (fields[0] !== "5" || !fields[11]?.trim()) continue;
    const key = fields.slice(1, 5).join("/");
    const [x, y, w, h] = fields.slice(6, 10).map(Number) as [number, number, number, number];
    const group = groups.get(key) ?? { text: [], x0: x, y0: y, x1: x + w, y1: y + h };
    group.text.push(fields.slice(11).join("\t"));
    group.x0 = Math.min(group.x0, x); group.y0 = Math.min(group.y0, y);
    group.x1 = Math.max(group.x1, x + w); group.y1 = Math.max(group.y1, y + h);
    groups.set(key, group);
    const confidence = Number(fields[10]); if (confidence >= 0) confidences.push(confidence);
  }
  const lines = [...groups.values()].map((g) => ({ text: g.text.join(" "), bbox: { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 } }));
  if (!lines.length) throw new Error("OCR found no text");
  return { text: lines.map((l) => l.text).join("\n"), lines, confidence: confidences.reduce((a, b) => a + b, 0) / Math.max(1, confidences.length) };
}

/** Native local tools avoid first-run network access. Each child has a timeout
 * and output cap; rasterization has a bounded side length and page count. */
export async function recognizeDocument(file: string, overrides: Partial<ExtractionLimits> = {}): Promise<OcrResult> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if ((await stat(file)).size > limits.maxFileBytes) throw new Error(`Input exceeds ${limits.maxFileBytes} bytes`);
  if (path.extname(file).toLowerCase() !== ".pdf") return image(file, limits);
  const info = await command(process.env.PDFINFO_BIN ?? "pdfinfo", [file], limits.commandTimeoutMs);
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
  if (!Number.isInteger(pages) || pages < 1 || pages > limits.maxPages) throw new Error(`PDF page limit exceeded or invalid page count (maximum ${limits.maxPages})`);
  if (/^Encrypted:\s+yes/im.test(info)) throw new Error("Encrypted PDFs are unsupported; supply an unencrypted copy");
  const scratch = await mkdtemp(path.join(tmpdir(), "doc-intake-pdf-"));
  const results: OcrResult[] = [];
  try {
    for (let page = 1; page <= pages; page++) {
      const text = await command(process.env.PDFTOTEXT_BIN ?? "pdftotext", ["-f", String(page), "-l", String(page), "-layout", file, "-"], limits.commandTimeoutMs);
      if (text.replace(/\s/g, "").length >= 40) results.push({ text, lines: [], confidence: 100 });
      else {
        const prefix = path.join(scratch, `page-${page}`);
        const side = Math.min(2400, Math.floor(Math.sqrt(limits.maxPixels)));
        await command(process.env.PDFTOPPM_BIN ?? "pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile", "-scale-to", String(side), "-png", file, prefix], limits.commandTimeoutMs);
        results.push(await image(prefix + ".png", limits));
        await rm(prefix + ".png");
      }
    }
    // Page-local coordinates cannot be compared across pages. Text order is
    // preserved; vendor selection uses first-page text instead of mixed boxes.
    return { text: results.map((r) => r.text).join("\n"), lines: [], confidence: results.reduce((n, r) => n + r.confidence, 0) / results.length };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export const recognize: OcrFn = (file) => recognizeDocument(file);

import type { OcrLine } from "../../src/types.js";

interface RawPage {
  text: string; confidence: number;
  blocks?: { paragraphs?: { lines?: OcrLine[] }[] }[];
}
export interface BrowserOcrResult { text: string; confidence: number; lines: OcrLine[]; }

/** Own the native worker before initialization starts. Tesseract.js 5's public
 * factory can leave its outer promise pending when language loading fails;
 * this small adapter uses that locked version's worker message protocol so
 * errors and deadlines can always dispose initialization resources. Actual
 * load/recognize messages are verified by the real-engine browser suite. */
export class BrowserOcr {
  private worker: Worker;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private disposed = false;
  constructor(private base: string, private progress: (status: string, value: number) => void) {
    this.worker = new Worker(base + "worker.min.js");
    this.worker.onerror = (event) => {
      event.preventDefault(); this.terminate(new Error("The OCR worker could not load or execute"));
    };
    this.worker.onmessage = (event: MessageEvent) => {
      const packet = event.data;
      if (packet?.status === "progress") {
        this.progress(String(packet.data?.status ?? "Working"), Number(packet.data?.progress) || 0); return;
      }
      const request = this.pending.get(String(packet?.jobId));
      if (!request) return;
      this.pending.delete(packet.jobId);
      if (packet.status === "resolve") request.resolve(packet.data);
      else request.reject(new Error("OCR engine: " + String(packet.data)));
    };
  }

  private request(action: string, payload: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("OCR worker was stopped"));
    const jobId = `browser-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.worker.postMessage({ workerId: "guided-demo", jobId, action, payload });
    });
  }

  async recognize(canvas: HTMLCanvasElement, timeoutMs = 90_000): Promise<BrowserOcrResult> {
    const deadline = window.setTimeout(() => this.terminate(new Error("OCR exceeded its 90-second deadline")), timeoutMs);
    try {
      await this.request("load", { options: { lstmOnly: true, corePath: this.base + "core" } });
      await this.request("loadLanguage", { langs: "eng", options: { langPath: this.base + "lang", gzip: true, lstmOnly: true, cacheMethod: "none" } });
      await this.request("initialize", { langs: "eng", oem: 1, config: {} });
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Image encoding failed")), "image/png"));
      const image = new Uint8Array(await blob.arrayBuffer());
      const page = await this.request("recognize", { image, options: {}, output: { text: true, blocks: true } }) as RawPage;
      if (!page.text?.trim()) throw new Error("No readable text found");
      return { text: page.text, confidence: page.confidence, lines: (page.blocks ?? []).flatMap((block) => (block.paragraphs ?? []).flatMap((paragraph) => paragraph.lines ?? [])) };
    } finally { window.clearTimeout(deadline); this.terminate(); }
  }

  terminate(reason = new Error("OCR worker stopped")): void {
    if (this.disposed) return;
    this.disposed = true; this.worker.terminate();
    for (const request of this.pending.values()) request.reject(reason);
    this.pending.clear();
    this.worker.onmessage = null; this.worker.onerror = null;
  }
}

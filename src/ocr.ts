import Tesseract from "tesseract.js";
import type { OcrLine } from "./types.js";

/*
 * OCR wrapper. Tesseract.js runs the engine as WASM - no native
 * dependencies, no service, nothing leaves the machine. The English
 * traineddata file is fetched once on first use and cached locally.
 */

export interface OcrResult {
  text: string;
  lines: OcrLine[];
  confidence: number;
}

export type OcrFn = (imagePath: string) => Promise<OcrResult>;

export const recognize: OcrFn = async (imagePath) => {
  const r = await Tesseract.recognize(imagePath, "eng");
  return {
    text: r.data.text,
    lines: (r.data.lines ?? []).map((l) => ({ text: l.text, bbox: l.bbox })),
    confidence: r.data.confidence,
  };
};

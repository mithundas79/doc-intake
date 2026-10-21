import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(demo, "public", "ocr");
const packageRoot = (name) => path.dirname(require.resolve(name + "/package.json"));
const tesseract = packageRoot("tesseract.js");
const core = packageRoot("tesseract.js-core");
const data = packageRoot("@tesseract.js-data/eng");
const files = [
  [path.join(tesseract, "dist", "worker.min.js"), "worker.min.js"],
  [path.join(core, "tesseract-core-lstm.wasm.js"), "core/tesseract-core-lstm.wasm.js"],
  [path.join(core, "tesseract-core-simd-lstm.wasm.js"), "core/tesseract-core-simd-lstm.wasm.js"],
  [path.join(data, "4.0.0_best_int", "eng.traineddata.gz"), "lang/eng.traineddata.gz"],
];
let size = 0;
for (const [source, relative] of files) {
  const destination = path.join(output, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination); size += (await stat(destination)).size;
}
const licenses = `Browser OCR assets\n\nThese files are copied from package-lock.json dependencies during build; no\ndocument is sent to a remote OCR service.\n\nTesseract.js — MIT\nhttps://github.com/naptha/tesseract.js\n${await readFile(path.join(tesseract, "LICENSE.md"), "utf8")}\n\nTesseract.js-core / Tesseract — Apache-2.0\nhttps://github.com/naptha/tesseract.js-core\n${await readFile(path.join(core, "LICENSE"), "utf8")}\n\nEnglish traineddata: @tesseract.js-data/eng, 4.0.0_best_int.\nPackage metadata declares MIT; contributors Balearica and jeromewu.\nhttps://github.com/naptha/tessdata\nUpstream English traineddata: https://github.com/tesseract-ocr/tessdata_best\nUpstream traineddata is Apache-2.0 (license text reproduced above).\n`;
await writeFile(path.join(output, "LICENSES.txt"), licenses);
console.log(`Prepared ${files.length} same-origin OCR assets: ${(size / 1024 / 1024).toFixed(2)} MiB, with license notices.`);

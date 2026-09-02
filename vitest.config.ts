import { defineConfig } from "vitest/config";

// The default suite is fast and deterministic; the real-OCR test lives in
// its own config (vitest.ocr.config.ts) because it downloads traineddata on
// first run and takes tens of seconds. `npm test` for logic, `npm run
// test:ocr` for the engine.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/ocr.test.ts"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    include: ["test/ocr.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

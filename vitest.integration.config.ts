import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  setupFiles: ["test/setup.ts"],
  include: ["test/cli.integration.test.ts", "test/watch.integration.test.ts"],
  testTimeout: 120_000, hookTimeout: 120_000,
} });

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test", timeout: 180_000, expect: { timeout: 90_000 },
  retries: 0, workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://127.0.0.1:4173/doc-intake/", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: "npm run preview -- --host 127.0.0.1 --port 4173", url: "http://127.0.0.1:4173/doc-intake/", reuseExistingServer: false },
});

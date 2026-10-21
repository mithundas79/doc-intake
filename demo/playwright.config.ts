import { defineConfig } from "@playwright/test";

const publishedDemoURL = process.env.PUBLISHED_DEMO_URL;
if (publishedDemoURL !== undefined && publishedDemoURL !== "https://mithundas79.github.io/doc-intake/") {
  throw new Error("PUBLISHED_DEMO_URL must be exactly https://mithundas79.github.io/doc-intake/");
}
const baseURL = publishedDemoURL ?? "http://127.0.0.1:4173/doc-intake/";

export default defineConfig({
  testDir: "./test", timeout: 180_000, expect: { timeout: 90_000 },
  retries: 0, workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { browserName: "chromium", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: publishedDemoURL ? undefined : { command: "npm run preview -- --host 127.0.0.1 --port 4173", url: baseURL, reuseExistingServer: false },
});

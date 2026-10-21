import { test, expect } from "@playwright/test";

test("real OCR explains clean, duplicate, reset and incorrect-total outcomes", async ({ page }, info) => {
  const requests: { url: string; method: string }[] = [];
  const errors: string[] = [];
  let liveWorkers = 0;
  page.on("request", (request) => requests.push({ url: request.url(), method: request.method() }));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("worker", (worker) => { liveWorkers++; worker.on("close", () => { liveWorkers--; }); });
  await page.goto("./");
  await expect(page).toHaveTitle(/doc-intake/i);
  await expect(page.getByRole("heading", { name: /Read the invoice/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Clean invoice/ })).toHaveAttribute("aria-pressed", "true");
  expect(requests.filter((request) => request.url.includes("/ocr/"))).toHaveLength(0);
  const run = page.getByRole("button", { name: "Run OCR", exact: false });
  async function recognize() {
    await run.click();
    await expect(page.getByRole("status")).toContainText("OCR complete");
    await expect(run).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => liveWorkers).toBe(0);
  }
  await recognize();
  await expect(page.getByTestId("verdict").getByRole("heading", { name: "Would file", exact: true })).toBeVisible();
  await expect(page.getByTestId("record-vendor")).toHaveText("Northwind Supplies");
  await expect(page.getByTestId("record-currency")).toHaveText("USD");
  await expect(page.getByTestId("record-total")).toHaveText("677.04");
  await expect(page.getByTestId("failed-check")).toHaveCount(0);
  await expect(page.getByTestId("session-count")).toContainText("1 completed run");
  await page.evaluate(() => window.scrollTo(0, 0));
  const clean = info.outputPath(`${info.project.name}-clean.png`);
  await page.screenshot({ path: clean, fullPage: true, animations: "disabled" });
  await info.attach("clean-invoice", { path: clean, contentType: "image/png" });

  await recognize();
  await expect(page.getByTestId("verdict").getByRole("heading", { name: "Would review" })).toBeVisible();
  await expect(page.getByTestId("failed-check")).toContainText("Duplicate of a document already seen");
  await page.getByRole("button", { name: "Reset session" }).click();
  await expect(page.getByTestId("session-count")).toContainText("0 completed runs");
  await expect(page.getByRole("status")).toContainText("Duplicate memory is empty");
  await recognize();
  await expect(page.getByTestId("verdict").getByRole("heading", { name: "Would file", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Incorrect total/ }).click();
  await expect(page.getByTestId("expected-outcome")).toContainText("329.84");
  await recognize();
  await expect(page.getByTestId("verdict").getByRole("heading", { name: "Would review" })).toBeVisible();
  await expect(page.getByTestId("record-vendor")).toHaveText("Ridgeway Trading");
  await expect(page.getByTestId("record-currency")).toHaveText("USD");
  await expect(page.getByTestId("record-total")).toHaveText("349.84");
  await expect(page.getByTestId("failed-check")).toHaveCount(1);
  await expect(page.getByTestId("failed-check")).toContainText("Subtotal plus tax equals the total");
  await expect(page.getByTestId("failed-check")).toContainText("329.84");
  await page.evaluate(() => window.scrollTo(0, 0));
  const bad = info.outputPath(`${info.project.name}-review.png`);
  await page.screenshot({ path: bad, fullPage: true, animations: "disabled" });
  await info.attach("incorrect-total", { path: bad, contentType: "image/png" });
  expect(errors).toEqual([]);
  expect(requests.some((request) => request.url.includes("/doc-intake/ocr/worker.min.js"))).toBe(true);
  expect(requests.some((request) => request.url.includes("tesseract-core") && request.url.endsWith(".wasm.js"))).toBe(true);
  expect(requests.some((request) => request.url.includes("eng.traineddata.gz"))).toBe(true);
  expect(requests.every((request) => new URL(request.url).origin === "http://127.0.0.1:4173")).toBe(true);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("validates local uploads and keeps sample selection keyboard accessible", async ({ page }) => {
  await page.goto("./");
  const file = page.getByLabel("Choose an image", { exact: true });
  await file.setInputFiles({ name: "oversized.png", mimeType: "image/png", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(page.getByRole("alert")).toContainText("too large");
  await file.setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("fictional unsupported PDF") });
  await expect(page.getByRole("alert")).toContainText("PDFs are supported by the local CLI");
  await file.setInputFiles({ name: "corrupt.png", mimeType: "image/png", buffer: Buffer.from("not a valid image") });
  await expect(page.getByRole("alert")).toContainText("could not be opened");
  await expect(page.getByRole("button", { name: /Run OCR/ })).toBeEnabled();
  const sample = page.getByRole("button", { name: /Incorrect total/ });
  await sample.focus(); await page.keyboard.press("Enter");
  await expect(sample).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "Run locally", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Use the CLI for real file handling." })).toBeVisible();
});

test("failed real-worker language download is disposed and can recover without claiming a duplicate", async ({ page, context }) => {
  let liveWorkers = 0; const errors: string[] = [];
  page.on("worker", (worker) => { liveWorkers++; worker.on("close", () => { liveWorkers--; }); });
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/ocr/lang/eng.traineddata.gz", (route) => route.abort("failed"));
  await page.goto("./"); await page.getByRole("button", { name: /Run OCR/ }).click();
  await expect(page.getByRole("alert")).toContainText("OCR could not finish");
  await expect(page.getByRole("button", { name: /Run OCR/ })).toBeEnabled();
  await expect.poll(() => liveWorkers).toBe(0);
  await expect(page.getByTestId("session-count")).toContainText("0 completed runs");
  await context.unroute("**/ocr/lang/eng.traineddata.gz");
  await page.getByRole("button", { name: /Run OCR/ }).click();
  await expect(page.getByRole("status")).toContainText("OCR complete");
  await expect(page.getByTestId("verdict").getByRole("heading", { name: "Would file", exact: true })).toBeVisible();
  await expect(page.getByTestId("session-count")).toContainText("1 completed run");
  await expect.poll(() => liveWorkers).toBe(0);
  expect(errors).toEqual([]);
});

test("the initialization deadline disposes a stalled worker before allowing another run", async ({ page, context }) => {
  let liveWorkers = 0;
  page.on("worker", (worker) => { liveWorkers++; worker.on("close", () => { liveWorkers--; }); });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await context.route("**/ocr/worker.min.js", async (route) => { await hold; await route.abort("failed").catch(() => {}); });
  await page.clock.install(); await page.goto("./");
  try {
    await page.getByRole("button", { name: /Run OCR/ }).click();
    await expect(page.getByRole("button", { name: /Working/ })).toBeDisabled();
    await page.clock.fastForward(90_001);
    await expect(page.getByRole("alert")).toContainText("OCR could not finish");
    await expect.poll(() => liveWorkers).toBe(0);
    await expect(page.getByRole("button", { name: /Run OCR/ })).toBeEnabled();
  } finally { release(); await context.unroute("**/ocr/worker.min.js"); }
  await page.getByRole("button", { name: /Run OCR/ }).click();
  await expect(page.getByRole("status")).toContainText("OCR complete");
  await expect(page.getByTestId("verdict").getByRole("heading", { name: "Would file", exact: true })).toBeVisible();
  await expect.poll(() => liveWorkers).toBe(0);
});

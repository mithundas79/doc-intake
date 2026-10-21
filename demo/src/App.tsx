import { useEffect, useRef, useState } from "react";
import { BrowserOcr } from "./browser-ocr";
import { extract } from "../../src/extract.js";
import { check } from "../../src/rules.js";
import { slug } from "../../src/slug.js";
import { SessionDuplicateStore, type DocumentRecord, type RuleResult } from "../../src/types.js";
import "./styles.css";

const SOURCE = "https://github.com/mithundas79/doc-intake/tree/main";
const LOCAL_COMMANDS = [
  "git clone --branch main https://github.com/mithundas79/doc-intake.git",
  "cd doc-intake", "npm ci", "npm run build",
  "# Create inbox/ and copy samples/northwind-multipage.pdf into it",
  "node dist/cli.js inbox --out out --dry-run", "node dist/cli.js inbox --out out",
].join("\n");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_PIXELS = 16_000_000;
interface Result { record: DocumentRecord; checks: RuleResult[]; confidence: number; text: string; }
interface Sample {
  vendor: string; number: string; date: string; due: string;
  lines: Array<[string, string, string]>; subtotal: string; tax: string; total: string;
}
const SAMPLES: Record<"clean" | "bad", Sample> = {
  clean: {
    vendor: "Northwind Supplies", number: "NW-2026-0481", date: "12 Aug 2026", due: "11 Sep 2026",
    lines: [["Filter cartridges", "24", "408.00"], ["Sealing rings", "6", "171.00"], ["Delivery", "1", "45.00"]],
    subtotal: "624.00", tax: "53.04", total: "677.04",
  },
  bad: {
    vendor: "Ridgeway Trading", number: "RT-9912", date: "03 Aug 2026", due: "02 Sep 2026",
    lines: [["Pallet wrap", "12", "216.00"], ["Strapping tape", "4", "88.00"]],
    subtotal: "304.00", tax: "25.84", total: "349.84",
  },
};

/** Original fictional samples, rendered without remote fonts or customer data. */
function drawInvoice(canvas: HTMLCanvasElement, sample: Sample): void {
  canvas.width = 1000; canvas.height = 1200;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#171717"; ctx.textBaseline = "top";
  ctx.font = "bold 44px Arial"; ctx.fillText(sample.vendor, 64, 60);
  ctx.font = "bold 32px Arial"; ctx.fillText("INVOICE", 760, 66);
  ctx.font = "26px Arial"; ctx.fillText("14 Harbour Road, Portland", 64, 130);
  ctx.font = "30px Arial";
  ctx.fillText(`Invoice No: ${sample.number}`, 64, 200);
  ctx.fillText(`Invoice Date: ${sample.date}`, 64, 250);
  ctx.fillText(`Due Date: ${sample.due}`, 64, 300);
  ctx.fillText("Currency: USD", 64, 350);
  ctx.strokeStyle = "#888"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(64, 420); ctx.lineTo(936, 420); ctx.stroke();
  ctx.font = "bold 28px Arial";
  ctx.fillText("Description", 64, 444); ctx.fillText("Qty", 650, 444); ctx.fillText("Amount", 810, 444);
  ctx.font = "30px Arial";
  let y = 510;
  for (const [description, quantity, amount] of sample.lines) {
    ctx.fillText(description, 64, y); ctx.fillText(quantity, 650, y);
    ctx.textAlign = "right"; ctx.fillText(amount, 936, y); ctx.textAlign = "left"; y += 64;
  }
  ctx.beginPath(); ctx.moveTo(64, y + 4); ctx.lineTo(936, y + 4); ctx.stroke();
  y += 42;
  for (const [label, amount] of [["Subtotal", sample.subtotal], ["Tax 8.5%", sample.tax], ["Total Due", sample.total]]) {
    if (label === "Total Due") ctx.font = "bold 32px Arial";
    ctx.fillText(label, 590, y); ctx.textAlign = "right"; ctx.fillText(amount, 936, y); ctx.textAlign = "left"; y += 64;
  }
  ctx.font = "23px Arial"; ctx.fillStyle = "#555";
  ctx.fillText("Payment terms: Net 30. Please quote the invoice number.", 64, y + 44);
}

function predictedPath(record: DocumentRecord, filename: string): string {
  const extension = filename.toLowerCase().match(/\.(png|jpe?g|webp)$/)?.[0] ?? ".png";
  return `filed/${record.document_type}/${slug(record.vendor, "unknown-vendor")}_${record.date ?? "undated"}_${slug(record.number, "no-number")}${extension}`;
}

export function App(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<BrowserOcr | null>(null);
  const duplicates = useRef(new SessionDuplicateStore());
  const mounted = useRef(true);
  const generation = useRef(0);
  const active = useRef(false);
  const [selected, setSelected] = useState<"clean" | "bad" | "upload">("clean");
  const [filename, setFilename] = useState("northwind-sample.png");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready. Choose a sample, then run OCR.");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [runs, setRuns] = useState(0);

  useEffect(() => {
    mounted.current = true;
    if (canvasRef.current) drawInvoice(canvasRef.current, SAMPLES.clean);
    return () => { mounted.current = false; generation.current++; workerRef.current?.terminate(); };
  }, []);

  function chooseSample(which: "clean" | "bad"): void {
    if (active.current || !canvasRef.current) return;
    drawInvoice(canvasRef.current, SAMPLES[which]); setSelected(which);
    setFilename(which === "clean" ? "northwind-sample.png" : "ridgeway-sample.png");
    setResult(null); setError(null); setProgress(0); setStatus("Sample ready. Run OCR to see the actual checks.");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function run(): Promise<void> {
    const canvas = canvasRef.current;
    if (!canvas || active.current) return;
    active.current = true; setBusy(true); setResult(null); setError(null); setProgress(0);
    setStatus("Loading the local browser OCR worker...");
    const token = ++generation.current;
    let worker: BrowserOcr | null = null;
    const current = () => mounted.current && generation.current === token;
    try {
      const base = `${window.location.origin}${import.meta.env.BASE_URL}ocr/`;
      worker = new BrowserOcr(base, (stage, value) => {
        if (current()) { setStatus(stage.charAt(0).toUpperCase() + stage.slice(1)); setProgress(Math.round(value * 100)); }
      });
      workerRef.current = worker;
      const recognition = await worker.recognize(canvas);
      if (!current()) return;
      const record = extract(recognition.text, recognition.lines);
      const checks = check(record, duplicates.current);
      setResult({ record, checks, confidence: Math.round(recognition.confidence), text: recognition.text });
      setRuns((value) => value + 1); setProgress(100); setStatus("OCR complete. Compare the proposed fields with the document.");
    } catch {
      if (current()) {
        setError("OCR could not finish. Check that this site's OCR assets can download and that the image contains readable English text, then try again.");
        setStatus("No result was recorded. Your document has not been added to duplicate memory.");
      }
    } finally {
      if (worker) { if (workerRef.current === worker) workerRef.current = null; worker.terminate(); }
      if (current()) { active.current = false; setBusy(false); }
    }
  }

  async function loadFile(file: File): Promise<void> {
    if (active.current) return;
    setError(null);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setError("Choose a PNG, JPEG or WebP image. PDFs are supported by the local CLI, not this browser demo."); return; }
    if (file.size > MAX_UPLOAD_BYTES) { setError("This image is too large. Choose one under 10 MiB, or use the local CLI."); return; }
    active.current = true; setBusy(true); setStatus("Opening your image locally...");
    const token = ++generation.current; const url = URL.createObjectURL(file);
    const image = new Image();
    let timer: number | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error("Image decode timeout")), 15_000);
        image.onload = () => resolve(); image.onerror = () => reject(new Error("Image decode failed")); image.src = url;
      });
      if (!mounted.current || generation.current !== token) return;
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > MAX_UPLOAD_PIXELS) throw new Error("Image pixel limit");
      const canvas = canvasRef.current!;
      const scale = Math.min(1600 / image.naturalWidth, 2000 / image.naturalHeight, 1);
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      setSelected("upload"); setFilename(file.name); setResult(null); setProgress(0); setStatus("Image ready. Run OCR when you are ready.");
    } catch {
      if (mounted.current && generation.current === token) setError("This image could not be opened, or exceeds 16 million pixels. Try a smaller readable PNG, JPEG or WebP image.");
    } finally {
      window.clearTimeout(timer); image.onload = null; image.onerror = null; image.src = ""; URL.revokeObjectURL(url);
      if (mounted.current && generation.current === token) { active.current = false; setBusy(false); }
    }
  }

  function resetSession(): void {
    if (active.current) return;
    duplicates.current = new SessionDuplicateStore(); setRuns(0); setResult(null); setError(null); setProgress(0);
    setStatus("Session reset. Duplicate memory is empty; run the selected document again.");
  }

  const failures = result?.checks.filter((item) => !item.ok) ?? [];
  return (
    <div className="page">
      <header className="topbar"><a className="brand" href="#top"><span className="brand-mark" aria-hidden="true">d.</span>doc-intake</a><nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#local-setup">Run locally</a><a href={SOURCE}>GitHub &#8599;</a></nav></header>
      <main id="top">
        <section className="intro" aria-labelledby="intro-title">
          <div><p className="eyebrow">A small tool for a careful workflow</p><h1 id="intro-title">Read the invoice.<br /><span>Check the numbers.</span></h1><p className="intro-copy">Turn an invoice image into proposed fields and a reasoned routing decision. Try real OCR in your browser, then see exactly why a document would file or need a person's review.</p><div className="intro-links"><a className="text-link" href="#workspace">Try the samples <span aria-hidden="true">&#8595;</span></a><span>No account | No API key</span></div></div>
          <aside className="scope-note"><p className="eyebrow">What happens here</p><h2>Your image stays in this browser.</h2><p>OCR runs on your device. The first run downloads the worker, WebAssembly engine and English language data from this site. No document is uploaded.</p><p>This demo <strong>predicts a route</strong>. It does not copy or move files. Duplicate memory lasts until reset or page reload.</p><a href="#local-setup">Need PDFs, saved history or real file handling? &#8595;</a></aside>
        </section>

        <section className="how" id="how-it-works" aria-labelledby="how-title"><h2 id="how-title">Three steps. Every reason visible.</h2><ol><li><span>01</span><div><h3>Choose a document</h3><p>Start with a fictional sample. Nothing runs until you press Run OCR.</p></div></li><li><span>02</span><div><h3>Read and extract</h3><p>Tesseract reads the image; the shared library proposes structured fields.</p></div></li><li><span>03</span><div><h3>Check before filing</h3><p>Inspect totals, dates and duplicates. A failing check calls for review.</p></div></li></ol></section>

        <section id="workspace" className="workspace" aria-labelledby="workspace-title" aria-busy={busy}>
          <div className="section-heading"><div><p className="eyebrow">Hands-on demo</p><h2 id="workspace-title">An invoice, with the working shown.</h2></div><p data-testid="session-count">{runs} completed run{runs === 1 ? "" : "s"} this session</p></div>
          <div className="sample-grid" role="group" aria-label="Sample selection"><button className="sample" aria-pressed={selected === "clean"} disabled={busy} onClick={() => chooseSample("clean")}><span className="sample-number">A</span><span><strong>Clean invoice</strong><small>Northwind Supplies | USD 677.04</small><span className="sample-expect">Expected first run: would file</span></span></button><button className="sample" aria-pressed={selected === "bad"} disabled={busy} onClick={() => chooseSample("bad")}><span className="sample-number">B</span><span><strong>Incorrect total</strong><small>Ridgeway Trading | USD 349.84</small><span className="sample-expect">Expected: would review</span></span></button></div>
          <div className="actions"><button className="primary" onClick={() => void run()} disabled={busy}>{busy ? "Working..." : "Run OCR"}<span aria-hidden="true"> &#8599;</span></button><label className="upload">Choose an image<input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose an image" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadFile(file); }} /></label><button className="reset" disabled={busy} onClick={resetSession}>Reset session</button><span className="upload-limit">PNG, JPEG, WebP | up to 10 MiB / 16 MP</span></div>
          <div className="status-box"><p role="status" aria-live="polite">{status}</p>{busy && <progress max="100" value={progress} aria-label="Current OCR or image-loading stage progress" />}{error && <p className="error" role="alert">{error}</p>}</div>
          <p className="expected" data-testid="expected-outcome">{selected === "clean" ? "Try this: run the clean sample once to see 'Would file', then again to see duplicate review. Reset session and rerun to clear that duplicate." : selected === "bad" ? "Look for this: USD 304.00 + 25.84 = 329.84, but the image states 349.84. The total check should ask for review." : "For your own image, compare every proposed field with the source. A passing check is not proof that OCR is correct."}</p>
          <div className="work-columns"><section className="document-panel" aria-labelledby="document-title"><div className="panel-heading"><h3 id="document-title">Source document</h3><span>{selected === "upload" ? "Your local image" : "Fictional sample"}</span></div><div className="paper"><canvas ref={canvasRef} role="img" aria-label={`Invoice image: ${filename}`} /></div><p className="caption">{filename}</p></section>
            <div className="results-panel"><section className={`verdict ${result ? failures.length ? "review" : "file" : "waiting"}`} aria-labelledby="verdict-title" data-testid="verdict"><p className="eyebrow">Proposed route | no files changed</p><h3 id="verdict-title">{!result ? "Ready for a closer look" : failures.length ? "Would review" : "Would file"}</h3><p>{!result ? "Run OCR to see the extracted fields and the checks behind the decision." : failures.length ? `${failures.length} check${failures.length === 1 ? " needs" : "s need"} attention. Review the image and the reasons below.` : "All current checks passed. Check the image yourself before using these fields."}</p>{result && <code>{failures.length ? `review/${filename}` : predictedPath(result.record, filename)}</code>}</section>
              <section className="result-card" aria-labelledby="fields-title"><div className="panel-heading"><h3 id="fields-title">Extracted fields</h3>{result && <span>Engine confidence {result.confidence}%</span>}</div>{result ? <><dl className="fields"><div><dt>Vendor</dt><dd data-testid="record-vendor">{result.record.vendor ?? "Not read"}</dd></div><div><dt>Document no.</dt><dd>{result.record.number ?? "Not read"}</dd></div><div><dt>Date</dt><dd>{result.record.date ?? "Not read"}</dd></div><div><dt>Currency</dt><dd data-testid="record-currency">{result.record.currency}</dd></div><div><dt>Subtotal</dt><dd>{result.record.subtotal?.toFixed(2) ?? "Not read"}</dd></div><div><dt>Tax</dt><dd>{result.record.tax?.toFixed(2) ?? "Not read"}</dd></div><div className="total"><dt>Total</dt><dd data-testid="record-total">{result.record.total?.toFixed(2) ?? "Not read"}</dd></div></dl><p className="caption">Engine confidence measures OCR certainty, not accounting correctness.</p></> : <p className="empty">The proposed record will appear here.</p>}</section>
              <section className="result-card" aria-labelledby="checks-title"><div className="panel-heading"><h3 id="checks-title">Rule checks</h3>{result && <span>{result.checks.filter((item) => item.ok).length}/{result.checks.length} passed</span>}</div>{result ? <ul className="checks">{result.checks.map((item) => <li key={item.rule} data-testid={item.ok ? "passing-check" : "failed-check"}><span className={`check-icon ${item.ok ? "pass" : "fail"}`} aria-label={item.ok ? "Passed" : "Needs review"}>{item.ok ? "\u2713" : "!"}</span><div><strong>{item.rule}</strong><p>{item.detail}</p></div></li>)}</ul> : <p className="empty">Totals, dates and duplicate checks will appear after OCR.</p>}</section>
              {result && <details className="result-card raw"><summary>Inspect recognized text and JSON</summary><h4>OCR text</h4><pre>{result.text}</pre><h4>Structured record</h4><pre>{JSON.stringify(result.record, null, 2)}</pre></details>}
            </div></div>
        </section>

        <section className="local-setup" id="local-setup" aria-labelledby="setup-title"><div><p className="eyebrow">Take the full workflow offline</p><h2 id="setup-title">Use the CLI for real file handling.</h2><p>The local TypeScript tool adds durable duplicate history, safe copy-by-default routing, multi-page PDFs, native Tesseract/Poppler and an auditable record.</p><p>Install Node.js 20+, Tesseract 5 with English data, and Poppler. The complete README covers Windows/Linux setup, explicit moves, dry-run, watch mode and limits.</p><a className="text-link" href={`${SOURCE.replace("/tree/", "/blob/")}/README.md`}>Full installation and test guide &#8599;</a></div><pre aria-label="Local setup commands"><code>{LOCAL_COMMANDS}</code></pre></section>
        <p className="honest-limit">A useful guardrail, not an accuracy guarantee. English invoice heuristics can miss errors, and unfamiliar layouts may need manual review. This page does not approve payments or store durable document history.</p>
      </main>
      <footer><a className="brand" href="#top">doc-intake</a><p>Fictional samples | MIT licensed | Real browser OCR</p><nav aria-label="Related projects"><a href={SOURCE}>Source</a><a href="https://github.com/mithundas79/filing-agent">filing-agent</a><a href="https://github.com/mithundas79/doc-intake-service">doc-intake-service</a></nav></footer>
    </div>
  );
}

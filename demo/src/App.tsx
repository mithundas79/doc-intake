import { useCallback, useEffect, useRef, useState } from "react";
import Tesseract from "tesseract.js";
import { extract } from "../../src/extract.js";
import { check } from "../../src/rules.js";
import { slug } from "../../src/slug.js";
import { SessionDuplicateStore, type DocumentRecord, type OcrLine, type RuleResult } from "../../src/types.js";

/*
 * The demo runs the same extraction and rule modules the CLI runs - imported
 * from ../src, not copied. OCR happens in this browser via tesseract.js;
 * nothing is uploaded anywhere.
 */

const dupes = new SessionDuplicateStore();

interface Result {
  record: DocumentRecord;
  checks: RuleResult[];
  confidence: number | null;
}

function drawInvoice(
  cv: HTMLCanvasElement,
  o: {
    vendor: string;
    number: string;
    date: string;
    due: string;
    lines: Array<[string, string, string]>;
    subtotal: string;
    tax: string;
    total: string;
  },
): void {
  const ctx = cv.getContext("2d")!;
  cv.width = 900;
  cv.height = 1160;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "#111111";
  ctx.textBaseline = "top";
  ctx.font = "700 44px Georgia, serif";
  ctx.fillText(o.vendor, 60, 60);
  ctx.font = "400 24px Georgia, serif";
  ctx.fillText("14 Harbour Road, Portland", 60, 118);
  ctx.font = "700 34px Georgia, serif";
  ctx.fillText("INVOICE", 620, 60);
  ctx.font = "400 24px Georgia, serif";
  ctx.fillText("Invoice No: " + o.number, 480, 116);
  ctx.fillText("Invoice Date: " + o.date, 480, 152);
  ctx.fillText("Due Date: " + o.due, 480, 188);
  ctx.strokeStyle = "#999";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(60, 250);
  ctx.lineTo(840, 250);
  ctx.stroke();
  ctx.font = "700 24px Georgia, serif";
  ctx.fillText("Description", 60, 274);
  ctx.fillText("Qty", 560, 274);
  ctx.fillText("Amount", 700, 274);
  ctx.font = "400 26px Georgia, serif";
  let y = 330;
  for (const [d, q, a] of o.lines) {
    ctx.fillText(d, 60, y);
    ctx.fillText(q, 560, y);
    ctx.fillText(a, 700, y);
    y += 52;
  }
  ctx.beginPath();
  ctx.moveTo(60, y + 10);
  ctx.lineTo(840, y + 10);
  ctx.stroke();
  y += 44;
  ctx.fillText("Subtotal", 520, y);
  ctx.fillText(o.subtotal, 700, y);
  y += 46;
  ctx.fillText("Tax 8.5%", 520, y);
  ctx.fillText(o.tax, 700, y);
  y += 46;
  ctx.font = "700 28px Georgia, serif";
  ctx.fillText("Total Due", 520, y);
  ctx.fillText(o.total, 700, y);
  ctx.font = "400 22px Georgia, serif";
  ctx.fillStyle = "#555";
  ctx.fillText("Payment terms: Net 30. Please quote the invoice number.", 60, y + 90);
}

const SAMPLES = {
  clean: {
    vendor: "Northwind Supplies",
    number: "NW-2026-0481",
    date: "12 Aug 2026",
    due: "11 Sep 2026",
    lines: [
      ["Filter cartridges 10 in", "24", "408.00"],
      ["Sealing rings box of 50", "6", "171.00"],
      ["Delivery", "1", "45.00"],
    ] as Array<[string, string, string]>,
    subtotal: "624.00",
    tax: "53.04",
    total: "677.04",
  },
  bad: {
    vendor: "Ridgeway Trading",
    number: "RT-9912",
    date: "03 Aug 2026",
    due: "02 Sep 2026",
    lines: [
      ["Pallet wrap 500m", "12", "216.00"],
      ["Strapping tape", "4", "88.00"],
    ] as Array<[string, string, string]>,
    subtotal: "304.00",
    tax: "25.84",
    total: "349.84",
  },
};

function wouldBeName(rec: DocumentRecord): string {
  return [
    slug(rec.vendor, "unknown-vendor"),
    rec.date ?? "undated",
    slug(rec.number, "no-number"),
  ].join("_");
}

export function App(): JSX.Element {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("Loading a sample…");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const run = useCallback(async () => {
    const cv = cvRef.current;
    if (!cv) return;
    setBusy(true);
    setStatus("Reading with OCR in this browser…");
    try {
      const r = await Tesseract.recognize(cv, "eng");
      const lines: OcrLine[] = (r.data.lines ?? []).map((l) => ({ text: l.text, bbox: l.bbox }));
      const record = extract(r.data.text, lines);
      setResult({ record, checks: check(record, dupes), confidence: Math.round(r.data.confidence) });
      setStatus("Done");
    } catch {
      setStatus("OCR engine failed to load (offline?) — try again online.");
    } finally {
      setBusy(false);
    }
  }, []);

  const loadSample = useCallback(
    (which: keyof typeof SAMPLES) => {
      const cv = cvRef.current;
      if (!cv) return;
      drawInvoice(cv, SAMPLES[which]);
      void run();
    },
    [run],
  );

  const loadFile = useCallback(
    (file: File) => {
      const cv = cvRef.current;
      if (!cv) return;
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(900 / img.width, 1160 / img.height, 1);
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        const ctx = cv.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        void run();
      };
      img.src = URL.createObjectURL(file);
    },
    [run],
  );

  useEffect(() => {
    loadSample("clean");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fails = result?.checks.filter((c) => !c.ok) ?? [];

  return (
    <div className="wrap">
      <style>{CSS}</style>
      <header>
        <h1>doc-intake</h1>
        <p className="lede">
          Documents in, order out. OCR runs in <b>this browser</b>; the same
          deterministic rules as the CLI decide whether the document files
          itself or waits for a person. Nothing is uploaded anywhere.{" "}
          <a href="https://github.com/mithundas79/doc-intake">Source on GitHub</a>.
          {" "}This image demo remembers duplicates for this browser session only.
          The offline CLI adds durable duplicate history, PDF support and safe file copying.
        </p>
      </header>

      <div className="bar">
        <button disabled={busy} onClick={() => loadSample("clean")}>
          Clean sample
        </button>
        <button disabled={busy} onClick={() => loadSample("bad")}>
          Sample with a problem
        </button>
        <label className="file">
          Choose an image
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadFile(f);
            }}
          />
        </label>
        <span className="status">{status}</span>
      </div>

      <div className="cols">
        <div className="card">
          <h2>Document</h2>
          <canvas ref={cvRef} />
          {result?.confidence != null && (
            <p className="muted">Tesseract confidence {result.confidence}%.</p>
          )}
        </div>

        <div>
          <div className="card">
            <h2>Extracted record</h2>
            <pre>{result ? JSON.stringify(result.record, null, 2) : "…"}</pre>
          </div>

          <div className="card">
            <h2>Rule checks</h2>
            {result?.checks.map((c, i) => (
              <div key={i} className="rule">
                <span className={c.ok ? "pill ok" : "pill bad"}>{c.ok ? "pass" : "check"}</span>
                <div>
                  <b>{c.rule}</b>
                  <div className="muted">{c.detail}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Verdict</h2>
            {result &&
              (fails.length === 0 ? (
                <p>
                  <span className="pill ok">files itself</span>{" "}
                  <code>
                    filed/{result.record.document_type}/{wouldBeName(result.record)}.png
                  </code>
                </p>
              ) : (
                <p>
                  <span className="pill bad">held for review</span>{" "}
                  <span className="muted">
                    {fails.length} rule{fails.length > 1 ? "s" : ""} failed — this document goes to
                    a person, under its original name. That is the correct outcome, not a failure.
                  </span>
                </p>
              ))}
          </div>
        </div>
      </div>

      <footer className="muted">
        Browser OCR is deliberately weaker than a production OCR+LLM pipeline — when it misreads,
        the rules catch it and refuse to file. MIT licensed.
      </footer>
    </div>
  );
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f8fa; color: #0f172a;
         font: 15px/1.5 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 40px; }
  h1 { margin: 0; font-size: 28px; }
  .lede { color: #475569; max-width: 70ch; }
  a { color: #0891b2; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 14px 0 18px; }
  button, .file { border: 1.5px solid #cbd5e1; background: #fff; border-radius: 8px;
                  padding: 8px 14px; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  .file input { display: none; }
  .status { color: #64748b; font-size: 13px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .card { background: #fff; border: 1.5px solid #e2e8f0; border-radius: 10px;
          padding: 14px 16px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 10px; font-size: 15px; }
  canvas { width: 100%; border: 1.5px solid #e2e8f0; border-radius: 8px; background: #fff; }
  pre { margin: 0; font-size: 12.5px; overflow-x: auto; }
  .rule { display: flex; gap: 10px; padding: 8px 0; border-top: 1px solid #eef2f6; font-size: 13.5px; }
  .pill { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
  .pill.ok { background: #ecfdf5; color: #0f766e; }
  .pill.bad { background: #fff7ed; color: #b45309; }
  .muted { color: #64748b; font-size: 13px; }
  code { background: #f1f5f9; border-radius: 6px; padding: 2px 6px; font-size: 12.5px; }
  footer { margin-top: 8px; }
`;

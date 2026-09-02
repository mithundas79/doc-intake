# doc-intake

**Documents in, order out. No cloud, no API key, no model.**

Drop scanned invoices, receipts and statements into a folder. `doc-intake` reads
them with OCR ([Tesseract](https://github.com/naptha/tesseract.js), running as
WASM on your machine), extracts the fields, and then — the part that matters —
puts every document through a set of **deterministic accounting rules** that
decide what happens next:

- every rule passes → renamed `vendor_date_number.ext` and filed under
  `filed/<type>/`, with a JSON sidecar holding the extracted record
- any rule fails → moved to `review/` **under its original name**, with the
  failing rules written down

Every decision is appended to an audit log. Nothing is guessed, nothing is
silently dropped, and nothing ever leaves your machine.

```
inbox/scan_0001.png
        │
        ▼
   ┌─────────┐    ┌─────────────┐    ┌───────────────┐    ┌─────────────────┐
   │  OCR    │ →  │  extract    │ →  │  rules decide │ →  │ file or review  │
   │ (local) │    │ fields      │    │  (all six)    │    │ + audit.jsonl   │
   └─────────┘    └─────────────┘    └───────────────┘    └─────────────────┘
```

## Why this exists

Most document-AI failures are not extraction failures — they are *silence*
failures: a wrong total posted without complaint, a duplicate paid twice, a
credit note recorded as a negative invoice. The fix is not a better model, it
is a rule layer with the authority to say "a person looks at this one."

The rules here are distilled from a production bookkeeping pipeline:

1. **Vendor identified** — something usable at the top of the document
2. **Document number found** — without one, de-duplication is unsafe
3. **Date read** — a posting date must never be guessed
4. **Subtotal + tax = total** — the totals must foot
5. **Line items sum to the subtotal** — within a tolerance
6. **Not a duplicate** — vendor + number + amount, against everything seen
7. **Document type recognised** — and a credit note is never a negative invoice

## Quickstart

```bash
git clone https://github.com/mithundas79/doc-intake
cd doc-intake
npm ci
npm test              # fast, deterministic suite (~2s)

# process a folder of scans once:
npx tsx src/cli.ts path/to/inbox --out out

# or keep watching for new files:
npx tsx src/cli.ts path/to/inbox --out out --watch
```

Try it immediately with the committed sample:

```bash
mkdir -p /tmp/inbox && cp samples/northwind-invoice.png /tmp/inbox/
npx tsx src/cli.ts /tmp/inbox --out /tmp/out
# filed   northwind-invoice.png -> filed/invoice/northwind-supplies_2026-08-12_nw-2026-0481.png
```

The first OCR run downloads the English traineddata file once and caches it.

Exit codes are unix-friendly: `0` everything filed, `1` something needs review,
`2` usage or processing error — so the CLI composes with `make`, cron and CI.

## What lands where

```
out/
├── audit.jsonl                # one line per document, append-only
├── filed/
│   └── invoice/
│       ├── northwind-supplies_2026-08-12_nw-2026-0481.png
│       └── northwind-supplies_2026-08-12_nw-2026-0481.png.json   # sidecar
└── review/
    └── IMG_4471.jpg           # original name kept - see below
```

The sidecar carries the OCR text, the extracted record, the rule results and a
sha256 of the original bytes, so downstream tools (see
[filing-agent](https://github.com/mithundas79/filing-agent)) never need to
re-read the image.

Documents sent to review keep their **original filename** deliberately:
renaming a document you don't yet trust destroys the one identifier a person
can still search their inbox for.

## Design rules

- **Nothing leaves the machine.** No upload, no telemetry, no API. The only
  network access ever is Tesseract fetching its traineddata once.
- **The rules decide, not the extractor.** Extraction proposes a record; the
  rule layer has the only authority over what gets filed.
- **Failing is a feature.** A document in `review/` with reasons attached is
  the correct outcome for messy input — not an error.
- **Money is parsed conservatively.** Amounts are only ever read from
  two-decimal tokens, so `Tax 8.5%` can never become a tax amount, and `Total`
  is never matched inside `Subtotal`.
- **Every claim is auditable.** Hash, record, rule results and routing decision
  for every document, in `audit.jsonl`, forever.

## Tests

```bash
npm test            # 26 unit + integration tests, OCR injected, ~2s
npm run test:ocr    # the real engine against the committed sample image
```

The default suite injects the OCR step so it is fast and deterministic. The
real-engine test is separate because it downloads traineddata on first run.

## Honest limits

- Tesseract on a phone photo is far weaker than a production OCR + LLM
  pipeline. That is partly the point: when OCR misreads, the **rules catch it
  and refuse to file** rather than guessing.
- Field extraction is line-based English-first heuristics. It reads clean
  invoices well; exotic layouts will land in `review/` — which is where they
  belong.
- Duplicate detection is per-run by default (`SessionDuplicateStore`); wire in
  your own `DuplicateStore` for durable memory.

## License

MIT © Mithun Das

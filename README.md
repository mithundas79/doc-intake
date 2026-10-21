# doc-intake

**Local document intake for people who need to see the checks, not just the extracted text.**

doc-intake is a TypeScript library and folder-based CLI for bookkeepers,
developers and individuals organizing invoices on one computer. Give it invoice
images or PDFs; it proposes structured fields, checks the numbers and routes a
copy into `filed/<type>/` or `review/`. JSON sidecars and audit records explain
each decision. Originals stay intact by default.

**[Try the browser OCR demo](https://mithundas79.github.io/doc-intake/)** |
[Feature-branch source](https://github.com/mithundas79/doc-intake/tree/feature/durable-offline-intake)

The published demo currently follows `main`. The improved guided demo described
here is prepared in PR #2 and awaits the normal Pages deployment; pushing this
feature branch alone does not publish it.

| Input | Local CLI output |
| --- | --- |
| A folder of image scans or multi-page PDFs | Copied documents under `filed/` or `review/` |
| A chosen output folder | JSON sidecars with proposed fields, source hashes, actual routes and check reasons |
| Repeated or watched-folder runs | Persistent duplicate review and recoverable audit history |

Features include native OCR, embedded/scanned PDF extraction, total and
line-item arithmetic checks, durable duplicates, bounded folder watching,
collision-safe names and mutation-free previews. A failed check asks for a
person's review. OCR and English invoice heuristics can miss errors: passing
checks are not proof of correctness or permission to pay an invoice.

Related projects: [doc-intake-service](https://github.com/mithundas79/doc-intake-service)
adds a correction/approval UI; [filing-agent](https://github.com/mithundas79/filing-agent)
provides a local-model controller with evidence checks.

## Try the guided browser demo

The demo runs actual Tesseract OCR and the same `extract`/`check` modules as the
CLI. Select a sample, then press **Run OCR**:

1. **Clean invoice:** Northwind, USD 677.04. First run: **Would file**. Run it
   again: duplicate review.
2. **Reset session:** clears the result and session duplicate memory. Run the
   clean sample again to get the first-run outcome.
3. **Incorrect total:** Ridgeway states USD 349.84, but 304.00 + 25.84 = 329.84.
   The total check should say **Would review**. Inspect the image, proposed
   fields and rule reasons rather than accepting OCR blindly.

These fictional samples are read live, not prerecorded responses. You can
also choose a local PNG/JPEG/WebP under 10 MiB and 16 million pixels. The
browser only predicts routing: it does not copy/move files, write the CLI audit,
keep duplicates across reloads, or process PDFs.

The built site includes about 10.5 MiB of worker, WebAssembly and English data
assets. A first OCR run downloads only its device-selected core and language
data from this site; browser caching can reduce later downloads. **Your images
are processed on your device and are not uploaded.** An initial network
connection is needed for the engine assets; fully cached offline browser use
is not guaranteed. Use the CLI for the offline workflow.

## Fresh-clone local installation

Use **Node.js 20+**, **Tesseract 5 with English traineddata**, and **Poppler**
(`pdfinfo`, `pdftotext`, `pdftoppm`) on PATH. No Python or paid account is needed.
Until this work is merged, clone the implemented feature branch.

Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils
git clone --branch feature/durable-offline-intake https://github.com/mithundas79/doc-intake.git
cd doc-intake
npm ci
npm run build
mkdir inbox
cp samples/northwind-multipage.pdf inbox/
node dist/cli.js inbox --out out --dry-run
node dist/cli.js inbox --out out
node dist/cli.js inbox --out out
# First real run exits 0; repeated run exits 1 for duplicate review.
```

Windows: install Tesseract 5 including English data and a Windows Poppler
distribution. Add their binary directories to PATH, open a new PowerShell
window and verify `tesseract --version`, `pdfinfo -v`, `pdftotext -v`,
`pdftoppm -v`. Then:

```powershell
git clone --branch feature/durable-offline-intake https://github.com/mithundas79/doc-intake.git
Set-Location doc-intake
npm ci
npm run build
New-Item -ItemType Directory -Force inbox
Copy-Item samples/northwind-multipage.pdf inbox/
node dist/cli.js inbox --out out --dry-run
node dist/cli.js inbox --out out
node dist/cli.js inbox --out out
# First real run: exit 0; repeated run: exit 1 for duplicate review.
```

`TESSERACT_BIN`, `PDFINFO_BIN`, `PDFTOTEXT_BIN`, `PDFTOPPM_BIN` can name absolute
executable paths. They are trusted local configuration, never document input.
The CLI invokes local tools: no API calls, document uploads or first-run model
download. Install dependencies and traineddata before taking it offline.

## Run the CLI

```bash
node dist/cli.js inbox --out out                 # copy by default
node dist/cli.js inbox --out out --keep          # compatible copy alias
node dist/cli.js inbox --out out --move          # explicitly remove sources after durable output
node dist/cli.js inbox --out out --dry-run       # preview without persistent mutations
node dist/cli.js inbox --out out --watch         # stable-file polling, bounded retries
```

Only top-level regular `.png`, `.jpg`, `.jpeg`, `.bmp`, `.webp`, `.tif`, `.tiff`,
`.pdf` files are considered. Subfolders, symlinks and other extensions are
ignored; direct library calls reject unsupported types.

| Exit | Meaning |
| --- | --- |
| 0 | All processed documents filed, or no supported inputs |
| 1 | At least one document needs review, including duplicates |
| 2 | Usage, listing, extraction, storage, recovery or permanent watch error; dominates review |

Preview uses the same codes. Processing errors go to stderr and an `error`
audit event when output storage is available. Usage/listing/lock errors can
happen before auditing is possible. Watch handles SIGINT/SIGTERM, finishes its
sweep and uses the accumulated status; a transient attempt followed by success
remains audited but does not alone cause exit 2.

Preview uses temporary extraction scratch but does not mutate inputs, output
directories, duplicate state or audit records. `--move` with preview is safe;
`--watch` with preview and `--move` with `--keep` are rejected. Predictions are
a snapshot; concurrent writes or pending recovery may affect the next real run.

## Copy-default and state migration

Older versions moved sources by default. **The default now preserves sources.**
Use `--move` for deletion. Library `keepOriginal: false` still explicitly moves;
omitting it now copies.

The first upgraded real run imports valid old `audit.jsonl` history and saves
an exact backup at `.intake/legacy-audit.jsonl`. Existing originals and sidecars
stay intact. Imported filed and reviewed identities are remembered; even a
preview before migration consults legacy identities without writing. Invalid
legacy audit data is preserved and rejected for manual migration. Back up the
whole output folder before upgrading; do not edit journal files by hand.

## Identity, outputs and recovery

The output root contains `filed/`, `review/`, `audit.jsonl`, and `.intake/`.
Keep `.intake/` with the outputs when moving or backing up a collection.

Duplicates match either SHA-256 source bytes or normalized vendor + number +
currency + type + total. Normalization uses Unicode NFKC, lowercase and collapsed
whitespace. Business identity requires vendor, number and total; byte identity
still works with unread fields. Date is excluded so a changed posting date
cannot bypass review. Different amounts, currencies or types are distinct
business identities. This is a review signal, not payment authorization.

Both filed and reviewed documents claim identities after complete outputs.
Failed processing does not. Repeated reviewed documents produce another review
copy; this CLI has no correction/approval workflow. A separate output folder
has separate duplicate history.

Routes prefer `filed/<type>/vendor_date_number.ext` and
`review/original-filename.ext`. If the document **or** sidecar already exists,
a transaction suffix is added; unrelated outputs are never replaced. Actual
routes, transaction IDs and hashes associate sidecars and audit entries.

Local PID/token locks serialize output writers and recover dead owners without
age-based eviction of live writers. Synced pending manifests/output bytes allow
replay after interruption. CLI startup resumes existing pending commits even
if an explicit move emptied the inbox; preview leaves them untouched. A partial
or conflicting output is preserved, the manifest goes to `.intake/quarantine/`
and the run reports exit 2 while other intake can continue. Inspect the source,
staged bytes and error before manually cleaning up.

Immutable `.intake/events/*.json` records are the authoritative history.
`audit.jsonl` is their atomically rebuilt projection, avoiding duplicate/partial
lines after interrupted appends. A hard kill before commit cannot produce an
error event. Changed move sources are preserved with
`source_cleanup: "source_changed_preserved"`; do not modify move inputs while
they are being handled.

Use a local filesystem with exclusive-create/rename semantics. Network shares
and multiple hosts sharing state are unsupported. Fsync/rename help recovery
but cannot guarantee power-loss behavior on every filesystem/device. History
grows and is read per document; this is a local tool, not a high-volume queue.

## Watch behavior

Defaults: polls every second, waits one stable second, attempts a file version
up to three times with 1/2-second retry delays. Options: `--poll-ms N`,
`--stable-ms N`, `--retry-ms N`, `--max-attempts N` (positive integers).
Bounded descriptor snapshots compare size, timestamps and content; changing
files are retried. Shared in-flight sweeps prevent overlapping processing.
Changed content at a reused filename resets observation/retry state.

After the last failure, stderr says `error permanent` and that version stops
retrying. Content/metadata changes or watch restart allow another bounded
sequence. Watch observations reset at restart; durable identities do not.
No stable interval proves a producer will never resume writing: prefer copying
to an unsupported temporary extension, then atomically renaming the finished
file. Increase stability time for slow producers.

## Extraction and parsing limits

- **25 MiB input, 20 PDF pages, 25 million image pixels.** PDF pages with at
  least 40 non-whitespace extracted characters use embedded text; sparser
  pages are rasterized/OCRed. Mixed PDFs can use both paths. A scan with a
  substantial unrelated text overlay may need image conversion to force OCR.
- PDF rasterization uses at most 2400 pixels on the longest side. Native
  commands have 60-second deadlines and 8 MiB output caps. These limits are
  not OS process-memory sandboxes. Image containers use their first frame;
  use PDF for multiple pages. Split bundles of invoices into separate files.
- English invoice heuristics can misread complex tables, repeated headers or
  multiple tax rows. Statements/receipts lacking invoice-style totals need
  human review. Complex split GST is not summed automatically.
- USD (`$`, `USD`), EUR (`EUR`, euro symbol), GBP (`GBP`, pound symbol), INR
  (`INR`, rupee symbol, `Rs`/`Rs.` before digits). Missing currency keeps the
  legacy USD default; conflicting indicators need review. `$` does not
  distinguish other dollar currencies.
- Money needs a dot and exactly two decimals. Ungrouped, Western
  `1,234,567.89`, and Indian `12,34,567.89` grouping work. Comma decimals,
  malformed groups, percentages and overprecision are rejected as whole
  tokens; locale conventions are never guessed.
- Valid ISO and long English dates normalize to ISO. Numeric `03/04/2026`
  stays raw for API compatibility but fails the posting-date rule. Impossible
  calendar dates fail; day/month order is never inferred.
- Rules check vendor, number, unambiguous date, subtotal + tax, item sums,
  duplicates and recognized type. They cannot prove authenticity or catch
  every extraction error. Always review records before financial use.

## Library and browser development

```ts
import { processFile } from "doc-intake";
const result = await processFile("inbox/scan.pdf", { outRoot: "out" });
console.log(result.entry.outcome, result.decision.relativePath);
```

Pure `extract`, `check`, `decide`, `recognize`, injected `OcrFn` and session
stores remain available. `processFile` always uses durable output-local history;
optional `dupes` adds session history. Custom `seenBefore(key)` stores work
in real processing but may mutate during lookup. Add non-mutating `has(key)`
for previews; preview rejects custom stores without it. Currency now includes
`INR`; update exhaustive switches. `recognizeDocument(file, limits)` exposes
PDF/image resource options. `recoverExistingOutput` resumes pending state.

```bash
npm ci --prefix demo
npm --prefix demo run dev
# Open http://localhost:5173/doc-intake/
npm --prefix demo run build
npm --prefix demo run preview -- --host 127.0.0.1 --port 4173
# Open http://localhost:4173/doc-intake/
```

Build preparation copies locked Tesseract.js worker, SIMD/non-SIMD LSTM cores
and English data into the site (10.45 MiB), with `ocr/LICENSES.txt`. Browser
workers terminate after a run; image object URLs are revoked, and upload/OCR
errors do not claim session identity. Native PDF processing, durable history,
copy/move and filesystem auditing belong to the CLI/library.
The small browser worker adapter targets the exact locked Tesseract.js 5.1.1
message protocol so it can own initialization resources and terminate failed
downloads/deadlines. Dependency upgrades must pass the real-worker success,
failed-download and deadline/recovery browser checks before publication.

## Tests and verification

```bash
npm ci
npm run build
npm test                    # parsing, identity, routing, retry/stability and filesystem regressions
npm run test:ocr            # actual native Tesseract/Poppler on committed fictional samples
npm run test:integration    # separate CLI processes, restart/concurrency and watched folders
npm ci --prefix demo
npm --prefix demo run build
cd demo
npx playwright install --with-deps chromium
npm run test:browser        # builds and tests /doc-intake/ in real Chromium
```

CI installs native tools and runs all suites. Browser checks on Ubuntu 24.04
use real OCR on desktop/mobile: clean, duplicate, reset, incorrect total, bounded
uploads, keyboard controls, same-origin GET-only engine requests and responsive
layout. They capture screenshots and upload reports plus the static build as
workflow artifacts. No OCR responses are mocked.

Pages publication uses the existing `github-pages` environment and branch
policy. This feature does not relax deployment gates. See
[implementation status](docs/implementation-status.md) for observed results and
[sample provenance](samples/README.md) for fixture sources. All samples are
fictional and rights-safe; no paid service is required.

## License

MIT - Mithun Das

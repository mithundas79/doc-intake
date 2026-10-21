# doc-intake

**Documents in, order out. Local OCR and deterministic accounting checks.**

An offline TypeScript library and CLI for a single user's invoice folder. It
extracts fields, checks dates/amounts/duplicates and copies each document into
`filed/<type>/` or `review/`, with a JSON sidecar and an audit trail. A failed
check means human review; extraction/storage failures mean a processing error.
Original documents are preserved by default.

[Browser image demo](https://mithundas79.github.io/doc-intake/) ·
[Full-stack review application](https://github.com/mithundas79/doc-intake-service)

## Fresh checkout

Use Node.js 20 or later, native **Tesseract 5** with English traineddata, and
**Poppler** (`pdfinfo`, `pdftotext`, `pdftoppm`) on PATH. On Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils
git clone https://github.com/mithundas79/doc-intake.git
cd doc-intake
npm ci
npm run build
mkdir inbox
cp samples/northwind-multipage.pdf inbox/
node dist/cli.js inbox --out out --dry-run
node dist/cli.js inbox --out out
node dist/cli.js inbox --out out
# First real run exits 0 (filed); repeated run exits 1 (duplicate for review).
```

On Windows install Tesseract and a Windows Poppler distribution, add their
binary directories to PATH, and use `New-Item -ItemType Directory inbox` and
`Copy-Item samples/northwind-multipage.pdf inbox/` for the two filesystem steps.
`TESSERACT_BIN`, `PDFINFO_BIN`, `PDFTOTEXT_BIN` and `PDFTOPPM_BIN` can each name
an executable by absolute path. These variables are local configuration; never
set them from untrusted document content. No Python runtime is needed.

The CLI invokes local tools and does not download traineddata, call an API or
upload documents. Install dependencies/traineddata before taking it offline.

## CLI behavior and migration

```bash
node dist/cli.js inbox --out out                 # copy originals (default)
node dist/cli.js inbox --out out --keep          # compatible copy alias
node dist/cli.js inbox --out out --move          # explicitly remove originals after durable output
node dist/cli.js inbox --out out --dry-run       # compute a preview, no persistent mutations
node dist/cli.js inbox --out out --watch         # stable-file polling and bounded retries
```

**Intentional change:** older versions moved sources by default. The default
now copies; use `--move` to opt into deletion. Library callers can also use the
legacy explicit `keepOriginal: false`; omitting it now preserves the input.
`--move` and `--keep` conflict. Preview can be combined with `--move`, but not
with continuous `--watch`.

Preview reads input/state and uses temporary scratch for extraction. It does
not create/change input files, output directories, audit records, duplicate
identities or supplied session stores. Its predicted filename/duplicate result
is a snapshot: a concurrent writer or pending recovery may change the next
real run's decision.

The first upgraded real run imports a valid pre-upgrade `audit.jsonl` into the
new journal, keeping an exact backup at `.intake/legacy-audit.jsonl`. Existing
file/review outputs and sidecars remain intact. Imported filed **and review**
identities are remembered. Invalid legacy audit content is preserved and
rejected with a migration error instead of being silently discarded. Back up
the entire output folder before upgrade; do not edit the journal by hand.

Only top-level regular files with `.png`, `.jpg`, `.jpeg`, `.bmp`, `.webp`,
`.tif`, `.tiff` or `.pdf` extensions are considered; subfolders, symlinks and
other extensions are ignored. The library rejects unsupported file types.

| Exit | Meaning |
| --- | --- |
| 0 | All processed documents filed, or no supported files found |
| 1 | At least one document needs review, including duplicates |
| 2 | Usage, input listing, extraction, storage or permanent watch error; dominates review |

Preview uses the same outcome codes. Processing errors are printed on stderr
and recorded as `outcome: "error"` when output storage remains available. Usage,
listing and lock-acquisition failures may occur before an audit can be written.
Watch stops gracefully on SIGINT/SIGTERM, finishes its current sweep and uses
the accumulated exit status. A failed transient attempt followed by success
stays visible in audit, but does not itself make the final watch exit 2.

## Durable identity, routing and recovery

The output root contains `filed/`, `review/`, `audit.jsonl`, and `.intake/`.
Keep `.intake/` with the documents when moving or backing up the folder.

Two identities are checked: SHA-256 of the exact source bytes, and normalized
vendor + document number + currency + document type + total. Normalization is
Unicode NFKC, lowercase and collapsed whitespace. Business identity is claimed
only with a vendor, number and total; exact-byte identity still works when
fields are missing. Date is excluded so a changed posting date cannot bypass
duplicate review. Different totals/currencies/types are separate business
identities. This is a conservative review signal, not a payment authorization.

Both filed and reviewed documents claim identities **after** outputs and the
sidecar are complete. Rejected OCR/processing attempts do not. Repeating a
reviewed document sends another copy for review; this CLI does not provide a
review approval/correction workflow. Start a deliberately separate output
root for separate duplicate history.

Routes prefer `filed/<type>/vendor_date_number.ext` or
`review/original-filename.ext`. If either the document or its sidecar already
exists, a transaction-specific suffix is added. Existing files are never
replaced. The actual route, transaction ID and source hash are recorded in the
sidecar/audit; use those fields instead of guessing filenames.

Writers to one output root serialize under a local PID/token lock. A dead
owner is recovered automatically; live owners are never evicted based on age.
Output bytes and pending manifests are synced before source deletion. Pending
transactions are replayed on the next real run. A conflicting/interrupted
partial output is preserved and its manifest quarantined under
`.intake/quarantine/`, with an error event; other intake can continue. Inspect
the preserved source, staged bytes and error before manually cleaning up.
The run that encounters a quarantined transaction reports the recovery error
on stderr and exits 2, even if its newly supplied document files successfully.

`audit.jsonl` is a recoverable projection of immutable `.intake/events/*.json`
records. It is replaced atomically under the lock to avoid partial/duplicate
JSONL records after interruption; events remain the authoritative history.
A hard kill before an event is committed cannot produce an error receipt.
If a move source changes during extraction, the new source is preserved and
`source_cleanup: "source_changed_preserved"` records the skipped deletion.
Do not concurrently modify move sources or manually edit outputs/state.

Use a local filesystem with normal exclusive-create/rename semantics; network
shares and different hosts sharing one output root are unsupported. Files are
synced, but there is no universal power-loss guarantee across operating systems,
storage devices and directory-metadata durability. The journal grows with
history and is read per document; this is a local tool, not a high-volume queue.

## Watch mode

Defaults: 1-second polls, 1-second stable interval, 3 attempts per observed
file version, and 1/2-second retry delays. Configure with `--poll-ms N`,
`--stable-ms N`, `--retry-ms N`, `--max-attempts N` (positive integers).
Size, timestamps and bounded content hashes must remain stable across polls.
Sweeps share one in-flight operation, so OCR cannot overlap a later sweep.
Changed bytes at an already processed path reset observation/retry state.
After the final failed attempt, stderr says `error permanent` and that version
is not retried again; changed content/metadata or restarting watch allows a new
bounded attempt sequence. Watch observation is in memory; durable duplicate
history still survives restarts.

No stability interval proves a producer will never write again. Prefer copying
to an unsupported temporary extension, then atomically renaming to the final
extension. Increase the stable interval for slow copies. Inputs that change
during a bounded snapshot are rejected and retried.

## PDF, OCR and parsing limits

- Maximum input: **25 MiB**; PDFs: **20 pages**. Every PDF page is considered.
  Pages with at least 40 non-whitespace extracted characters use embedded text;
  sparser pages are rasterized and OCRed. Mixed PDFs can use both paths.
  A scanned page with a substantial unrelated text overlay may need manual
  conversion to an image to force full-page OCR.
- PDF rasterization: at most 2400 pixels on the longest edge; input images:
  **25 million pixels**. Each native command has a **60-second timeout** and
  **8 MiB output cap**. Page/pixel/byte limits and deadlines bound normal work;
  native parsers are not OS memory sandboxes. Use trusted local files and
  current native-tool packages. TIFF/image containers use the first frame;
  use PDF for multi-page documents.
- English, line-based invoice heuristics. PDFs combine all pages into one
  document; bundles of several invoices should be split first. Repeated
  headers, subtotals or complex tables may require review.
- USD (`$`, `USD`), EUR (`€`, `EUR`), GBP (`£`, `GBP`) and INR (`₹`, `INR`,
  `Rs`/`Rs.` before a number). No indicator retains the legacy USD default;
  conflicting indicators require review. Dollar notation does not distinguish
  other dollar currencies. GST is read as tax; complex split GST is not summed
  automatically.
- Amounts require a dot and exactly two decimals. Ungrouped, Western grouping
  (`1,234,567.89`) and Indian grouping (`12,34,567.89`) work. Comma decimals,
  malformed grouping, percentages and overprecision are rejected as whole
  tokens. Decimal conventions are never inferred from locale.
- Long English dates and valid ISO dates normalize to ISO. Numeric
  `03/04/2026` remains raw for API compatibility but fails the posting-date
  check. Impossible calendar dates fail. No day/month-order inference.
- Checks require vendor, number, unambiguous date, subtotal + tax = total,
  item sums, non-duplicate identity and a recognized type. These accounting
  heuristics cannot prove authenticity or guarantee every extraction error is
  caught. Statements/receipts without invoice-like totals need human review.

## Library and browser demo

```ts
import { processFile, SessionDuplicateStore } from "doc-intake";
const result = await processFile("inbox/scan.pdf", { outRoot: "out" });
console.log(result.entry.outcome, result.decision.relativePath);
```

`extract`, `check`, `decide`, `recognize`, injected `OcrFn`, and session stores
remain available. `processFile` now always uses output-local durable history;
`dupes` is an optional additional session store. A custom legacy
`seenBefore(key)` store works in real processing and may mutate during its
lookup. Implement optional `has(key)` for non-mutating lookup and preview;
preview rejects a supplied custom store without `has` instead of mutating it.
`DocumentRecord.currency` now includes `INR`; exhaustive switches should add it.
`recognizeDocument(file, limits)` exposes PDF/image limits to library callers.

CLI OCR now uses installed native Tesseract, replacing the earlier Tesseract.js
first-run download. The browser demo still uses Tesseract.js and fetches its
WASM/English resources as needed. It accepts images, keeps duplicates in the
current browser session and writes no filesystem audit. Durable storage,
watch mode and PDFs are CLI/library features.

```bash
npm ci --prefix demo
npm --prefix demo run build
npm --prefix demo run dev
```

## Verification

```bash
npm ci
npm run build             # TypeScript public library/CLI
npm test                  # parsing, routing, identity, stability/retry, pipeline regressions
npm run test:ocr          # actual Tesseract + Poppler on committed rights-safe samples
npm run test:integration  # actual child CLI processes, filesystem/restart/concurrency/watch
npm ci --prefix demo
npm --prefix demo run build
```

CI runs these checks on Ubuntu with native tool installation. Integration tests
cover copy/move/preview, persistent duplicates, collisions, corrupt/oversized
files, killed lock owners, pending recovery, delayed writes, transient failures,
bounded permanent errors and reused filenames. See
[implementation status](docs/implementation-status.md) for exact observed
results and remaining limitations, and [sample provenance](samples/README.md)
for fixture sources. No paid service is required.

## License

MIT © Mithun Das

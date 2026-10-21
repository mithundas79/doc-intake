# Durable offline intake — issue #1

Branch: `feature/durable-offline-intake`. Work in progress; not ready to merge.

## Acceptance checkpoint (2026-10-21)

- Durable identities: output-local immutable event journal; exact bytes plus
  normalized vendor/number/currency/type/total. Filed and review documents claim
  identities; extraction errors do not. Local PID/token lock serializes writers.
- Routing: copy default, explicit move, mutation-free preview, exclusive output
  creation, associated transaction IDs on audit/sidecar, pending recovery and
  conservative conflict quarantine. Changed move sources remain intact.
- Watch: stable content/metadata observations, serialized sweeps, bounded
  exponential retries, permanent error callback, changed-filename reuse.
- PDFs: native Poppler embedded-text extraction across pages and raster OCR for
  scanned pages; 25 MiB, 20 pages, 25 MP images, 60-second child deadlines.
- Parsing: explicit INR/Rs/rupee indicators, validated Indian/Western grouping,
  dot/two-decimal money only; ambiguous numeric dates require review.
- API: legacy session stores supported; preview requires optional non-mutating
  `has()` if a custom store is supplied. Defaults intentionally preserve sources.

## Actual verification

- `npm run build`: PASS (TypeScript).
- `npm test`: PASS — 5 files, 40 tests, 2.22 seconds.
- `npm run test:ocr`: PASS — 1 file, 4 tests, 3.33 seconds; actual native
  Tesseract PNG OCR, Poppler two-page embedded text, rasterized scanned PDF OCR,
  and page/pixel limits. Fixtures are committed fictional MIT content.

Initial Windows sandbox Temp rename/hard-link failures were reproduced and
resolved with checkout-local test scratch and exclusive-copy publication.

## Outstanding

Cross-process CLI/restart/concurrency/error/interruption integration; watched
folder end-to-end tests; expanded recovery/collision tests; CI, clean-checkout
README and demo guidance/build; final root review, push and draft PR.

Limits to document: local-machine filesystem (no network-share lock guarantee),
native Tesseract/Poppler installation, heuristic English invoice extraction,
no blanket accounting accuracy claim, and no power-loss durability guarantee
beyond filesystem fsync/rename semantics. Interrupted partial outputs are
preserved and quarantined rather than overwritten.

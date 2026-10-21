# Durable offline intake — issue #1

Branch: `feature/durable-offline-intake`.
Draft PR: https://github.com/mithundas79/doc-intake/pull/2. Do not merge as part
of this task. Implementation complete; final Linux CI/independent review pending.

## Acceptance mapping (2026-10-21)

| Issue criterion | Implementation and verification |
| --- | --- |
| Durable duplicate identity and concurrency | Immutable output-local journal, SHA-256 plus normalized vendor/number/currency/type/total, filed/review claims and failed-attempt exclusion. PID/token lock, killed-owner recovery, separate-process restart/business-identity/concurrent-writer tests. Legacy audit migration retains backup/history; read-only legacy previews work before migration. |
| Preserve originals and dry-run | Default copy, explicit `--move`, compatible `--keep` and library `keepOriginal:false`. Integration hashes entire input/output tree before/after previews, including a populated output and untouched legacy state. |
| Collision-safe association | Exclusive copies, suffix if either output or sidecar exists, transaction IDs and hashes in sidecars/audit. Tests preserve unrelated filed/review originals and orphan sidecars. Pending replay and partial-copy quarantine preserve bytes and continue intake. Recovery errors return exit 2. |
| Stable bounded watch | Bounded descriptor reads, size/time/content stability, shared in-flight sweep, exponential retries, permanent error observations, changed-filename reuse. Actual CLI delayed-write/reuse/permanent-error test; transient real extraction and nonoverlap integration. Unit race timing injects a real append after first descriptor read and verifies growth rejection. |
| Text/scanned multi-page PDF and images | Native Poppler per-page text/raster extraction and Tesseract OCR; 25 MiB input, 20 pages, 25 MP images, bounded raster side, 60-second/8 MiB child caps. Actual committed PNG, two-page text PDF, scanned PDF and resource-limit tests pass. |
| INR and conservative parsing | INR/Rs/rupee indicators, Indian/Western grouping validation, USD/EUR/GBP preservation, rejected comma decimals/percentages/overprecision, mixed-currency review, invalid/ambiguous date review. Focused unit tests. |
| Audit and exit codes | Filed/review/error outcomes, recoverable JSONL projection from authoritative immutable events; errors dominate review with exit 2, duplicate/review exit 1, clean exit 0. CLI integration asserts all three, failure retry, quarantine and usage errors. |
| Public interface and documentation | Pure extraction/rule modules retained for demo; optional `dupes`, legacy custom-store compatibility, non-mutating `has` requirement for custom-store preview. README documents copy/native-OCR migration, identity policy, examples, watch behavior, PDF/parser/storage limits and browser scope. |
| Reproducible CI/sample workflow | CI installs native tools and runs TypeScript, units, native OCR/PDF, real CLI/watch integration and demo build. Fictional MIT fixtures/generator committed. README includes fresh-checkout Ubuntu/Windows instructions and actual CLI sample workflow. |

## Actual local verification

Node v20.20.2, Windows, installed native Tesseract and Poppler. No paid service,
remote OCR, fake engine substitution in the native suite or production documents.

| Exact command | Observed result |
| --- | --- |
| `npm ci` | PASS, dependencies installed from lockfile. |
| `npm run build` | PASS, TypeScript compiler exit 0. |
| `npm test` | PASS — `Test Files 6 passed (6)`, `Tests 41 passed (41)`; final run 2.20s. |
| `npm run test:ocr` | PASS — `Test Files 1 passed (1)`, `Tests 4 passed (4)`; actual native PNG OCR, two-page embedded PDF (OCR binary deliberately unavailable), scanned PDF OCR, page/pixel limits. |
| `npm run test:integration` | PASS — `Test Files 2 passed (2)`, `Tests 11 passed (11)`; final run 12.98s. Includes separate-process empty-inbox explicit-move commit recovery, unchanged dry-run and no output creation for an empty untouched inbox. |
| `npm ci --prefix demo` | PASS. |
| `npm --prefix demo run build` | PASS — TypeScript check and Vite build, 84 modules transformed. |

The coordinator independently ran the compiled CLI on the two-page PDF:
preview exit 0 with no output creation; first copy exit 0; separate-process
duplicate exit 1; original SHA unchanged; two audit destinations and sidecar
IDs/hashes matched. Initial incorrectly hardcoded local Poppler path was fixed
in the coordinator's environment; the application correctly reported ENOENT.

Initial Windows sandbox Temp rename/hard-link failures were reproduced and
resolved using checkout-local test scratch and exclusive-copy publication.
Initial checkpoint CI used the previous workflow without explicit native
installation and failed. Retrieved job logs confirm `spawn tesseract ENOENT`
and `spawn pdfinfo ENOENT`; final updated CI result must be checked separately.

## Deliberate limits and remaining delivery work

- Local-machine filesystems only; no shared-host/network-share locking promise.
- English invoice heuristics, no assertion of universal accounting accuracy;
  ambiguous formats go to review. TIFF images use the first frame; PDF is the
  multi-page path. Substantial PDF text overlays can hide scanned content from
  the text-vs-OCR heuristic; README describes forcing OCR via image conversion.
- Native Tesseract/Poppler required. Resource caps are not OS process-memory
  sandboxes. Power-loss guarantees depend on filesystem fsync/rename behavior.
- A hard kill before commit may leave staging data with no audit event. Pending
  conflicts are preserved/quarantined, not overwritten; no automatic deletion
  of unrelated data. Source writers should use atomic producer renames.
- Watch observation/retry counters reset after restart; duplicate memory does
  not. The event journal grows and is read per intake document.
- Final GitHub CI confirmation, coordinator review and final PR verification
  update remain. `attach_artifact` was attempted for PR #2 but the Codex bridge
  returned MCP -32000; GitHub PR creation and feature-branch push succeeded.

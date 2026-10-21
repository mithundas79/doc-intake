# Sample provenance

All sample vendors, identifiers and amounts are fictional. These fixtures and
their generator are original project content distributed under the repository
MIT license; no customer documents or personal data are included.

`northwind-invoice.png` is the existing rendered invoice from the companion HTML.
`northwind-multipage.pdf` splits the invoice and its totals across two pages of
embedded text. `northwind-scanned.pdf` embeds the image without a text layer.
`over-page-limit.pdf` has 21 pages to verify rejection before extraction/OCR.

The PDFs are committed: running tests does not need Python. To regenerate them,
install the development-only `reportlab` Python package and run
`python samples/generate-pdfs.py`.

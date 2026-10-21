"""Regenerate fictional MIT-licensed fixtures (development only: reportlab)."""
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

root = Path(__file__).parent
pages = [
    ["Northwind Supplies", "Invoice No: NW-2026-0481", "Invoice Date: 12 Aug 2026",
     "Filter cartridges 10 in 24 408.00", "Sealing rings box of 50 6 171.00"],
    ["Delivery 1 45.00", "Subtotal 624.00", "Tax 8.5% 53.04", "Total Due 677.04"],
]
pdf = canvas.Canvas(str(root / "northwind-multipage.pdf"), pagesize=(700, 900), invariant=1)
for lines in pages:
    pdf.setFont("Helvetica", 22)
    for i, line in enumerate(lines):
        pdf.drawString(45, 830 - i * 45, line)
    pdf.showPage()
pdf.save()
pdf = canvas.Canvas(str(root / "northwind-scanned.pdf"), pagesize=(900, 1160), invariant=1)
pdf.drawImage(ImageReader(str(root / "northwind-invoice.png")), 0, 0, width=900, height=1160)
pdf.showPage()
pdf.save()
pdf = canvas.Canvas(str(root / "over-page-limit.pdf"), invariant=1)
for i in range(21):
    pdf.drawString(50, 800, f"Fictional resource-limit fixture page {i + 1}")
    pdf.showPage()
pdf.save()

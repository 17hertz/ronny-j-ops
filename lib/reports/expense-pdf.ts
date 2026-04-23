/**
 * Render an expense report to PDF using pdfkit.
 *
 * Kept intentionally minimal — a header, a summary box, and a table of
 * rows. Matches the layout philosophy of lib/invoices/generate-pdf.ts
 * (same library, same page size) so the look is consistent when Jason
 * prints them side by side.
 *
 * Returns a Node.js Buffer so the API route can stream it directly in
 * the HTTP response.
 */
import PDFDocument from "pdfkit";
import type { ExpenseReport, ExpenseRow } from "./expenses";

export async function renderExpenseReportPdf(
  report: ExpenseReport
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "LETTER",
      margin: 50,
      bufferPages: true,
    });

    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // --- Header -----------------------------------------------------
    doc
      .fontSize(9)
      .fillColor("#888")
      .text("RONNY J LISTEN UP LLC", { characterSpacing: 2 });
    doc.moveDown(0.3);
    doc
      .fontSize(18)
      .fillColor("#111")
      .text(report.title);
    doc.moveDown(0.5);
    doc
      .fontSize(9)
      .fillColor("#666")
      .text(`Generated ${new Date().toLocaleString("en-US")}`);
    doc.moveDown(1.2);

    // --- Summary ----------------------------------------------------
    const summaryY = doc.y;
    doc
      .roundedRect(50, summaryY, 512, 80, 6)
      .lineWidth(0.5)
      .strokeColor("#ddd")
      .stroke();

    const col = (n: number) => 50 + 16 + n * 128;
    doc
      .fontSize(8)
      .fillColor("#888")
      .text("INVOICES", col(0), summaryY + 14)
      .text("APPROVED", col(1), summaryY + 14)
      .text("PAID", col(2), summaryY + 14)
      .text("TOTAL", col(3), summaryY + 14);

    doc
      .fontSize(16)
      .fillColor("#111")
      .text(String(report.totals.count), col(0), summaryY + 30)
      .text(formatMoney(report.totals.approvedCents), col(1), summaryY + 30)
      .text(formatMoney(report.totals.paidCents), col(2), summaryY + 30)
      .text(formatMoney(report.totals.totalCents), col(3), summaryY + 30);

    doc.y = summaryY + 100;
    doc.moveDown(0.5);

    // --- Table ------------------------------------------------------
    if (report.rows.length === 0) {
      doc
        .fontSize(11)
        .fillColor("#666")
        .text("No approved or paid invoices in this period.");
      doc.end();
      return;
    }

    drawTableHeader(doc);

    for (const row of report.rows) {
      // Page break when we're close to the bottom — 60pt leaves room
      // for a row without cramming into the footer margin.
      if (doc.y > 720) {
        doc.addPage();
        drawTableHeader(doc);
      }
      drawTableRow(doc, row);
    }

    doc.end();
  });
}

function drawTableHeader(doc: PDFKit.PDFDocument): void {
  const y = doc.y;
  doc
    .fontSize(8)
    .fillColor("#888")
    .text("DATE", 50, y)
    .text("VENDOR", 120, y)
    .text("INVOICE", 280, y)
    .text("STATUS", 380, y)
    .text("AMOUNT", 480, y, { width: 80, align: "right" });
  doc.moveDown(0.4);
  doc
    .moveTo(50, doc.y)
    .lineTo(562, doc.y)
    .lineWidth(0.5)
    .strokeColor("#ccc")
    .stroke();
  doc.moveDown(0.4);
}

function drawTableRow(doc: PDFKit.PDFDocument, row: ExpenseRow): void {
  const y = doc.y;
  const date = row.submitted_at
    ? new Date(row.submitted_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "—";
  doc
    .fontSize(10)
    .fillColor("#222")
    .text(date, 50, y, { width: 70 })
    .text(truncate(row.vendor_name, 24), 120, y, { width: 160 })
    .text(row.invoice_number ?? "—", 280, y, { width: 100 })
    .text(row.invoice_status, 380, y, { width: 100 })
    .text(formatMoney(row.invoice_amount_cents), 480, y, {
      width: 80,
      align: "right",
    });
  doc.moveDown(0.6);
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

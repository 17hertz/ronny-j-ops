/**
 * Invoice PDF generator.
 *
 * Used by the "Generate invoice" flow when a vendor fills out the short
 * form instead of uploading their own PDF. Renders a simple Letter-size
 * invoice to a Buffer using pdfkit, which the caller then uploads to
 * Supabase Storage alongside the vendor_documents metadata row.
 *
 * The layout is intentionally plain:
 *   - Helvetica everywhere (a built-in font, so no font file embedding).
 *   - Two-column header: vendor on the left, issuer (17 Hertz Inc.) on right.
 *   - Line-items table: Description | Qty | Unit | Amount.
 *   - Bold total + optional due date.
 *   - Footer identifies the generator so it doesn't look forged later.
 *
 * Why no fancy branding? The PDF is a payment artifact, not marketing.
 * Ronny J's team needs to be able to read "who, what, how much" at a
 * glance; any more chrome is a liability for readability.
 *
 * Edge cases handled:
 *   - achLast4 may be null (vendor with no bank on file — shouldn't happen
 *     for approved vendors, but don't crash the PDF if it does).
 *   - dueDate may be null.
 *   - Long descriptions wrap within the column width.
 */
// @types/pdfkit declares the default export as a PDFDocument *instance*
// rather than the constructor — mismatched with the real module which
// exports the class. Cast the default import to a constructable shape.
// Runtime behavior is unaffected; this is purely a types shim.
import PDFDocumentRaw from "pdfkit";
const PDFDocument = PDFDocumentRaw as unknown as {
  new (options?: PDFKit.PDFDocumentOptions): PDFKit.PDFDocument;
};

export type InvoicePdfInput = {
  invoiceNumber: string;
  description: string;
  dueDate: string | null; // ISO yyyy-mm-dd
  lineItems: Array<{
    description: string;
    quantity: number;
    unit_amount_cents: number;
  }>;
  totalAmountCents: number;
  vendor: {
    legalName: string;
    achLast4: string | null;
  };
  issuer: {
    name: string;
    line1: string;
    line2: string;
  };
};

export async function generateInvoicePdf(
  input: InvoicePdfInput
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 72, bottom: 72, left: 72, right: 72 },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      renderInvoice(doc, input);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function renderInvoice(
  doc: PDFKit.PDFDocument,
  input: InvoicePdfInput
): void {
  const pageLeft = doc.page.margins.left;
  const pageRight = doc.page.width - doc.page.margins.right;
  const contentWidth = pageRight - pageLeft;

  // ----- Header strip ---------------------------------------------------
  doc
    .font("Helvetica-Bold")
    .fontSize(24)
    .fillColor("#0A0A0A")
    .text("INVOICE", pageLeft, doc.page.margins.top, { align: "left" });

  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#555")
    .text(
      `Invoice #: ${input.invoiceNumber}`,
      pageLeft,
      doc.page.margins.top,
      {
        align: "right",
        width: contentWidth,
      }
    )
    .text(`Dated: ${formatDateLong(new Date())}`, pageLeft, doc.y, {
      align: "right",
      width: contentWidth,
    });

  // ----- From / Billed-to blocks ---------------------------------------
  const blockTop = doc.page.margins.top + 64;
  const colWidth = (contentWidth - 24) / 2;

  // Left column — From (vendor)
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#888")
    .text("FROM", pageLeft, blockTop);
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#0A0A0A")
    .text(input.vendor.legalName, pageLeft, blockTop + 14, {
      width: colWidth,
    });
  if (input.vendor.achLast4) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555")
      .text(`Payment: ACH ···${input.vendor.achLast4}`, pageLeft, doc.y + 2, {
        width: colWidth,
      });
  }

  // Right column — Billed to (issuer)
  const rightX = pageLeft + colWidth + 24;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#888")
    .text("BILLED TO", rightX, blockTop);
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#0A0A0A")
    .text(input.issuer.name, rightX, blockTop + 14, { width: colWidth });
  doc
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#555")
    .text(input.issuer.line1, rightX, doc.y + 2, { width: colWidth })
    .text(input.issuer.line2, rightX, doc.y + 2, { width: colWidth });

  // ----- Description paragraph -----------------------------------------
  const descTop = blockTop + 110;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#888")
    .text("DESCRIPTION", pageLeft, descTop);
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#0A0A0A")
    .text(input.description, pageLeft, descTop + 14, {
      width: contentWidth,
    });

  // ----- Line-items table ----------------------------------------------
  const tableTop = doc.y + 24;
  const colDesc = pageLeft;
  const colQty = pageLeft + contentWidth * 0.55;
  const colUnit = pageLeft + contentWidth * 0.7;
  const colAmount = pageLeft + contentWidth * 0.85;
  const rightEdge = pageRight;

  // Header row
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor("#888")
    .text("DESCRIPTION", colDesc, tableTop)
    .text("QTY", colQty, tableTop, {
      width: colUnit - colQty - 6,
      align: "right",
    })
    .text("UNIT", colUnit, tableTop, {
      width: colAmount - colUnit - 6,
      align: "right",
    })
    .text("AMOUNT", colAmount, tableTop, {
      width: rightEdge - colAmount,
      align: "right",
    });

  doc
    .moveTo(pageLeft, tableTop + 14)
    .lineTo(pageRight, tableTop + 14)
    .strokeColor("#CCC")
    .lineWidth(0.5)
    .stroke();

  // Body rows
  let y = tableTop + 20;
  doc.font("Helvetica").fontSize(11).fillColor("#0A0A0A");
  for (const li of input.lineItems) {
    const lineAmountCents = li.quantity * li.unit_amount_cents;
    // Measure the description height first so we know how tall this row is
    const descHeight = doc.heightOfString(li.description, {
      width: colQty - colDesc - 8,
    });
    const rowHeight = Math.max(descHeight, 14);

    doc.text(li.description, colDesc, y, {
      width: colQty - colDesc - 8,
    });
    doc.text(String(li.quantity), colQty, y, {
      width: colUnit - colQty - 6,
      align: "right",
    });
    doc.text(formatMoney(li.unit_amount_cents), colUnit, y, {
      width: colAmount - colUnit - 6,
      align: "right",
    });
    doc.text(formatMoney(lineAmountCents), colAmount, y, {
      width: rightEdge - colAmount,
      align: "right",
    });

    y += rowHeight + 8;
  }

  // Total row
  doc
    .moveTo(pageLeft, y + 2)
    .lineTo(pageRight, y + 2)
    .strokeColor("#0A0A0A")
    .lineWidth(1)
    .stroke();

  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor("#0A0A0A")
    .text("Total", colUnit, y + 10, {
      width: colAmount - colUnit - 6,
      align: "right",
    })
    .text(formatMoney(input.totalAmountCents), colAmount, y + 10, {
      width: rightEdge - colAmount,
      align: "right",
    });

  if (input.dueDate) {
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555")
      .text(`Due: ${formatDateLong(new Date(input.dueDate))}`, colUnit, y + 30, {
        width: rightEdge - colUnit,
        align: "right",
      });
  }

  // ----- Footer ---------------------------------------------------------
  const footerY = doc.page.height - doc.page.margins.bottom - 14;
  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#999")
    .text(
      `Generated by 17 Hertz Inc. on ${formatDateLong(
        new Date()
      )} — Ronny J Ops`,
      pageLeft,
      footerY,
      { width: contentWidth, align: "center" }
    );
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function formatDateLong(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

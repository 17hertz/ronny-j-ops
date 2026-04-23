/**
 * Render an expense report to XLSX using exceljs.
 *
 * Shape:
 *   - Summary sheet with the range, totals, and generation timestamp.
 *   - "Invoices" sheet with one row per invoice, matching the PDF's
 *     column set so the two documents reconcile cleanly.
 *
 * Returns the file as a Node.js Buffer so the API route can stream it.
 *
 * Number formats:
 *   - Amount columns use Excel's built-in currency format so downstream
 *     sum/filter work without text-to-number conversion.
 *   - Dates are written as real JS Dates (not strings) so sort + filter
 *     behave correctly.
 */
import ExcelJS from "exceljs";
import type { ExpenseReport } from "./expenses";

export async function renderExpenseReportXlsx(
  report: ExpenseReport
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ronny J Ops";
  wb.created = new Date();

  // --- Summary sheet -------------------------------------------------
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { key: "field", width: 32 },
    { key: "value", width: 40 },
  ];
  summary.addRows([
    { field: "Report", value: report.title },
    { field: "Granularity", value: report.granularity },
    { field: "Range start (UTC)", value: new Date(report.rangeStart) },
    { field: "Range end (UTC)", value: new Date(report.rangeEnd) },
    { field: "", value: "" },
    { field: "Invoices in range", value: report.totals.count },
    {
      field: "Approved (not yet paid)",
      value: report.totals.approvedCents / 100,
    },
    { field: "Paid", value: report.totals.paidCents / 100 },
    { field: "Total", value: report.totals.totalCents / 100 },
    { field: "", value: "" },
    { field: "Generated at", value: new Date() },
  ]);

  // Currency format on the money rows + the total.
  const moneyRows = [7, 8, 9];
  for (const r of moneyRows) {
    summary.getCell(`B${r}`).numFmt = '"$"#,##0.00';
  }
  summary.getRow(1).font = { bold: true };

  // --- Invoices sheet ------------------------------------------------
  const invoices = wb.addWorksheet("Invoices");
  invoices.columns = [
    { header: "Submitted", key: "submitted_at", width: 18 },
    { header: "Vendor", key: "vendor_name", width: 32 },
    { header: "Vendor email", key: "vendor_email", width: 32 },
    { header: "Invoice #", key: "invoice_number", width: 18 },
    { header: "Due", key: "invoice_due_at", width: 14 },
    { header: "Status", key: "invoice_status", width: 12 },
    { header: "Amount", key: "amount", width: 14 },
  ];

  for (const r of report.rows) {
    invoices.addRow({
      submitted_at: r.submitted_at ? new Date(r.submitted_at) : null,
      vendor_name: r.vendor_name,
      vendor_email: r.vendor_email,
      invoice_number: r.invoice_number,
      invoice_due_at: r.invoice_due_at ? new Date(r.invoice_due_at) : null,
      invoice_status: r.invoice_status,
      amount: r.invoice_amount_cents / 100,
    });
  }

  // Header row styling — bold + subtle fill so it stands apart when
  // filtering/sorting.
  invoices.getRow(1).font = { bold: true };
  invoices.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF3F3F3" },
  };

  // Number formats for the data columns.
  invoices.getColumn("submitted_at").numFmt = "yyyy-mm-dd hh:mm";
  invoices.getColumn("invoice_due_at").numFmt = "yyyy-mm-dd";
  invoices.getColumn("amount").numFmt = '"$"#,##0.00';

  // Freeze the header so it sticks while scrolling.
  invoices.views = [{ state: "frozen", ySplit: 1 }];

  // Sum row at the bottom — small ergonomic win so Jason doesn't have
  // to reach for SUM() in the rare case he opens the file without a
  // pivot table in mind.
  if (report.rows.length > 0) {
    const totalRow = invoices.addRow({
      vendor_name: "TOTAL",
      amount: report.totals.totalCents / 100,
    });
    totalRow.font = { bold: true };
    totalRow.getCell("amount").numFmt = '"$"#,##0.00';
  }

  // `writeBuffer` returns an ArrayBuffer in exceljs — coerce to Node Buffer
  // so the API route can pass it to NextResponse directly.
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
}

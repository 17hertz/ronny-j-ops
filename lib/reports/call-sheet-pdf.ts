/**
 * Day-of-show call sheet PDF.
 *
 * One-pager (more if the crew list is long) that Ronny pulls up on his
 * phone or prints before a show. Everything you want at a glance:
 *   - Event title, date, time window, location
 *   - Crew grouped/sorted by service-window-start, each row showing
 *     role, vendor name, service window, on-site contact, notes
 *
 * Rendered with pdfkit to stay consistent with the expense-report
 * PDFs Jason already has. Returns a Node Buffer; the API route wraps
 * it in Uint8Array for NextResponse.
 */
import PDFDocument from "pdfkit";

export type CallSheetInput = {
  event: {
    title: string;
    description: string | null;
    location: string | null;
    starts_at: string;
    ends_at: string;
    timezone: string;
  };
  crew: Array<{
    role: string;
    service_window_start: string | null;
    service_window_end: string | null;
    contact_on_site: string | null;
    notes: string | null;
    vendor_name: string;
    vendor_dba: string | null;
    vendor_phone: string | null;
  }>;
  /** Viewer's tz — used for the main date label. Defaults to event.tz. */
  viewerTz?: string;
};

export async function renderCallSheetPdf(
  input: CallSheetInput
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

    const tz = input.viewerTz || input.event.timezone || "America/New_York";

    // --- Header: date + event title ---------------------------------
    const dateLine = new Date(input.event.starts_at).toLocaleDateString(
      "en-US",
      {
        timeZone: tz,
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }
    );
    doc
      .fontSize(9)
      .fillColor("#888")
      .text(dateLine.toUpperCase(), { characterSpacing: 2 });
    doc.moveDown(0.2);
    doc.fontSize(22).fillColor("#111").text(input.event.title);
    doc.moveDown(0.3);

    // --- Event window + location ------------------------------------
    const timeLine = formatEventWindow(
      input.event.starts_at,
      input.event.ends_at,
      tz
    );
    doc.fontSize(11).fillColor("#333").text(timeLine);
    if (input.event.location) {
      doc.fontSize(11).fillColor("#555").text(input.event.location);
    }
    if (input.event.description) {
      doc.moveDown(0.3);
      doc
        .fontSize(10)
        .fillColor("#666")
        .text(input.event.description, { lineGap: 2 });
    }
    doc.moveDown(1.2);

    // --- Crew -------------------------------------------------------
    doc
      .fontSize(9)
      .fillColor("#888")
      .text("CREW", { characterSpacing: 2 });
    doc
      .moveTo(50, doc.y + 4)
      .lineTo(562, doc.y + 4)
      .lineWidth(0.75)
      .strokeColor("#bbb")
      .stroke();
    doc.moveDown(0.5);

    if (input.crew.length === 0) {
      doc
        .fontSize(11)
        .fillColor("#666")
        .text("No vendors attached to this event yet.");
      doc.end();
      return;
    }

    // Sort by service window start (nulls last), then by role.
    const sorted = [...input.crew].sort((a, b) => {
      const aHas = !!a.service_window_start;
      const bHas = !!b.service_window_start;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      if (aHas && bHas) {
        return (
          new Date(a.service_window_start!).getTime() -
          new Date(b.service_window_start!).getTime()
        );
      }
      return a.role.localeCompare(b.role);
    });

    for (const c of sorted) {
      if (doc.y > 700) {
        doc.addPage();
      }
      drawCrewRow(doc, c, tz);
    }

    doc.end();
  });
}

function drawCrewRow(
  doc: PDFKit.PDFDocument,
  c: CallSheetInput["crew"][number],
  tz: string
): void {
  const startY = doc.y;

  // Role badge (left column).
  doc
    .rect(50, startY, 110, 18)
    .fillColor("#f3f3f3")
    .fill();
  doc
    .fontSize(9)
    .fillColor("#333")
    .text(
      c.role.replace(/_/g, " ").toUpperCase(),
      54,
      startY + 5,
      { characterSpacing: 1 }
    );

  // Time window.
  const timeText = c.service_window_start
    ? formatTimeWindow(c.service_window_start, c.service_window_end, tz)
    : "—";
  doc
    .fontSize(10)
    .fillColor("#111")
    .text(timeText, 170, startY + 3);

  // Vendor name + dba.
  let vendorLabel = c.vendor_name;
  if (c.vendor_dba) vendorLabel += ` (dba ${c.vendor_dba})`;
  doc
    .fontSize(12)
    .fillColor("#111")
    .text(vendorLabel, 50, startY + 24);

  // Contact (prefers on-site contact, falls back to vendor phone).
  const contactLine = [
    c.contact_on_site,
    c.contact_on_site ? null : c.vendor_phone,
  ]
    .filter(Boolean)
    .join(" ");
  if (contactLine) {
    doc
      .fontSize(10)
      .fillColor("#444")
      .text(contactLine, 50, doc.y + 2);
  }

  if (c.notes) {
    doc
      .fontSize(9)
      .fillColor("#666")
      .text(c.notes, 50, doc.y + 2, { lineGap: 1 });
  }

  doc.moveDown(0.8);
  // Light separator line between crew rows.
  doc
    .moveTo(50, doc.y)
    .lineTo(562, doc.y)
    .lineWidth(0.25)
    .strokeColor("#e5e5e5")
    .stroke();
  doc.moveDown(0.5);
}

function formatEventWindow(
  startIso: string,
  endIso: string,
  tz: string
): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  return `${fmt(startIso)} – ${fmt(endIso)}`;
}

function formatTimeWindow(
  startIso: string,
  endIso: string | null,
  tz: string
): string {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  if (!endIso) return `from ${fmt(startIso)}`;
  return `${fmt(startIso)} – ${fmt(endIso)}`;
}

/**
 * Claude Sonnet vision classifier for capture images.
 *
 * Takes a base64-encoded image, sends it to Claude with a constrained
 * tool schema, returns a structured intent + extracted fields. The
 * Inngest runner then routes based on the intent.
 *
 * Why constrained tool-use (not free-form):
 *   - Reliable, parseable output: we get a JSON object every time.
 *   - tool_choice: "any" forces a classification — Claude can't go off
 *     and write us a paragraph.
 *
 * Cost: ~$0.01–0.02 per image at Sonnet 4.5 pricing including the
 * image tokens. At 20 receipts/day that's ~$10/mo, comfortably under
 * the $20 cap.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { preflightSpendCheck, logSpend } from "@/lib/agent/spend-gate";

const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 600;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export type ClassificationResult = {
  intent:
    | "task"
    | "event"
    | "bill_service"
    | "bill_product"
    | "contact"
    | "other";
  confidence: number;
  reasoning?: string | null;
  // Extracted fields (filled in based on intent — most are nullable).
  title?: string | null;
  description?: string | null;
  // Bills
  amount_cents?: number | null;
  sales_tax_cents?: number | null;
  merchant?: string | null;
  merchant_email?: string | null;
  merchant_phone?: string | null;
  payment_link?: string | null;
  due_date?: string | null;       // YYYY-MM-DD
  // Events
  event_starts_at?: string | null; // ISO (naive or UTC)
  event_ends_at?: string | null;
  event_location?: string | null;
  // Contacts
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
};

const tool: Anthropic.Tool = {
  name: "classify_capture",
  description:
    "Classify what kind of thing this image is and extract relevant fields.",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: [
          "task",
          "event",
          "bill_service",
          "bill_product",
          "contact",
          "other",
        ],
        description:
          "What this image represents. Use bill_product when sales tax is " +
          "visible on a receipt (means a registered retailer collected it; " +
          "no W9 needed). Use bill_service for invoices for labor/services " +
          "without sales tax (1099-eligible vendor). Use 'other' if it's " +
          "ambiguous or doesn't fit.",
      },
      confidence: {
        type: "number",
        description: "0.0–1.0 your confidence in the classification.",
      },
      reasoning: {
        type: "string",
        description: "One short sentence explaining the classification.",
      },
      title: {
        type: "string",
        description:
          "A short title for the artifact. For tasks: the task itself. " +
          "For events: event name. For bills: 'Receipt from <merchant>'. " +
          "For contacts: the contact's name.",
      },
      description: {
        type: "string",
        description: "Short notes / detail (under 500 chars).",
      },
      amount_cents: {
        type: "integer",
        description: "Total amount in cents if this is a bill.",
      },
      sales_tax_cents: {
        type: "integer",
        description: "Sales tax portion in cents if visible on receipt.",
      },
      merchant: {
        type: "string",
        description: "Merchant / business name if a bill.",
      },
      merchant_email: { type: "string" },
      merchant_phone: { type: "string" },
      payment_link: {
        type: "string",
        description: "Stripe / Venmo / PayPal / Zelle URL if visible on the bill.",
      },
      due_date: {
        type: "string",
        description: "YYYY-MM-DD if visible.",
      },
      event_starts_at: {
        type: "string",
        description:
          "ISO date-time without offset (e.g. 2026-04-26T20:00:00) for events. " +
          "Interpret in America/New_York unless the image specifies another zone.",
      },
      event_ends_at: { type: "string" },
      event_location: { type: "string" },
      contact_name: { type: "string" },
      contact_email: { type: "string" },
      contact_phone: { type: "string" },
    },
    required: ["intent", "confidence"],
  },
};

const SYSTEM = `You classify images sent into Ronny J Ops, a live-events booking app.

Decision rules:
- bill_product: receipt with visible SALES TAX from a registered retailer.
  These don't need a W9 (sales tax already covers state revenue reporting).
  Example: a Guitar Center receipt for cables.
- bill_service: invoice for labor/services, often without sales tax.
  These DO need a W9 because they're 1099-reportable. Example: a
  freelance lighting tech's invoice.
- task: a written or printed reminder of something to do (a sticky note,
  a screenshot of a "remind me to X" message, a checklist item).
- event: a flyer, save-the-date, calendar invite, venue confirmation —
  something with a date + time + place.
- contact: a business card or contact-info block. Capture name + phone +
  email; downstream code may turn this into a vendor stub.
- other: ambiguous or doesn't fit — flag for human review.

When extracting amounts, use cents (4218 for $42.18). When extracting
dates, prefer the format on the image; if you must guess year, use the
current year. Be conservative with confidence: 0.95+ only when fields
are clearly readable; 0.6–0.8 when you're inferring; <0.5 when guessing.`;

/**
 * Run Claude on a captured file. Internally dispatches based on the
 * file's MIME type:
 *   - image/* → vision API (multimodal image content block)
 *   - application/pdf → Claude's document content block (native PDF
 *     understanding — handles scanned and digital PDFs)
 *   - application/vnd.openxmlformats-officedocument.wordprocessingml.document
 *     → extract text via mammoth, send as text
 *   - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *     → extract text via exceljs, send as text
 *   - text/plain | text/csv → send raw text
 *
 * Returns the same ClassificationResult shape regardless of input type
 * so the Inngest runner doesn't need to branch.
 */
export async function classifyCaptureFile(opts: {
  fileBuffer: Buffer;
  mediaType: string;
  filename?: string | null;
  teamMemberId?: string | null;
}): Promise<
  | { ok: true; result: ClassificationResult }
  | { ok: false; refused?: boolean; error: string }
> {
  const check = await preflightSpendCheck();
  if (!check.ok) {
    await logSpend({
      purpose: "other",
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      teamMemberId: opts.teamMemberId ?? null,
      note: "capture-classify refused: monthly cap reached",
    });
    return {
      ok: false,
      refused: true,
      error:
        "Monthly Claude spend cap reached. Capture not classified — try again on the 1st.",
    };
  }

  try {
    // Build the user content block based on file type.
    const userContent = await buildUserContent(opts);
    if (!userContent.ok) return userContent;

    const response = await client().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: [tool],
      tool_choice: { type: "any" },
      messages: [
        {
          role: "user",
          content: userContent.content as any,
        },
      ],
    });

    const usage = response.usage as any;
    await logSpend({
      purpose: "other",
      model: MODEL,
      inputTokens: usage?.input_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      teamMemberId: opts.teamMemberId ?? null,
      note: `capture-classify (${opts.mediaType})`,
    });

    const toolUse = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
    );
    if (!toolUse) {
      return { ok: false, error: "Claude returned no tool call" };
    }
    const result = toolUse.input as ClassificationResult;
    if (!result?.intent || typeof result.confidence !== "number") {
      return { ok: false, error: "Claude returned a malformed classification" };
    }
    return { ok: true, result };
  } catch (err: any) {
    console.error("[captures/classify] Claude call failed", err);
    return {
      ok: false,
      error: err?.message ?? "Claude classify call failed",
    };
  }
}

/**
 * Backwards-compat shim: the old image-only entry point is preserved
 * so existing callers (any older Inngest events still queued) still
 * work after the refactor.
 */
export async function classifyCaptureImage(opts: {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  teamMemberId?: string | null;
}) {
  return classifyCaptureFile({
    fileBuffer: Buffer.from(opts.imageBase64, "base64"),
    mediaType: opts.mediaType,
    teamMemberId: opts.teamMemberId,
  });
}

const PROMPT_TEXT =
  "Classify this and extract whatever fields apply per the rules.";

/**
 * Build the message-content array for a given file. Returns a structured
 * result so the caller can short-circuit on extraction failures.
 */
async function buildUserContent(opts: {
  fileBuffer: Buffer;
  mediaType: string;
  filename?: string | null;
}): Promise<
  | { ok: true; content: unknown[] }
  | { ok: false; error: string }
> {
  const mt = opts.mediaType.toLowerCase();
  const filenameNote = opts.filename
    ? `Original filename: ${opts.filename}.\n\n`
    : "";

  // ---- Images → vision content block ---------------------------------
  if (mt.startsWith("image/")) {
    const allowed = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]);
    const claimed = allowed.has(mt) ? mt : "image/jpeg";
    return {
      ok: true,
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: claimed,
            data: opts.fileBuffer.toString("base64"),
          },
        },
        { type: "text", text: PROMPT_TEXT },
      ],
    };
  }

  // ---- PDFs → document content block --------------------------------
  if (mt === "application/pdf") {
    return {
      ok: true,
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: opts.fileBuffer.toString("base64"),
          },
        },
        { type: "text", text: PROMPT_TEXT },
      ],
    };
  }

  // ---- DOCX / DOC → mammoth text extraction --------------------------
  if (
    mt ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mt === "application/msword"
  ) {
    try {
      // Lazy import keeps mammoth out of the cold-start bundle for
      // routes that never see a docx.
      const mammoth = await import("mammoth");
      const { value: text } = await mammoth.extractRawText({
        buffer: opts.fileBuffer,
      });
      const truncated = truncateText(text, 100_000);
      return {
        ok: true,
        content: [
          {
            type: "text",
            text:
              filenameNote +
              "Document contents (Word doc, text-only extract):\n\n" +
              truncated +
              "\n\n" +
              PROMPT_TEXT,
          },
        ],
      };
    } catch (err: any) {
      return {
        ok: false,
        error: `Couldn't read this Word doc — ${err?.message ?? "extract failed"}.`,
      };
    }
  }

  // ---- XLSX / XLS → exceljs CSV-ish dump -----------------------------
  if (
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.ms-excel"
  ) {
    try {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(opts.fileBuffer);
      const lines: string[] = [];
      wb.eachSheet((sheet) => {
        lines.push(`### Sheet: ${sheet.name}`);
        sheet.eachRow((row) => {
          const vals = (row.values as unknown[]).slice(1).map((v) => {
            if (v === null || v === undefined) return "";
            if (typeof v === "object" && v !== null && "text" in (v as any)) {
              return String((v as any).text ?? "");
            }
            return String(v);
          });
          lines.push(vals.join("\t"));
        });
        lines.push("");
      });
      const dump = truncateText(lines.join("\n"), 100_000);
      return {
        ok: true,
        content: [
          {
            type: "text",
            text:
              filenameNote +
              "Document contents (spreadsheet, tab-separated text-only extract):\n\n" +
              dump +
              "\n\n" +
              PROMPT_TEXT,
          },
        ],
      };
    } catch (err: any) {
      return {
        ok: false,
        error: `Couldn't read this spreadsheet — ${err?.message ?? "extract failed"}.`,
      };
    }
  }

  // ---- Plain text / CSV → utf-8 ----------------------------------
  if (mt === "text/plain" || mt === "text/csv") {
    const text = truncateText(opts.fileBuffer.toString("utf-8"), 100_000);
    return {
      ok: true,
      content: [
        {
          type: "text",
          text:
            filenameNote +
            (mt === "text/csv" ? "CSV contents:" : "Text file contents:") +
            "\n\n" +
            text +
            "\n\n" +
            PROMPT_TEXT,
        },
      ],
    };
  }

  return {
    ok: false,
    error: `Unsupported file type for classification: ${opts.mediaType}.`,
  };
}

/**
 * Cap the text we send to Claude so a malicious or massive document
 * can't blow the token budget. ~100k chars is roughly 25k tokens for
 * English — comfortable headroom under any per-call limit.
 */
function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\n\n[…truncated]";
}

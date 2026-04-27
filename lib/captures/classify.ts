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
 * Run Claude vision on a base64-encoded image. `mediaType` is the image
 * MIME type (image/jpeg, image/png, etc.).
 */
export async function classifyCaptureImage(opts: {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** For the spend log audit trail. */
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
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: [tool],
      tool_choice: { type: "any" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: opts.mediaType,
                data: opts.imageBase64,
              },
            },
            {
              type: "text",
              text: "Classify this image and extract whatever fields apply.",
            },
          ],
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
      note: "capture-classify",
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
      error: err?.message ?? "Claude vision call failed",
    };
  }
}

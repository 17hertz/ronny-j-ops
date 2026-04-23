/**
 * Tool definitions for the Ronny J operations agent.
 *
 * Design rules:
 *   - v0.1 is read-only + draft-only. NO writes. NO sends. NO money moves.
 *     When Claude wants to do something that changes state, it drafts it and
 *     we (Jason) click the final button. This is a deliberate trust ramp —
 *     we let Claude read and reason before we let it act.
 *
 *   - Each tool is a pair: a JSON Schema that Anthropic's Messages API uses
 *     for function-calling, plus a server-side executor that actually runs
 *     the logic against Supabase. The executor signature is always
 *     `(input: unknown) => Promise<unknown>` so the dispatcher doesn't need
 *     to know types at runtime.
 *
 *   - Every executor uses the admin Supabase client. The agent never runs
 *     on behalf of a specific user — it's a back-office operator with full
 *     read access. Writes stay gated elsewhere.
 *
 *   - Outputs are shaped small. Claude's context is precious; we don't
 *     return every column of every row. Return only what a human operator
 *     would glance at — names, status, amounts, dates — and let Claude
 *     ask for details via a follow-up get_ call if needed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";

type ToolDef = {
  schema: Anthropic.Tool;
  run: (input: any) => Promise<unknown>;
};

// ---------- search_vendors ---------------------------------------------

const searchVendors: ToolDef = {
  schema: {
    name: "search_vendors",
    description:
      "Search vendors by legal name, DBA, email, or service category. " +
      "Returns up to 20 brief matches. Use get_vendor for full details on one.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text query — name, email, or service category",
        },
        status: {
          type: "string",
          enum: ["pending", "approved", "rejected"],
          description: "Optional status filter",
        },
      },
      required: ["query"],
    },
  },
  run: async (input: { query: string; status?: string }) => {
    const admin = createAdminClient();
    let q = (admin as any)
      .from("vendors")
      .select(
        "id, legal_name, dba, contact_email, service_category, status, created_at"
      )
      .limit(20)
      .order("created_at", { ascending: false });

    // Broad match across text columns. For richer search we'd add a tsvector
    // column, but for 20-200 rows this ilike OR is fine.
    const pattern = `%${input.query}%`;
    q = q.or(
      `legal_name.ilike.${pattern},dba.ilike.${pattern},contact_email.ilike.${pattern},service_category.ilike.${pattern}`
    );
    if (input.status) q = q.eq("status", input.status);

    const { data, error } = await q;
    if (error) return { error: error.message };
    return { results: data ?? [] };
  },
};

// ---------- get_vendor -------------------------------------------------

const getVendor: ToolDef = {
  schema: {
    name: "get_vendor",
    description:
      "Get full details for one vendor. Returns legal name, status, " +
      "contact info, service category, and payment-method last4 (never full " +
      "account numbers).",
    input_schema: {
      type: "object",
      properties: {
        vendor_id: { type: "string", description: "Vendor UUID" },
      },
      required: ["vendor_id"],
    },
  },
  run: async (input: { vendor_id: string }) => {
    const admin = createAdminClient();
    const { data, error } = await (admin as any)
      .from("vendors")
      .select(
        "id, legal_name, dba, contact_email, contact_phone, service_category, status, ach_bank_name, ach_account_last4, secondary_payment_method, tin_match_status, created_at, updated_at"
      )
      .eq("id", input.vendor_id)
      .maybeSingle();
    if (error) return { error: error.message };
    if (!data) return { error: "not found" };
    return data;
  },
};

// ---------- list_invoices ----------------------------------------------

const listInvoices: ToolDef = {
  schema: {
    name: "list_invoices",
    description:
      "List invoices, optionally filtered by status, vendor, or submission " +
      "window. Returns up to 50 rows sorted newest-first.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["submitted", "under_review", "approved", "rejected", "paid", "void"],
        },
        vendor_id: { type: "string" },
        since: {
          type: "string",
          description: "ISO date — only invoices submitted on or after this",
        },
      },
    },
  },
  run: async (input: { status?: string; vendor_id?: string; since?: string }) => {
    const admin = createAdminClient();
    let q = (admin as any)
      .from("vendor_documents")
      .select(
        "id, vendor_id, invoice_number, invoice_amount_cents, invoice_status, invoice_description, submitted_at, reviewed_at, paid_at"
      )
      .eq("kind", "invoice")
      .order("submitted_at", { ascending: false })
      .limit(50);

    if (input.status) q = q.eq("invoice_status", input.status);
    if (input.vendor_id) q = q.eq("vendor_id", input.vendor_id);
    if (input.since) q = q.gte("submitted_at", input.since);

    const { data, error } = await q;
    if (error) return { error: error.message };
    return { results: data ?? [] };
  },
};

// ---------- get_invoice -----------------------------------------------

const getInvoice: ToolDef = {
  schema: {
    name: "get_invoice",
    description:
      "Get full details for one invoice including line items (if generated), " +
      "review notes, and the vendor snapshot.",
    input_schema: {
      type: "object",
      properties: {
        invoice_id: { type: "string" },
      },
      required: ["invoice_id"],
    },
  },
  run: async (input: { invoice_id: string }) => {
    const admin = createAdminClient();
    const { data, error } = await (admin as any)
      .from("vendor_documents")
      .select(
        "id, vendor_id, invoice_number, invoice_amount_cents, invoice_status, invoice_description, invoice_due_at, invoice_form_payload, generated_by_system, submitted_at, reviewed_at, review_notes, paid_at, original_filename"
      )
      .eq("id", input.invoice_id)
      .eq("kind", "invoice")
      .maybeSingle();
    if (error) return { error: error.message };
    if (!data) return { error: "not found" };

    // Pull vendor name alongside — nearly every downstream reasoning step
    // wants the vendor name, so save a tool round-trip.
    const { data: vendor } = await (admin as any)
      .from("vendors")
      .select("legal_name, contact_email, ach_account_last4")
      .eq("id", data.vendor_id)
      .maybeSingle();

    return { ...data, vendor };
  },
};

// ---------- list_events ------------------------------------------------

const listEvents: ToolDef = {
  schema: {
    name: "list_events",
    description:
      "List calendar events in a time window. Use for 'what's scheduled " +
      "this week', 'any unconfirmed sessions', etc.",
    input_schema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO datetime lower bound" },
        until: { type: "string", description: "ISO datetime upper bound" },
      },
      required: ["since", "until"],
    },
  },
  run: async (input: { since: string; until: string }) => {
    const admin = createAdminClient();
    const { data, error } = await (admin as any)
      .from("events")
      .select(
        "id, title, starts_at, ends_at, timezone, location, status, google_event_id"
      )
      .gte("starts_at", input.since)
      .lte("starts_at", input.until)
      .order("starts_at", { ascending: true })
      .limit(100);
    if (error) return { error: error.message };
    return { results: data ?? [] };
  },
};

// ---------- list_pending_reminders -------------------------------------

const listPendingReminders: ToolDef = {
  schema: {
    name: "list_pending_reminders",
    description:
      "Reminders scheduled to dispatch in the future that haven't sent yet.",
    input_schema: { type: "object", properties: {} },
  },
  run: async () => {
    const admin = createAdminClient();
    const now = new Date().toISOString();
    const { data, error } = await (admin as any)
      .from("reminders")
      .select("id, event_id, kind, scheduled_at, status")
      .gte("scheduled_at", now)
      .neq("status", "sent")
      .order("scheduled_at", { ascending: true })
      .limit(100);
    if (error) return { error: error.message };
    return { results: data ?? [] };
  },
};

// ---------- draft_vendor_message ---------------------------------------
// No side effect — this literally just returns a suggested email body. The
// operator copies it into their email client. We gate actual sending to a
// later version once we trust the drafts.

const draftVendorMessage: ToolDef = {
  schema: {
    name: "draft_vendor_message",
    description:
      "Draft a plain-text email to a vendor. Returns subject + body as " +
      "strings. The operator reviews and sends manually — this does not " +
      "actually email anyone.",
    input_schema: {
      type: "object",
      properties: {
        vendor_id: { type: "string" },
        purpose: {
          type: "string",
          description:
            "What the email should accomplish in plain language. E.g. " +
            "'ask for a missing W9', 'follow up on invoice 12 that's been " +
            "submitted for 10 days', 'decline politely because we don't " +
            "need mastering right now'",
        },
      },
      required: ["vendor_id", "purpose"],
    },
  },
  run: async (input: { vendor_id: string; purpose: string }) => {
    // This tool deliberately returns a placeholder payload — the drafting
    // itself happens in Claude's own text response. We just hand it the
    // vendor context so it can address the email correctly.
    const admin = createAdminClient();
    const { data } = await (admin as any)
      .from("vendors")
      .select("legal_name, contact_email, status, service_category")
      .eq("id", input.vendor_id)
      .maybeSingle();
    if (!data) return { error: "vendor not found" };
    return {
      vendor: data,
      purpose: input.purpose,
      instruction:
        "Write the email in your next reply. Keep it short, warm but " +
        "professional, and sign it '— 17 Hertz Inc.'",
    };
  },
};

// ---------- Registry ---------------------------------------------------

export const tools: Record<string, ToolDef> = {
  search_vendors: searchVendors,
  get_vendor: getVendor,
  list_invoices: listInvoices,
  get_invoice: getInvoice,
  list_events: listEvents,
  list_pending_reminders: listPendingReminders,
  draft_vendor_message: draftVendorMessage,
};

export const toolSchemas: Anthropic.Tool[] = Object.values(tools).map(
  (t) => t.schema
);

/**
 * Dispatch a tool call from Claude's tool_use content block. Returns a
 * stringified JSON payload — the shape Anthropic's Messages API expects in
 * a tool_result content block.
 */
export async function runTool(
  name: string,
  input: unknown
): Promise<string> {
  const tool = tools[name];
  if (!tool) {
    return JSON.stringify({ error: `unknown tool: ${name}` });
  }
  try {
    const result = await tool.run(input);
    return JSON.stringify(result);
  } catch (err: any) {
    console.error(`[agent/tools] ${name} threw`, err);
    return JSON.stringify({ error: err?.message ?? "tool failed" });
  }
}

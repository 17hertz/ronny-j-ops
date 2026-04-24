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
import {
  updateTask,
  completeTask as completeTaskService,
  cancelTask as cancelTaskService,
} from "@/lib/tasks/service";
import { updateEvent } from "@/lib/events/service";
import { naiveLocalToUtcIso } from "@/lib/time/naive-iso";

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

// ---------- list_event_crew -------------------------------------------

const listEventCrew: ToolDef = {
  schema: {
    name: "list_event_crew",
    description:
      "List vendor assignments (crew) for events. Use when the user asks " +
      "questions like 'who's my security tonight?', 'what time's my set?', " +
      "'who's working this weekend?', 'what time is the driver showing up?'. " +
      "Returns each assignment with role, vendor name, service window, and " +
      "on-site contact. Filter by event_id (exact match), date (YYYY-MM-DD " +
      "in America/New_York, finds events that day), or role.",
    input_schema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "UUID of a specific event. If set, ignores date filter.",
        },
        date: {
          type: "string",
          description:
            "YYYY-MM-DD (America/New_York) to filter by events happening that day.",
        },
        role: {
          type: "string",
          description:
            "Optional role filter (security, artist, driver, photography, etc.)",
        },
      },
    },
  },
  run: async (input: { event_id?: string; date?: string; role?: string }) => {
    const admin = createAdminClient();

    let q = (admin as any)
      .from("event_vendors")
      .select(
        `
        id, role, service_window_start, service_window_end,
        contact_on_site, notes,
        event:events ( id, title, starts_at, ends_at, timezone, location ),
        vendor:vendors ( id, legal_name, dba, contact_email, contact_phone, service_category )
        `
      )
      .order("service_window_start", { ascending: true, nullsFirst: false });

    if (input.event_id) q = q.eq("event_id", input.event_id);
    if (input.role) q = q.eq("role", input.role);

    // Date filter resolves to "events whose starts_at falls on this date
    // in America/New_York." Two-step: compute UTC bounds for the date,
    // then filter the JOIN via `starts_at` ranges. Postgrest doesn't
    // easily filter on a joined column, so we do a preliminary event
    // lookup and then constrain event_id to the resulting list.
    if (input.date && !input.event_id) {
      const anchor = new Date(`${input.date}T12:00:00Z`);
      const hourInZone = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          hour12: false,
        }).format(anchor)
      );
      const offsetHours = 12 - hourInZone;
      const startUtc = new Date(`${input.date}T00:00:00Z`);
      startUtc.setUTCHours(startUtc.getUTCHours() + offsetHours);
      const endUtc = new Date(startUtc);
      endUtc.setUTCDate(endUtc.getUTCDate() + 1);

      const { data: dateEvents } = (await (admin as any)
        .from("events")
        .select("id")
        .gte("starts_at", startUtc.toISOString())
        .lt("starts_at", endUtc.toISOString())) as {
        data: Array<{ id: string }> | null;
      };
      const ids = (dateEvents ?? []).map((e) => e.id);
      if (ids.length === 0) return { count: 0, assignments: [] };
      q = q.in("event_id", ids);
    }

    const { data, error } = await q.limit(50);
    if (error) return { error: error.message };
    return { count: (data ?? []).length, assignments: data ?? [] };
  },
};

// ---------- assign_vendor_to_event ------------------------------------

const assignVendorToEvent: ToolDef = {
  schema: {
    name: "assign_vendor_to_event",
    description:
      "Attach a vendor to an event in a specific role with optional service " +
      "window and on-site contact. Use when the user says things like " +
      "'assign Crescent Security to tonight's show, call time 8pm' or " +
      "'put Monk behind the lens for Saturday'. Requires both event_id and " +
      "vendor_id — you may need to call list_events and search_vendors first.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Target event UUID" },
        vendor_id: { type: "string", description: "Vendor UUID to assign" },
        role: {
          type: "string",
          enum: [
            "security", "photography", "videography", "catering", "lighting",
            "sound", "driver", "transportation", "promoter", "venue",
            "artist", "opener", "hair_makeup", "stylist", "stage", "runner",
            "hospitality", "streamer", "performer", "model", "other",
          ],
        },
        service_window_start: {
          type: "string",
          description: "Optional ISO 8601 start (call time, set start, etc.)",
        },
        service_window_end: {
          type: "string",
          description: "Optional ISO 8601 end. Defaults to 1h after start if omitted.",
        },
        contact_on_site: {
          type: "string",
          description: "Free-text 'name + phone' of the specific person working (e.g. 'Mike 555-1234')",
        },
        notes: { type: "string", description: "Short free-text notes" },
      },
      required: ["event_id", "vendor_id", "role"],
    },
  },
  run: async (input: {
    event_id: string;
    vendor_id: string;
    role: string;
    service_window_start?: string;
    service_window_end?: string;
    contact_on_site?: string;
    notes?: string;
  }) => {
    const admin = createAdminClient();
    const end =
      input.service_window_end ??
      (input.service_window_start
        ? new Date(
            new Date(input.service_window_start).getTime() + 60 * 60 * 1000
          ).toISOString()
        : undefined);

    const { data, error } = (await (admin as any)
      .from("event_vendors")
      .insert({
        event_id: input.event_id,
        vendor_id: input.vendor_id,
        role: input.role,
        service_window_start: input.service_window_start ?? null,
        service_window_end: end ?? null,
        contact_on_site: input.contact_on_site ?? null,
        notes: input.notes ?? null,
      })
      .select("id, event_id, vendor_id, role")
      .single()) as {
      data: {
        id: string;
        event_id: string;
        vendor_id: string;
        role: string;
      } | null;
      error: { message: string } | null;
    };

    if (error) return { error: error.message };
    return { ok: true, assignment: data };
  },
};

// ---------- unassign_vendor_from_event --------------------------------

const unassignVendorFromEvent: ToolDef = {
  schema: {
    name: "unassign_vendor_from_event",
    description:
      "Remove a vendor assignment from an event. Use when the user says " +
      "'drop X from tonight' or 'unbook Y from Saturday'. Pass the " +
      "assignment's id (not the vendor_id). Get the id from list_event_crew.",
    input_schema: {
      type: "object",
      properties: {
        assignment_id: {
          type: "string",
          description:
            "UUID of the event_vendors row to delete. Returned by list_event_crew as `id`.",
        },
      },
      required: ["assignment_id"],
    },
  },
  run: async (input: { assignment_id: string }) => {
    const admin = createAdminClient();
    const { error } = await (admin as any)
      .from("event_vendors")
      .delete()
      .eq("id", input.assignment_id);
    if (error) return { error: error.message };
    return { ok: true, removed: input.assignment_id };
  },
};

// ---------- list_tasks ------------------------------------------------

const listTasks: ToolDef = {
  schema: {
    name: "list_tasks",
    description:
      "List tasks for a specific team member. Use when the user asks " +
      "'what's on my todo list?', 'any open tasks?', 'what did I finish " +
      "today?'. Optionally filter by status (needsAction, completed). " +
      "Pass include_completed=true to include recently-completed items.",
    input_schema: {
      type: "object",
      properties: {
        team_member_id: {
          type: "string",
          description: "UUID of the team_member whose tasks to list.",
        },
        status: {
          type: "string",
          enum: ["needsAction", "completed", "cancelled"],
          description: "Optional filter. Default: needsAction only.",
        },
        limit: {
          type: "number",
          description: "Max rows. Default 20, cap 100.",
        },
      },
      required: ["team_member_id"],
    },
  },
  run: async (input: {
    team_member_id: string;
    status?: string;
    limit?: number;
  }) => {
    const admin = createAdminClient();
    const limit = Math.min(100, input.limit ?? 20);
    let q = (admin as any)
      .from("tasks")
      .select("id, title, notes, status, due_at, completed_at, source")
      .eq("team_member_id", input.team_member_id)
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (input.status) q = q.eq("status", input.status);
    else q = q.eq("status", "needsAction");
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { count: (data ?? []).length, tasks: data ?? [] };
  },
};

// ---------- update_task -----------------------------------------------

const updateTaskTool: ToolDef = {
  schema: {
    name: "update_task",
    description:
      "Edit a task's title, notes, or due date. Use when the user says " +
      "'rename that task to X' or 'push the deadline to tomorrow'. " +
      "Queues a push to Google Tasks automatically. Get the task_id " +
      "from list_tasks first.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "UUID of the task to edit." },
        title: { type: "string", description: "New title (optional)." },
        notes: {
          type: "string",
          description: "New notes/body. Pass empty string to clear.",
        },
        due_at: {
          type: "string",
          description:
            "New due date-time. Prefer full ISO with Z. If you emit a " +
            "naive wall-clock like '2026-04-25T17:00:00', also set " +
            "due_at_timezone so we interpret it correctly.",
        },
        due_at_timezone: {
          type: "string",
          description:
            "IANA tz (e.g. 'America/Los_Angeles'). Used when due_at is " +
            "naive. Prefer passing the SENDER's timezone.",
        },
      },
      required: ["task_id"],
    },
  },
  run: async (input: {
    task_id: string;
    title?: string;
    notes?: string;
    due_at?: string;
    due_at_timezone?: string;
  }) => {
    const dueAt = input.due_at
      ? naiveLocalToUtcIso(input.due_at, input.due_at_timezone || "America/New_York")
      : undefined;
    try {
      const task = await updateTask({
        taskId: input.task_id,
        title: input.title,
        notes: input.notes === undefined ? undefined : input.notes,
        dueAt: dueAt,
      });
      return { ok: true, task };
    } catch (err: any) {
      return { error: err?.message ?? "update failed" };
    }
  },
};

// ---------- complete_task ---------------------------------------------

const completeTaskTool: ToolDef = {
  schema: {
    name: "complete_task",
    description:
      "Mark a task as done. Queues a push to Google Tasks. Idempotent. " +
      "Use when the user says 'mark X done' or 'I finished Y'.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "UUID of the task." },
      },
      required: ["task_id"],
    },
  },
  run: async (input: { task_id: string }) => {
    try {
      const task = await completeTaskService(input.task_id);
      return { ok: true, task };
    } catch (err: any) {
      return { error: err?.message ?? "complete failed" };
    }
  },
};

// ---------- cancel_task -----------------------------------------------

const cancelTaskTool: ToolDef = {
  schema: {
    name: "cancel_task",
    description:
      "Soft-delete / cancel a task. Local row stays for audit but the " +
      "task is removed from Google Tasks. Use for 'drop that todo' or " +
      "'never mind on X'. Confirm with the user first for destructive " +
      "asks where they might have meant complete_task.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "UUID of the task." },
      },
      required: ["task_id"],
    },
  },
  run: async (input: { task_id: string }) => {
    try {
      const task = await cancelTaskService(input.task_id);
      return { ok: true, task };
    } catch (err: any) {
      return { error: err?.message ?? "cancel failed" };
    }
  },
};

// ---------- update_event ----------------------------------------------

const updateEventTool: ToolDef = {
  schema: {
    name: "update_event",
    description:
      "Edit an event's title, time window, location, or notes. Queues " +
      "a PATCH to Google Calendar so the change syncs to everyone's " +
      "phone. Get event_id from list_events first.",
    input_schema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "UUID of the event." },
        title: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        starts_at: {
          type: "string",
          description:
            "New start time. Prefer full UTC ISO with Z. If you emit a " +
            "naive wall-clock, also set the_timezone so we interpret it.",
        },
        ends_at: {
          type: "string",
          description: "New end time. Same format rules as starts_at.",
        },
        the_timezone: {
          type: "string",
          description:
            "IANA tz (e.g. 'America/Los_Angeles'). Applied to any naive " +
            "starts_at/ends_at. Prefer the SENDER's timezone.",
        },
      },
      required: ["event_id"],
    },
  },
  run: async (input: {
    event_id: string;
    title?: string;
    description?: string;
    location?: string;
    starts_at?: string;
    ends_at?: string;
    the_timezone?: string;
  }) => {
    const tz = input.the_timezone || "America/New_York";
    const startsAt = input.starts_at
      ? naiveLocalToUtcIso(input.starts_at, tz)
      : undefined;
    const endsAt = input.ends_at
      ? naiveLocalToUtcIso(input.ends_at, tz)
      : undefined;
    try {
      // The service handles pushing via Inngest. We don't track the
      // acting team_member here (no session context in tool runner),
      // so pass a best-effort placeholder — the push worker looks up
      // the event's existing google_account_id for authentication.
      const event = await updateEvent({
        eventId: input.event_id,
        title: input.title,
        description: input.description === undefined ? undefined : input.description,
        location: input.location === undefined ? undefined : input.location,
        startsAt,
        endsAt,
        timezone: input.the_timezone,
        teamMemberId: "",
      });
      return { ok: true, event };
    } catch (err: any) {
      return { error: err?.message ?? "update failed" };
    }
  },
};

// ---------- Registry ---------------------------------------------------

export const tools: Record<string, ToolDef> = {
  search_vendors: searchVendors,
  get_vendor: getVendor,
  list_invoices: listInvoices,
  get_invoice: getInvoice,
  list_events: listEvents,
  list_event_crew: listEventCrew,
  assign_vendor_to_event: assignVendorToEvent,
  unassign_vendor_from_event: unassignVendorFromEvent,
  list_pending_reminders: listPendingReminders,
  draft_vendor_message: draftVendorMessage,
  list_tasks: listTasks,
  update_task: updateTaskTool,
  complete_task: completeTaskTool,
  cancel_task: cancelTaskTool,
  update_event: updateEventTool,
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

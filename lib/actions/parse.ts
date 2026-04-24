/**
 * Intent parser for inbound SMS/WhatsApp.
 *
 * Takes a raw message body ("add todo: pick up headphones", "done: approve
 * 3 invoices", "what's on today?") and returns a structured intent the
 * dispatcher can execute.
 *
 * Strategy: Claude Haiku 4.5 with constrained tool-use. We define one
 * tool per intent and set `tool_choice: { type: "any" }` — Claude MUST
 * pick one. Sparse, cheap, reliable for classification-grade parsing.
 *
 * Pre-flight spend check guards every call. Common keywords (help, stop,
 * "what's today") are short-circuited BEFORE the parser so we don't burn
 * an LLM call on them.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { preflightSpendCheck, logSpend } from "@/lib/agent/spend-gate";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 256;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

/** All possible parsed intents. */
export type ParsedIntent =
  | { kind: "create_task"; title: string; dueAt?: string | null }
  | { kind: "complete_task"; titleMatch: string }
  | { kind: "get_digest" }
  | { kind: "help" }
  | { kind: "create_event"; title: string; startsAt: string; endsAt?: string | null; location?: string | null }
  | { kind: "ask_claude"; question: string }
  | { kind: "ask_gpt"; question: string }
  | { kind: "unknown"; reason: string }
  | { kind: "spend_cap_reached" };

const tools: Anthropic.Tool[] = [
  {
    name: "create_task",
    description:
      "Create a new task/todo. Use for: 'add todo: X', 'remind me to X', 'task: X'. Extract just the action itself (no 'add todo:' prefix).",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The task title — what needs to happen",
        },
        due_at: {
          type: "string",
          description:
            "Optional ISO date-time when due. Only set if user gave a clear time/date.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description:
      "Mark an existing task as done. Use for: 'done: X', 'finished X', 'mark X complete'. Pass a short substring from the task's title for matching.",
    input_schema: {
      type: "object",
      properties: {
        title_match: {
          type: "string",
          description:
            "Short keyword or phrase from the target task's title. Used for fuzzy matching.",
        },
      },
      required: ["title_match"],
    },
  },
  {
    name: "create_event",
    description:
      "Create a calendar event. Use for: 'add lunch w/ X Friday 1pm', 'schedule X for Y date', 'book meeting...'. Requires a clear start time.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Event title" },
        starts_at: {
          type: "string",
          description:
            "ISO date-time for start. Current year assumed if not specified. Use America/New_York timezone unless user says otherwise.",
        },
        ends_at: {
          type: "string",
          description:
            "Optional ISO date-time for end. If omitted, we default to 1 hour after starts_at.",
        },
        location: {
          type: "string",
          description: "Optional location or address",
        },
      },
      required: ["title", "starts_at"],
    },
  },
  {
    name: "get_digest",
    description:
      "Reply with today's digest (events + open tasks + what's been done). Use for: 'what's on today', 'digest', 'summary', 'what do i have today'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "help",
    description:
      "Reply with a help menu explaining available commands. Use when the user asks for help or sends an unclear message.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "unknown",
    description:
      "Use when the message doesn't fit any other command AND isn't asking for help. Explain briefly why.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief explanation of why this couldn't be parsed",
        },
      },
      required: ["reason"],
    },
  },
];

/**
 * Build the system prompt with the sender's current time injected in
 * their timezone, not the server's. Critical for relative expressions
 * like "tomorrow noon" — if Jason (PT) texts at 11pm PT, his "tomorrow"
 * is one PT day ahead; using the server's UTC clock would land it on
 * the wrong day.
 */
function buildSystemPrompt(senderTz: string): string {
  // ISO with offset for the sender's wall clock. Example output:
  //   "2026-04-23T14:05:00-07:00"
  // Constructed via Intl because JS Date has no native "ISO in zone".
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: senderTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const localIso = `${get("year")}-${get("month")}-${get("day")}T${get(
    "hour"
  )}:${get("minute")}:${get("second")}`;

  return `You are an SMS command parser for Ronny J Ops, a booking / operations app.
You receive one short text message and MUST pick exactly one tool to invoke.
Sender's current local time: ${localIso} (timezone: ${senderTz}).

Rules:
- Only emit tool calls — never write prose.
- If the message is ambiguous, prefer 'help' over 'unknown'.
- For dates like "Friday 1pm" or "tomorrow noon", resolve to the NEXT upcoming occurrence in the SENDER's timezone (${senderTz}).
- When emitting starts_at / ends_at / due_at, produce a bare ISO like "2026-04-24T12:00:00" (no Z, no offset). The dispatcher combines it with the sender's timezone when pushing to Google.
- Keep extracted titles concise — strip command prefixes like "add todo:".
- Never invent due dates. If the user didn't say when, omit due_at.`;
}

export async function parseIntent(
  message: string,
  opts: { senderTz: string } = { senderTz: "America/New_York" }
): Promise<ParsedIntent> {
  // Pre-flight spend check. If we've hit the cap, skip the LLM entirely —
  // the dispatcher will reply with a graceful "paused" message.
  const check = await preflightSpendCheck();
  if (!check.ok) {
    await logSpend({
      purpose: "sms-parse",
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      note: `refused: monthly cap ($${(check.capCents / 100).toFixed(
        0
      )}) reached`,
    });
    return { kind: "spend_cap_reached" };
  }

  try {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(opts.senderTz),
      tools,
      // Force the model to use a tool. No free-form replies.
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: message }],
    });

    const usage = response.usage as any;
    await logSpend({
      purpose: "sms-parse",
      model: MODEL,
      inputTokens: usage?.input_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    });

    const toolUse = response.content.find(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
    );
    if (!toolUse) {
      return { kind: "unknown", reason: "parser returned no tool call" };
    }

    const input = toolUse.input as any;
    switch (toolUse.name) {
      case "create_task":
        if (!input?.title) {
          return { kind: "unknown", reason: "missing task title" };
        }
        return {
          kind: "create_task",
          title: String(input.title),
          dueAt: input.due_at ? String(input.due_at) : null,
        };
      case "complete_task":
        if (!input?.title_match) {
          return { kind: "unknown", reason: "missing task match" };
        }
        return {
          kind: "complete_task",
          titleMatch: String(input.title_match),
        };
      case "create_event":
        if (!input?.title || !input?.starts_at) {
          return {
            kind: "unknown",
            reason: "missing event title or start time",
          };
        }
        return {
          kind: "create_event",
          title: String(input.title),
          startsAt: String(input.starts_at),
          endsAt: input.ends_at ? String(input.ends_at) : null,
          location: input.location ? String(input.location) : null,
        };
      case "get_digest":
        return { kind: "get_digest" };
      case "help":
        return { kind: "help" };
      case "unknown":
        return {
          kind: "unknown",
          reason: input?.reason ?? "could not parse",
        };
      default:
        return { kind: "unknown", reason: `unexpected tool: ${toolUse.name}` };
    }
  } catch (err: any) {
    console.error("[actions/parse] Claude call failed", err);
    return {
      kind: "unknown",
      reason: `parser error: ${err?.message ?? "unknown"}`,
    };
  }
}

/**
 * Free-form chat passthrough for SMS/WhatsApp commands like
 * "claude <question>". Runs a Claude Sonnet tool-use loop with access
 * to the ops tools (search_vendors / get_vendor / search_invoices /
 * get_invoice / list_events / list_pending_reminders / etc.).
 *
 * Answers operational questions like:
 *   - "how much did I spend this week?"       → search_invoices
 *   - "what's my security vendor's phone?"    → search_vendors
 *   - "who's at tonight's show?"              → list_events + drills
 *
 * Stateless per message. Gated by preflightSpendCheck so runaway use
 * doesn't blow through the $20/mo cap. Prompt-cached tool schemas so
 * the second+ messages in a session are ~10% of the input cost.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { preflightSpendCheck, logSpend } from "@/lib/agent/spend-gate";
import { toolSchemas, runTool } from "@/lib/agent/tools";

// Using Sonnet here (not Haiku) because tool-use chains benefit from
// Sonnet's better reasoning — Haiku sometimes hallucinates tool args
// or skips the lookup and answers from thin air. Cost is bounded by
// max_tokens + iteration cap + rate limit + monthly cap.
const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 512;
// Enough for lookup → maybe another lookup → answer. Tighter than the
// dashboard's 8 because SMS replies should be quick and bounded.
const MAX_ITERATIONS = 4;

// Cap so replies fit in one or two SMS segments. Anthropic may emit
// longer, we truncate.
const SMS_REPLY_CHAR_CAP = 800;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Run Claude in a tool-use loop with an SMS-friendly system prompt +
 * access to the ops tools. Returns what Claude ultimately said, truncated
 * for SMS. Even on failure we return a sendable string so the user
 * isn't left hanging.
 */
export async function askClaudePassthrough(
  question: string,
  opts: {
    senderTz?: string;
    senderName?: string;
    senderTeamMemberId?: string;
  } = {}
): Promise<{ replyText: string; refused?: boolean; error?: string }> {
  const trimmed = question.trim();
  if (!trimmed) {
    return { replyText: "Ask me a question after 'claude' and I'll answer." };
  }

  const check = await preflightSpendCheck();
  if (!check.ok) {
    await logSpend({
      purpose: "other",
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      note: `claude-passthrough refused: monthly cap reached`,
    });
    return {
      replyText:
        "I'm paused for the rest of the month (AI spend cap). Full service resumes on the 1st.",
      refused: true,
    };
  }

  // Cache the tool schemas — same pattern as lib/agent/run.ts. The first
  // SMS in a session pays full price (~$0.02); subsequent ones pay ~10%
  // on the cached-tool prefix.
  const cachedTools = toolSchemas.map((t, idx) =>
    idx === toolSchemas.length - 1
      ? { ...t, cache_control: { type: "ephemeral" as const } }
      : t
  );

  const system = buildSystemPrompt(opts);
  const working: Anthropic.MessageParam[] = [
    { role: "user", content: trimmed },
  ];

  let totalInput = 0;
  let totalCachedInput = 0;
  let totalOutput = 0;
  let finalText = "";

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await client().messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: cachedTools,
        messages: working,
      });

      const usage = response.usage as any;
      totalInput += usage?.input_tokens ?? 0;
      totalCachedInput += usage?.cache_read_input_tokens ?? 0;
      totalOutput += usage?.output_tokens ?? 0;

      // Always push the assistant turn so tool_result threading stays valid.
      working.push({ role: "assistant", content: response.content });

      const textBits = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text);
      if (textBits.length > 0) finalText = textBits.join("\n\n");

      // Done when Claude stops calling tools.
      if (response.stop_reason !== "tool_use") break;

      // Run every tool_use block Claude emitted and thread results back.
      const toolUses = response.content.filter(
        (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const output = await runTool(use.name, use.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: output,
        });
      }
      working.push({ role: "user", content: toolResults });
    }

    await logSpend({
      purpose: "other",
      model: MODEL,
      inputTokens: totalInput,
      cachedInputTokens: totalCachedInput,
      outputTokens: totalOutput,
      note: "claude-passthrough",
    });

    if (!finalText.trim()) {
      return {
        replyText:
          "(got an empty reply from Claude — try rephrasing your question)",
      };
    }

    return { replyText: truncateForSms(finalText.trim()) };
  } catch (err: any) {
    // Log whatever tokens we accumulated before the throw, so spend
    // tracking doesn't lose visibility on failed calls.
    await logSpend({
      purpose: "other",
      model: MODEL,
      inputTokens: totalInput,
      cachedInputTokens: totalCachedInput,
      outputTokens: totalOutput,
      note: `claude-passthrough failed: ${err?.message ?? "unknown"}`,
    });
    console.error("[chat-passthrough] Claude call failed", err);
    return {
      replyText: "Couldn't reach Claude right now. Try again in a minute.",
      error: err?.message ?? "unknown",
    };
  }
}

/**
 * GPT passthrough stub — returns a canned "not wired up" message until
 * someone decides whether to add OpenAI as a second AI provider. The
 * trade-offs: separate API bill, different tool-use schema, potential
 * 1-2s latency hop depending on provider. Track in todolist.txt if we
 * decide to build it.
 */
export async function askGptPassthrough(
  _question: string
): Promise<{ replyText: string }> {
  return {
    replyText:
      "GPT passthrough isn't wired up yet — use 'claude <question>' for now. We can add OpenAI later if Claude doesn't cut it.",
  };
}

function buildSystemPrompt(opts: {
  senderTz?: string;
  senderName?: string;
  senderTeamMemberId?: string;
}): string {
  const name = opts.senderName ? ` You are texting with ${opts.senderName}.` : "";
  const tz = opts.senderTz ?? "America/New_York";
  const teamMemberId = opts.senderTeamMemberId ?? "";
  return `You are the Ronny J Ops assistant, answering via SMS/WhatsApp.${name}

You have tools into the team's operational data (read AND write):
  READ    search_vendors, get_vendor, list_invoices, get_invoice,
          list_events, list_event_crew, list_tasks,
          list_pending_reminders
  WRITE   update_task, complete_task, cancel_task
          update_event, assign_vendor_to_event,
          unassign_vendor_from_event
          draft_vendor_message (drafts only — does not send)

Always use tools to answer questions about specific bookings, spend,
vendor contacts, schedules, or tasks — never guess. When the user asks
you to CHANGE something (rename a task, push a deadline, move an event,
add notes, mark done, drop, cancel), USE THE WRITE TOOLS — don't tell
them to use the dashboard.

Behavior:
- Reply in PLAIN TEXT. No markdown, no bullet lists, no headers — SMS
  doesn't render them.
- Keep replies tight: under 400 characters when possible, 800 max.
- Current time: ${new Date().toISOString()}. Sender timezone: ${tz}.
- Sender's team_member_id: ${teamMemberId}. Pass this as team_member_id
  to list_tasks and similar scoped tools.

Spend questions ("how much this week / today / month"): use
list_invoices with date range + status in ['approved','paid']. Sum
totals, state count.

Vendor contact questions: search_vendors by query/category, then
get_vendor if you need fuller details. Return the specific field
asked for — don't dump every column.

Event questions: list_events for the window. For crew-specific
questions ("who's my security?", "what time's my set?") use
list_event_crew.

Time-bearing edits: the update_task / update_event tools accept a
timezone param. When the user says "push it to tomorrow 3pm", set
the new time as "2026-04-26T15:00:00" plus due_at_timezone or
the_timezone = "${tz}". The tool converts to UTC correctly.

Destructive actions (cancel_task, unassign_vendor_from_event): for
anything that could be a user mistake, reply first with what you're
about to do and wait for confirmation ("Cancel the 'call Acme' task —
confirm?"). For unambiguous "mark X done" / "complete Y", just do it.

If a tool returns nothing relevant, SAY SO. "No approved invoices
this week." Don't invent data. Never invent vendor phone numbers,
event details, or dollar figures.`;
}

function truncateForSms(text: string): string {
  if (text.length <= SMS_REPLY_CHAR_CAP) return text;
  return text.slice(0, SMS_REPLY_CHAR_CAP - 1).replace(/\s+\S*$/, "") + "…";
}

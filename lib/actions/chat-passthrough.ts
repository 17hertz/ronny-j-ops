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
  opts: { senderTz?: string; senderName?: string } = {}
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
}): string {
  const name = opts.senderName ? ` You are texting with ${opts.senderName}.` : "";
  const tz = opts.senderTz ?? "America/New_York";
  return `You are the Ronny J Ops assistant, answering via SMS.${name}

You have READ-ONLY tools into the team's operational data — vendors
(bands, lighting, catering, security, promoters, venues), invoices
(approved + paid are expenses), events (calendar items), reminders
(scheduled notifications). ALWAYS use tools to answer questions about
specific bookings, spend, vendor contacts, schedules — never guess.

Behavior:
- Reply in PLAIN TEXT. No markdown, no bullet lists, no headers — SMS
  doesn't render them.
- Keep replies tight: under 400 characters when possible, 800 max.
- For spend questions ("how much did I spend this week / today / this
  month"), use search_invoices with the right date range and status
  filter (approved + paid = committed expenses; paid alone = cash-basis).
  Sum in your head and state the total + count. Current time: ${new Date().toISOString()}. Sender timezone: ${tz}.
- For vendor contact questions, use search_vendors, then optionally
  get_vendor for fuller details. Return the specific field asked for
  (phone, email, address) — don't dump every column.
- For event questions ("what's tonight", "who's at tomorrow's show"),
  use list_events. If the user asks about specific attendees, mention
  whether the app knows the roster (today attendees come from the intake
  portal / manual attach).
- If a tool returns nothing relevant, SAY SO. "No approved invoices
  this week." Don't invent data.
- The user might reference 'my', 'our', 'the team' — all scoped to this
  team's data. No multi-tenant filtering needed.

Don'ts:
- Never run a write/mutation action from SMS passthrough — the tools
  are read-only but be defensive about not chaining something
  destructive. If the user asks to create/modify/delete, redirect them
  to the structured SMS commands (add todo, add lunch..., done: X) or
  the dashboard.
- Never invent vendor phone numbers, event details, or dollar figures.
  If tools come up empty, that's your answer.`;
}

function truncateForSms(text: string): string {
  if (text.length <= SMS_REPLY_CHAR_CAP) return text;
  return text.slice(0, SMS_REPLY_CHAR_CAP - 1).replace(/\s+\S*$/, "") + "…";
}

/**
 * Agent runner — the tool-use loop.
 *
 * Takes a conversation history, calls Claude with the ops tool schemas, runs
 * any tool_use blocks Claude emits, feeds results back, and repeats until
 * Claude stops calling tools. Returns the final assistant message + the
 * full updated history (so the route handler can persist it or return it).
 *
 * Why a manual loop rather than the Claude Agent SDK here:
 *   - This is a single back-office chat surface, not a multi-session
 *     long-running agent. Raw @anthropic-ai/sdk gives us explicit control
 *     over limits, timeouts, and context shaping.
 *   - @anthropic-ai/sdk is already in package.json (^0.30.0). No new dep.
 *   - Keeps the mental model transparent: Claude calls a tool, we run it,
 *     we hand back the result. Nothing magical in between.
 *
 * Guardrails:
 *   - MAX_ITERATIONS caps the tool-loop so a confused Claude can't wedge
 *     itself into an infinite tool cycle.
 *   - Tool errors are returned as normal tool_result content — Claude gets
 *     to see them and recover. We don't throw.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { SYSTEM_PROMPT } from "./system-prompt";
import { toolSchemas, runTool } from "./tools";
import { preflightSpendCheck, logSpend } from "./spend-gate";

const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 2048;
const MAX_ITERATIONS = 8;

export type ChatMessage = Anthropic.MessageParam;

export type RunResult = {
  reply: string;
  history: ChatMessage[];
  toolCalls: Array<{ name: string; input: unknown }>;
  stopReason: string | null;
};

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Run the agent on a conversation. `history` should already include the new
 * user turn as the last message. Returns the reply and the updated history
 * (with the assistant's messages appended).
 */
export async function runAgent(
  history: ChatMessage[]
): Promise<RunResult> {
  // Pre-flight spend check — if we've hit the monthly cap, refuse
  // gracefully with a chat-native reply instead of a stack trace.
  // Logged as a 0-token entry with a note so it's visible in the audit.
  const check = await preflightSpendCheck();
  if (!check.ok) {
    const spendDollars = (check.monthToDateCents / 100).toFixed(2);
    const capDollars = (check.capCents / 100).toFixed(0);
    await logSpend({
      purpose: "agent",
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      note: `refused: monthly cap ($${capDollars}) reached, $${spendDollars} spent`,
    });
    return {
      reply:
        `I'm paused for the rest of the month — we've hit the Anthropic spend cap ` +
        `($${spendDollars}/$${capDollars}). Full service resumes on the 1st. ` +
        `Raise ANTHROPIC_MONTHLY_CAP_USD to unblock sooner.`,
      history,
      toolCalls: [],
      stopReason: "spend-cap",
    };
  }

  const working: ChatMessage[] = [...history];
  const toolCalls: RunResult["toolCalls"] = [];
  let finalText = "";
  let stopReason: string | null = null;
  // Token accumulators across the tool-use loop — one logSpend at the
  // end so the audit row reflects the whole turn, not each iteration.
  let totalInput = 0;
  let totalCachedInput = 0;
  let totalOutput = 0;

  // Prompt caching: tag the last tool with `cache_control: ephemeral` so
  // Anthropic caches the system prompt + all tool definitions (the prefix
  // up to the breakpoint). Cached tokens bill at ~10% of normal input
  // rate and expire 5 min after last hit. For our workload — ~1500 tokens
  // of tool schemas + ~200 tokens of system prompt sent verbatim every
  // turn — this drops input cost by roughly 80%.
  //
  // Written outside the loop because the object is identical per turn;
  // Anthropic hashes the cached prefix and re-uses regardless.
  const cachedTools = toolSchemas.map((t, idx) =>
    idx === toolSchemas.length - 1
      ? { ...t, cache_control: { type: "ephemeral" as const } }
      : t
  );

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: cachedTools,
      messages: working,
    });

    stopReason = response.stop_reason;

    // Accumulate usage across iterations. Anthropic's response includes
    // cache_read_input_tokens when prompt caching hits.
    const u = response.usage as any;
    totalInput += u?.input_tokens ?? 0;
    totalCachedInput += u?.cache_read_input_tokens ?? 0;
    totalOutput += u?.output_tokens ?? 0;

    // Always push the assistant turn — even if it only contains tool_use
    // blocks, the next turn needs to see it to thread the tool_result back.
    working.push({ role: "assistant", content: response.content });

    // Collect any text content for the final reply. If Claude calls tools
    // AND writes text in the same turn, we still surface the text.
    const textBits = response.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text);
    if (textBits.length > 0) finalText = textBits.join("\n\n");

    // If Claude didn't request any tools, we're done.
    if (response.stop_reason !== "tool_use") {
      break;
    }

    // Run every tool_use block, in order. Build the tool_result content
    // array for the next user turn.
    const toolUses = response.content.filter(
      (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
    );
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCalls.push({ name: use.name, input: use.input });
      const output = await runTool(use.name, use.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: output,
      });
    }

    working.push({ role: "user", content: toolResults });
  }

  // Log aggregate spend once per turn (not per iteration) so the audit
  // row reflects what the user actually asked for. Failures in logSpend
  // are swallowed inside the helper.
  await logSpend({
    purpose: "agent",
    model: MODEL,
    inputTokens: totalInput,
    cachedInputTokens: totalCachedInput,
    outputTokens: totalOutput,
  });

  return {
    reply: finalText || "(no reply — agent exhausted iteration budget)",
    history: working,
    toolCalls,
    stopReason,
  };
}

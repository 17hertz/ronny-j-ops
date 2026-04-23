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
  const working: ChatMessage[] = [...history];
  const toolCalls: RunResult["toolCalls"] = [];
  let finalText = "";
  let stopReason: string | null = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: toolSchemas,
      messages: working,
    });

    stopReason = response.stop_reason;

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

  return {
    reply: finalText || "(no reply — agent exhausted iteration budget)",
    history: working,
    toolCalls,
    stopReason,
  };
}

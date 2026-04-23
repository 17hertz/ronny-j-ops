/**
 * POST /api/agent/chat
 *
 * The admin-facing agent endpoint. Team-member gated.
 *
 * Body: { messages: ChatMessage[] }
 *   - `messages` is the running conversation history in Anthropic's
 *     MessageParam shape. The client owns it — this route is stateless
 *     (no DB persistence yet; we'll add conversation storage in v0.2 if
 *     Jason wants recall across refreshes).
 *
 * Response: { reply: string, toolCalls: [...], stopReason: string | null }
 *
 * Auth: must be signed in AND have a row in team_members. Vendors must not
 * reach this endpoint — the agent can read across all vendors and that
 * would be a trivial data leak.
 *
 * This route deliberately does NOT stream. Tool-use loops don't stream
 * cleanly via Server-Sent Events without more infrastructure, and for a
 * v0.1 internal chat the 2-5 second wait is fine.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runAgent, type ChatMessage } from "@/lib/agent/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Not signed in." },
      { status: 401 }
    );
  }

  const { data: teamMember } = (await sb
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };

  if (!teamMember) {
    return NextResponse.json(
      { ok: false, error: "Agent is team-only." },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const { messages } = body as { messages?: ChatMessage[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json(
      { ok: false, error: "messages[] is required." },
      { status: 400 }
    );
  }

  // Soft cap — don't let a runaway client jam a million tokens of history
  // into the model context. 40 turns is way more than the chat will ever
  // hold before the user hits "new conversation".
  if (messages.length > 40) {
    return NextResponse.json(
      { ok: false, error: "Conversation too long — start a new thread." },
      { status: 413 }
    );
  }

  try {
    const result = await runAgent(messages);
    return NextResponse.json({
      ok: true,
      reply: result.reply,
      history: result.history,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
    });
  } catch (err: any) {
    console.error("[agent/chat] runAgent threw", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Agent failed." },
      { status: 500 }
    );
  }
}

/**
 * Intent dispatcher.
 *
 * Takes a parsed intent + the acting team_member, executes the matching
 * action (create task, complete task, etc.), and returns a reply body
 * the Twilio handler can put into TwiML.
 *
 * Scope notes for v1:
 *   - create_task, complete_task, get_digest, help → implemented.
 *   - create_event → parked with a "coming soon" reply. We don't yet
 *     have a local-events-with-Google-push writer; implementing that
 *     is its own task (will land in a future iteration).
 *   - unknown + spend_cap_reached → canned replies.
 *
 * Handlers return { replyText, artifactId? } where artifactId is the
 * new row's id when applicable — the webhook stores it on the audit row
 * so the history log can link back.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createTask,
  completeTask,
  listCompletedTodayForMember,
} from "@/lib/tasks/service";
import {
  renderDigest,
  todayBoundsUtc,
  type DigestEvent,
  type DigestTask,
  type CompletedTaskSummary,
} from "@/lib/notify/digest";
import type { ParsedIntent } from "./parse";

const TZ = "America/New_York";

export type DispatchOutcome = {
  replyText: string;
  actionStatus: "done" | "error" | "ignored";
  intent: string;
  artifactId?: string;
  error?: string;
};

export async function dispatchIntent(
  intent: ParsedIntent,
  teamMemberId: string
): Promise<DispatchOutcome> {
  switch (intent.kind) {
    case "create_task":
      return await handleCreateTask(intent.title, intent.dueAt ?? null, teamMemberId);
    case "complete_task":
      return await handleCompleteTask(intent.titleMatch, teamMemberId);
    case "get_digest":
      return await handleDigest(teamMemberId);
    case "help":
      return { replyText: HELP_TEXT, actionStatus: "done", intent: "help" };
    case "create_event":
      return {
        replyText:
          "Calendar event creation is coming soon. For now, add it in " +
          "Google Calendar directly — it'll sync to your dashboard " +
          "within a minute.",
        actionStatus: "ignored",
        intent: "create_event",
      };
    case "unknown":
      return {
        replyText:
          "Didn't catch that. Reply 'help' for a list of commands.",
        actionStatus: "ignored",
        intent: "unknown",
        error: intent.reason,
      };
    case "spend_cap_reached":
      return {
        replyText:
          "I'm paused for the rest of the month (Anthropic spend cap). " +
          "Full service resumes on the 1st.",
        actionStatus: "ignored",
        intent: "spend_cap_reached",
      };
  }
}

const HELP_TEXT = [
  "Ronny J Ops commands:",
  "• add todo: <task>",
  "• done: <task keyword>",
  "• what's on today",
  "• help",
  "",
  "Tasks sync to Google Tasks automatically.",
].join("\n");

async function handleCreateTask(
  title: string,
  dueAt: string | null,
  teamMemberId: string
): Promise<DispatchOutcome> {
  try {
    const task = await createTask({
      teamMemberId,
      title,
      dueAt,
      source: "sms",
    });
    const dueBit = dueAt
      ? ` (due ${new Date(dueAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })})`
      : "";
    return {
      replyText: `✓ Added: ${truncate(title, 60)}${dueBit}`,
      actionStatus: "done",
      intent: "create_task",
      artifactId: task.id,
    };
  } catch (err: any) {
    return {
      replyText:
        "Couldn't add that task — something broke on our end. Try again in a minute.",
      actionStatus: "error",
      intent: "create_task",
      error: err?.message ?? "create failed",
    };
  }
}

async function handleCompleteTask(
  titleMatch: string,
  teamMemberId: string
): Promise<DispatchOutcome> {
  try {
    const admin = createAdminClient();
    // Fuzzy title match — case-insensitive substring on open tasks only.
    // If multiple match, pick the most recently created.
    const { data: candidates } = (await (admin as any)
      .from("tasks")
      .select("id, title")
      .eq("team_member_id", teamMemberId)
      .eq("status", "needsAction")
      .ilike("title", `%${titleMatch}%`)
      .order("created_at", { ascending: false })
      .limit(2)) as {
      data: Array<{ id: string; title: string }> | null;
    };

    if (!candidates || candidates.length === 0) {
      return {
        replyText: `No open task matched "${truncate(titleMatch, 40)}".`,
        actionStatus: "ignored",
        intent: "complete_task",
      };
    }

    if (candidates.length > 1) {
      // Ambiguous — show the top two and bail. User can send a more
      // specific keyword.
      const titles = candidates
        .slice(0, 2)
        .map((c) => `• ${truncate(c.title, 40)}`)
        .join("\n");
      return {
        replyText: `Multiple tasks matched. Be more specific:\n${titles}`,
        actionStatus: "ignored",
        intent: "complete_task",
      };
    }

    const task = candidates[0];
    await completeTask(task.id);
    return {
      replyText: `✓ Done: ${truncate(task.title, 60)}`,
      actionStatus: "done",
      intent: "complete_task",
      artifactId: task.id,
    };
  } catch (err: any) {
    return {
      replyText:
        "Couldn't complete that task — something broke on our end. Try again.",
      actionStatus: "error",
      intent: "complete_task",
      error: err?.message ?? "complete failed",
    };
  }
}

async function handleDigest(teamMemberId: string): Promise<DispatchOutcome> {
  try {
    const admin = createAdminClient();
    const { startUtc, endUtc } = todayBoundsUtc(TZ);

    const { data: eventRows } = (await (admin as any)
      .from("events")
      .select("title, starts_at, location")
      .gte("starts_at", startUtc.toISOString())
      .lt("starts_at", endUtc.toISOString())
      .order("starts_at", { ascending: true })) as {
      data: Array<{ title: string; starts_at: string; location: string | null }> | null;
    };
    const events: DigestEvent[] = (eventRows ?? []).map((e) => ({
      title: e.title,
      starts_at: e.starts_at,
      location: e.location,
    }));

    const { data: taskRows } = (await (admin as any)
      .from("tasks")
      .select("title, status, due_at")
      .eq("team_member_id", teamMemberId)
      .eq("status", "needsAction")
      .lt("due_at", endUtc.toISOString())
      .order("due_at", { ascending: true })) as {
      data: Array<{ title: string; status: string; due_at: string | null }> | null;
    };
    const tasks: DigestTask[] = (taskRows ?? []).map((t) => ({
      title: t.title,
      due_at: t.due_at,
      overdue: t.due_at ? new Date(t.due_at) < startUtc : false,
    }));

    const completedRows = await listCompletedTodayForMember({
      teamMemberId,
      tz: TZ,
    });
    const completed: CompletedTaskSummary[] = completedRows.map((t) => ({
      title: t.title,
    }));

    const body = renderDigest({ events, tasks, completed, tz: TZ });
    return {
      replyText: body,
      actionStatus: "done",
      intent: "get_digest",
    };
  } catch (err: any) {
    return {
      replyText:
        "Couldn't pull today's digest — something broke on our end. Try again shortly.",
      actionStatus: "error",
      intent: "get_digest",
      error: err?.message ?? "digest failed",
    };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

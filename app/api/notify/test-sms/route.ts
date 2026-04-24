/**
 * POST /api/notify/test-sms
 *
 * Renders the daily digest (today's calendar events + today's Google Tasks)
 * and sends it as an SMS to the *logged-in team member's* phone number.
 *
 * Intended as a manual test button before we wire this into a daily cron.
 * The renderer lives in lib/notify/digest.ts and is the exact function the
 * eventual cron will use, so a green test here means the cron will work.
 *
 * Auth:
 *   - Must be signed in.
 *   - Must have a `team_members` row.
 *   - Must have `team_members.phone` set (E.164).
 *
 * Response shape:
 *   { ok: true, to, body, providerMessageId }     on success
 *   { ok: false, error, body? }                   on failure
 * `body` is returned even on failure so the caller can render a preview
 * when SMS is disabled (env gate) or the phone number is missing.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/notify/sms";
import { sendWhatsApp } from "@/lib/notify/whatsapp";
import {
  renderDigest,
  todayBoundsUtc,
  type DigestEvent,
  type DigestTask,
  type CompletedTaskSummary,
} from "@/lib/notify/digest";
import { listCompletedTodayForMember } from "@/lib/tasks/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Operational timezone. We don't have per-member tz yet — when we add it,
// pull from team_members.timezone and default here.
const TZ = "America/New_York";

type EventRow = {
  title: string;
  starts_at: string;
  location: string | null;
};

type TaskRow = {
  title: string;
  status: string;
  due_at: string | null;
};

export async function POST(request: Request) {
  // Parse the optional channel param from the request body. Default to
  // 'sms' so existing callers (the dashboard SMS button, forthcoming cron)
  // keep working unchanged. 'whatsapp' routes through the Twilio WA sender;
  // useful while toll-free SMS is gated on TFV approval.
  let channel: "sms" | "whatsapp" = "sms";
  try {
    const raw = await request.text();
    if (raw) {
      const parsed = JSON.parse(raw) as { channel?: string };
      if (parsed.channel === "whatsapp") channel = "whatsapp";
    }
  } catch {
    // Bad JSON? Ignore and default to sms.
  }

  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  const { data: member } = (await sb
    .from("team_members")
    .select("id, phone, full_name")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: { id: string; phone: string | null; full_name: string } | null;
  };

  if (!member) {
    return NextResponse.json({ ok: false, error: "not_team_member" }, { status: 403 });
  }
  if (!member.phone) {
    return NextResponse.json(
      {
        ok: false,
        error: "No phone number on file. Add one to your team_members row.",
      },
      { status: 400 }
    );
  }

  // Service-role client to read events + google_tasks regardless of RLS —
  // identity has already been established above.
  const admin = createAdminClient();

  const { startUtc, endUtc } = todayBoundsUtc(TZ);

  // Today's events — any event whose start falls in today's zone.
  // Privacy filter: viewer's own events + team-shared events only.
  const { data: eventRows } = (await (admin as any)
    .from("events")
    .select("title, starts_at, location")
    .gte("starts_at", startUtc.toISOString())
    .lt("starts_at", endUtc.toISOString())
    .or(`created_by.eq.${member.id},shared.eq.true`)
    .order("starts_at", { ascending: true })) as {
    data: EventRow[] | null;
  };
  const events: DigestEvent[] = (eventRows ?? []).map((e) => ({
    title: e.title,
    starts_at: e.starts_at,
    location: e.location,
  }));

  // Today's tasks — status='needsAction' AND (due today OR overdue).
  // Anything due tomorrow+ is not on today's radar.
  const { data: taskRows } = (await (admin as any)
    .from("google_tasks")
    .select("title, status, due_at")
    .eq("team_member_id", member.id)
    .eq("status", "needsAction")
    .lt("due_at", endUtc.toISOString())
    .order("due_at", { ascending: true })) as {
    data: TaskRow[] | null;
  };
  const tasks: DigestTask[] = (taskRows ?? []).map((t) => ({
    title: t.title,
    due_at: t.due_at,
    overdue: t.due_at ? new Date(t.due_at) < startUtc : false,
  }));

  // Today's completions — renders as an optional "Done:" section at the
  // bottom of the digest. Matches the dashboard's collapsible recap so
  // the morning SMS and end-of-day SMS tell the same story.
  const completedRows = await listCompletedTodayForMember({
    teamMemberId: member.id,
    tz: TZ,
  });
  const completed: CompletedTaskSummary[] = completedRows.map((t) => ({
    title: t.title,
  }));

  const body = renderDigest({ events, tasks, completed, tz: TZ });

  // Dispatch on channel. Note: WhatsApp has no SMS_ENABLED equivalent,
  // so `skipped` can never come back from that path. SMS can still short-
  // circuit on SMS_ENABLED=false for local preview flow.
  const sendRes =
    channel === "whatsapp"
      ? await sendWhatsApp({ to: member.phone, body })
      : await sendSms({ to: member.phone, body });

  const skipped =
    "skipped" in sendRes ? sendRes.skipped === true : false;

  if (!sendRes.ok) {
    return NextResponse.json(
      {
        ok: false,
        channel,
        error: sendRes.error ?? "send failed",
        skipped,
        to: member.phone,
        body,
      },
      // 200 when SMS is simply disabled via env gate — caller shows a
      // preview rather than a hard error.
      { status: skipped ? 200 : 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    channel,
    to: member.phone,
    body,
    providerMessageId: sendRes.providerMessageId,
  });
}

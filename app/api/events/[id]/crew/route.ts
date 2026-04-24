/**
 * POST /api/events/:id/crew
 *
 * Attach a vendor to an event in a specific role, with optional
 * service window + on-site contact + notes. Used by the dashboard
 * crew form. Mirrors the `assign_vendor_to_event` Claude tool.
 *
 * Request body:
 *   {
 *     vendor_id: uuid,
 *     role: string,
 *     service_window_start?: ISO string | null,
 *     service_window_end?: ISO string | null,
 *     contact_on_site?: string | null,
 *     notes?: string | null
 *   }
 *
 * Auth: logged-in team member only.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const Body = z.object({
  vendor_id: z.string().uuid(),
  role: z.enum([
    "security", "photography", "videography", "catering", "lighting",
    "sound", "driver", "transportation", "promoter", "venue",
    "artist", "opener", "hair_makeup", "stylist", "stage", "runner",
    "hospitality", "streamer", "performer", "model", "other",
  ]),
  service_window_start: z.string().datetime().nullable().optional(),
  service_window_end: z.string().datetime().nullable().optional(),
  contact_on_site: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  const { data: member } = (await sb
    .from("team_members")
    .select("id")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as { data: { id: string } | null };
  if (!member) {
    return NextResponse.json({ ok: false, error: "not_team_member" }, { status: 403 });
  }

  let body;
  try {
    body = Body.parse(await request.json());
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: `invalid body: ${err?.message ?? "parse error"}` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Confirm the event exists + the viewer has visibility (created_by OR shared).
  // Defense-in-depth even though RLS already guards the team-scope.
  const { data: event } = (await (admin as any)
    .from("events")
    .select("id, created_by, shared")
    .eq("id", params.id)
    .maybeSingle()) as {
    data: { id: string; created_by: string | null; shared: boolean } | null;
  };
  if (!event) {
    return NextResponse.json({ ok: false, error: "event_not_found" }, { status: 404 });
  }
  if (event.created_by !== member.id && !event.shared) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Default service_window_end to +1h when omitted but start is given.
  const end =
    body.service_window_end ??
    (body.service_window_start
      ? new Date(
          new Date(body.service_window_start).getTime() + 60 * 60 * 1000
        ).toISOString()
      : null);

  const { data, error } = (await (admin as any)
    .from("event_vendors")
    .insert({
      event_id: params.id,
      vendor_id: body.vendor_id,
      role: body.role,
      service_window_start: body.service_window_start ?? null,
      service_window_end: end,
      contact_on_site: body.contact_on_site ?? null,
      notes: body.notes ?? null,
      created_by: member.id,
    })
    .select("id")
    .single()) as {
    data: { id: string } | null;
    error: { message: string } | null;
  };

  if (error || !data) {
    return NextResponse.json(
      { ok: false, error: error?.message ?? "insert failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, assignmentId: data.id });
}

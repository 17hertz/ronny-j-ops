/**
 * GET /api/events/:id/call-sheet
 *
 * Render a day-of-show call sheet PDF for an event and return it as
 * an attachment. Pulls event details + crew assignments from the DB,
 * hands off to renderCallSheetPdf, streams the result.
 *
 * Auth: logged-in team_member. Visibility rule matches the event
 * detail page: created_by = me OR shared = true.
 *
 * Why GET and not POST: call sheets are pure reads with no body.
 * A plain <a href="/api/events/X/call-sheet" download> works on the
 * client without a blob-fetch dance.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { renderCallSheetPdf } from "@/lib/reports/call-sheet-pdf";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const sb = createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { data: member } = (await sb
    .from("team_members")
    .select("id, timezone")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: { id: string; timezone: string } | null;
  };
  if (!member) {
    return NextResponse.json({ error: "not_team_member" }, { status: 403 });
  }

  const admin = createAdminClient();

  const { data: event } = (await (admin as any)
    .from("events")
    .select(
      "id, title, description, location, starts_at, ends_at, timezone, created_by, shared"
    )
    .eq("id", params.id)
    .maybeSingle()) as {
    data: {
      id: string;
      title: string;
      description: string | null;
      location: string | null;
      starts_at: string;
      ends_at: string;
      timezone: string;
      created_by: string | null;
      shared: boolean;
    } | null;
  };
  if (!event) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (event.created_by !== member.id && !event.shared) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { data: crew } = (await (admin as any)
    .from("event_vendors")
    .select(
      `
      role, service_window_start, service_window_end,
      contact_on_site, notes,
      vendor:vendors ( legal_name, dba, contact_phone )
      `
    )
    .eq("event_id", event.id)) as {
    data: Array<{
      role: string;
      service_window_start: string | null;
      service_window_end: string | null;
      contact_on_site: string | null;
      notes: string | null;
      vendor: {
        legal_name: string;
        dba: string | null;
        contact_phone: string | null;
      } | null;
    }> | null;
  };

  const pdf = await renderCallSheetPdf({
    event: {
      title: event.title,
      description: event.description,
      location: event.location,
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      timezone: event.timezone,
    },
    crew: (crew ?? []).map((c) => ({
      role: c.role,
      service_window_start: c.service_window_start,
      service_window_end: c.service_window_end,
      contact_on_site: c.contact_on_site,
      notes: c.notes,
      vendor_name: c.vendor?.legal_name ?? "(unknown vendor)",
      vendor_dba: c.vendor?.dba ?? null,
      vendor_phone: c.vendor?.contact_phone ?? null,
    })),
    viewerTz: member.timezone || event.timezone,
  });

  // Sanitize the title into a filename.
  const safeTitle = event.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const dateSuffix = new Date(event.starts_at)
    .toISOString()
    .slice(0, 10);
  const filename = `call-sheet-${safeTitle || "event"}-${dateSuffix}.pdf`;

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

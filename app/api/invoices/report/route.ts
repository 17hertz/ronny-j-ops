/**
 * POST /api/invoices/report
 *
 * Generates an expense report (approved + paid invoices) for a given
 * window and returns it as a file attachment.
 *
 * Request body:
 *   {
 *     granularity: "daily" | "weekly" | "monthly",
 *     anchorDate: "YYYY-MM-DD",
 *     format: "pdf" | "xlsx"
 *   }
 *
 * Auth: logged-in team_member only. Non-members 403.
 *
 * Why POST (not GET) for what's essentially a read: so we can accept
 * JSON body with a typed schema instead of stringified query params,
 * and so browser caching doesn't serve a stale copy of a fresh report.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  buildExpenseReport,
  type ExpenseGranularity,
} from "@/lib/reports/expenses";
import { renderExpenseReportPdf } from "@/lib/reports/expense-pdf";
import { renderExpenseReportXlsx } from "@/lib/reports/expense-xlsx";

export const dynamic = "force-dynamic";
// Generation is fast (under a second even for hundreds of rows) but
// leave headroom for Supabase latency spikes.
export const maxDuration = 30;

const Body = z.object({
  granularity: z.enum(["daily", "weekly", "monthly"]),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(["pdf", "xlsx"]),
});

export async function POST(request: Request) {
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

  try {
    const report = await buildExpenseReport({
      granularity: body.granularity as ExpenseGranularity,
      anchorDate: body.anchorDate,
    });

    const fileBase = `ronny-j-expenses-${body.granularity}-${body.anchorDate}`;

    if (body.format === "pdf") {
      const pdf = await renderExpenseReportPdf(report);
      return new NextResponse(pdf, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileBase}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    // xlsx
    const xlsx = await renderExpenseReportXlsx(report);
    return new NextResponse(xlsx, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileBase}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("[api/invoices/report] failed", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "report failed" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/vendors/:id/reveal-banking
 *
 * Decrypts + returns a vendor's full ACH bank details (routing + account
 * number + account holder name + account type). Also optionally returns
 * the decrypted tax ID when fields='both' or 'tax_id'. Logs every reveal
 * to public.banking_reveals for audit.
 *
 * Plaintext leaves the server ONCE per request, inside a TLS-encrypted
 * response body. Caller (browser) holds it in memory for the user's
 * countdown window (~30s) before the client auto-hides it. We do not
 * persist plaintext anywhere.
 *
 * Request body:
 *   { fields: "ach" | "tax_id" | "both", reason?: string }
 *
 * Auth: logged-in team_member only. Any team member can reveal — the
 * audit trail is the deterrent, not role gating (two-person team today;
 * when we scale, add role checks).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToString } from "@/lib/crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const Body = z.object({
  fields: z.enum(["ach", "tax_id", "both"]),
  reason: z.string().max(500).optional(),
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
    .select("id, full_name")
    .eq("auth_user_id", user.id)
    .maybeSingle()) as {
    data: { id: string; full_name: string } | null;
  };
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

  // Fetch only what we'll actually decrypt. Ciphertext columns are bytea
  // — Supabase returns them as a JSON-encoded "\x..." hex string by
  // default; we convert back to Buffer below.
  const { data: vendor, error: vErr } = (await (admin as any)
    .from("vendors")
    .select(
      "id, legal_name, ach_bank_details_encrypted, tax_id_encrypted, ach_account_holder_name, ach_bank_name, ach_account_type"
    )
    .eq("id", params.id)
    .maybeSingle()) as {
    data: {
      id: string;
      legal_name: string;
      ach_bank_details_encrypted: string | null;
      tax_id_encrypted: string | null;
      ach_account_holder_name: string | null;
      ach_bank_name: string | null;
      ach_account_type: string | null;
    } | null;
    error: { message: string } | null;
  };

  if (vErr) {
    return NextResponse.json({ ok: false, error: vErr.message }, { status: 500 });
  }
  if (!vendor) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Decrypt the requested pieces.
  let ach: {
    routing_number: string;
    account_number: string;
    account_holder_name: string | null;
    bank_name: string | null;
    account_type: string | null;
  } | null = null;
  let taxId: string | null = null;

  try {
    if (body.fields === "ach" || body.fields === "both") {
      if (!vendor.ach_bank_details_encrypted) {
        return NextResponse.json(
          { ok: false, error: "No ACH info on file for this vendor." },
          { status: 404 }
        );
      }
      const buf = byteaToBuffer(vendor.ach_bank_details_encrypted);
      const json = decryptToString(buf);
      // The intake writes { routing, account } (see app/api/vendors/
      // submit/route.ts encryptJson call) — match those keys exactly.
      const parsed = JSON.parse(json) as {
        routing: string;
        account: string;
      };
      ach = {
        routing_number: parsed.routing,
        account_number: parsed.account,
        account_holder_name: vendor.ach_account_holder_name,
        bank_name: vendor.ach_bank_name,
        account_type: vendor.ach_account_type,
      };
    }

    if (body.fields === "tax_id" || body.fields === "both") {
      if (!vendor.tax_id_encrypted) {
        return NextResponse.json(
          { ok: false, error: "No tax ID on file for this vendor." },
          { status: 404 }
        );
      }
      const buf = byteaToBuffer(vendor.tax_id_encrypted);
      taxId = decryptToString(buf);
    }
  } catch (err: any) {
    // Most likely causes: ENCRYPTION_KEY mismatch between intake and
    // now, or an unrecognized bytea wire format from supabase-js.
    // Log the actual stack server-side (check Vercel runtime logs)
    // so we can debug without leaking internals to the client.
    console.error("[reveal-banking] decrypt failed", {
      vendorId: params.id,
      fields: body.fields,
      errMessage: err?.message,
      errStack: err?.stack,
    });
    return NextResponse.json(
      { ok: false, error: "Could not decrypt banking info — contact support." },
      { status: 500 }
    );
  }

  // Audit row — written AFTER successful decrypt so we don't log noise
  // for failed reveals. Captures IP + user-agent for forensic trail.
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    request.headers.get("x-real-ip") ??
    null;
  const userAgent = request.headers.get("user-agent") ?? null;

  await (admin as any).from("banking_reveals").insert({
    team_member_id: member.id,
    vendor_id: vendor.id,
    fields: body.fields,
    reason: body.reason ?? null,
    ip,
    user_agent: userAgent,
  });

  return NextResponse.json({
    ok: true,
    vendor: { id: vendor.id, legal_name: vendor.legal_name },
    ach,
    taxId,
    // Client uses this to start its countdown consistently.
    revealed_at: new Date().toISOString(),
  });
}

/**
 * Supabase-JS returns bytea columns in several possible shapes
 * depending on SDK version + request path:
 *   - "\x<hex>"                 — Postgres's text representation
 *   - "<hex>"                   — ditto, without the prefix
 *   - "<base64>"                — some postgrest configs
 *   - { type: "Buffer", data }  — if the value round-tripped JSON
 *   - Buffer                    — rare, but handle it
 * Try the declared format first, then fall back heuristically.
 */
function byteaToBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;

  if (raw && typeof raw === "object") {
    const obj = raw as { type?: string; data?: unknown };
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      return Buffer.from(obj.data as number[]);
    }
  }

  if (typeof raw === "string") {
    // Preferred: Postgres text form.
    if (raw.startsWith("\\x")) {
      return Buffer.from(raw.slice(2), "hex");
    }
    // Unprefixed hex (even length, hex chars only).
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
      return Buffer.from(raw, "hex");
    }
    // Fall back to base64 — handles the case where the SDK base64-
    // encoded the Buffer on write and returns the same on read.
    return Buffer.from(raw, "base64");
  }

  throw new Error(`unrecognized bytea shape: ${typeof raw}`);
}

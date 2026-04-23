/**
 * Anthropic spend gate.
 *
 * Before every Claude API call, the caller runs `preflightSpendCheck()`
 * to confirm we haven't blown the monthly cap. After every Claude API
 * call, the caller runs `logSpend()` to record what it cost.
 *
 * Cap is controlled by ANTHROPIC_MONTHLY_CAP_USD (default $20). When
 * the cap is reached, `preflightSpendCheck()` returns `{ ok: false }`
 * and the caller short-circuits with a graceful refusal message — the
 * user sees something polite, not a stack trace.
 *
 * Pricing table below reflects Anthropic's published per-MTok prices
 * as of 2026-04-23. If prices change, update the constants here; the
 * spend log stays authoritative because we computed cost at call time.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type SpendCheck =
  | { ok: true; monthToDateCents: number; capCents: number }
  | {
      ok: false;
      reason: "monthly-cap-reached";
      monthToDateCents: number;
      capCents: number;
    };

export type Purpose = "agent" | "sms-parse" | "other";

const DEFAULT_MONTHLY_CAP_USD = 20;

/** Dollars-per-million-tokens for each model. Both input + output. */
const PRICING: Record<
  string,
  { inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number }
> = {
  // Sonnet 4.5
  "claude-sonnet-4-5-20250929": {
    inputPerMTok: 3,
    cachedInputPerMTok: 0.3, // 10% of input for cache hits
    outputPerMTok: 15,
  },
  // Haiku 4.5 — cheaper; used by the SMS intent parser.
  "claude-haiku-4-5-20251001": {
    inputPerMTok: 1,
    cachedInputPerMTok: 0.1,
    outputPerMTok: 5,
  },
};

function capCents(): number {
  const raw = process.env.ANTHROPIC_MONTHLY_CAP_USD;
  const dollars = raw ? Number(raw) : DEFAULT_MONTHLY_CAP_USD;
  if (!Number.isFinite(dollars) || dollars <= 0) {
    return DEFAULT_MONTHLY_CAP_USD * 100;
  }
  return Math.floor(dollars * 100);
}

/**
 * Sum cost_cents for the current UTC month. We use UTC (not ET) for the
 * monthly boundary because Anthropic's billing uses UTC. This is a
 * simple count query — indexed on created_at desc.
 */
async function monthToDateCents(): Promise<number> {
  const admin = createAdminClient();
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString();

  const { data, error } = (await (admin as any)
    .from("api_spend_log")
    .select("cost_cents")
    .gte("created_at", monthStart)) as {
    data: Array<{ cost_cents: number }> | null;
    error: { message: string } | null;
  };
  if (error) {
    // Don't block a Claude call because our cost-tracking infra broke —
    // log and let the call through. The next tick will catch up.
    console.error("[spend-gate] summary query failed", error);
    return 0;
  }
  return (data ?? []).reduce((s, r) => s + (r.cost_cents ?? 0), 0);
}

/**
 * Call BEFORE making a Claude API request. Returns { ok: true } if
 * we're under the cap; { ok: false } if we should refuse the call.
 */
export async function preflightSpendCheck(): Promise<SpendCheck> {
  const cap = capCents();
  const mtd = await monthToDateCents();
  if (mtd >= cap) {
    return {
      ok: false,
      reason: "monthly-cap-reached",
      monthToDateCents: mtd,
      capCents: cap,
    };
  }
  return { ok: true, monthToDateCents: mtd, capCents: cap };
}

/**
 * Call AFTER a Claude API request completes. Records tokens + computed
 * cost. Safe to call even on failures — pass `note` to document what
 * happened (e.g. "tool-use loop failed mid-run").
 */
export async function logSpend(opts: {
  purpose: Purpose;
  model: string;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  teamMemberId?: string | null;
  note?: string | null;
}): Promise<void> {
  const admin = createAdminClient();

  const cost = computeCostCents({
    model: opts.model,
    inputTokens: opts.inputTokens,
    cachedInputTokens: opts.cachedInputTokens ?? 0,
    outputTokens: opts.outputTokens,
  });

  const { error } = await (admin as any).from("api_spend_log").insert({
    purpose: opts.purpose,
    model: opts.model,
    input_tokens: opts.inputTokens,
    cached_input_tokens: opts.cachedInputTokens ?? 0,
    output_tokens: opts.outputTokens,
    cost_cents: cost,
    note: opts.note ?? null,
    team_member_id: opts.teamMemberId ?? null,
  });
  if (error) {
    // Same philosophy as preflight — don't cascade infra failures into
    // user-visible errors. Just log.
    console.error("[spend-gate] log insert failed", error);
  }
}

/**
 * Compute cost in cents for a given token split. Exposed so the SMS
 * refusal path can quote dollars without a full round-trip through the
 * insert.
 */
export function computeCostCents(opts: {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  const pricing = PRICING[opts.model];
  if (!pricing) {
    // Unknown model — log it but assume the worst-case Sonnet pricing
    // so we don't under-report cost. Prevents a silent pricing drift
    // when a new model is added.
    console.warn(`[spend-gate] unknown model pricing: ${opts.model}`);
    return computeCostCents({
      ...opts,
      model: "claude-sonnet-4-5-20250929",
    });
  }
  const fresh =
    ((opts.inputTokens - opts.cachedInputTokens) * pricing.inputPerMTok) / 1_000_000;
  const cached =
    (opts.cachedInputTokens * pricing.cachedInputPerMTok) / 1_000_000;
  const out = (opts.outputTokens * pricing.outputPerMTok) / 1_000_000;
  const totalDollars = fresh + cached + out;
  return Math.ceil(totalDollars * 100); // cents, rounded up
}

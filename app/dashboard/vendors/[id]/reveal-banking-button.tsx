"use client";

/**
 * "Reveal banking" button on the vendor detail page.
 *
 * Flow:
 *   1. Team member clicks Reveal.
 *   2. Optional prompt for a reason ("processing April 25 payout") —
 *      pulled into the audit row so the reveal log reads usefully later.
 *   3. POST /api/vendors/[id]/reveal-banking → decrypts server-side,
 *      logs to banking_reveals, returns plaintext in JSON body.
 *   4. Client displays the plaintext inline with a 30-second countdown.
 *   5. On countdown zero OR manual Hide click, state resets — plaintext
 *      is dropped from memory (React re-renders with it gone).
 *
 * Safety posture:
 *   - Plaintext never hits localStorage / sessionStorage / clipboard
 *     automatically. User must select + copy consciously.
 *   - Auto-hide + no persistence = short-lived exposure.
 *   - Every reveal is audited server-side; the UI doesn't need to
 *     enforce — the audit trail is the deterrent.
 */
import { useEffect, useState } from "react";

type Ach = {
  routing_number: string;
  account_number: string;
  account_holder_name: string | null;
  bank_name: string | null;
  account_type: string | null;
};

type RevealState =
  | { kind: "idle" }
  | { kind: "prompting" }
  | { kind: "revealing" }
  | {
      kind: "revealed";
      ach: Ach | null;
      taxId: string | null;
      expiresAt: number; // ms timestamp when auto-hide triggers
    }
  | { kind: "error"; message: string };

const REVEAL_DURATION_MS = 30_000;

export function RevealBankingButton({
  vendorId,
  hasAch,
  hasTaxId,
}: {
  vendorId: string;
  hasAch: boolean;
  hasTaxId: boolean;
}) {
  const [state, setState] = useState<RevealState>({ kind: "idle" });
  const [reason, setReason] = useState("");
  const [fields, setFields] = useState<"ach" | "tax_id" | "both">(
    hasAch && hasTaxId ? "both" : hasAch ? "ach" : "tax_id"
  );
  const [remaining, setRemaining] = useState(REVEAL_DURATION_MS);

  // Countdown timer — when we're in the 'revealed' state, tick every
  // 250ms and flip to 'idle' when time's up.
  useEffect(() => {
    if (state.kind !== "revealed") return;
    const tick = () => {
      const ms = state.expiresAt - Date.now();
      if (ms <= 0) {
        setState({ kind: "idle" });
        setRemaining(REVEAL_DURATION_MS);
      } else {
        setRemaining(ms);
      }
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [state]);

  async function onReveal() {
    setState({ kind: "revealing" });
    try {
      const res = await fetch(`/api/vendors/${vendorId}/reveal-banking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields, reason: reason.trim() || undefined }),
      });
      const json = await res.json();
      if (!json.ok) {
        setState({
          kind: "error",
          message: json.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      setState({
        kind: "revealed",
        ach: json.ach ?? null,
        taxId: json.taxId ?? null,
        expiresAt: Date.now() + REVEAL_DURATION_MS,
      });
      setRemaining(REVEAL_DURATION_MS);
    } catch (e: any) {
      setState({ kind: "error", message: e?.message ?? "network error" });
    }
  }

  if (state.kind === "idle" || state.kind === "error") {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setState({ kind: "prompting" })}
          className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-amber-200 transition hover:border-amber-700 hover:text-amber-100"
        >
          Reveal banking info
        </button>
        {state.kind === "error" && (
          <p className="mt-1 text-xs text-red-400">{state.message}</p>
        )}
      </div>
    );
  }

  if (state.kind === "prompting") {
    return (
      <div className="mt-2 rounded-md border border-amber-900/60 bg-amber-950/20 p-4">
        <p className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
          Confirm reveal
        </p>
        <p className="mt-2 text-xs text-amber-100">
          This will decrypt and show sensitive banking details. Every
          reveal is logged (who, when, reason) in the banking_reveals
          audit table. Plaintext stays visible for 30 seconds.
        </p>

        {hasAch && hasTaxId && (
          <div className="mt-3">
            <label className="block font-mono text-[10px] uppercase tracking-wider text-amber-300">
              Reveal
            </label>
            <select
              value={fields}
              onChange={(e) => setFields(e.target.value as typeof fields)}
              className="mt-1 w-full rounded-md border border-amber-900/60 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-amber-500 focus:outline-none"
            >
              <option value="both">Both (ACH + tax ID)</option>
              <option value="ach">ACH bank info only</option>
              <option value="tax_id">Tax ID only</option>
            </select>
          </div>
        )}

        <div className="mt-3">
          <label className="block font-mono text-[10px] uppercase tracking-wider text-amber-300">
            Reason (optional but recommended)
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Processing April 25 payout"
            maxLength={500}
            className="mt-1 w-full rounded-md border border-amber-900/60 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-amber-900/70 focus:border-amber-500 focus:outline-none"
          />
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onReveal}
            className="rounded-md border border-amber-700 bg-amber-950/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-amber-100 transition hover:border-amber-500"
          >
            Reveal for 30s
          </button>
          <button
            type="button"
            onClick={() => {
              setState({ kind: "idle" });
              setReason("");
            }}
            className="rounded-md border border-neutral-700 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-neutral-300 transition hover:border-neutral-500"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "revealing") {
    return (
      <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-amber-300">
        Decrypting…
      </p>
    );
  }

  // state.kind === "revealed"
  const secondsLeft = Math.ceil(remaining / 1000);
  return (
    <div className="mt-2 rounded-md border border-amber-700 bg-amber-950/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <p className="font-mono text-[10px] uppercase tracking-wider text-amber-300">
          Revealed · auto-hides in {secondsLeft}s
        </p>
        <button
          type="button"
          onClick={() => setState({ kind: "idle" })}
          className="font-mono text-[10px] uppercase tracking-wider text-amber-300 hover:text-amber-100"
        >
          Hide now
        </button>
      </div>

      {state.ach && (
        <div className="mt-3 space-y-1 font-mono text-sm">
          <p className="text-neutral-200">
            <span className="text-amber-400/80">Holder: </span>
            {state.ach.account_holder_name ?? "—"}
          </p>
          <p className="text-neutral-200">
            <span className="text-amber-400/80">Bank: </span>
            {state.ach.bank_name ?? "—"}
          </p>
          <p className="text-neutral-200">
            <span className="text-amber-400/80">Type: </span>
            <span className="capitalize">
              {state.ach.account_type ?? "—"}
            </span>
          </p>
          <p className="select-all text-neutral-100">
            <span className="text-amber-400/80">Routing: </span>
            {state.ach.routing_number}
          </p>
          <p className="select-all text-neutral-100">
            <span className="text-amber-400/80">Account: </span>
            {state.ach.account_number}
          </p>
        </div>
      )}

      {state.taxId && (
        <div className="mt-3 border-t border-amber-900/40 pt-3 font-mono text-sm">
          <p className="select-all text-neutral-100">
            <span className="text-amber-400/80">Tax ID: </span>
            {state.taxId}
          </p>
        </div>
      )}

      <p className="mt-3 font-mono text-[10px] text-amber-400/60">
        This view auto-hides. Copy what you need now.
      </p>
    </div>
  );
}

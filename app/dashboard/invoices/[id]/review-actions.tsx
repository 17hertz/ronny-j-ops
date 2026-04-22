"use client";

/**
 * Admin invoice review controls.
 *
 * Handles the buttons on the invoice detail page. Each action POSTs to
 * /api/admin/invoices/[id]/action with a JSON body and refreshes the
 * server component on success so the status badge + timestamps update.
 *
 * Reject opens an inline textarea (review notes required). Mark paid
 * requires a native confirm() — it's a financial-ish state change and
 * accidental double-clicks should not silently mark things paid.
 *
 * We intentionally don't navigate away after any action. Jason/Ronny
 * usually want to re-read the invoice after deciding (the "did I just
 * approve the right one?" instinct).
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Action = "approve" | "reject" | "under_review" | "mark_paid";

type Props = {
  invoiceId: string;
  currentStatus: string;
};

export function InvoiceReviewActions({ invoiceId, currentStatus }: Props) {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [inFlight, setInFlight] = useState<Action | null>(null);

  const canReview =
    currentStatus === "submitted" || currentStatus === "under_review";
  const canMarkPaid = currentStatus === "approved";

  async function submit(action: Action) {
    setError(null);

    if (action === "reject") {
      if (!showRejectBox) {
        setShowRejectBox(true);
        return;
      }
      if (notes.trim().length === 0) {
        setError("Leave a note explaining why you're rejecting this invoice.");
        return;
      }
    }

    if (action === "mark_paid") {
      const ok = window.confirm(
        "Mark this invoice as paid? This records it as fulfilled and removes it from pending queues."
      );
      if (!ok) return;
    }

    setInFlight(action);
    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          review_notes: action === "reject" ? notes.trim() : undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Something went wrong. Please try again.");
        setInFlight(null);
        return;
      }
      startTransition(() => {
        router.refresh();
        setInFlight(null);
        if (action === "reject") {
          setShowRejectBox(false);
          setNotes("");
        }
      });
    } catch (err) {
      console.error("[invoice-review-actions]", err);
      setError("Network error. Please try again.");
      setInFlight(null);
    }
  }

  if (!canReview && !canMarkPaid) {
    return (
      <p className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
        This invoice is{" "}
        <span className="text-neutral-200">{currentStatus}</span>. No further
        actions available here.
      </p>
    );
  }

  const busy = isPending || !!inFlight;

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {canReview && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => submit("approve")}
            disabled={busy}
            className="rounded-md border border-emerald-700 bg-emerald-800/40 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-800/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {inFlight === "approve" ? "Approving…" : "Approve"}
          </button>

          {currentStatus !== "under_review" && (
            <button
              type="button"
              onClick={() => submit("under_review")}
              disabled={busy}
              className="rounded-md border border-amber-800 bg-amber-900/30 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-900/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inFlight === "under_review"
                ? "Updating…"
                : "Mark under review"}
            </button>
          )}

          <button
            type="button"
            onClick={() => submit("reject")}
            disabled={busy}
            className="rounded-md border border-red-900 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {inFlight === "reject"
              ? "Rejecting…"
              : showRejectBox
                ? "Reject with note"
                : "Reject"}
          </button>
        </div>
      )}

      {showRejectBox && canReview && (
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
            Rejection note (required)
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="What should the vendor fix before resubmitting?"
            disabled={busy}
            className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-brand focus:outline-none"
          />
        </label>
      )}

      {canMarkPaid && (
        <div>
          <button
            type="button"
            onClick={() => submit("mark_paid")}
            disabled={busy}
            className="rounded-md border border-brand bg-brand px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {inFlight === "mark_paid" ? "Marking paid…" : "Mark paid"}
          </button>
          <p className="mt-2 text-xs text-neutral-500">
            Click once the ACH / Zelle transfer has been initiated.
          </p>
        </div>
      )}
    </div>
  );
}

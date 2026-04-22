"use client";

/**
 * Approve / Reject controls for the vendor review page.
 *
 * This is a client component because the decision is a side effect (POST
 * to /api/vendors/[id]/approve or /reject) and we want:
 *   - an inline notes textarea that persists on submit
 *   - optimistic-ish UX: disable the buttons while the request is in flight
 *   - an error banner that doesn't require a full page reload
 *
 * After a successful call we `router.refresh()` so the server component
 * re-fetches the vendor row (status badge, "Last reviewed" timestamp, etc.).
 * We don't navigate away — Jason/Ronny often want to re-read the record
 * after deciding.
 *
 * Rejection REQUIRES notes. Approval doesn't. This mirrors how humans
 * actually use a review queue: "looks good, approved" is fine, but
 * "rejected with no reason" leaves the next person confused.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  vendorId: string;
  currentStatus: string;
  initialNotes: string;
};

export function ReviewActions({
  vendorId,
  currentStatus,
  initialNotes,
}: Props) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [inFlight, setInFlight] = useState<"approve" | "reject" | null>(null);

  const terminal = currentStatus === "approved" || currentStatus === "rejected";

  async function submit(decision: "approve" | "reject") {
    setError(null);

    if (decision === "reject" && notes.trim().length === 0) {
      setError("Leave a note explaining why you're rejecting this vendor.");
      return;
    }

    setInFlight(decision);
    try {
      const res = await fetch(`/api/vendors/${vendorId}/${decision}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes }),
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
      // Let the server component re-render with the new status + timestamp.
      startTransition(() => {
        router.refresh();
        setInFlight(null);
      });
    } catch (err) {
      console.error("[review-actions]", err);
      setError("Network error. Please try again.");
      setInFlight(null);
    }
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
          Internal notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="Optional for approvals. Required for rejections."
          className="mt-2 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-700 focus:border-brand focus:outline-none"
          disabled={isPending || !!inFlight}
        />
      </label>

      {terminal && (
        <p className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
          This vendor is currently{" "}
          <span
            className={
              currentStatus === "approved" ? "text-emerald-400" : "text-red-400"
            }
          >
            {currentStatus}
          </span>
          . You can still flip the decision below if you need to.
        </p>
      )}

      {error && (
        <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => submit("approve")}
          disabled={isPending || !!inFlight}
          className="rounded-md border border-emerald-700 bg-emerald-800/40 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-800/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {inFlight === "approve" ? "Approving…" : "Approve for payout"}
        </button>
        <button
          type="button"
          onClick={() => submit("reject")}
          disabled={isPending || !!inFlight}
          className="rounded-md border border-red-900 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-200 transition hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {inFlight === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </div>
  );
}

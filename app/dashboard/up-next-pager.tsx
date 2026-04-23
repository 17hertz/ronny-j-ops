"use client";

/**
 * Previous / Next paginator for the "Up next" panel.
 *
 * URL-driven like the range picker — writes `?page=N` (0-indexed). The
 * server component reads that and slices the event list. `page=0` is the
 * default so we strip the param for a clean URL.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export function UpNextPager({
  currentPage,
  totalPages,
}: {
  currentPage: number;
  totalPages: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function go(next: number) {
    const sp = new URLSearchParams(params.toString());
    if (next <= 0) {
      sp.delete("page");
    } else {
      sp.set("page", String(next));
    }
    const qs = sp.toString();
    startTransition(() => {
      router.push(qs ? `?${qs}` : "?", { scroll: false });
      router.refresh();
    });
  }

  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;

  return (
    <div className="mt-4 flex items-center justify-between border-t border-neutral-800 pt-3">
      <button
        type="button"
        onClick={() => go(currentPage - 1)}
        disabled={!hasPrev || pending}
        className="rounded-md border border-neutral-800 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-30"
      >
        ← Prev
      </button>
      <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">
        Page {currentPage + 1} of {totalPages}
      </span>
      <button
        type="button"
        onClick={() => go(currentPage + 1)}
        disabled={!hasNext || pending}
        className="rounded-md border border-neutral-800 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200 disabled:cursor-not-allowed disabled:opacity-30"
      >
        Next →
      </button>
    </div>
  );
}

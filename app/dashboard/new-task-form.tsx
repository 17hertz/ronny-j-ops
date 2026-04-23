"use client";

/**
 * Dashboard "New task" form.
 *
 * Minimal by design — title is required, notes + due date are optional.
 * Submits to POST /api/tasks, refreshes the server component on success
 * so the freshly-created row shows up in the task list without a hard
 * reload.
 *
 * This is the `source='dashboard'` entry point for the unified tasks
 * pipeline. Once the Inngest push-to-Google worker lands (step 3), any
 * task created here will also appear on Ronny's phone within a few
 * seconds.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function NewTaskForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "error"; message: string }
    | { kind: "ok" }
  >({ kind: "idle" });
  const [, startTransition] = useTransition();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setStatus({ kind: "submitting" });

    try {
      // Due date is a bare "YYYY-MM-DD" from <input type="date">. Push the
      // day to end-of-day local so it sorts alongside Google Tasks that
      // come back as midnight UTC of the due date.
      const dueAt = dueDate
        ? new Date(`${dueDate}T23:59:00`).toISOString()
        : null;

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          notes: notes.trim() || null,
          dueAt,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setStatus({ kind: "error", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      // Clear the form and refresh the server component so the new row
      // renders in the task list below.
      setTitle("");
      setNotes("");
      setDueDate("");
      setStatus({ kind: "ok" });
      startTransition(() => router.refresh());
    } catch (err: any) {
      setStatus({
        kind: "error",
        message: err?.message ?? "network error",
      });
    }
  }

  const busy = status.kind === "submitting";

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to happen?"
          disabled={busy}
          maxLength={500}
          required
          className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Extra context — contact info, links, etc."
            disabled={busy}
            maxLength={5000}
            rows={2}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Due (optional)
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-brand focus:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded-md border border-brand px-4 py-1.5 text-xs uppercase tracking-wider text-brand transition hover:bg-brand/10 disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add task"}
        </button>
        {status.kind === "ok" && (
          <span className="text-xs text-emerald-400">
            Added — syncing to Google…
          </span>
        )}
        {status.kind === "error" && (
          <span className="text-xs text-red-400">{status.message}</span>
        )}
      </div>
    </form>
  );
}

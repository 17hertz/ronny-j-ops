"use client";

/**
 * Admin invite form. Two fields (email + optional personal note) that POST
 * to /api/admin/vendors/invite. On success we reset the form and show a
 * little "sent ✓" flash so Jason can bang out a few in a row.
 *
 * If the API returns ok:true but with an `emailWarning`, we surface that —
 * the invite row was saved, so a "resend" click (future feature) can push
 * the email again without creating a duplicate.
 *
 * After a successful send we also call router.refresh() so the outstanding
 * list on the parent server component picks up the new row.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

// Kept in sync with DEFAULT_GREETING in the invite API route. Duplicated here
// (instead of imported) because this file is a client component and the API
// route pulls in Node-only deps (resend, node:crypto) we don't want shipped
// to the browser bundle.
const DEFAULT_GREETING_PREVIEW =
  "Thanks for working with Ronny J. 17 Hertz Inc. manages vendor onboarding and payments on Ronny's behalf — we'd like to get your info on file so we can pay you promptly on this and any future projects.";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "sent"; email: string; warning?: string }
  | { kind: "error"; message: string };

export function InviteForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) {
      setStatus({ kind: "error", message: "Email is required." });
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/admin/vendors/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          personalNote: note.trim(),
        }),
      });
      const json = (await res.json()) as
        | { ok: true; inviteId: string; emailWarning?: string }
        | { ok: false; error: string };

      if (!res.ok || !("ok" in json) || !json.ok) {
        setStatus({
          kind: "error",
          message:
            ("error" in json && json.error) ||
            `Request failed (${res.status}).`,
        });
        return;
      }

      setStatus({
        kind: "sent",
        email: trimmed,
        warning: json.emailWarning,
      });
      setEmail("");
      setNote("");
      // Refresh the server page so the outstanding list re-renders.
      router.refresh();
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }

  const submitting = status.kind === "submitting";

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-950 p-6"
    >
      <label className="block">
        <span className="text-sm text-neutral-300">
          Vendor email <span className="text-brand">*</span>
        </span>
        <input
          type="email"
          name="email"
          required
          autoComplete="off"
          placeholder="katy@katysphotos.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          className="mt-2 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
      </label>

      <label className="block">
        <span className="text-sm text-neutral-300">
          Personal note{" "}
          <span className="text-neutral-500">
            (optional — overrides the default greeting)
          </span>
        </span>
        <textarea
          name="personalNote"
          rows={3}
          maxLength={500}
          placeholder="Hey Katy — thanks for shooting last Friday. Here's the quick intake so we can pay you."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={submitting}
          className="mt-2 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
        <div className="mt-2 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-xs text-neutral-500">
          <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">
            Default greeting (used if blank)
          </span>
          <p className="mt-1 italic text-neutral-400">
            &ldquo;{DEFAULT_GREETING_PREVIEW}&rdquo;
          </p>
        </div>
      </label>

      <div className="flex items-center justify-between gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Sending…" : "Send invite"}
        </button>

        {status.kind === "sent" && (
          <p className="text-sm text-emerald-400">
            Sent to <span className="text-neutral-100">{status.email}</span>
            {status.warning && (
              <span className="ml-2 text-amber-400">({status.warning})</span>
            )}
          </p>
        )}
        {status.kind === "error" && (
          <p className="text-sm text-red-400">{status.message}</p>
        )}
      </div>
    </form>
  );
}

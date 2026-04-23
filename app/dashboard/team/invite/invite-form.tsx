"use client";

/**
 * Client-side teammate invite form. Just email — no personal note field for
 * now since the Supabase-native "Invite user" email template covers the copy
 * (already branded "17 Hertz Inc / Ronny J"). POST to /api/admin/team/invite.
 *
 * On success, reset + flash "sent ✓" and router.refresh() so the pending
 * list on the server page re-renders with the new row.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "sent"; email: string; warning?: string }
  | { kind: "error"; message: string };

export function InviteTeammateForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setStatus({ kind: "error", message: "Email is required." });
      return;
    }

    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/admin/team/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          fullName: name.trim(),
        }),
      });
      const json = (await res.json()) as
        | { ok: true; teamMemberId: string; emailWarning?: string }
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
        email: trimmedEmail,
        warning: json.emailWarning,
      });
      setEmail("");
      setName("");
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
          Teammate email <span className="text-brand">*</span>
        </span>
        <input
          type="email"
          name="email"
          required
          autoComplete="off"
          placeholder="teammate@17hertz.io"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          className="mt-2 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
      </label>

      <label className="block">
        <span className="text-sm text-neutral-300">
          Full name{" "}
          <span className="text-neutral-500">(optional — helps you tell them apart in the team list)</span>
        </span>
        <input
          type="text"
          name="fullName"
          autoComplete="off"
          placeholder="Alex Rivera"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          className="mt-2 w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none disabled:opacity-50"
        />
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

"use client";

/**
 * Client-side settings form: password + email update.
 *
 * Both updates hit Supabase directly using the authenticated client. Email
 * changes trigger a confirmation email to the *new* address — the change
 * doesn't take effect until the link is clicked. That's Supabase's default
 * and it's the right default.
 */
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type PwStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

type EmailStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "sent"; newEmail: string }
  | { kind: "error"; message: string };

export function SettingsForm({ currentEmail }: { currentEmail: string }) {
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [pwStatus, setPwStatus] = useState<PwStatus>({ kind: "idle" });

  const [newEmail, setNewEmail] = useState("");
  const [emailStatus, setEmailStatus] = useState<EmailStatus>({ kind: "idle" });

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setPwStatus({
        kind: "error",
        message: "Password must be at least 8 characters.",
      });
      return;
    }
    if (password !== passwordConfirm) {
      setPwStatus({ kind: "error", message: "Passwords don't match." });
      return;
    }
    setPwStatus({ kind: "saving" });

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setPwStatus({ kind: "error", message: error.message });
    } else {
      setPwStatus({ kind: "ok" });
      setPassword("");
      setPasswordConfirm("");
    }
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmail || newEmail === currentEmail) {
      setEmailStatus({
        kind: "error",
        message: "Enter a different email address.",
      });
      return;
    }
    setEmailStatus({ kind: "saving" });

    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ email: newEmail });
    if (error) {
      setEmailStatus({ kind: "error", message: error.message });
    } else {
      setEmailStatus({ kind: "sent", newEmail });
    }
  }

  return (
    <div className="space-y-10">
      {/* Password */}
      <form
        onSubmit={handlePassword}
        className="rounded-lg border border-neutral-800 bg-neutral-950 p-6"
      >
        <h2 className="font-display text-xl">Password</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Set or change your password. You can still sign in via Google or
          magic link — this is just for folks who prefer a password.
        </p>

        <div className="mt-5 space-y-3">
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none"
          />
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            placeholder="Confirm new password"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none"
          />
          <button
            type="submit"
            disabled={pwStatus.kind === "saving"}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm font-medium text-neutral-100 transition hover:bg-neutral-800 disabled:opacity-50"
          >
            {pwStatus.kind === "saving" ? "Saving…" : "Update password"}
          </button>
          {pwStatus.kind === "ok" && (
            <p className="text-sm text-emerald-400">Password updated.</p>
          )}
          {pwStatus.kind === "error" && (
            <p className="text-sm text-red-400">{pwStatus.message}</p>
          )}
        </div>
      </form>

      {/* Email */}
      <form
        onSubmit={handleEmail}
        className="rounded-lg border border-neutral-800 bg-neutral-950 p-6"
      >
        <h2 className="font-display text-xl">Sign-in email</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Currently{" "}
          <span className="text-neutral-200">{currentEmail}</span>. Changes
          don&apos;t take effect until you click the confirmation link we
          send to the new address.
        </p>

        <div className="mt-5 space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="new-email@example.com"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none"
          />
          <button
            type="submit"
            disabled={emailStatus.kind === "saving"}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm font-medium text-neutral-100 transition hover:bg-neutral-800 disabled:opacity-50"
          >
            {emailStatus.kind === "saving"
              ? "Sending…"
              : "Send confirmation to new email"}
          </button>
          {emailStatus.kind === "sent" && (
            <p className="text-sm text-emerald-400">
              Confirmation sent to {emailStatus.newEmail}. Click the link in
              that email to finish the change.
            </p>
          )}
          {emailStatus.kind === "error" && (
            <p className="text-sm text-red-400">{emailStatus.message}</p>
          )}
        </div>
      </form>
    </div>
  );
}

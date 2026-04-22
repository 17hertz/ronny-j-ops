"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email) return;

    setStatus({ kind: "sending" });
    const supabase = createClient();

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/api/auth/callback?next=/dashboard`,
      },
    });

    if (error) {
      setStatus({ kind: "error", message: error.message });
    } else {
      setStatus({ kind: "sent", email });
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-8 py-16">
      <Link
        href="/"
        className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
      >
        ← Ronny J Ops
      </Link>

      <p className="mt-10 font-mono text-xs uppercase tracking-[0.3em] text-brand">
        Team access
      </p>
      <h1 className="mt-4 font-display text-5xl leading-tight">
        Sign <span className="italic text-brand">in</span>
      </h1>
      <p className="mt-4 text-neutral-400">
        We&apos;ll email you a one-time link. No password required.
      </p>

      {status.kind === "sent" ? (
        <div className="mt-10 rounded-lg border border-neutral-800 bg-neutral-950 p-6">
          <p className="font-display text-xl">Check your inbox.</p>
          <p className="mt-2 text-sm text-neutral-400">
            We sent a sign-in link to{" "}
            <span className="text-neutral-100">{status.email}</span>. Click it
            within the next hour to finish signing in.
          </p>
          <button
            type="button"
            onClick={() => setStatus({ kind: "idle" })}
            className="mt-4 text-sm text-brand underline"
          >
            Use a different email
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-10 space-y-4">
          <label className="block">
            <span className="text-sm text-neutral-400">Work email</span>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@17hertz.io"
              className="mt-2 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none"
            />
          </label>

          <button
            type="submit"
            disabled={status.kind === "sending"}
            className="w-full rounded-lg bg-brand px-4 py-3 font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {status.kind === "sending" ? "Sending..." : "Send sign-in link"}
          </button>

          {status.kind === "error" && (
            <p className="text-sm text-red-400">{status.message}</p>
          )}
        </form>
      )}

      <p className="mt-16 text-xs text-neutral-600">
        Access is invitation-only. Not on the team? Ask Jason.
      </p>
    </main>
  );
}

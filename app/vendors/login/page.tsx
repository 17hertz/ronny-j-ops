"use client";

/**
 * Vendor login page.
 *
 * Three ways in, in order of friction:
 *   1. Continue with Google (biggest button — most vendors use Gmail)
 *   2. Email me a one-click sign-in link (magic link via Supabase OTP)
 *   3. Email + password (for vendors who set one from their account page)
 *
 * Why three options:
 *   - Music/entertainment vendors are wildly inconsistent tech-wise. Some
 *     are going to want Google because it's one tap. Some don't have a
 *     Google account and need a magic link. A few will insist on a
 *     traditional password.
 *   - None of them are going to remember a password they only use once
 *     a month — the password option is defensive, not primary.
 *
 * After auth, Supabase redirects to /api/auth/callback which sets the
 * session cookie and forwards to ?next=/vendors/account.
 */
import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

type LinkStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

type PwStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string };

export default function VendorLoginPage() {
  const [linkEmail, setLinkEmail] = useState("");
  const [linkStatus, setLinkStatus] = useState<LinkStatus>({ kind: "idle" });

  const [pwEmail, setPwEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pwStatus, setPwStatus] = useState<PwStatus>({ kind: "idle" });
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  async function handleGoogle() {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/api/auth/callback?next=/vendors/account`,
      },
    });
    if (error) {
      setLinkStatus({ kind: "error", message: error.message });
    }
    // On success the browser redirects to Google — nothing else to do.
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!linkEmail) return;
    setLinkStatus({ kind: "sending" });

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: linkEmail,
      options: {
        // Don't auto-create a user if they haven't been approved yet.
        // This prevents a random person from typing any email and
        // getting an account.
        shouldCreateUser: false,
        emailRedirectTo: `${window.location.origin}/api/auth/callback?next=/vendors/account`,
      },
    });

    if (error) {
      // When shouldCreateUser:false and there's no existing user, Supabase
      // returns a specific error. Surface a friendlier message.
      const friendlier = /not\s*found|not\s*signed\s*up/i.test(error.message)
        ? "We don't see a vendor account for that email. Ask the 17 Hertz team to check your approval status."
        : error.message;
      setLinkStatus({ kind: "error", message: friendlier });
    } else {
      setLinkStatus({ kind: "sent", email: linkEmail });
    }
  }

  async function handlePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pwEmail || !password) return;
    setPwStatus({ kind: "submitting" });

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: pwEmail,
      password,
    });

    if (error) {
      setPwStatus({ kind: "error", message: error.message });
    } else {
      // Supabase set the session cookie. Navigate to the account page.
      window.location.href = "/vendors/account";
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-8 py-16">
      <Link
        href="/"
        className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
      >
        ← 17 Hertz
      </Link>

      <p className="mt-10 font-mono text-xs uppercase tracking-[0.3em] text-brand">
        Vendor portal
      </p>
      <h1 className="mt-4 font-display text-5xl leading-tight">
        Sign <span className="italic text-brand">in</span>
      </h1>
      <p className="mt-4 text-neutral-400">
        Pick whichever way is easiest. They all get you to the same place.
      </p>

      {/* 1. Google */}
      <button
        type="button"
        onClick={handleGoogle}
        className="mt-8 flex w-full items-center justify-center gap-3 rounded-lg border border-neutral-700 bg-white px-4 py-3 font-medium text-neutral-900 transition hover:bg-neutral-100"
      >
        <GoogleLogo />
        Continue with Google
      </button>

      {/* 2. Magic link */}
      <div className="relative mt-6 flex items-center">
        <span className="h-px flex-1 bg-neutral-800" />
        <span className="px-3 font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-600">
          or email me a link
        </span>
        <span className="h-px flex-1 bg-neutral-800" />
      </div>

      {linkStatus.kind === "sent" ? (
        <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-950 p-6">
          <p className="font-display text-xl">Check your inbox.</p>
          <p className="mt-2 text-sm text-neutral-400">
            We sent a sign-in link to{" "}
            <span className="text-neutral-100">{linkStatus.email}</span>.
            Click it within the next hour to finish signing in.
          </p>
          <button
            type="button"
            onClick={() => setLinkStatus({ kind: "idle" })}
            className="mt-4 text-sm text-brand underline"
          >
            Use a different email
          </button>
        </div>
      ) : (
        <form onSubmit={handleMagicLink} className="mt-6 space-y-3">
          <input
            type="email"
            required
            autoComplete="email"
            value={linkEmail}
            onChange={(e) => setLinkEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none"
          />
          <button
            type="submit"
            disabled={linkStatus.kind === "sending"}
            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 font-medium text-neutral-100 transition hover:bg-neutral-800 disabled:opacity-50"
          >
            {linkStatus.kind === "sending"
              ? "Sending…"
              : "Email me a sign-in link"}
          </button>
          {linkStatus.kind === "error" && (
            <p className="text-sm text-red-400">{linkStatus.message}</p>
          )}
        </form>
      )}

      {/* 3. Password (collapsed by default) */}
      <div className="mt-8 border-t border-neutral-900 pt-6">
        {!showPasswordForm ? (
          <button
            type="button"
            onClick={() => setShowPasswordForm(true)}
            className="text-sm text-neutral-500 underline hover:text-brand"
          >
            I set a password — let me use that instead
          </button>
        ) : (
          <form onSubmit={handlePassword} className="space-y-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-neutral-500">
              Sign in with password
            </p>
            <input
              type="email"
              required
              autoComplete="email"
              value={pwEmail}
              onChange={(e) => setPwEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none"
            />
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-neutral-100 placeholder:text-neutral-600 focus:border-brand focus:outline-none"
            />
            <button
              type="submit"
              disabled={pwStatus.kind === "submitting"}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 font-medium text-neutral-100 transition hover:bg-neutral-800 disabled:opacity-50"
            >
              {pwStatus.kind === "submitting" ? "Signing in…" : "Sign in"}
            </button>
            {pwStatus.kind === "error" && (
              <p className="text-sm text-red-400">{pwStatus.message}</p>
            )}
            <button
              type="button"
              onClick={() => setShowPasswordForm(false)}
              className="text-xs text-neutral-600 underline"
            >
              Hide password option
            </button>
          </form>
        )}
      </div>

      <p className="mt-16 text-xs text-neutral-600">
        Access is for approved vendors only. Not approved yet? Fill out the{" "}
        <Link href="/vendors/new" className="underline hover:text-brand">
          intake form
        </Link>{" "}
        first.
      </p>
    </main>
  );
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.63z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86A5.27 5.27 0 0 1 4.04 10.7H1.03v2.33A8.99 8.99 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M4.04 10.7a5.41 5.41 0 0 1 0-3.4V4.96H1.03a9 9 0 0 0 0 8.07L4.04 10.7z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A8.99 8.99 0 0 0 1.03 4.96L4.04 7.3A5.37 5.37 0 0 1 9 3.58z"
      />
    </svg>
  );
}

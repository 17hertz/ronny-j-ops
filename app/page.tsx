import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-8 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-brand">
        Ronny J Listen UP LLC
      </p>
      <h1 className="mt-4 font-display text-6xl leading-tight">
        Operations{" "}
        <span className="italic text-brand">console</span>
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-neutral-400">
        Tasks, calendar, reminders, and vendor compliance — all in one place.
      </p>

      <nav className="mt-12 grid gap-4 sm:grid-cols-3">
        <Link
          href="/dashboard"
          className="rounded-lg border border-neutral-800 bg-neutral-950 p-6 transition hover:border-brand"
        >
          <div className="text-sm text-neutral-500">Team</div>
          <div className="mt-2 font-display text-2xl">Dashboard</div>
          <div className="mt-3 text-sm text-neutral-400">
            Tasks, today&apos;s schedule, reminder queue
          </div>
        </Link>

        <Link
          href="/vendors/new"
          className="rounded-lg border border-neutral-800 bg-neutral-950 p-6 transition hover:border-brand"
        >
          <div className="text-sm text-neutral-500">Vendors</div>
          <div className="mt-2 font-display text-2xl">Intake form</div>
          <div className="mt-3 text-sm text-neutral-400">
            W9 + invoice upload portal
          </div>
        </Link>

        <a
          href="https://github.com/17hertz/ronny-j-ops"
          className="rounded-lg border border-neutral-800 bg-neutral-950 p-6 transition hover:border-brand"
        >
          <div className="text-sm text-neutral-500">Build</div>
          <div className="mt-2 font-display text-2xl">Repo</div>
          <div className="mt-3 text-sm text-neutral-400">
            Source, docs, manual setup guide
          </div>
        </a>
      </nav>

      <p className="mt-16 text-xs text-neutral-600">
        Built for Ronny J · 2026
      </p>
    </main>
  );
}

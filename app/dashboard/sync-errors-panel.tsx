/**
 * Sync errors panel (server component).
 *
 * Lists tasks + events that failed to push to Google (push_status=
 * 'error'). Each row shows the title, the error message, and a Retry
 * button that re-emits the Inngest event for that specific item.
 *
 * Hidden entirely when there's nothing errored — part of the "invisible
 * infrastructure" philosophy. Only surfaces problems when they actually
 * need attention.
 *
 * Note: `skip` rows (permission-denied / no Google account) are NOT
 * shown here because they aren't retryable without a reconnect. The
 * reconnect banner at the top of the dashboard handles that flow.
 */
import { SyncErrorRetryButton } from "./sync-error-retry-button";

export type SyncErrorTaskRow = {
  id: string;
  title: string;
  push_error: string | null;
  last_push_attempt_at: string | null;
};

export type SyncErrorEventRow = {
  id: string;
  title: string;
  push_error: string | null;
  last_push_attempt_at: string | null;
  starts_at: string;
};

export function SyncErrorsPanel({
  erroredTasks,
  erroredEvents,
}: {
  erroredTasks: SyncErrorTaskRow[];
  erroredEvents: SyncErrorEventRow[];
}) {
  const total = erroredTasks.length + erroredEvents.length;
  if (total === 0) return null;

  return (
    <section className="mb-6 rounded-lg border border-red-900/60 bg-red-950/20 p-5">
      <header className="flex items-center justify-between">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-red-300">
            Sync errors
          </p>
          <h2 className="mt-1 font-display text-lg text-red-100">
            {total} {total === 1 ? "item" : "items"} didn't sync to Google
          </h2>
        </div>
        <p className="text-xs text-red-200/70">
          Local state is saved — retry below, or it'll auto-resolve next
          time Google's endpoint is healthy.
        </p>
      </header>

      {erroredTasks.length > 0 && (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-red-300/70">
            Tasks ({erroredTasks.length})
          </p>
          <ul className="mt-2 space-y-2">
            {erroredTasks.map((t) => (
              <li
                key={t.id}
                className="flex items-start justify-between gap-3 rounded-md border border-red-900/40 bg-neutral-950/60 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-neutral-100">
                    {t.title}
                  </p>
                  <p
                    className="mt-1 truncate font-mono text-[10px] text-red-200/80"
                    title={t.push_error ?? undefined}
                  >
                    {truncateError(t.push_error)}
                  </p>
                  {t.last_push_attempt_at && (
                    <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
                      last attempt{" "}
                      {formatRelative(t.last_push_attempt_at)}
                    </p>
                  )}
                </div>
                <SyncErrorRetryButton kind="task" id={t.id} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {erroredEvents.length > 0 && (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-wider text-red-300/70">
            Events ({erroredEvents.length})
          </p>
          <ul className="mt-2 space-y-2">
            {erroredEvents.map((e) => (
              <li
                key={e.id}
                className="flex items-start justify-between gap-3 rounded-md border border-red-900/40 bg-neutral-950/60 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-neutral-100">
                    {e.title}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {formatEventStart(e.starts_at)}
                  </p>
                  <p
                    className="mt-1 truncate font-mono text-[10px] text-red-200/80"
                    title={e.push_error ?? undefined}
                  >
                    {truncateError(e.push_error)}
                  </p>
                  {e.last_push_attempt_at && (
                    <p className="mt-0.5 font-mono text-[10px] text-neutral-600">
                      last attempt{" "}
                      {formatRelative(e.last_push_attempt_at)}
                    </p>
                  )}
                </div>
                <SyncErrorRetryButton kind="event" id={e.id} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Google error bodies can be verbose. Chop to 100 chars for the inline
 * display — the full text is available via the hover title attribute.
 */
function truncateError(msg: string | null): string {
  if (!msg) return "(no error message)";
  const first = msg.split("\n")[0];
  return first.length <= 100 ? first : first.slice(0, 99) + "…";
}

function formatRelative(iso: string): string {
  const ago = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (ago < 1) return "just now";
  if (ago < 60) return `${ago}m ago`;
  if (ago < 60 * 24) return `${Math.round(ago / 60)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatEventStart(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

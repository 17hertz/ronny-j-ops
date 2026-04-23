/**
 * Google Calendar API v3 client.
 *
 * We only use a tiny slice of the API — `events.list` with incremental-sync
 * semantics — so hand-rolled fetch is cheaper than pulling in `googleapis`.
 *
 * Incremental sync flow:
 *   1. First sync: no syncToken → paginate with pageToken + `timeMin`, collect
 *      everything, save the final `nextSyncToken` returned with the last page.
 *   2. Later syncs: pass `syncToken` → Google returns only changed events since
 *      the previous sync. Returns a new `nextSyncToken` at the end.
 *   3. If the token is older than ~7 days Google returns 410 Gone and we must
 *      discard it and do a full re-sync from scratch.
 */
const CAL_API = "https://www.googleapis.com/calendar/v3";

/** Subset of the Google Calendar Event resource that we care about. */
export type GoogleEvent = {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  etag?: string;
  updated?: string;
};

export type ListEventsResult = {
  items: GoogleEvent[];
  nextSyncToken: string | null;
};

export class SyncTokenInvalidError extends Error {
  constructor() {
    super("Google returned 410 Gone — sync token expired, need full re-sync");
    this.name = "SyncTokenInvalidError";
  }
}

/**
 * Thrown on 401 from Google. Caller should force-refresh the access token
 * (ignoring our locally-stored expiry) and retry once. If it 401s again,
 * the refresh token itself is dead and the user must reconnect.
 *
 * `body` is retained so the caller can log Google's error code — e.g.
 *   { "error": { "code": 401, "status": "UNAUTHENTICATED",
 *                "message": "Request had invalid authentication credentials..." } }
 */
export class UnauthorizedError extends Error {
  readonly body: string;
  constructor(body: string) {
    super(`Google returned 401 Unauthorized: ${body}`);
    this.name = "UnauthorizedError";
    this.body = body;
  }
}

/**
 * List events from a single calendar, paginating until exhausted.
 *
 * On the happy path this returns all events + the final `nextSyncToken`.
 * On 410 Gone it throws `SyncTokenInvalidError` — the caller should clear
 * the stored token and retry without one.
 */
export async function listEvents(params: {
  accessToken: string;
  calendarId: string;
  syncToken?: string | null;
  /** Only used on the first sync (cannot be combined with syncToken). */
  timeMin?: string;
}): Promise<ListEventsResult> {
  const collected: GoogleEvent[] = [];
  let pageToken: string | undefined = undefined;
  let nextSyncToken: string | null = null;

  // Google forbids mixing syncToken with other filters. First sync uses
  // timeMin to bound the initial pull; subsequent syncs use syncToken only.
  const useSyncToken = !!params.syncToken;

  // Arbitrary upper bound on pages — protects against a busted cursor
  // returning the same page forever.
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({
      singleEvents: "true",
      maxResults: "250",
      showDeleted: useSyncToken ? "true" : "false",
    });
    if (useSyncToken) qs.set("syncToken", params.syncToken!);
    else if (params.timeMin) qs.set("timeMin", params.timeMin);
    if (pageToken) qs.set("pageToken", pageToken);
    // `orderBy=startTime` is only valid when singleEvents=true AND no syncToken
    if (!useSyncToken) qs.set("orderBy", "startTime");

    const url =
      `${CAL_API}/calendars/${encodeURIComponent(params.calendarId)}/events?` +
      qs.toString();

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${params.accessToken}` },
    });

    if (res.status === 410) throw new SyncTokenInvalidError();
    if (res.status === 401) {
      const body = await res.text();
      throw new UnauthorizedError(body);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Google events.list failed (${res.status}): ${body}`);
    }

    const json = (await res.json()) as {
      items?: GoogleEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };

    if (json.items) collected.push(...json.items);
    if (json.nextSyncToken) nextSyncToken = json.nextSyncToken;
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }

  return { items: collected, nextSyncToken };
}

/**
 * Map a Google event to the columns our `events` table expects.
 * Returns null if the event is cancelled (caller should delete in that case).
 */
export function toEventRow(
  gevent: GoogleEvent,
  googleCalendarId: string,
  defaultTimezone: string
): null | {
  google_calendar_id: string;
  google_event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  etag: string | null;
  source: "google";
} {
  if (gevent.status === "cancelled") return null;

  const tz =
    gevent.start?.timeZone ||
    gevent.end?.timeZone ||
    defaultTimezone ||
    "America/New_York";

  // All-day events come back as `date: "YYYY-MM-DD"`. Store them as
  // midnight in the event's timezone — the viewer can decide to render
  // as "all day" based on equal timestamps or the lack of time component.
  const startIso =
    gevent.start?.dateTime ??
    (gevent.start?.date ? `${gevent.start.date}T00:00:00Z` : null);
  const endIso =
    gevent.end?.dateTime ??
    (gevent.end?.date ? `${gevent.end.date}T00:00:00Z` : null);

  if (!startIso || !endIso) return null;

  return {
    google_calendar_id: googleCalendarId,
    google_event_id: gevent.id,
    title: gevent.summary?.trim() || "(no title)",
    description: gevent.description ?? null,
    location: gevent.location ?? null,
    starts_at: startIso,
    ends_at: endIso,
    timezone: tz,
    etag: gevent.etag ?? null,
    source: "google",
  };
}

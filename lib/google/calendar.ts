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
 *
 * `createdBy` is the team_member who owns the Google account this event
 * came from. Stamping this on every synced row is what makes per-user
 * privacy work — without it, Ronny would see Jason's calendar.
 */
export function toEventRow(
  gevent: GoogleEvent,
  googleCalendarId: string,
  defaultTimezone: string,
  createdBy: string
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
  created_by: string;
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
    created_by: createdBy,
  };
}

// =========================================================================
// Google Calendar WRITE path — used by lib/inngest/functions.ts to
// propagate local event creates/edits back to Google Calendar.
//
// Mirrors the error-class pattern in lib/google/tasks.ts:
//   - 401 → EventUnauthorizedError (caller should force-refresh & retry)
//   - 403 → EventPermissionError (scope missing OR Calendar API not
//           enabled — not retryable without user/admin action)
//   - 412 → EventEtagConflictError (remote version changed since read)
// =========================================================================

export class EventUnauthorizedError extends Error {
  constructor() {
    super("Google Calendar returned 401 — access token rejected, needs refresh");
    this.name = "EventUnauthorizedError";
  }
}

export class EventPermissionError extends Error {
  constructor() {
    super("Google Calendar returned 403 — scope missing or Calendar API not enabled");
    this.name = "EventPermissionError";
  }
}

export class EventEtagConflictError extends Error {
  constructor() {
    super("Google Calendar etag mismatch — concurrent edit detected");
    this.name = "EventEtagConflictError";
  }
}

/**
 * Shape Google expects for start/end. `dateTime` is ISO (no Z or with
 * offset — Google uses timeZone to interpret). `date` is an all-day
 * event in YYYY-MM-DD.
 */
type GoogleEventTime =
  | { dateTime: string; timeZone?: string }
  | { date: string };

/**
 * Create a new event on a Google Calendar.
 *
 * `calendarId` — usually "primary" for the user's main calendar. Can
 * be any calendar ID they have write access to.
 *
 * `timeZone` — IANA zone like "America/New_York". Google interprets
 * the `dateTime` field in this zone, so an input of
 *   { dateTime: "2026-04-25T13:00:00", timeZone: "America/New_York" }
 * books the event at 1pm ET regardless of where the user's browser is.
 */
export async function createGoogleEvent(params: {
  accessToken: string;
  calendarId: string;
  title: string;
  description?: string | null;
  location?: string | null;
  startIso: string;
  endIso: string;
  timeZone: string;
}): Promise<GoogleEvent> {
  const body: Record<string, unknown> = {
    summary: params.title,
    start: {
      dateTime: params.startIso,
      timeZone: params.timeZone,
    } as GoogleEventTime,
    end: {
      dateTime: params.endIso,
      timeZone: params.timeZone,
    } as GoogleEventTime,
  };
  if (params.description) body.description = params.description;
  if (params.location) body.location = params.location;

  const res = await fetch(
    `${CAL_API}/calendars/${encodeURIComponent(params.calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (res.status === 401) throw new EventUnauthorizedError();
  if (res.status === 403) throw new EventPermissionError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google events.insert failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleEvent;
}

/**
 * PATCH an existing event. Uses If-Match with the expected etag so
 * concurrent edits throw EventEtagConflictError instead of silently
 * overwriting. Pass `expectedEtag: null` to force overwrite.
 */
export async function patchGoogleEvent(params: {
  accessToken: string;
  calendarId: string;
  googleEventId: string;
  expectedEtag: string | null;
  title?: string;
  description?: string | null;
  location?: string | null;
  startIso?: string;
  endIso?: string;
  timeZone?: string;
}): Promise<GoogleEvent> {
  const body: Record<string, unknown> = {};
  if (params.title !== undefined) body.summary = params.title;
  if (params.description !== undefined) body.description = params.description;
  if (params.location !== undefined) body.location = params.location;
  if (params.startIso !== undefined) {
    body.start = {
      dateTime: params.startIso,
      timeZone: params.timeZone ?? "America/New_York",
    };
  }
  if (params.endIso !== undefined) {
    body.end = {
      dateTime: params.endIso,
      timeZone: params.timeZone ?? "America/New_York",
    };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.accessToken}`,
    "Content-Type": "application/json",
  };
  if (params.expectedEtag) {
    headers["If-Match"] = params.expectedEtag;
  }

  const res = await fetch(
    `${CAL_API}/calendars/${encodeURIComponent(
      params.calendarId
    )}/events/${encodeURIComponent(params.googleEventId)}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    }
  );
  if (res.status === 412) throw new EventEtagConflictError();
  if (res.status === 401) throw new EventUnauthorizedError();
  if (res.status === 403) throw new EventPermissionError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google events.patch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleEvent;
}

/**
 * DELETE an event from Google Calendar. Idempotent — 404 is swallowed
 * so a retry on an already-deleted event is a no-op.
 */
export async function deleteGoogleEvent(params: {
  accessToken: string;
  calendarId: string;
  googleEventId: string;
}): Promise<void> {
  const res = await fetch(
    `${CAL_API}/calendars/${encodeURIComponent(
      params.calendarId
    )}/events/${encodeURIComponent(params.googleEventId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${params.accessToken}` },
    }
  );
  if (res.status === 404) return;
  if (res.status === 401) throw new EventUnauthorizedError();
  if (res.status === 403) throw new EventPermissionError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google events.delete failed (${res.status}): ${text}`);
  }
}

/**
 * GET a single event. Used for pull-on-conflict during etag mismatches.
 */
export async function getGoogleEvent(params: {
  accessToken: string;
  calendarId: string;
  googleEventId: string;
}): Promise<GoogleEvent> {
  const res = await fetch(
    `${CAL_API}/calendars/${encodeURIComponent(
      params.calendarId
    )}/events/${encodeURIComponent(params.googleEventId)}`,
    { headers: { Authorization: `Bearer ${params.accessToken}` } }
  );
  if (res.status === 401) throw new EventUnauthorizedError();
  if (res.status === 403) throw new EventPermissionError();
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google events.get failed (${res.status}): ${text}`);
  }
  return (await res.json()) as GoogleEvent;
}

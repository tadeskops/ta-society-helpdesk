// Google Calendar mirror (Phase 3) — best-effort external mirror.
// Spec: tsh_requirement.md §20.
//
// Design goals:
//   - The application DB (config/reservations.json) is the source of
//     truth. Calendar events are a mirror.
//   - Behind FEATURE_TSH_RESERVATIONS_CALENDAR. Default OFF for safety.
//   - Never break a reservation transition. Every API call is wrapped
//     by the caller in try/catch; failures are pushed to a retry queue
//     (config/calendar-queue.json).
//   - No secrets in code. OAuth uses a refresh token stored as a worker
//     secret (GOOGLE_CAL_REFRESH_TOKEN). Missing creds ⇒ no external
//     call is made and the op is queued for later drain.

import type { Env } from '../env.ts';
import type { SiteConfig } from '../config/defaults.ts';
import { isFeatureOn, tunable } from '../config/defaults.ts';
import { getFile, putFile } from '../github/client.ts';
import type { Facility, Reservation } from './reservation.ts';

export const CAL_FLAG = 'FEATURE_TSH_RESERVATIONS_CALENDAR';
export const CAL_QUEUE_PATH = 'config/calendar-queue.json';

export type CalendarOp = 'create' | 'update' | 'delete';

export interface CalendarQueueItem {
  op: CalendarOp;
  resId: string;
  calendarId: string;
  calendarEventId?: string;
  attempts: number;
  lastError?: string;
  at: string;                     // ISO 8601 (first-queued time)
  payload?: unknown;              // opaque body used on drain (create/update)
}

export interface CalendarQueue {
  version: 1;
  items: CalendarQueueItem[];
}

// ---- Cache ----------------------------------------------------------

interface Cached { at: number; queue: CalendarQueue; sha?: string; }
let cache: Cached | null = null;
export const _resetCalendarCacheForTests = (): void => { cache = null; };

// ---- Storage --------------------------------------------------------

const loadQueue = async (env: Env, cfg: SiteConfig): Promise<{ queue: CalendarQueue; sha?: string }> => {
  const ttlMs = tunable(cfg, 'CALENDAR_QUEUE_CACHE_SECONDS', 60) * 1000;
  if (cache && (Date.now() - cache.at) < ttlMs) {
    return cache.sha !== undefined ? { queue: cache.queue, sha: cache.sha } : { queue: cache.queue };
  }
  const f = await getFile(env, CAL_QUEUE_PATH);
  let queue: CalendarQueue = { version: 1, items: [] };
  if (f) {
    try {
      const parsed = JSON.parse(f.content) as CalendarQueue;
      if (parsed && Array.isArray(parsed.items)) queue = { version: 1, items: parsed.items };
    } catch { /* fall through with empty */ }
  }
  const entry: Cached = { at: Date.now(), queue };
  if (f?.sha !== undefined) entry.sha = f.sha;
  cache = entry;
  return cache.sha !== undefined ? { queue, sha: cache.sha } : { queue };
};

const saveQueue = async (env: Env, queue: CalendarQueue, sha: string | undefined, actor: string, reason: string): Promise<void> => {
  const content = JSON.stringify(queue, null, 2) + '\n';
  const res = await putFile(env, CAL_QUEUE_PATH, content, `chore(calendar-queue): ${reason} [${actor}]`.slice(0, 72), actor, sha);
  cache = { at: Date.now(), queue, sha: res.sha };
};

// ---- OAuth ----------------------------------------------------------

interface TokenCache { token: string; expiresAt: number; }
let tokenCache: TokenCache | null = null;
export const _resetCalendarTokenForTests = (): void => { tokenCache = null; };

const haveCreds = (env: Env): boolean =>
  !!(env.GOOGLE_CAL_CLIENT_ID && env.GOOGLE_CAL_CLIENT_SECRET && env.GOOGLE_CAL_REFRESH_TOKEN);

const getAccessToken = async (env: Env): Promise<string | undefined> => {
  if (!haveCreds(env)) return undefined;
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;
  const body = new URLSearchParams({
    client_id:     env.GOOGLE_CAL_CLIENT_ID!,
    client_secret: env.GOOGLE_CAL_CLIENT_SECRET!,
    refresh_token: env.GOOGLE_CAL_REFRESH_TOKEN!,
    grant_type:    'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`google oauth ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json() as { access_token: string; expires_in?: number };
  tokenCache = { token: j.access_token, expiresAt: Date.now() + ((j.expires_in ?? 3600) * 1000) };
  return tokenCache.token;
};

// ---- Time helpers ---------------------------------------------------

// Build ISO strings for a slot on a given date, in IST (+05:30).
const istIso = (date: string, hour: number): string => {
  const h = String(Math.max(0, Math.min(24, hour))).padStart(2, '0');
  return `${date}T${h}:00:00+05:30`;
};

// Build IST-anchored ISO from a minute-of-day (0..1440).
const istIsoFromMin = (date: string, minutes: number): string => {
  const clamped = Math.max(0, Math.min(24 * 60, minutes));
  const h = String(Math.floor(clamped / 60)).padStart(2, '0');
  const m = String(clamped % 60).padStart(2, '0');
  return `${date}T${h}:${m}:00+05:30`;
};

// ---- Event payload --------------------------------------------------

const buildEventBody = (rec: Reservation, facility: Facility) => {
  // Prefer time-range fields; fall back to legacy slot lookup for
  // pre-cutover records that never persisted startMin/endMin.
  let startIso: string;
  let endIso: string;
  if (typeof rec.startMin === 'number' && typeof rec.endMin === 'number' && rec.endMin > rec.startMin) {
    startIso = istIsoFromMin(rec.date, rec.startMin);
    endIso   = istIsoFromMin(rec.date, rec.endMin);
  } else {
    const slot = (facility.slots ?? []).find((s) => s.id === rec.slotId);
    const startHour = slot?.startHour ?? 9;
    const endHour   = slot?.endHour   ?? Math.min(24, startHour + 1);
    startIso = istIso(rec.date, startHour);
    endIso   = istIso(rec.date, endHour === 24 ? 23 : endHour);
  }
  return {
    summary:     `${facility.name} · ${rec.owner.name || rec.owner.email}`,
    description: `${rec.purpose}\n\nReservation: ${rec.id}\nOwner: ${rec.owner.email}${rec.owner.flat ? '\nFlat: ' + rec.owner.flat : ''}`,
    location:    facility.name,
    start:       { dateTime: startIso, timeZone: 'Asia/Kolkata' },
    end:         { dateTime: endIso,   timeZone: 'Asia/Kolkata' },
    extendedProperties: {
      private: { tshReservationId: rec.id, tshFacilityId: rec.facilityId },
    },
  };
};

// ---- Google Calendar API v3 wrappers --------------------------------

const CAL_API = 'https://www.googleapis.com/calendar/v3/calendars';

const gcalCreate = async (env: Env, calendarId: string, body: unknown): Promise<string> => {
  const token = await getAccessToken(env);
  if (!token) throw new Error('no-oauth-creds');
  const url = `${CAL_API}/${encodeURIComponent(calendarId)}/events`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`gcal create ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json() as { id: string };
  return j.id;
};

const gcalUpdate = async (env: Env, calendarId: string, eventId: string, body: unknown): Promise<void> => {
  const token = await getAccessToken(env);
  if (!token) throw new Error('no-oauth-creds');
  const url = `${CAL_API}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`gcal update ${res.status}: ${t.slice(0, 200)}`);
  }
};

const gcalDelete = async (env: Env, calendarId: string, eventId: string): Promise<void> => {
  const token = await getAccessToken(env);
  if (!token) throw new Error('no-oauth-creds');
  const url = `${CAL_API}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  // 410 Gone = already deleted, treat as success.
  if (!res.ok && res.status !== 410 && res.status !== 404) {
    const t = await res.text().catch(() => '');
    throw new Error(`gcal delete ${res.status}: ${t.slice(0, 200)}`);
  }
};

// ---- Queue helpers --------------------------------------------------

const enqueue = async (env: Env, cfg: SiteConfig, item: Omit<CalendarQueueItem, 'attempts' | 'at'> & { at?: string; attempts?: number }): Promise<void> => {
  try {
    const { queue, sha } = await loadQueue(env, cfg);
    queue.items.push({
      op:              item.op,
      resId:           item.resId,
      calendarId:      item.calendarId,
      ...(item.calendarEventId !== undefined ? { calendarEventId: item.calendarEventId } : {}),
      attempts:        item.attempts ?? 0,
      at:              item.at ?? new Date().toISOString(),
      ...(item.lastError !== undefined ? { lastError: item.lastError } : {}),
      ...(item.payload  !== undefined ? { payload: item.payload }       : {}),
    });
    // Keep queue bounded to protect the config file.
    if (queue.items.length > 500) queue.items.splice(0, queue.items.length - 500);
    await saveQueue(env, queue, sha, 'system', `queue ${item.op} ${item.resId}`);
  } catch {
    // If we can't even queue, we drop silently — the reservation record
    // itself is intact and a manual re-sync is always possible.
  }
};

// ---- Public API used by reservations route --------------------------

/**
 * Mirror a "reservation confirmed" event into Google Calendar. Best-effort:
 * on any failure the op is added to the retry queue and the returned event
 * id is undefined. When the flag is off or creds are missing, the call is
 * a silent no-op / queue.
 */
export const mirrorConfirm = async (env: Env, cfg: SiteConfig, rec: Reservation, facility: Facility): Promise<string | undefined> => {
  if (!isFeatureOn(cfg, CAL_FLAG)) return undefined;
  const calendarId = facility.calendarId;
  if (!calendarId) return undefined;
  const body = buildEventBody(rec, facility);
  if (!haveCreds(env)) {
    await enqueue(env, cfg, { op: 'create', resId: rec.id, calendarId, payload: body });
    return undefined;
  }
  try {
    return await gcalCreate(env, calendarId, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await enqueue(env, cfg, { op: 'create', resId: rec.id, calendarId, lastError: msg, payload: body });
    return undefined;
  }
};

/**
 * Mirror a "reservation cancelled / rejected" — delete the mirrored event.
 * No-op when the reservation has no `calendarEventId` (was never mirrored)
 * or the flag is off.
 */
export const mirrorRemove = async (env: Env, cfg: SiteConfig, rec: Reservation, facility: Facility): Promise<void> => {
  if (!isFeatureOn(cfg, CAL_FLAG)) return;
  const calendarId = facility.calendarId;
  if (!calendarId) return;
  if (!rec.calendarEventId) return;
  if (!haveCreds(env)) {
    await enqueue(env, cfg, { op: 'delete', resId: rec.id, calendarId, calendarEventId: rec.calendarEventId });
    return;
  }
  try {
    await gcalDelete(env, calendarId, rec.calendarEventId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await enqueue(env, cfg, { op: 'delete', resId: rec.id, calendarId, calendarEventId: rec.calendarEventId, lastError: msg });
  }
};

// ---- Admin status + drain -------------------------------------------

export interface CalendarStatus {
  enabled: boolean;
  haveCreds: boolean;
  queueDepth: number;
  lastErrors: { at: string; resId: string; op: CalendarOp; lastError: string }[];
}

export const status = async (env: Env, cfg: SiteConfig): Promise<CalendarStatus> => {
  const { queue } = await loadQueue(env, cfg);
  const errs = queue.items.filter((i) => i.lastError).slice(-5).map((i) => ({
    at:        i.at,
    resId:     i.resId,
    op:        i.op,
    lastError: i.lastError!,
  }));
  return {
    enabled:    isFeatureOn(cfg, CAL_FLAG),
    haveCreds:  haveCreds(env),
    queueDepth: queue.items.length,
    lastErrors: errs,
  };
};

export interface DrainResult { attempted: number; ok: number; failed: number; dropped: number; }

/**
 * Attempt to drain queued calendar ops. Each item gets one attempt per
 * call; on failure `attempts` is incremented and the item stays queued
 * until it exceeds `CALENDAR_RETRY_MAX` (default 5), after which it is
 * dropped.
 */
export const drain = async (env: Env, cfg: SiteConfig): Promise<DrainResult> => {
  const out: DrainResult = { attempted: 0, ok: 0, failed: 0, dropped: 0 };
  if (!isFeatureOn(cfg, CAL_FLAG)) return out;
  if (!haveCreds(env)) return out;
  const maxAttempts = tunable(cfg, 'CALENDAR_RETRY_MAX', 5);
  const { queue, sha } = await loadQueue(env, cfg);
  if (queue.items.length === 0) return out;
  const survivors: CalendarQueueItem[] = [];
  for (const item of queue.items) {
    out.attempted++;
    try {
      if (item.op === 'create') {
        await gcalCreate(env, item.calendarId, item.payload ?? {});
      } else if (item.op === 'update') {
        if (!item.calendarEventId) throw new Error('update without event id');
        await gcalUpdate(env, item.calendarId, item.calendarEventId, item.payload ?? {});
      } else if (item.op === 'delete') {
        if (!item.calendarEventId) throw new Error('delete without event id');
        await gcalDelete(env, item.calendarId, item.calendarEventId);
      }
      out.ok++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const attempts = item.attempts + 1;
      if (attempts >= maxAttempts) {
        out.dropped++;
      } else {
        out.failed++;
        survivors.push({ ...item, attempts, lastError: msg });
      }
    }
  }
  queue.items = survivors;
  await saveQueue(env, queue, sha, 'system', `drain attempted=${out.attempted} ok=${out.ok} failed=${out.failed} dropped=${out.dropped}`);
  return out;
};

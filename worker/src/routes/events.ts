// Upcoming events panel.
// GET /events — anonymous read, gated by FEATURE_DAILY_EVENTS.
// PUT /events — MANAGER / COMMITTEE / DEVELOPER write the full list.
//
// Each item: { id, title, body?, eventAt, location?, href?, expiresAt?,
//               createdAt, createdBy, updatedAt }.
// `eventAt` is the date/time the event happens. `expiresAt` defaults to
// eventAt + 1 day (or createdAt + DAILY_NOTICE_TTL_DAYS if no eventAt).
// Items past expiry are filtered from GET and pruned on the next PUT.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson, str, optStr, isObj } from '../lib/validate.ts';
import { BadRequest } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { tunable } from '../config/defaults.ts';

const EVT_PATH = 'config/events.json';
const MAX_ITEMS = 50;

interface EventItem {
  id: string;
  title: string;
  body?: string;
  eventAt: string;        // ISO-8601 when the event is happening
  location?: string;
  href?: string;
  expiresAt?: string;     // when to disappear; default eventAt + 1 day
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

interface EventList { version: number; items: EventItem[]; }

const EMPTY: EventList = { version: 1, items: [] };

interface Cache { value: EventList; sha?: string; expiresAt: number; }
let cache: Cache | undefined;
const invalidate = (): void => { cache = undefined; };
export const _resetEventsCacheForTests = (): void => { cache = undefined; };

const loadFromGithub = async (env: Ctx['env']): Promise<{ value: EventList; sha?: string }> => {
  const f = await getFile(env, EVT_PATH);
  if (!f) return { value: structuredClone(EMPTY) };
  try {
    const parsed = JSON.parse(f.content) as Partial<EventList>;
    return {
      value: {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        items: Array.isArray(parsed.items) ? (parsed.items as EventItem[]) : [],
      },
      sha: f.sha,
    };
  } catch {
    return { value: structuredClone(EMPTY), sha: f.sha };
  }
};

const load = async (ctx: Ctx): Promise<EventList> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const fresh = await loadFromGithub(ctx.env);
  const ttl = tunable(ctx.config, 'EVENTS_CACHE_SECONDS', 60) * 1000;
  cache = {
    value: fresh.value,
    expiresAt: now + ttl,
    ...(fresh.sha !== undefined ? { sha: fresh.sha } : {}),
  };
  return fresh.value;
};

const cryptoRandomId = (): string => {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  return `evt-${hex}`;
};

const sanitiseItem = (raw: unknown, actor: string, defaultTtlDays: number): EventItem => {
  if (!isObj(raw)) throw new BadRequest('event item must be an object');
  const title = str(raw['title'], 'event.title', { min: 1, max: 160 });
  const eventAtRaw = str(raw['eventAt'], 'event.eventAt', { min: 1, max: 40 });
  const eventAtMs = Date.parse(eventAtRaw);
  if (Number.isNaN(eventAtMs)) throw new BadRequest('event.eventAt must be ISO 8601');
  const createdAt = typeof raw['createdAt'] === 'string' ? raw['createdAt'] : new Date().toISOString();
  const out: EventItem = {
    id: typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : cryptoRandomId(),
    title,
    eventAt: new Date(eventAtMs).toISOString(),
    createdAt,
    createdBy: typeof raw['createdBy'] === 'string' && raw['createdBy'] ? raw['createdBy'] : actor,
    updatedAt: new Date().toISOString(),
  };
  const body = optStr(raw['body'], 'event.body', { max: 4000 });
  if (body) out.body = body;
  const location = optStr(raw['location'], 'event.location', { max: 240 });
  if (location) out.location = location;
  const href = optStr(raw['href'], 'event.href', { max: 500 });
  if (href) out.href = href;
  const exp = optStr(raw['expiresAt'], 'event.expiresAt', { max: 40 });
  if (exp) {
    const t = Date.parse(exp);
    if (Number.isNaN(t)) throw new BadRequest('event.expiresAt must be ISO 8601');
    out.expiresAt = new Date(t).toISOString();
  } else {
    // Default: roll off 1 day after the event so attendees still see it on
    // the day-of. If editor wants a longer notice window, they can set
    // expiresAt explicitly.
    out.expiresAt = new Date(eventAtMs + 24 * 60 * 60 * 1000).toISOString();
    // Cap to the TTL window measured from createdAt so abandoned drafts
    // also disappear eventually.
    if (defaultTtlDays > 0) {
      const base = Date.parse(createdAt);
      const ttlEnd = (Number.isFinite(base) ? base : Date.now()) + defaultTtlDays * 24 * 60 * 60 * 1000;
      const explicit = Date.parse(out.expiresAt);
      if (Number.isFinite(explicit) && explicit < ttlEnd) {
        // keep the event-day rule (it's the tighter bound)
      } else if (Number.isFinite(explicit)) {
        // event is far away — let the TTL ceiling apply
        out.expiresAt = new Date(Math.max(explicit, ttlEnd)).toISOString();
      }
    }
  }
  return out;
};

const isExpired = (it: EventItem, now: number): boolean => {
  if (!it.expiresAt) return false;
  const t = Date.parse(it.expiresAt);
  if (Number.isNaN(t)) return false;
  return t < now;
};

export const mountEvents = (r: Router): void => {
  r.get('/events', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: ['FEATURE_DAILY_EVENTS'] });
    const e = await load(ctx);
    const now = Date.now();
    // Sort upcoming first, then by closest eventAt; expired filtered out.
    const active = e.items
      .filter((it) => !isExpired(it, now))
      .sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt));
    return ok(ctx.env, ctx.req, { version: e.version, items: active });
  });

  r.put('/events', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_EVENTS'],
      roles: ['MANAGER', 'COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const incoming = (body['events'] ?? body) as Record<string, unknown>;
    if (!isObj(incoming)) throw new BadRequest('events must be an object');
    const itemsRaw = Array.isArray(incoming['items']) ? incoming['items'] : [];
    if (itemsRaw.length > MAX_ITEMS) throw new BadRequest(`events supports at most ${MAX_ITEMS}`);
    const actor = ctx.identity!.email;
    const defaultTtlDays = tunable(ctx.config, 'DAILY_NOTICE_TTL_DAYS', 7);
    const sanitised = itemsRaw.map((it) => sanitiseItem(it, actor, defaultTtlDays));
    const now = Date.now();
    const kept = sanitised.filter((it) => !isExpired(it, now));
    const next: EventList = {
      version: typeof incoming['version'] === 'number' ? (incoming['version'] as number) : 1,
      items: kept,
    };
    const existing = await getFile(ctx.env, EVT_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(ctx.env, EVT_PATH, serialised, `events: update by ${actor}`, actor, existing?.sha);
    await writeAudit(ctx.env, {
      actor, action: 'events:put', target: EVT_PATH, detail: `items=${next.items.length}`,
    });
    invalidate();
    return ok(ctx.env, ctx.req, { saved: true, count: next.items.length });
  });
};

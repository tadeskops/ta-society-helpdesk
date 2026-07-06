// Admin-toggled announcements section.
// GET /announcements — anonymous read, gated by FEATURE_DAILY_ANNOUNCEMENTS.
// PUT /announcements — MANAGER / COMMITTEE / ADMIN write the full list.
//
// Each item: { id, title, body, pinned?, createdAt, createdBy, updatedAt }.
// Frontend mounts a "What's new" section card on the landing page when the
// admin enables the flag from Settings.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson, str, optStr, isObj } from '../lib/validate.ts';
import { BadRequest } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { filterSeed } from '../lib/seed.ts';
import { writeAudit } from '../lib/audit.ts';
import { tunable } from '../config/defaults.ts';

const ANN_PATH = 'config/announcements.json';
const MAX_ITEMS = 50;

interface Announcement {
  id: string;
  title: string;
  body: string;
  pinned?: boolean;
  /**
   * ISO-8601 instant after which the item should disappear from public reads.
   * Defaults to createdAt + DAILY_NOTICE_TTL_DAYS days when the editor leaves
   * it blank. Writers may still set any future timestamp explicitly. Items
   * past their expiry are filtered from GET but kept in storage until the
   * next PUT (which prunes them) so an accidental TTL bug can be reverted.
   */
  expiresAt?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

interface AnnouncementList { version: number; items: Announcement[]; }

const EMPTY: AnnouncementList = { version: 1, items: [] };

interface Cache { value: AnnouncementList; sha?: string; expiresAt: number; }
let cache: Cache | undefined;
const invalidate = (): void => { cache = undefined; };
export const _resetAnnouncementsCacheForTests = (): void => { cache = undefined; };

const loadFromGithub = async (env: Ctx['env']): Promise<{ value: AnnouncementList; sha?: string }> => {
  const f = await getFile(env, ANN_PATH);
  if (!f) return { value: structuredClone(EMPTY) };
  try {
    const parsed = JSON.parse(f.content) as Partial<AnnouncementList>;
    return {
      value: {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        items: Array.isArray(parsed.items) ? (parsed.items as Announcement[]) : [],
      },
      sha: f.sha,
    };
  } catch {
    return { value: structuredClone(EMPTY), sha: f.sha };
  }
};

const load = async (ctx: Ctx): Promise<AnnouncementList> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const fresh = await loadFromGithub(ctx.env);
  const ttl = tunable(ctx.config, 'ANNOUNCEMENTS_CACHE_SECONDS', 60) * 1000;
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
  return `ann-${hex}`;
};

const sanitiseItem = (raw: unknown, actor: string, defaultTtlDays: number): Announcement => {
  if (!isObj(raw)) throw new BadRequest('announcement item must be an object');
  const title = str(raw['title'], 'announcement.title', { min: 1, max: 160 });
  const body  = str(raw['body'],  'announcement.body',  { min: 1, max: 4000 });
  const createdAt = typeof raw['createdAt'] === 'string' ? raw['createdAt'] : new Date().toISOString();
  const out: Announcement = {
    id: typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : cryptoRandomId(),
    title,
    body,
    createdAt,
    createdBy: typeof raw['createdBy'] === 'string' && raw['createdBy'] ? raw['createdBy'] : actor,
    updatedAt: new Date().toISOString(),
  };
  if (raw['pinned'] === true) out.pinned = true;
  const exp = optStr(raw['expiresAt'], 'announcement.expiresAt', { max: 40 });
  if (exp) {
    const t = Date.parse(exp);
    if (Number.isNaN(t)) throw new BadRequest('announcement.expiresAt must be ISO 8601');
    out.expiresAt = new Date(t).toISOString();
  } else if (defaultTtlDays > 0) {
    // Editor left expiry blank — assign the configured default so old
    // notices auto-disappear without manager cleanup.
    const base = Date.parse(createdAt);
    const ms = (Number.isFinite(base) ? base : Date.now()) + defaultTtlDays * 24 * 60 * 60 * 1000;
    out.expiresAt = new Date(ms).toISOString();
  }
  return out;
};

const isExpired = (it: Announcement, now: number): boolean => {
  if (!it.expiresAt) return false;
  const t = Date.parse(it.expiresAt);
  if (Number.isNaN(t)) return false;
  return t < now;
};

export const mountAnnouncements = (r: Router): void => {
  r.get('/announcements', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: ['FEATURE_DAILY_ANNOUNCEMENTS'] });
    const a = await load(ctx);
    // Filter expired so residents never see stale notices. The storage
    // file is pruned the next time a writer saves.
    const now = Date.now();
    const active = filterSeed(a.items.filter((it) => !isExpired(it, now)), ctx.config);
    return ok(ctx.env, ctx.req, { version: a.version, items: active });
  });

  r.put('/announcements', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_ANNOUNCEMENTS'],
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
      requireIdentity: true,
    });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const incoming = (body['announcements'] ?? body) as Record<string, unknown>;
    if (!isObj(incoming)) throw new BadRequest('announcements must be an object');
    const itemsRaw = Array.isArray(incoming['items']) ? incoming['items'] : [];
    if (itemsRaw.length > MAX_ITEMS) throw new BadRequest(`announcements supports at most ${MAX_ITEMS}`);
    const actor = ctx.identity!.email;
    const defaultTtlDays = tunable(ctx.config, 'DAILY_NOTICE_TTL_DAYS', 7);
    const sanitised = itemsRaw.map((it) => sanitiseItem(it, actor, defaultTtlDays));
    // Auto-prune already-expired entries so the stored file stays small.
    const now = Date.now();
    const kept = sanitised.filter((it) => !isExpired(it, now));
    const next: AnnouncementList = {
      version: typeof incoming['version'] === 'number' ? (incoming['version'] as number) : 1,
      items: kept,
    };
    const existing = await getFile(ctx.env, ANN_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(ctx.env, ANN_PATH, serialised, `announcements: update by ${actor}`, actor, existing?.sha);
    await writeAudit(ctx.env, {
      actor, action: 'announcements:put', target: ANN_PATH, detail: `items=${next.items.length}`,
    });
    invalidate();
    return ok(ctx.env, ctx.req, { saved: true, count: next.items.length });
  });
};

// Manager-curated rotating banner shown across resident-facing pages.
// GET /banner — public read, gated by FEATURE_DAILY_BANNER.
// PUT /banner — MANAGER / COMMITTEE / DEVELOPER write the full item list.
//
// Each item: { id, text, severity?, href?, expiresAt?, createdAt, createdBy }.
// The frontend rotates active (non-expired) items in a strip and stacks the
// full active list in a right-rail panel.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson, str, optStr, isObj } from '../lib/validate.ts';
import { BadRequest } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { tunable } from '../config/defaults.ts';

const BANNER_PATH = 'config/banner.json';
const MAX_ITEMS = 20;
const VALID_SEVERITY = new Set(['info', 'warn', 'alert']);

interface BannerItem {
  id: string;
  text: string;
  severity: 'info' | 'warn' | 'alert';
  href?: string;
  expiresAt?: string;
  createdAt: string;
  createdBy: string;
}

interface Banner { version: number; items: BannerItem[]; }

const EMPTY: Banner = { version: 1, items: [] };

interface Cache { value: Banner; sha?: string; expiresAt: number; }
let cache: Cache | undefined;
const invalidate = (): void => { cache = undefined; };
export const _resetBannerCacheForTests = (): void => { cache = undefined; };

const loadFromGithub = async (env: Ctx['env']): Promise<{ value: Banner; sha?: string }> => {
  const f = await getFile(env, BANNER_PATH);
  if (!f) return { value: structuredClone(EMPTY) };
  try {
    const parsed = JSON.parse(f.content) as Partial<Banner>;
    return {
      value: {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        items: Array.isArray(parsed.items) ? (parsed.items as BannerItem[]) : [],
      },
      sha: f.sha,
    };
  } catch {
    return { value: structuredClone(EMPTY), sha: f.sha };
  }
};

const loadBanner = async (ctx: Ctx): Promise<Banner> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const fresh = await loadFromGithub(ctx.env);
  const ttl = tunable(ctx.config, 'BANNER_CACHE_SECONDS', 60) * 1000;
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
  return `bnr-${hex}`;
};

const sanitiseItem = (raw: unknown, actor: string, defaultTtlDays: number): BannerItem => {
  if (!isObj(raw)) throw new BadRequest('banner item must be an object');
  const text = str(raw['text'], 'banner.text', { min: 1, max: 240 });
  const sevRaw = optStr(raw['severity'], 'banner.severity', { max: 16 });
  const severity = (sevRaw && VALID_SEVERITY.has(sevRaw)) ? (sevRaw as BannerItem['severity']) : 'info';
  const createdAt = typeof raw['createdAt'] === 'string' ? raw['createdAt'] : new Date().toISOString();
  const out: BannerItem = {
    id: typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : cryptoRandomId(),
    text,
    severity,
    createdAt,
    createdBy: typeof raw['createdBy'] === 'string' && raw['createdBy'] ? raw['createdBy'] : actor,
  };
  const href = optStr(raw['href'], 'banner.href', { max: 500 });
  if (href) out.href = href;
  const exp = optStr(raw['expiresAt'], 'banner.expiresAt', { max: 40 });
  if (exp) {
    const t = Date.parse(exp);
    if (Number.isNaN(t)) throw new BadRequest('banner.expiresAt must be ISO 8601');
    out.expiresAt = new Date(t).toISOString();
  } else if (defaultTtlDays > 0) {
    // Auto-TTL: editor didn't set one, so the notice rolls off after the
    // configured window (DAILY_NOTICE_TTL_DAYS).
    const base = Date.parse(createdAt);
    const ms = (Number.isFinite(base) ? base : Date.now()) + defaultTtlDays * 24 * 60 * 60 * 1000;
    out.expiresAt = new Date(ms).toISOString();
  }
  return out;
};

const isExpired = (it: BannerItem, now: number): boolean => {
  if (!it.expiresAt) return false;
  const t = Date.parse(it.expiresAt);
  if (Number.isNaN(t)) return false;
  return t < now;
};

export const mountBanner = (r: Router): void => {
  r.get('/banner', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: ['FEATURE_DAILY_BANNER'] });
    const b = await loadBanner(ctx);
    const now = Date.now();
    const active = b.items.filter((it) => !isExpired(it, now));
    return ok(ctx.env, ctx.req, { version: b.version, items: active });
  });

  r.put('/banner', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_BANNER'],
      roles: ['MANAGER', 'COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const incoming = (body['banner'] ?? body) as Record<string, unknown>;
    if (!isObj(incoming)) throw new BadRequest('banner must be an object');
    const itemsRaw = Array.isArray(incoming['items']) ? incoming['items'] : [];
    if (itemsRaw.length > MAX_ITEMS) throw new BadRequest(`banner.items supports at most ${MAX_ITEMS}`);
    const actor = ctx.identity!.email;
    const defaultTtlDays = tunable(ctx.config, 'DAILY_NOTICE_TTL_DAYS', 7);
    const sanitised = itemsRaw.map((it) => sanitiseItem(it, actor, defaultTtlDays));
    const now = Date.now();
    const kept = sanitised.filter((it) => !isExpired(it, now));
    const next: Banner = {
      version: typeof incoming['version'] === 'number' ? (incoming['version'] as number) : 1,
      items: kept,
    };
    const existing = await getFile(ctx.env, BANNER_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(ctx.env, BANNER_PATH, serialised, `banner: update by ${actor}`, actor, existing?.sha);
    await writeAudit(ctx.env, {
      actor, action: 'banner:put', target: BANNER_PATH, detail: `items=${next.items.length}`,
    });
    invalidate();
    return ok(ctx.env, ctx.req, { saved: true, count: next.items.length });
  });
};

// In-app notification framework.
// Spec: tsh_requirement.md Â§19.
//
// Storage: single JSON file at config/notifications.json (mirrors the
// reservations.json / announcements.json shape). Global cap keeps the
// file bounded; per-user cap trims the oldest read entries first.
//
// Delivery: in-app only for now. The `channels` field on each entry is
// reserved for future email / WhatsApp adapters (Phase 4b) so the
// emitter surface below does not have to change when we add them.

import type { Env } from '../env.ts';
import type { SiteConfig } from '../config/defaults.ts';
import { tunable } from '../config/defaults.ts';
import { getFile, putFile } from '../github/client.ts';

const PATH = 'config/notifications.json';
export const NOTIFY_FLAG = 'FEATURE_TSH_NOTIFICATIONS';

export const NOTIFY_EVENTS = [
  'reservation-created',
  'reservation-approved',
  'reservation-rejected',
  'reservation-cancelled',
  'reservation-commented',
  'payment-uploaded',
  'payment-verified',
  'payment-rejected',
  'issue-created',
  'issue-assigned',
  'issue-resolved',
  'system',
] as const;
export type NotifyEvent = typeof NOTIFY_EVENTS[number];

export interface Notification {
  id: string;               // NTF-<epoch>-<rand>
  recipient: string;        // email (lowercase)
  event: NotifyEvent;
  title: string;
  body: string;
  link?: string;            // in-site link, e.g. reservations.html?open=RES-...
  createdAt: string;        // ISO
  readAt?: string;          // ISO once read
  actor?: string;           // who triggered it
  channels: ('in-app' | 'email' | 'whatsapp')[];
}

interface Store { version: number; items: Notification[] }

let cache: { value: Store; sha?: string; expiresAt: number } | undefined;

export const _resetNotifyCacheForTests = (): void => { cache = undefined; };

const load = async (env: Env, cfg: SiteConfig): Promise<{ items: Notification[]; sha?: string }> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    const out: { items: Notification[]; sha?: string } = { items: cache.value.items };
    if (cache.sha !== undefined) out.sha = cache.sha;
    return out;
  }
  const ttl = tunable(cfg, 'NOTIFICATIONS_CACHE_SECONDS', 30) * 1000;
  const f = await getFile(env, PATH);
  if (!f) {
    cache = { value: { version: 1, items: [] }, expiresAt: now + ttl };
    return { items: [] };
  }
  try {
    const parsed = JSON.parse(f.content) as { version?: number; items?: Notification[] };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    cache = {
      value: { version: parsed.version ?? 1, items },
      expiresAt: now + ttl,
      ...(f.sha !== undefined ? { sha: f.sha } : {}),
    };
    const out: { items: Notification[]; sha?: string } = { items };
    if (f.sha !== undefined) out.sha = f.sha;
    return out;
  } catch {
    cache = { value: { version: 1, items: [] }, expiresAt: now + ttl };
    return { items: [] };
  }
};

const save = async (env: Env, cfg: SiteConfig, items: Notification[], sha: string | undefined, actor: string, reason: string): Promise<void> => {
  // Global cap: trim from the front (oldest first) once we exceed it,
  // but keep at least the newest 10 unread items per user regardless.
  const globalCap = tunable(cfg, 'NOTIFICATIONS_MAX_ITEMS', 2000);
  const perUserCap = tunable(cfg, 'NOTIFICATIONS_PER_USER_CAP', 200);
  const trimmed = trim(items, globalCap, perUserCap);
  const body = JSON.stringify({ version: 1, items: trimmed }, null, 2) + '\n';
  await putFile(env, PATH, body, `notifications: ${reason} by ${actor}`.slice(0, 72), actor, sha);
  cache = undefined;
};

const trim = (items: Notification[], globalCap: number, perUserCap: number): Notification[] => {
  if (items.length <= globalCap) {
    // still enforce per-user cap
    return applyPerUserCap(items, perUserCap);
  }
  // Prefer to drop read items first, then oldest.
  const sorted = items.slice().sort((a, b) => {
    if (!a.readAt && b.readAt) return 1;
    if (a.readAt && !b.readAt) return -1;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
  return applyPerUserCap(sorted.slice(sorted.length - globalCap), perUserCap);
};

const applyPerUserCap = (items: Notification[], perUserCap: number): Notification[] => {
  const byUser = new Map<string, Notification[]>();
  for (const n of items) {
    const arr = byUser.get(n.recipient) || [];
    arr.push(n);
    byUser.set(n.recipient, arr);
  }
  const keep: Notification[] = [];
  for (const [, arr] of byUser) {
    if (arr.length <= perUserCap) { keep.push(...arr); continue; }
    // Newest first, oldest read items dropped
    arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    keep.push(...arr.slice(0, perUserCap));
  }
  keep.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return keep;
};

// ---- Public API ------------------------------------------------------

let idCounter = 0;
const nextId = (): string => {
  idCounter = (idCounter + 1) % 100000;
  return `NTF-${Date.now().toString(36)}-${idCounter.toString(36)}`;
};

export interface EmitInput {
  recipients: string[];             // emails (case-insensitive; dedup + lowercase)
  event: NotifyEvent;
  title: string;
  body: string;
  link?: string;
  actor?: string;
  channels?: Notification['channels'];
}

/**
 * Emit one notification per recipient. Safe to call from any route; when
 * the feature flag is off this is a no-op so callers do not have to
 * guard themselves.
 */
export const emit = async (env: Env, cfg: SiteConfig, input: EmitInput): Promise<Notification[]> => {
  if (cfg.features[NOTIFY_FLAG] === false) return [];
  const uniq = new Set<string>();
  const recips = input.recipients
    .map((e) => (e || '').toLowerCase().trim())
    .filter((e) => !!e && e.includes('@') && !uniq.has(e) && (uniq.add(e), true));
  if (!recips.length) return [];
  const { items, sha } = await load(env, cfg);
  const nowIso = new Date().toISOString();
  const created: Notification[] = recips.map((r) => {
    const n: Notification = {
      id: nextId(),
      recipient: r,
      event: input.event,
      title: input.title,
      body: input.body,
      createdAt: nowIso,
      channels: input.channels && input.channels.length ? input.channels : ['in-app'],
    };
    if (input.link) n.link = input.link;
    if (input.actor) n.actor = input.actor;
    return n;
  });
  const next = items.concat(created);
  await save(env, cfg, next, sha, input.actor || 'system', input.event);
  return created;
};

export const listFor = async (env: Env, cfg: SiteConfig, email: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> => {
  const { items } = await load(env, cfg);
  const me = (email || '').toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const filtered = items
    .filter((n) => n.recipient === me)
    .filter((n) => !opts.unreadOnly || !n.readAt);
  filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return filtered.slice(0, limit);
};

export const countUnreadFor = async (env: Env, cfg: SiteConfig, email: string): Promise<number> => {
  const { items } = await load(env, cfg);
  const me = (email || '').toLowerCase();
  let n = 0;
  for (const it of items) if (it.recipient === me && !it.readAt) n++;
  return n;
};

export const markOneRead = async (env: Env, cfg: SiteConfig, id: string, email: string, actor: string): Promise<Notification | undefined> => {
  const { items, sha } = await load(env, cfg);
  const me = (email || '').toLowerCase();
  const idx = items.findIndex((n) => n.id === id && n.recipient === me);
  if (idx === -1) return undefined;
  if (items[idx]!.readAt) return items[idx]!;
  items[idx] = { ...items[idx]!, readAt: new Date().toISOString() };
  await save(env, cfg, items, sha, actor, 'mark-read');
  return items[idx]!;
};

export const markAllRead = async (env: Env, cfg: SiteConfig, email: string, actor: string): Promise<number> => {
  const { items, sha } = await load(env, cfg);
  const me = (email || '').toLowerCase();
  const nowIso = new Date().toISOString();
  let changed = 0;
  const next = items.map((n) => {
    if (n.recipient !== me || n.readAt) return n;
    changed++;
    return { ...n, readAt: nowIso };
  });
  if (changed) await save(env, cfg, next, sha, actor, 'mark-all-read');
  return changed;
};

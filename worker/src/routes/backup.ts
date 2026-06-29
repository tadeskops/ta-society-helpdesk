// Backup endpoints + cron handler. Spec: see tsh_requirement.md §11 (backups).
//
// POST /reports/backup       — committee+ (or anyone signed in for self-service)
//   Body: { snapshot: object, pdfB64?: string, fileName?: string, source?: string }
//   Stores the JSON snapshot (and optional PDF) under backups/YYYY-MM-DD/HHMM-<source>.{json,pdf}
//
// GET  /reports/backups       — committee+; returns metadata for last 50 saved snapshots.
//
// scheduledBackup(env)         — invoked by the Worker's scheduled() trigger
//   when the current IST time matches a slot in config.system.backupTimes.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import type { Env } from '../env.ts';
import { ok } from '../lib/envelope.ts';
import { BadRequest } from '../lib/errors.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson } from '../lib/validate.ts';
import { putFile, putBinaryB64, listIssues, getFile } from '../github/client.ts';
import { toPublicIssue } from '../lib/issue.ts';
import { loadConfig } from '../config/loader.ts';
import { log } from '../lib/log.ts';

const IST_OFFSET_MS = 330 * 60 * 1000;

const istParts = (date: Date) => {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const yyyy = String(ist.getUTCFullYear()).padStart(4, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mn = String(ist.getUTCMinutes()).padStart(2, '0');
  return { yyyy, mm, dd, hh, mn, ymd: `${yyyy}-${mm}-${dd}`, hhmn: `${hh}${mn}` };
};

const sanitizeSource = (s: unknown): string => {
  const raw = String(s ?? 'manual').toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 32) || 'manual';
};

interface BackupBody {
  snapshot?: unknown;
  pdfB64?: string;
  fileName?: string;
  source?: string;
}

export const mountBackup = (r: Router): void => {
  r.post('/reports/backup', async (ctx: Ctx) => {
    // Anyone signed in may save their own export — keeps the "Export +
    // store" UX one-click. Anonymous calls are rejected so we always have
    // an authoring email on the commit.
    ensureAllowed(ctx, { requireIdentity: true });

    const body = await parseJson<BackupBody>(ctx.req);
    if (!body || typeof body !== 'object') throw new BadRequest('expected JSON body');
    if (!body.snapshot || typeof body.snapshot !== 'object') {
      throw new BadRequest('snapshot must be an object');
    }

    const source = sanitizeSource(body.source);
    const { ymd, hhmn } = istParts(new Date());
    const base = `backups/${ymd}/${hhmn}-${source}`;
    const author = ctx.identity?.email ?? 'tsh-worker@users.noreply.github.com';

    const jsonPath = `${base}.json`;
    const jsonBody = JSON.stringify(body.snapshot, null, 2);
    await putFile(ctx.env, jsonPath, jsonBody, `backup: ${ymd} ${hhmn} (${source}) snapshot`, author);

    let pdfPath: string | undefined;
    if (body.pdfB64) {
      const cleaned = body.pdfB64.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]+=*$/.test(cleaned)) throw new BadRequest('pdfB64 must be base64');
      if (cleaned.length > 12_000_000) throw new BadRequest('pdf too large (limit ~9 MB)');
      pdfPath = `${base}.pdf`;
      await putBinaryB64(ctx.env, pdfPath, cleaned, `backup: ${ymd} ${hhmn} (${source}) pdf`, author);
    }

    log.info(ctx.env, 'backup_saved', { jsonPath, pdfPath, source, by: author });
    return ok(ctx.env, ctx.req, { jsonPath, pdfPath, source });
  });

  r.get('/reports/backups', async (ctx: Ctx) => {
    ensureAllowed(ctx, { roles: ['COMMITTEE', 'DEVELOPER'], requireIdentity: true });
    const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? '50')));
    const entries = await listRecentBackups(ctx.env, limit);
    return ok(ctx.env, ctx.req, { entries, count: entries.length });
  });
};

interface BackupEntry {
  path: string;
  date: string;
  time: string;
  source: string;
  size: number;
  isPdf: boolean;
  url: string;
}

const listRecentBackups = async (env: Env, limit: number): Promise<BackupEntry[]> => {
  // GitHub contents-list is shallow — walk by day directories. To stay
  // cheap, peek at the last 7 days only.
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const p = istParts(d);
    days.push(p.ymd);
  }
  const out: BackupEntry[] = [];
  for (const day of days) {
    const listing = await ghDirList(env, `backups/${day}`).catch(() => [] as Array<{ name: string; size: number; download_url?: string; path: string }>);
    for (const entry of listing) {
      const m = entry.name.match(/^(\d{4})-([a-z0-9_-]+)\.(json|pdf)$/i);
      if (!m) continue;
      out.push({
        path: entry.path,
        date: day,
        time: `${m[1].slice(0, 2)}:${m[1].slice(2)}`,
        source: m[2],
        size: entry.size,
        isPdf: m[3].toLowerCase() === 'pdf',
        url: entry.download_url ?? `https://github.com/${env.GH_OWNER}/${env.GH_REPO}/blob/${env.GH_BRANCH}/${entry.path}`,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
};

const ghDirList = async (env: Env, path: string): Promise<Array<{ name: string; size: number; download_url?: string; path: string }>> => {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${encodeURI(path)}?ref=${env.GH_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tsh-worker',
    },
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`github list ${path} -> ${res.status}`);
  return (await res.json()) as Array<{ name: string; size: number; download_url?: string; path: string }>;
};

// ------------------------------------------------------------ cron handler

/**
 * Called from Worker's `scheduled` trigger. The cron runs every hour
 * (see wrangler.toml [triggers]); we only emit a backup when the
 * current IST HH:MM is at or just past one of the slots in
 * config.system.backupTimes.
 */
export const scheduledBackup = async (env: Env, scheduledTime: number): Promise<{ skipped: true; reason: string } | { skipped: false; path: string }> => {
  const { config } = await loadConfig(env);
  const times = (config.system as unknown as { backupTimes?: string[] })?.backupTimes ?? ['08:00', '14:00', '20:00'];
  const enabled = (config.system as unknown as { backupEnabled?: boolean })?.backupEnabled ?? true;
  if (!enabled) return { skipped: true, reason: 'backup disabled in config' };

  const now = new Date(scheduledTime || Date.now());
  const { ymd, hh, mn, hhmn } = istParts(now);
  const currentHM = `${hh}:${mn}`;
  // Match either exact HH:MM or the same hour (cron fires on the hour;
  // the slot may say e.g. "08:00" while the trigger fires at 08:00).
  const match = times.find((t) => t === currentHM || t.slice(0, 2) === hh);
  if (!match) return { skipped: true, reason: `no slot matches IST ${currentHM}` };

  const path = `backups/${ymd}/${hhmn}-cron.json`;
  // Idempotent: don't re-write if today's slot already exists.
  const existing = await getFile(env, path).catch(() => undefined);
  if (existing) {
    log.info(env, 'backup_cron_skipped', { path, reason: 'already exists' });
    return { skipped: true, reason: 'already exists' };
  }

  const issues = await listIssues(env, { state: 'all', labels: ['daily'], per_page: 200 });
  const items = issues.map((i) => toPublicIssue(i, { includePhotos: true }));
  const snapshot = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'cron@tsh-worker',
    slot: match,
    title: 'Society Help Desk — Scheduled Snapshot',
    source: 'cron',
    itemCount: items.length,
    items,
  };
  await putFile(
    env,
    path,
    JSON.stringify(snapshot, null, 2),
    `backup: cron ${ymd} ${hhmn} (slot ${match})`,
    'tsh-worker@users.noreply.github.com',
  );
  log.info(env, 'backup_cron_saved', { path, count: items.length, slot: match });
  return { skipped: false, path };
};

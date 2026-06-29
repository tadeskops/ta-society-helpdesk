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
import { putFile, putBinaryB64, listIssues, getFile, getJson } from '../github/client.ts';
import { toPublicIssue, type PublicIssue } from '../lib/issue.ts';
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

interface MonthlyArchive {
  archivedAt: string;
  month: string;
  itemCount: number;
  items: PublicIssue[];
}

const monthRangeList = (from: string, to: string): string[] => {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
};

const prevMonth = (ym: string): string => {
  let [y, m] = ym.split('-').map(Number);
  m--; if (m < 1) { m = 12; y--; }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
};

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
    let latestPath: string | undefined;
    let monthlyPath: string | undefined;
    if (body.pdfB64) {
      const cleaned = body.pdfB64.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]+=*$/.test(cleaned)) throw new BadRequest('pdfB64 must be base64');
      if (cleaned.length > 12_000_000) throw new BadRequest('pdf too large (limit ~9 MB)');
      pdfPath = `${base}.pdf`;
      await putBinaryB64(ctx.env, pdfPath, cleaned, `backup: ${ymd} ${hhmn} (${source}) pdf`, author);

      // Always-latest copy + current-month frozen copy. The 1st of each
      // month, archiveMonthly() snapshots the previous month's latest
      // into TSH_Report_<MMYY>.pdf so that file represents that month's
      // final state even after the next month's downloads start.
      const istNow = istParts(new Date());
      const mmyy = `${istNow.mm}${istNow.yyyy.slice(2)}`;
      latestPath = 'backups/TSH_Report.pdf';
      monthlyPath = `backups/TSH_Report_${mmyy}.pdf`;
      await putBinaryB64(ctx.env, latestPath,  cleaned, `backup: latest TSH_Report.pdf (${source} @ ${ymd} ${hhmn})`, author);
      await putBinaryB64(ctx.env, monthlyPath, cleaned, `backup: monthly TSH_Report_${mmyy}.pdf (${source} @ ${ymd} ${hhmn})`, author);
    }

    log.info(ctx.env, 'backup_saved', { jsonPath, pdfPath, latestPath, monthlyPath, source, by: author });
    return ok(ctx.env, ctx.req, { jsonPath, pdfPath, latestPath, monthlyPath, source });
  });

  r.get('/reports/backups', async (ctx: Ctx) => {
    ensureAllowed(ctx, { roles: ['COMMITTEE', 'DEVELOPER'], requireIdentity: true });
    const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? '50')));
    const entries = await listRecentBackups(ctx.env, limit);
    return ok(ctx.env, ctx.req, { entries, count: entries.length });
  });

  // Monthly archive consumer — managers and above can pull an aggregated
  // window of issues for PDF export. Reads from archive/YYYY-MM.json when
  // available; falls back to a live filter for the current (or any
  // un-archived) month.
  r.get('/reports/monthly', async (ctx: Ctx) => {
    ensureAllowed(ctx, { roles: ['MANAGER', 'COMMITTEE', 'DEVELOPER'], requireIdentity: true });
    const from = (ctx.url.searchParams.get('from') ?? '').trim();
    const to = (ctx.url.searchParams.get('to') ?? from).trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(from)) throw new BadRequest('from must be YYYY-MM');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(to)) throw new BadRequest('to must be YYYY-MM');
    if (from > to) throw new BadRequest('from must be <= to');
    const months = monthRangeList(from, to);
    if (months.length > 24) throw new BadRequest('range too wide (max 24 months)');

    const currentMonth = `${istParts(new Date()).yyyy}-${istParts(new Date()).mm}`;
    let liveItems: PublicIssue[] | undefined;
    const out: PublicIssue[] = [];
    const sourceByMonth: Record<string, 'archive' | 'live'> = {};

    for (const ym of months) {
      let monthItems: PublicIssue[] | undefined;
      if (ym !== currentMonth) {
        const snap = await getJson<MonthlyArchive>(ctx.env, `archive/${ym}.json`).catch(() => undefined);
        if (snap && Array.isArray(snap.items)) {
          monthItems = snap.items;
          sourceByMonth[ym] = 'archive';
        }
      }
      if (!monthItems) {
        if (!liveItems) {
          const issues = await listIssues(ctx.env, { state: 'all', labels: ['daily'], per_page: 200 });
          liveItems = issues.map((i) => toPublicIssue(i, { includePhotos: true }));
        }
        monthItems = liveItems.filter((p) => (p.createdAt || '').slice(0, 7) === ym);
        sourceByMonth[ym] = 'live';
      }
      out.push(...monthItems);
    }
    return ok(ctx.env, ctx.req, { months, count: out.length, sourceByMonth, items: out });
  });

  r.get('/reports/archive', async (ctx: Ctx) => {
    ensureAllowed(ctx, { roles: ['MANAGER', 'COMMITTEE', 'DEVELOPER'], requireIdentity: true });
    const listing = await ghDirList(ctx.env, 'archive').catch(() => [] as Array<{ name: string; size: number; download_url?: string; path: string }>);
    const entries = listing
      .filter((e) => /^\d{4}-\d{2}\.json$/.test(e.name))
      .map((e) => ({
        month: e.name.replace(/\.json$/, ''),
        path: e.path,
        size: e.size,
        url: e.download_url ?? `https://github.com/${ctx.env.GH_OWNER}/${ctx.env.GH_REPO}/blob/${ctx.env.GH_BRANCH}/${e.path}`,
      }))
      .sort((a, b) => (a.month < b.month ? 1 : -1));
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

/**
 * Monthly archive — on the 1st of each month (IST 02:xx) write a
 * consolidated snapshot of the *previous* month to archive/YYYY-MM.json.
 * Idempotent: skips if the file already exists. Called from scheduled().
 */
export const archiveMonthly = async (
  env: Env,
  scheduledTime: number,
): Promise<{ skipped: true; reason: string } | { skipped: false; path: string; month: string; count: number }> => {
  const now = new Date(scheduledTime || Date.now());
  const { yyyy, mm, dd, hh } = istParts(now);
  if (dd !== '01') return { skipped: true, reason: `not 1st of month (got dd=${dd})` };
  if (hh !== '02') return { skipped: true, reason: `not 02:xx IST (got hh=${hh})` };

  const target = prevMonth(`${yyyy}-${mm}`);
  const path = `archive/${target}.json`;
  const existing = await getFile(env, path).catch(() => undefined);
  if (existing) {
    log.info(env, 'archive_monthly_skipped', { path, reason: 'already exists' });
    return { skipped: true, reason: 'already archived' };
  }

  const issues = await listIssues(env, { state: 'all', labels: ['daily'], per_page: 200 });
  const items = issues
    .map((i) => toPublicIssue(i, { includePhotos: true }))
    .filter((p) => (p.createdAt || '').slice(0, 7) === target);
  const snapshot: MonthlyArchive = {
    archivedAt: new Date().toISOString(),
    month: target,
    itemCount: items.length,
    items,
  };
  await putFile(
    env,
    path,
    JSON.stringify(snapshot, null, 2),
    `archive: monthly snapshot for ${target}`,
    'tsh-worker@users.noreply.github.com',
  );
  log.info(env, 'archive_monthly_saved', { path, count: items.length, month: target });
  return { skipped: false, path, month: target, count: items.length };
};

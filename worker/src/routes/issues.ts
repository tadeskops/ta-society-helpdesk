// All write paths against GitHub Issues. Spec: tsh_requirement.md §5, §6, §7.
//
// Endpoints in this file:
//   POST   /issues                  create (JWT + Turnstile)
//   GET    /issues                  manager+/list (filterable)
//   PATCH  /issues/:id              status transition (manager+)
//   POST   /issues/:id/photos       attach photos (manager+)
//   POST   /issues/:id/redact       edit body (committee+)
//   POST   /issues/:id/delete       soft-delete (committee+)
//   POST   /issues/bulk-archive     retention sweep (committee+)

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { BadRequest, NotFound, Forbidden, FeatureDisabled, Unauthorized } from '../lib/errors.ts';
import {
  createIssue, listIssues, getIssue, updateIssue, lockIssue, commentOnIssue, putBinaryB64,
  type GhIssue,
} from '../github/client.ts';
import {
  STATUSES, SEVERITIES, type Status, type Severity,
  formatTitle, padId, buildBody, buildInitialLabels, setStatus, setPrefixed,
  statusOf, isDeleted, isAllowedTransition, auditComment,
  toPublicIssue, tombstoneBody, writeResolution, appendPhotos,
  photoRawUrl, photoRepoPath,
  parseBody, towerOf, categoryFromLabels, severityOf,
} from '../lib/issue.ts';
import { isFeatureOn, tunable } from '../config/defaults.ts';
import { parseJson, str, optStr, optBool, optNum, oneOf, normalisePhone, isObj } from '../lib/validate.ts';
import { verifyTurnstile } from '../lib/turnstile.ts';
import { writeAudit } from '../lib/audit.ts';

// ---- In-memory submission throttle (per Worker isolate) ------------------
// Soft cap. Cloudflare can spawn multiple isolates so the cap is approximate
// across the fleet — adequate as an abuse brake for a small society app.
// Promote to KV/Durable Object if you need a strict global limit.
interface Throttle { last: number; daily: { date: string; count: number } }
const throttle = new Map<string, Throttle>();

/** Test-only escape hatch. Not used at runtime; the throttle map is otherwise
 *  module-private. Call from a test `beforeEach` to keep submissions isolated. */
export const _resetThrottleForTests = (): void => { throttle.clear(); };

const dayUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const checkSubmitThrottle = (ctx: Ctx, key: string): void => {
  const now = Date.now();
  const cooldownS = tunable(ctx.config, 'DAILY_RATE_LIMIT_SECONDS', 20);
  const dailyMax  = tunable(ctx.config, 'DAILY_DAILY_LIMIT', 20);
  const today = dayUtc(now);
  const entry = throttle.get(key) ?? { last: 0, daily: { date: today, count: 0 } };
  if (entry.daily.date !== today) entry.daily = { date: today, count: 0 };
  const elapsedS = (now - entry.last) / 1000;
  if (entry.last && elapsedS < cooldownS) {
    const wait = Math.ceil(cooldownS - elapsedS);
    throw new BadRequest(`Please wait ${wait}s before submitting another issue (DAILY_RATE_LIMIT_SECONDS=${cooldownS}).`);
  }
  if (entry.daily.count >= dailyMax) {
    throw new BadRequest(`Daily submission limit reached (DAILY_DAILY_LIMIT=${dailyMax}). Try again tomorrow.`);
  }
  entry.last = now;
  entry.daily.count++;
  throttle.set(key, entry);
};

// ---- Photo helpers --------------------------------------------------------

interface PhotoIn { dataUrl: string; name?: string | undefined }

const DATA_URL_RE = /^data:(image\/(?:jpe?g|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

const extOf = (mime: string): string => {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png')  return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif')  return 'gif';
  return 'bin';
};

const parsePhotos = (raw: unknown, field: string): PhotoIn[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequest(`${field} must be an array`);
  const out: PhotoIn[] = [];
  for (const p of raw) {
    if (!isObj(p)) throw new BadRequest(`${field}[] entries must be objects`);
    const dataUrl = str(p['dataUrl'], `${field}[].dataUrl`, { min: 30, max: 10_000_000 });
    const name = optStr(p['name'], `${field}[].name`, { max: 100 });
    out.push({ dataUrl, ...(name !== undefined ? { name } : {}) });
  }
  return out;
};

/**
 * Decode + validate + upload photos. Writes to photos/DLY-<n>/NN.<ext>
 * starting from `startIdx`. Returns the raw URLs of uploaded files.
 */
const uploadPhotos = async (
  ctx: Ctx,
  issueNum: number,
  photos: PhotoIn[],
  startIdx: number,
  actor: string,
): Promise<string[]> => {
  const maxBytes = tunable(ctx.config, 'DAILY_PHOTO_MAX_BYTES', 5_242_880);
  const urls: string[] = [];
  let idx = startIdx;
  for (const p of photos) {
    const m = DATA_URL_RE.exec(p.dataUrl);
    if (!m) throw new BadRequest(`photo ${idx}: dataUrl must be image/jpeg|png|webp|gif base64`);
    const mime = m[1]!;
    const b64 = m[2]!;
    // base64 byte size: floor(len * 3/4) minus padding
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const byteSize = Math.floor((b64.length * 3) / 4) - padding;
    if (byteSize > maxBytes) {
      throw new BadRequest(`photo ${idx}: ${byteSize} bytes exceeds DAILY_PHOTO_MAX_BYTES (${maxBytes})`);
    }
    const fileName = `${String(idx).padStart(2, '0')}.${extOf(mime)}`;
    await putBinaryB64(
      ctx.env,
      photoRepoPath(issueNum, fileName),
      b64,
      `${padId(issueNum)} photo ${fileName} by ${actor}`,
      actor,
    );
    urls.push(photoRawUrl(ctx.env, issueNum, fileName));
    idx++;
  }
  return urls;
};

// ---- POST /issues (create) ------------------------------------------------

const validateCreateInput = (ctx: Ctx, raw: Record<string, unknown>) => {
  const towers = ctx.config.lists.towers;
  const cats = ctx.config.lists.categories;
  const tower = oneOf(raw['tower'], 'tower', towers);
  const category = oneOf(raw['category'], 'category', cats);
  const subList = ctx.config.lists.subCategories[category] ?? ['Other'];
  const subCategory = oneOf(raw['subCategory'], 'subCategory', subList);
  const locMax = tunable(ctx.config, 'DAILY_LOCATION_MAX', 120);
  const descMin = tunable(ctx.config, 'DAILY_DESC_MIN', 5);
  const descMax = tunable(ctx.config, 'DAILY_DESC_MAX', 2000);
  const location = str(raw['location'], 'location', { min: 1, max: locMax });
  const description = str(raw['description'], 'description', { min: descMin, max: descMax });
  const reporterName  = optStr(raw['reporterName'],  'reporterName',  { max: 80 });
  const reporterFlat  = optStr(raw['reporterFlat'],  'reporterFlat',  { max: 30 });
  const phoneRaw      = optStr(raw['reporterPhone'], 'reporterPhone', { max: 30 });
  const reporterPhone = phoneRaw ? (normalisePhone(phoneRaw) || undefined) : undefined;
  const notifyWhatsapp = optBool(raw['notifyWhatsapp'], 'notifyWhatsapp');
  const photos = parsePhotos(raw['photos'], 'photos');
  const turnstileToken = optStr(raw['turnstileToken'], 'turnstileToken', { max: 4000 });
  return { tower, category, subCategory, location, description, reporterName, reporterFlat, reporterPhone, notifyWhatsapp, photos, turnstileToken };
};

const mountCreate = (r: Router): void => {
  r.post('/issues', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_TRACK'],
      // requireIdentity is conditional: depends on FEATURE_DAILY_ANONYMOUS_SUBMIT.
    });
    if (!isFeatureOn(ctx.config, 'FEATURE_DAILY_ANONYMOUS_SUBMIT')) {
      if (!ctx.identity) throw new Unauthorized('Sign in with Google to submit a report');
      if (!ctx.identity.emailVerified) throw new Unauthorized('Google email is not verified');
    }

    const raw = await parseJson<Record<string, unknown>>(ctx.req);
    const input = validateCreateInput(ctx, raw);

    if (isFeatureOn(ctx.config, 'FEATURE_DAILY_TURNSTILE')) {
      await verifyTurnstile(ctx.env, input.turnstileToken, ctx.ip);
    }

    // Per-submitter throttle. Key on identity email when signed in,
    // otherwise the source IP — keeps anonymous flow rate-limited too.
    const throttleKey = ctx.identity?.email ?? `ip:${ctx.ip || 'unknown'}`;
    checkSubmitThrottle(ctx, throttleKey);

    if (input.photos.length && !isFeatureOn(ctx.config, 'FEATURE_DAILY_PHOTO_UPLOAD')) {
      throw new FeatureDisabled('FEATURE_DAILY_PHOTO_UPLOAD');
    }
    const maxPhotos = tunable(ctx.config, 'DAILY_PHOTO_MAX_PER_ISSUE', 6);
    if (input.photos.length > maxPhotos) {
      throw new BadRequest(`Up to ${maxPhotos} photos per issue`);
    }

    // 1. Create issue with provisional body (we don't yet know the issue number for photo paths)
    const provisionalBody = buildBody({
      tower: input.tower,
      location: input.location,
      category: input.category,
      subCategory: input.subCategory,
      description: input.description,
      ...(input.reporterName  !== undefined ? { reporterName:  input.reporterName  } : {}),
      ...(input.reporterFlat  !== undefined ? { reporterFlat:  input.reporterFlat  } : {}),
      ...(input.reporterPhone !== undefined ? { reporterPhone: input.reporterPhone } : {}),
      ...(input.notifyWhatsapp !== undefined ? { notifyWhatsapp: input.notifyWhatsapp } : {}),
    });
    const labels = buildInitialLabels(input.tower, input.category);
    const actorEmail = ctx.identity?.email ?? 'anonymous@resident.local';

    const created = await createIssue(ctx.env, {
      title: formatTitle(0, input.category, input.tower), // patched right after
      body: provisionalBody,
      labels,
    });

    // 2. Patch title with correct DLY-<n>
    const finalTitle = formatTitle(created.number, input.category, input.tower);
    let updated = await updateIssue(ctx.env, created.number, { title: finalTitle });

    // 3. Upload photos and patch body if any
    if (input.photos.length) {
      const urls = await uploadPhotos(ctx, created.number, input.photos, 1, actorEmail);
      const nextBody = appendPhotos(updated.body, urls);
      updated = await updateIssue(ctx.env, created.number, { body: nextBody });
    }

    return ok(ctx.env, ctx.req, {
      id: padId(created.number),
      number: created.number,
      url: updated.html_url,
    }, 201);
  });
};

// ---- GET /issues (manager+ list) -----------------------------------------

const mountList = (r: Router): void => {
  r.get('/issues', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_TRACK'],
      roles: ['MANAGER', 'COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const statusFilter = ctx.url.searchParams.get('status');
    const towerFilter  = ctx.url.searchParams.get('tower');
    const labels = ['daily'];
    if (statusFilter && (STATUSES as readonly string[]).includes(statusFilter)) labels.push(statusFilter);
    if (towerFilter) labels.push(`tower:${towerFilter}`);

    const issues = await listIssues(ctx.env, { state: 'all', labels, per_page: 100 });
    const showDemo = isFeatureOn(ctx.config, 'FEATURE_DAILY_SHOW_DEMO_ISSUES');
    // Privileged callers see the full body; we still hide deleted. We also
    // parse the body once on the server so the dashboard UI can render tower,
    // category, description and photos directly without re-parsing markdown
    // on the client.
    const items = issues
      .filter((i) => !isDeleted(i))
      .filter((i) => showDemo || !i.labels.some((l) => l.name === 'seed:demo'))
      .map((i) => {
        const parsed = parseBody(i.body ?? '');
        const tower = parsed.reported.tower ?? towerOf(i.labels);
        const category = parsed.reported.category ?? categoryFromLabels(i.labels);
        const sev = severityOf(i.labels);
        return {
          id: padId(i.number),
          number: i.number,
          title: i.title,
          body: i.body,
          labels: i.labels.map((l) => l.name),
          status: statusOf(i.labels) ?? 'unknown',
          url: i.html_url,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
          locked: i.locked,
          ...(tower ? { tower } : {}),
          ...(category ? { category } : {}),
          ...(sev ? { severity: sev } : {}),
          description: parsed.description,
          photos: parsed.photoUrls,
        };
      });
    return ok(ctx.env, ctx.req, { items, count: items.length });
  });
};

// ---- PATCH /issues/:id (status transition) -------------------------------

const parseIssueParam = (params: Record<string, string>): number => {
  const raw = (params['id'] ?? '').toUpperCase();
  const m = /^(?:DLY-)?0*(\d+)$/.exec(raw);
  if (!m) throw new BadRequest('id must look like DLY-00042 or 42');
  return Number(m[1]);
};

const mountPatch = (r: Router): void => {
  r.patch('/issues/:id', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_TRACK'],
      roles: ['MANAGER', 'COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const num = parseIssueParam(params);
    const issue = await getIssue(ctx.env, num);
    if (!issue || isDeleted(issue)) throw new NotFound(`No issue ${padId(num)}`);

    const raw = await parseJson<Record<string, unknown>>(ctx.req);
    const to = oneOf(raw['to'], 'to', STATUSES.filter((s) => s !== 'deleted'));
    const from = statusOf(issue.labels) ?? 'new';
    if (!isAllowedTransition(from, to as Status)) {
      throw new Forbidden(`Forbidden transition: ${from} → ${to}`);
    }
    const sev = optStr(raw['severity'], 'severity') as Severity | undefined;
    if (sev !== undefined && !(SEVERITIES as readonly string[]).includes(sev)) {
      throw new BadRequest(`severity must be one of: ${SEVERITIES.join(', ')}`);
    }
    const notes = optStr(raw['notes'], 'notes', { max: 2000 });
    const resolutionNotes = optStr(raw['resolutionNotes'], 'resolutionNotes', { max: 4000 });
    const cost = optNum(raw['cost'], 'cost', { min: 0 });
    if (cost !== undefined && !isFeatureOn(ctx.config, 'FEATURE_DAILY_COST_FIELD')) {
      throw new FeatureDisabled('FEATURE_DAILY_COST_FIELD');
    }

    let labels = setStatus(issue.labels, to as Status);
    if (sev) labels = setPrefixed(labels.map((n) => ({ name: n })), 'sev', sev);

    let body = issue.body;
    if (to === 'resolved') {
      if (!resolutionNotes) throw new BadRequest('resolutionNotes required when transitioning to resolved');
      body = writeResolution(body, ctx.identity!.email, resolutionNotes, cost);
    }

    const actor = ctx.identity!.email;
    const updated = await updateIssue(ctx.env, num, {
      labels,
      body,
      // Close GitHub Issue when terminal status; reopen on reactivation.
      state: (to === 'resolved' || to === 'rejected') ? 'closed' : 'open',
    });
    await commentOnIssue(ctx.env, num, auditComment(from, to as Status, actor, notes));
    return ok(ctx.env, ctx.req, {
      id: padId(num),
      from,
      to,
      status: to,
      url: updated.html_url,
    });
  });
};

// ---- POST /issues/:id/photos ---------------------------------------------

const mountPhotos = (r: Router): void => {
  r.post('/issues/:id/photos', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_TRACK', 'FEATURE_DAILY_PHOTO_UPLOAD'],
      roles: ['MANAGER', 'COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const num = parseIssueParam(params);
    const issue = await getIssue(ctx.env, num);
    if (!issue || isDeleted(issue)) throw new NotFound(`No issue ${padId(num)}`);

    const raw = await parseJson<Record<string, unknown>>(ctx.req);
    const photos = parsePhotos(raw['photos'], 'photos');
    if (!photos.length) throw new BadRequest('photos must be a non-empty array');

    const maxPhotos = tunable(ctx.config, 'DAILY_PHOTO_MAX_PER_ISSUE', 6);
    const existing = (issue.body.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length;
    if (existing + photos.length > maxPhotos) {
      throw new BadRequest(`Issue would have ${existing + photos.length} photos; max ${maxPhotos}`);
    }
    const actor = ctx.identity!.email;
    const urls = await uploadPhotos(ctx, num, photos, existing + 1, actor);
    const nextBody = appendPhotos(issue.body, urls);
    await updateIssue(ctx.env, num, { body: nextBody });
    return ok(ctx.env, ctx.req, { id: padId(num), added: urls.length, urls });
  });
};

// ---- POST /issues/:id/redact ---------------------------------------------

const mountRedact = (r: Router): void => {
  r.post('/issues/:id/redact', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_TRACK'],
      roles: ['COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const num = parseIssueParam(params);
    const issue = await getIssue(ctx.env, num);
    if (!issue || isDeleted(issue)) throw new NotFound(`No issue ${padId(num)}`);

    const raw = await parseJson<Record<string, unknown>>(ctx.req);
    const body = str(raw['body'], 'body', { min: 10, max: 20_000 });
    const reason = optStr(raw['reason'], 'reason', { max: 500 });
    const actor = ctx.identity!.email;

    await updateIssue(ctx.env, num, { body });
    await commentOnIssue(ctx.env, num, [
      '**Body redacted**',
      `- By: ${actor}`,
      `- At: ${new Date().toISOString()}`,
      ...(reason ? [`- Reason: ${reason}`] : []),
    ].join('\n'));
    await writeAudit(ctx.env, {
      actor,
      action: 'issue:redact',
      target: padId(num),
      ...(reason ? { detail: reason } : {}),
    });
    return ok(ctx.env, ctx.req, { id: padId(num), redacted: true });
  });
};

// ---- POST /issues/:id/delete ---------------------------------------------

const softDelete = async (ctx: Ctx, issue: GhIssue, actor: string, reason?: string): Promise<void> => {
  const newLabels = Array.from(new Set([...issue.labels.map((l) => l.name).filter((n) => !(STATUSES as readonly string[]).includes(n)), 'deleted']));
  await updateIssue(ctx.env, issue.number, {
    labels: newLabels,
    body: tombstoneBody(actor),
    state: 'closed',
  });
  try { await lockIssue(ctx.env, issue.number, 'resolved'); } catch { /* idempotent */ }
  await writeAudit(ctx.env, {
    actor,
    action: 'issue:delete',
    target: padId(issue.number),
    ...(reason ? { detail: reason } : {}),
  });
};

const mountDelete = (r: Router): void => {
  r.post('/issues/:id/delete', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_TRACK'],
      roles: ['COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const num = parseIssueParam(params);
    const issue = await getIssue(ctx.env, num);
    if (!issue) throw new NotFound(`No issue ${padId(num)}`);
    if (isDeleted(issue)) return ok(ctx.env, ctx.req, { id: padId(num), deleted: true, alreadyDeleted: true });

    const raw = await parseJson<Record<string, unknown>>(ctx.req).catch(() => ({} as Record<string, unknown>));
    const reason = optStr(raw['reason'], 'reason', { max: 500 });
    const actor = ctx.identity!.email;
    await softDelete(ctx, issue, actor, reason);
    return ok(ctx.env, ctx.req, { id: padId(num), deleted: true });
  });
};

// ---- POST /issues/bulk-archive -------------------------------------------

const mountBulkArchive = (r: Router): void => {
  r.post('/issues/bulk-archive', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_TRACK'],
      roles: ['COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const days = tunable(ctx.config, 'DAILY_ARCHIVE_AFTER_DAYS', 90);
    const cutoff = Date.now() - days * 86_400_000;
    const candidates = await listIssues(ctx.env, { state: 'closed', labels: ['daily'], per_page: 100 });
    const actor = ctx.identity!.email;
    const archived: string[] = [];

    for (const issue of candidates) {
      if (isDeleted(issue)) continue;
      const s = statusOf(issue.labels);
      if (s !== 'resolved' && s !== 'rejected') continue;
      if (new Date(issue.updated_at).getTime() > cutoff) continue;
      await softDelete(ctx, issue, actor, `bulk-archive after ${days}d`);
      archived.push(padId(issue.number));
    }
    return ok(ctx.env, ctx.req, { archived, count: archived.length, cutoffDays: days });
  });
};

// ---- Public export -------------------------------------------------------

export const mountIssues = (r: Router): void => {
  mountCreate(r);
  mountList(r);
  mountPatch(r);
  mountPhotos(r);
  mountRedact(r);
  mountDelete(r);
  mountBulkArchive(r);
};

// re-export so other modules can hit toPublicIssue without circular imports
export { toPublicIssue };

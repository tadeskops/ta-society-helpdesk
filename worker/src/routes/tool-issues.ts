// Tool-issue reports (in-app "Report site bug" button in the footer).
//
// Purpose:
//   Residents can report a website bug from the footer. The report is
//   filed straight to GitHub Issues (no mailto, no browser bounce), but
//   using a dedicated `tool-issue` label so it is INVISIBLE to every
//   resident-facing issue listing endpoint. Those endpoints all filter
//   on the `daily` label (see routes/issues.ts and routes/public.ts),
//   which we deliberately never apply here.
//
// Endpoints:
//   POST /tool-issues     signed-in create (JWT required, throttled)
//
// Why a separate route file (and not `/issues?kind=tool`):
//   - Zero risk of pollution: helpdesk listings can't accidentally
//     pick these up because we omit the `daily` label entirely.
//   - Zero coupling to the tower/category taxonomy — a website bug has
//     no `tower`, no `category`, no ticket id.
//   - Independent throttle and validation so tool-report spam can't
//     starve the resident submit endpoint.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { BadRequest, Unauthorized, UpstreamError } from '../lib/errors.ts';
import { createIssue, updateIssue, putBinaryB64 } from '../github/client.ts';
import { parseJson, str, optStr, oneOf as _oneOf, isObj } from '../lib/validate.ts';

// Dedicated label so any list that filters by it can find tool reports
// and every resident-facing list (which requires `daily`) ignores them.
const TOOL_LABEL = 'tool-issue';

// Photo storage — kept under a distinct folder so it can't collide with
// resident daily-report photos (`photos/<paddedIssueNum>/…`).
const TOOL_PHOTO_ROOT = 'photos/tool-issues';

const DESC_MIN = 10;
const DESC_MAX = 2000;
const PAGE_MAX = 500;
const TITLE_MAX = 200;
const UA_MAX = 500;
const PHOTO_MAX_COUNT = 3;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

// ---- Throttle (per-user, per-isolate) -------------------------------------
// A tool-report should be rare per user; we cap at 3 per 10 min per email.
// This is intentionally stricter than the resident daily throttle because
// (a) it's a maintainer-facing channel, not a resident workflow, and
// (b) it costs a GitHub API call plus photo commits.

interface ToolThrottle { hits: number[] }
const throttle = new Map<string, ToolThrottle>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 3;

/** Test-only escape hatch. */
export const _resetToolThrottleForTests = (): void => { throttle.clear(); };

const checkThrottle = (email: string): void => {
  const now = Date.now();
  const entry = throttle.get(email) ?? { hits: [] };
  entry.hits = entry.hits.filter((t) => now - t < WINDOW_MS);
  if (entry.hits.length >= MAX_HITS) {
    const waitS = Math.ceil((WINDOW_MS - (now - entry.hits[0]!)) / 1000);
    throw new BadRequest(`Too many tool reports — please wait ${waitS}s before sending another.`);
  }
  entry.hits.push(now);
  throttle.set(email, entry);
};

// ---- Photos ---------------------------------------------------------------

interface PhotoIn { dataUrl: string; name?: string }

const DATA_URL_RE = /^data:(image\/(?:jpe?g|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

const extOf = (mime: string): string => {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png')  return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif')  return 'gif';
  return 'bin';
};

const parsePhotos = (raw: unknown): PhotoIn[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequest('photos must be an array');
  if (raw.length > PHOTO_MAX_COUNT) {
    throw new BadRequest(`Up to ${PHOTO_MAX_COUNT} screenshots per report`);
  }
  const out: PhotoIn[] = [];
  for (const p of raw) {
    if (!isObj(p)) throw new BadRequest('photos[] entries must be objects');
    const dataUrl = str(p['dataUrl'], 'photos[].dataUrl', { min: 30, max: 10_000_000 });
    const name = optStr(p['name'], 'photos[].name', { max: 100 });
    out.push({ dataUrl, ...(name !== undefined ? { name } : {}) });
  }
  return out;
};

const uploadToolPhotos = async (
  ctx: Ctx,
  issueNum: number,
  photos: PhotoIn[],
  actor: string,
): Promise<string[]> => {
  const urls: string[] = [];
  let idx = 1;
  for (const p of photos) {
    const m = DATA_URL_RE.exec(p.dataUrl);
    if (!m) throw new BadRequest(`photo ${idx}: dataUrl must be image/jpeg|png|webp|gif base64`);
    const mime = m[1]!;
    const b64 = m[2]!;
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const byteSize = Math.floor((b64.length * 3) / 4) - padding;
    if (byteSize > PHOTO_MAX_BYTES) {
      throw new BadRequest(`photo ${idx}: ${byteSize} bytes exceeds ${PHOTO_MAX_BYTES}`);
    }
    const fileName = `${String(idx).padStart(2, '0')}.${extOf(mime)}`;
    const repoPath = `${TOOL_PHOTO_ROOT}/${issueNum}/${fileName}`;
    await putBinaryB64(
      ctx.env,
      repoPath,
      b64,
      `tool-issue #${issueNum} photo ${fileName} by ${actor}`,
      actor,
    );
    urls.push(
      `https://raw.githubusercontent.com/${ctx.env.GH_OWNER}/${ctx.env.GH_REPO}/${ctx.env.GH_BRANCH}/${repoPath}`,
    );
    idx++;
  }
  return urls;
};

// ---- Body builders --------------------------------------------------------

const truncateTitle = (raw: string): string =>
  raw.length <= TITLE_MAX ? raw : raw.slice(0, TITLE_MAX - 1) + '…';

const buildTitle = (pageTitle: string, description: string): string => {
  const firstLine = description.split(/\r?\n/)[0]!.trim().slice(0, 80);
  const prefix = '[Tool Issue]';
  const parts = [prefix, pageTitle || 'unknown page'];
  if (firstLine) parts.push('— ' + firstLine);
  return truncateTitle(parts.join(' '));
};

const buildBody = (input: {
  page: string;
  pageTitle: string;
  description: string;
  reporter: string;
  userAgent: string;
  photoUrls: string[];
}): string => {
  const lines: string[] = [];
  lines.push('> **Website bug reported from the resident app footer.**');
  lines.push('> This is NOT a society helpdesk ticket.');
  lines.push('');
  lines.push('### Context');
  lines.push('- **Where:** [' + input.pageTitle + '](' + input.page + ')');
  lines.push('- **Reporter:** ' + input.reporter);
  lines.push('- **When:** ' + new Date().toISOString());
  lines.push('- **Browser:** `' + input.userAgent + '`');
  lines.push('');
  lines.push('### Description');
  lines.push(input.description);
  if (input.photoUrls.length) {
    lines.push('');
    lines.push('### Screenshots');
    for (const url of input.photoUrls) {
      lines.push('![screenshot](' + url + ')');
    }
  }
  return lines.join('\n');
};

// ---- Route ----------------------------------------------------------------

export const mountToolIssues = (r: Router): void => {
  r.post('/tool-issues', async (ctx: Ctx) => {
    ensureAllowed(ctx, { requireIdentity: true });
    // Belt-and-braces: ensureAllowed throws Unauthorized if identity is
    // missing, but TypeScript can't narrow that so we assert here.
    if (!ctx.identity) throw new Unauthorized('Sign in required');
    if (!ctx.identity.emailVerified) {
      throw new Unauthorized('Google email is not verified');
    }

    checkThrottle(ctx.identity.email);

    const raw = await parseJson<Record<string, unknown>>(ctx.req);
    const description = str(raw['description'], 'description', { min: DESC_MIN, max: DESC_MAX });
    const page        = str(raw['page'],        'page',        { min: 1,        max: PAGE_MAX });
    const pageTitle   = optStr(raw['pageTitle'], 'pageTitle', { max: 200 }) ?? '';
    const userAgent   = optStr(raw['userAgent'], 'userAgent', { max: UA_MAX }) ?? 'unknown';
    const photos      = parsePhotos(raw['photos']);

    const reporter = ctx.identity.email;
    const title = buildTitle(pageTitle, description);

    // 1. Create the issue up-front with a placeholder body — we need the
    //    issue number before we can write photo paths.
    const provisionalBody = buildBody({
      page, pageTitle, description, reporter, userAgent, photoUrls: [],
    });
    const created = await createIssue(ctx.env, {
      title,
      body: provisionalBody,
      labels: [TOOL_LABEL],
    });

    // 2. Upload photos (if any) and patch the body to embed them.
    let finalUrl = created.html_url;
    if (photos.length) {
      try {
        const photoUrls = await uploadToolPhotos(ctx, created.number, photos, reporter);
        const finalBody = buildBody({
          page, pageTitle, description, reporter, userAgent, photoUrls,
        });
        const updated = await updateIssue(ctx.env, created.number, { body: finalBody });
        finalUrl = updated.html_url;
      } catch (e) {
        // Photos failed but the report itself was filed — leave a
        // comment on the issue explaining, so the maintainer knows.
        // (We don't want to fail the whole call because the resident
        // has already lost their description otherwise.)
        const msg = e instanceof Error ? e.message : String(e);
        throw new UpstreamError('Report filed as #' + created.number
          + ' but photo upload failed: ' + msg);
      }
    }

    return ok(ctx.env, ctx.req, {
      number: created.number,
      url: finalUrl,
    }, 201);
  });
};

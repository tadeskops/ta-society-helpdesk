// Public read endpoints. Anonymous-allowed. PII scrubbed.
// Spec: tsh_requirement.md §5.2, §15.1.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { listIssues, getIssue } from '../github/client.ts';
import { isDeleted, toPublicIssue, statusOf, TKT_ID_RE } from '../lib/issue.ts';
import { isFeatureOn } from '../config/defaults.ts';
import { NotFound, BadRequest } from '../lib/errors.ts';

export const mountPublic = (r: Router): void => {
  // ---- GET /issues/public ----
  r.get('/issues/public', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: ['FEATURE_DAILY_TRACK'] });
    const all = await listIssues(ctx.env, { state: 'all', labels: ['daily'], per_page: 100 });
    const includePhotos = isFeatureOn(ctx.config, 'FEATURE_DAILY_PUBLIC_PHOTOS');
    const showResolved  = isFeatureOn(ctx.config, 'FEATURE_DAILY_PUBLIC_RESOLVED');
    const showRejected  = isFeatureOn(ctx.config, 'FEATURE_DAILY_PUBLIC_REJECTED');
    const showDemo      = isFeatureOn(ctx.config, 'FEATURE_DAILY_SHOW_DEMO_ISSUES');

    const visible = all.filter((i) => {
      if (isDeleted(i)) return false;
      if (!showDemo && i.labels.some((l) => l.name === 'seed:demo')) return false;
      const s = statusOf(i.labels);
      if (s === 'resolved' && !showResolved) return false;
      if (s === 'rejected' && !showRejected) return false;
      return true;
    });

    const items = visible.map((i) => toPublicIssue(i, { includePhotos }));
    return ok(ctx.env, ctx.req, { items, count: items.length });
  });

  // ---- GET /issues/:id/public ----
  r.get('/issues/:id/public', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, { flags: ['FEATURE_DAILY_TRACK'] });
    const raw = (params['id'] ?? '').toUpperCase();
    let issue;
    if (TKT_ID_RE.test(raw)) {
      const matches = await listIssues(ctx.env, {
        state: 'all',
        labels: ['daily', `tkt:${raw}`],
        per_page: 1,
      });
      issue = matches[0];
    } else {
      const m = /^(?:DLY-)?0*(\d+)$/.exec(raw);
      if (!m) throw new BadRequest('id must look like TKT-2806260345 or DLY-00042');
      issue = await getIssue(ctx.env, Number(m[1]));
    }
    if (!issue || isDeleted(issue)) throw new NotFound(`No public issue ${raw}`);
    // System filter: must carry the 'daily' label to be a daily-track issue.
    if (!issue.labels.some((l) => l.name === 'daily')) throw new NotFound(`No public issue ${raw}`);
    if (!isFeatureOn(ctx.config, 'FEATURE_DAILY_SHOW_DEMO_ISSUES') &&
        issue.labels.some((l) => l.name === 'seed:demo')) {
      throw new NotFound(`No public issue ${raw}`);
    }
    const includePhotos = isFeatureOn(ctx.config, 'FEATURE_DAILY_PUBLIC_PHOTOS');
    return ok(ctx.env, ctx.req, toPublicIssue(issue, { includePhotos }));
  });
};

// GET /audit — recent audit-log entries (committee + admin).
// Spec: tsh_requirement.md §5, §6.5.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { readAudit } from '../lib/audit.ts';
import { isFeatureOn } from '../config/defaults.ts';
import { FeatureDisabled } from '../lib/errors.ts';

export const mountAudit = (r: Router): void => {
  r.get('/audit', async (ctx: Ctx) => {
    ensureAllowed(ctx, { roles: ['COMMITTEE', 'ADMIN'], requireIdentity: true });
    // The audit log itself is always written; the UI gate is the FEATURE_DAILY_AUDIT_LOG_UI
    // flag so committee can disable the read endpoint independently.
    if (!isFeatureOn(ctx.config, 'FEATURE_DAILY_AUDIT_LOG_UI')) {
      throw new FeatureDisabled('FEATURE_DAILY_AUDIT_LOG_UI');
    }
    const limit = Math.min(500, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? '200')));
    const entries = await readAudit(ctx.env, limit);
    return ok(ctx.env, ctx.req, { entries, count: entries.length });
  });
};

// Admin-only routes for the Google Calendar mirror (Phase 3).
// Spec: tsh_requirement.md §20.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { CAL_FLAG, status, drain } from '../lib/google-calendar.ts';

export const mountCalendar = (r: Router): void => {
  r.get('/admin/calendar-status', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [CAL_FLAG], requireIdentity: true, roles: ['ADMIN'] });
    const s = await status(ctx.env, ctx.config);
    return ok(ctx.env, ctx.req, s);
  });

  r.post('/admin/calendar-retry', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [CAL_FLAG], requireIdentity: true, roles: ['ADMIN'] });
    const result = await drain(ctx.env, ctx.config);
    return ok(ctx.env, ctx.req, result);
  });
};

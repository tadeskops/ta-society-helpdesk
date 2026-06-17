// Route registry. Phase 1 ships the bare-minimum read endpoints
// (whoami + config). Phase 2 adds the rest (issues CRUD, settings PUT,
// access-list PUT, audit GET). Spec: tsh_requirement.md §5.

import { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';

export const buildRouter = (): Router => {
  const r = new Router();

  // ---- whoami (any verified caller; anonymous returns UNKNOWN) ----
  r.get('/whoami', (ctx: Ctx) => {
    ensureAllowed(ctx, {}); // no role / flag constraints
    return ok(ctx.env, ctx.req, {
      email: ctx.roles.email,
      roles: ctx.roles.all,
      primary: ctx.roles.primary,
    });
  });

  // ---- config (anonymous; PII-free) ----
  r.get('/config', (ctx: Ctx) => {
    ensureAllowed(ctx, {});
    return ok(ctx.env, ctx.req, ctx.config);
  });

  // ---- TODO Phase 2: issues, photos, redact, delete, bulk-archive,
  //                    access-lists GET/PUT, config PUT, audit GET ----

  return r;
};

// GET /whoami — identity + role(s) of the verified caller.
// Spec: tsh_requirement.md §5. Anonymous callers get UNKNOWN.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';

export const mountWhoami = (r: Router): void => {
  r.get('/whoami', (ctx: Ctx) => {
    ensureAllowed(ctx, {});
    return ok(ctx.env, ctx.req, {
      email: ctx.roles.email,
      roles: ctx.roles.all,
      primary: ctx.roles.primary,
      identity: ctx.identity
        ? { email: ctx.identity.email, name: ctx.identity.name, picture: ctx.identity.picture }
        : null,
    });
  });
};

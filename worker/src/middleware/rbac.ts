// RBAC + feature-flag guard. Used by every route handler.
// Spec: tsh_requirement.md §5, §14.2.

import { Forbidden, FeatureDisabled, Unauthorized } from '../lib/errors.ts';
import type { Ctx } from '../lib/ctx.ts';
import type { Role } from '../auth/roles.ts';
import { hasAny } from '../auth/roles.ts';
import { isFeatureOn } from '../config/defaults.ts';

export interface Guard {
  /** Roles permitted to call this route. Omit to allow anonymous. */
  roles?: Role[];
  /** Feature flag(s) that must ALL be true. */
  flags?: string[];
  /** Require a verified Google identity (even if anonymous-allowed for the role check). */
  requireIdentity?: boolean;
}

export const ensureAllowed = (ctx: Ctx, guard: Guard): void => {
  if (guard.requireIdentity && !ctx.identity) throw new Unauthorized();
  if (guard.flags) {
    for (const flag of guard.flags) {
      if (!isFeatureOn(ctx.config, flag)) throw new FeatureDisabled(flag);
    }
  }
  if (guard.roles) {
    if (!hasAny(ctx.roles, ...guard.roles)) throw new Forbidden(`Role ${ctx.roles.primary} not allowed here`);
  }
};

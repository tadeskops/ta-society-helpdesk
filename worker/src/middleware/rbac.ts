// RBAC + feature-flag guard. Used by every route handler.
// Spec: tsh_requirement.md §5, §14.2.

import { Forbidden, FeatureDisabled, Unauthorized } from '../lib/errors.ts';
import type { Ctx } from '../lib/ctx.ts';
import type { Role } from '../auth/roles.ts';
import { isAtLeast, rankOf } from '../auth/roles.ts';
import { isFeatureOn } from '../config/defaults.ts';

export interface Guard {
  /**
   * Roles permitted to call this route. Interpreted as
   * **"at least the LOWEST-ranked tier in the list"** — the caller
   * passes iff `isAtLeast(rs, min(roles))`. This matches how every
   * existing callsite lists the minimum tier plus (redundantly)
   * every tier above it, and it lets CHAIRMAN / SECRETARY / TREASURER
   * / CONTRIBUTOR inherit access transitively under the strict 8-tier
   * hierarchy without every route file having to enumerate them.
   *
   * Omit to allow anonymous.
   */
  roles?: Role[];
  /** Feature flag(s) that must ALL be true. */
  flags?: string[];
  /** Require a verified Google identity (even if anonymous-allowed for the role check). */
  requireIdentity?: boolean;
}

// Under strict-hierarchy semantics `guard.roles` is treated as
// "at least the weakest tier listed". Anonymous (UNKNOWN) is
// implicitly the weakest and is only ever allowed when `roles`
// is omitted entirely (see ensureAllowed below).
const weakestRole = (roles: Role[]): Role => {
  let weakest: Role = roles[0]!;
  let weakestRank = rankOf(weakest);
  for (const r of roles) {
    const rk = rankOf(r);
    if (rk > weakestRank) { weakest = r; weakestRank = rk; }
  }
  return weakest;
};

export const ensureAllowed = (ctx: Ctx, guard: Guard): void => {
  if (guard.requireIdentity && !ctx.identity) throw new Unauthorized();
  if (guard.flags) {
    for (const flag of guard.flags) {
      if (!isFeatureOn(ctx.config, flag)) throw new FeatureDisabled(flag);
    }
  }
  if (guard.roles && guard.roles.length > 0) {
    const min = weakestRole(guard.roles);
    if (!isAtLeast(ctx.roles, min)) {
      throw new Forbidden(`Role ${ctx.roles.primary} not allowed here (requires at least ${min})`);
    }
  }
};

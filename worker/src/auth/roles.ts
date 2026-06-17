// Role resolution. Spec: tsh_requirement.md §2, §3.2.
// Precedence (for landing-page routing / displayed badge):
//   DEVELOPER > COMMITTEE > MANAGER > UNKNOWN
// Capabilities are additive — an email in multiple lists gets the union.

import type { AccessLists } from '../config/loader.ts';

export type Role = 'DEVELOPER' | 'COMMITTEE' | 'MANAGER' | 'UNKNOWN';

export interface RoleSet {
  primary: Role;
  all: Role[];          // additive set, sorted by precedence desc
  email: string | null; // null = anonymous
}

const PRECEDENCE: Role[] = ['DEVELOPER', 'COMMITTEE', 'MANAGER'];

const includesCi = (list: string[], email: string): boolean =>
  list.some((e) => e.toLowerCase() === email);

export const resolveRoles = (access: AccessLists, email: string | null): RoleSet => {
  if (!email) return { primary: 'UNKNOWN', all: ['UNKNOWN'], email: null };
  const lower = email.toLowerCase();
  const roles: Role[] = [];
  if (includesCi(access.developers, lower)) roles.push('DEVELOPER');
  if (includesCi(access.committee,  lower)) roles.push('COMMITTEE');
  if (includesCi(access.managers,   lower)) roles.push('MANAGER');
  if (roles.length === 0) return { primary: 'UNKNOWN', all: ['UNKNOWN'], email: lower };
  // Already in precedence order because we pushed in order
  return { primary: roles[0]!, all: roles, email: lower };
};

export const hasAny = (rs: RoleSet, ...allowed: Role[]): boolean =>
  allowed.some((r) => rs.all.includes(r));

export const isAtLeast = (rs: RoleSet, min: Role): boolean => {
  if (min === 'UNKNOWN') return true;
  const minIdx = PRECEDENCE.indexOf(min);
  return rs.all.some((r) => {
    const idx = PRECEDENCE.indexOf(r);
    return idx !== -1 && idx <= minIdx;
  });
};

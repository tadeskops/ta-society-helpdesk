// Role resolution. Spec: tsh_requirement.md §2, §3.2.
//
// STRICT LINEAR HIERARCHY (top → bottom):
//   ADMIN > CHAIRMAN > SECRETARY > TREASURER > COMMITTEE > CONTRIBUTOR
//     > MANAGER > RESIDENT > UNKNOWN
//
// Capabilities inherit downward: a role at tier N automatically has every
// capability of every tier below N. `isAtLeast(rs, min)` returns true iff
// primary is at or above `min` in this chain.
//
// Access-list editing follows the same hierarchy — see `canEditAccessList`
// below. A caller can edit the roster of any role STRICTLY below their own
// primary tier. Admin (top) can edit every list including the Admin list
// itself (subject to the one-admin-minimum guard in the route).
//
// RESIDENT  = signed-in Google identity not on any privileged list.
// UNKNOWN   = anonymous (no verified email at all).
//
// History: prior to 2026-07-12 the top three tiers (CHAIRMAN/SECRETARY/
// TREASURER) were "additive capability tags" outside the precedence chain
// and treasury access was gated by `hasAny(CHAIRMAN|TREASURER|SECRETARY)`.
// They are now first-class precedence tiers and treasury access flows
// from `isAtLeast(TREASURER)`. The old additive-tag helpers still work
// via the wrappers below to keep existing route code and tests running.

import type { AccessLists } from '../config/loader.ts';
import type { SiteConfig } from '../config/defaults.ts';

export type Role =
  | 'ADMIN'
  | 'CHAIRMAN'
  | 'SECRETARY'
  | 'TREASURER'
  | 'COMMITTEE'
  | 'CONTRIBUTOR'
  | 'MANAGER'
  | 'RESIDENT'
  | 'UNKNOWN';

export interface RoleSet {
  primary: Role;
  all: Role[];          // every list the email is directly on, sorted by precedence desc
  email: string | null; // null = anonymous
}

// Top → bottom. Index 0 = highest authority. `isAtLeast(rs, min)` returns
// true iff primary's index in PRECEDENCE is ≤ index of `min`.
const PRECEDENCE: Role[] = [
  'ADMIN',
  'CHAIRMAN',
  'SECRETARY',
  'TREASURER',
  'COMMITTEE',
  'CONTRIBUTOR',
  'MANAGER',
  'RESIDENT',
];

const includesCi = (list: string[] | undefined, email: string): boolean =>
  !!list && list.some((e) => e.toLowerCase() === email);

export const resolveRoles = (access: AccessLists, email: string | null): RoleSet => {
  if (!email) return { primary: 'UNKNOWN', all: ['UNKNOWN'], email: null };
  const lower = email.toLowerCase();
  const roles: Role[] = [];
  // Push in strict-precedence order — highest tier first — so
  // `all[0]` is the caller's primary badge and later entries are
  // lower tiers they are ALSO explicitly listed on (rare, but
  // permitted so an operator can name someone in more than one list).
  if (includesCi(access.admins,      lower)) roles.push('ADMIN');
  if (includesCi(access.chairman,    lower)) roles.push('CHAIRMAN');
  if (includesCi(access.secretary,   lower)) roles.push('SECRETARY');
  if (includesCi(access.treasurer,   lower)) roles.push('TREASURER');
  if (includesCi(access.committee,   lower)) roles.push('COMMITTEE');
  if (includesCi(access.contributor, lower)) roles.push('CONTRIBUTOR');
  if (includesCi(access.managers,    lower)) roles.push('MANAGER');
  // Every signed-in identity is at minimum a Resident — the baseline
  // tier for any verified Gmail. This is what the badge shows when
  // there's no privileged mapping.
  roles.push('RESIDENT');
  return { primary: roles[0]!, all: roles, email: lower };
};

export const hasAny = (rs: RoleSet, ...allowed: Role[]): boolean =>
  allowed.some((r) => rs.all.includes(r));

export const isAtLeast = (rs: RoleSet, min: Role): boolean => {
  if (min === 'UNKNOWN') return true;
  if (min === 'RESIDENT') return rs.email !== null; // any signed-in user
  const minIdx = PRECEDENCE.indexOf(min);
  if (minIdx === -1) return false;
  return rs.all.some((r) => {
    const idx = PRECEDENCE.indexOf(r);
    return idx !== -1 && idx <= minIdx;
  });
};

/**
 * Rank (0 = highest = ADMIN, 7 = lowest = RESIDENT) of the given role.
 * Returns Number.POSITIVE_INFINITY for UNKNOWN or an unrecognised role.
 * Exposed for the settings UI + `canEditAccessList` below.
 */
export const rankOf = (role: Role): number => {
  const idx = PRECEDENCE.indexOf(role);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
};

/** Editable-access-list role keys (matches AccessLists field names). */
export type EditableAccessRole =
  | 'admins'
  | 'chairman'
  | 'secretary'
  | 'treasurer'
  | 'committee'
  | 'contributor'
  | 'managers';

const ACCESS_LIST_TO_ROLE: Record<EditableAccessRole, Role> = {
  admins:      'ADMIN',
  chairman:    'CHAIRMAN',
  secretary:   'SECRETARY',
  treasurer:   'TREASURER',
  committee:   'COMMITTEE',
  contributor: 'CONTRIBUTOR',
  managers:    'MANAGER',
};

/**
 * Delegated access-list editing rule. Returns true iff the caller's
 * primary tier is STRICTLY ABOVE the target role in the hierarchy —
 * with one exception: an ADMIN may edit the ADMIN list itself
 * (subject to the one-admin-minimum guard applied in the route).
 *
 * Examples (with the strict 8-tier chain):
 *   caller=ADMIN     → may edit admins, chairman, secretary, treasurer,
 *                       committee, contributor, managers
 *   caller=CHAIRMAN  → may edit secretary, treasurer, committee,
 *                       contributor, managers (NOT admins, NOT self)
 *   caller=SECRETARY → may edit treasurer, committee, contributor, managers
 *   caller=TREASURER → may edit committee, contributor, managers
 *   caller=COMMITTEE → may edit contributor, managers
 *   caller=CONTRIBUTOR → may edit managers
 *   caller=MANAGER / RESIDENT → may edit nothing
 */
export const canEditAccessList = (rs: RoleSet, target: EditableAccessRole): boolean => {
  const targetRole = ACCESS_LIST_TO_ROLE[target];
  const callerRank = rankOf(rs.primary);
  const targetRank = rankOf(targetRole);
  if (callerRank === Number.POSITIVE_INFINITY) return false;
  if (rs.primary === 'ADMIN') return true;              // Admin edits everything
  return callerRank < targetRank;                        // strict-above
};

/**
 * Delegated feature-flag toggling rule. Returns true iff the caller
 * may flip `flag` on/off through the narrow `PATCH /features/:flag`
 * endpoint. ADMIN may always toggle; other roles may toggle only
 * flags explicitly delegated to them (or a lower tier) via
 * `system.flagDelegation[flag]` in site.json.
 *
 * Example site.json snippet:
 *   "system": { "flagDelegation": {
 *     "FEATURE_TREASURY_MANAGER_APPROVE": "CHAIRMAN"
 *   } }
 * → chairman (and above) may toggle that flag; committee-and-below cannot.
 */
export const canToggleFeatureFlag = (
  rs: RoleSet,
  flag: string,
  config: SiteConfig,
): boolean => {
  if (rs.primary === 'ADMIN') return true;
  const delegation = config.system?.flagDelegation ?? {};
  const minRoleRaw = delegation[flag];
  if (!minRoleRaw) return false;
  // Narrow the site.json string to a known Role. Unknown values
  // (typo in site.json) fail closed — only ADMIN retains toggle rights.
  if (!PRECEDENCE.includes(minRoleRaw as Role)) return false;
  return isAtLeast(rs, minRoleRaw as Role);
};

/**
 * Returns true iff the caller may view the confidential treasury
 * dashboard (ledger, all reimbursements, expenses, summary, receipt
 * binaries).
 *
 * Rules (in order, after the 2026-07-12 strict-hierarchy refactor):
 *   1. `isAtLeast(rs, 'TREASURER')` → true. This covers ADMIN,
 *      CHAIRMAN, SECRETARY, and TREASURER (all four inherit treasury
 *      access under the strict linear hierarchy).
 *   2. GRANDFATHER: while NONE of the three treasury-authoritative
 *      lists (chairman / secretary / treasurer) is seeded, fall back
 *      to the legacy Committee+Admin gate so operators upgrading in
 *      place don't lose access before they've had a chance to
 *      configure the new lists. Once ANY of the three lists has at
 *      least one email the grandfather flips off automatically.
 *
 * The old opt-in flag `FEATURE_TREASURY_SECRETARY_ACCESS` is a no-op
 * under the new hierarchy (SECRETARY inherits treasury view from being
 * ABOVE TREASURER in the chain) and is kept in defaults only for
 * backward compatibility with existing site.json files.
 *
 * Residents (their own claim + raise flow) are gated by
 * FEATURE_TREASURY_RESIDENT_RAISE elsewhere and are NOT affected by
 * this helper — this function is exclusively about the confidential
 * committee-side dashboard.
 *
 * NOTE: the `config` argument is unused today but retained so the
 * signature can carry per-tenant tweaks (e.g. a future site.json flag
 * that further restricts treasury view) without churning every call
 * site again.
 */
export const canViewTreasuryLedger = (
  rs: RoleSet,
  access: AccessLists,
  _config: SiteConfig,
): boolean => {
  if (isAtLeast(rs, 'TREASURER')) return true;
  if (isTreasuryGrandfatherActive(access) && isAtLeast(rs, 'COMMITTEE')) return true;
  return false;
};

/**
 * Returns true iff the caller may perform write actions on the
 * treasury ledger (approve reimbursements, mark paid, record direct
 * expenses, edit or soft-delete expense rows).
 *
 * Under the strict hierarchy this mirrors `canViewTreasuryLedger`:
 * anyone at TREASURER-or-above may act. MANAGER retains its opt-in
 * per-action flags (FEATURE_TREASURY_MANAGER_APPROVE / _PAY /
 * _RECORD_EXPENSE) — those are checked separately by the treasury
 * route helpers, on top of this baseline.
 *
 * Grandfather: same as view — legacy COMMITTEE (and above) can act
 * until any of the three new lists is seeded.
 */
export const canActOnTreasuryLedger = (
  rs: RoleSet,
  access: AccessLists,
): boolean => {
  if (isAtLeast(rs, 'TREASURER')) return true;
  if (isTreasuryGrandfatherActive(access) && isAtLeast(rs, 'COMMITTEE')) return true;
  return false;
};

/**
 * True when the grandfather clause described in canViewTreasuryLedger
 * is currently active. Exposed to the client so the Settings UI can
 * show a "please seed the three new lists" banner.
 */
export const isTreasuryGrandfatherActive = (access: AccessLists): boolean =>
  (access.treasurer ?? []).length === 0 &&
  (access.chairman  ?? []).length === 0 &&
  (access.secretary ?? []).length === 0;

// Role resolution. Spec: tsh_requirement.md §2, §3.2.
// Precedence (for landing-page routing / displayed badge):
//   ADMIN > COMMITTEE > MANAGER > RESIDENT > UNKNOWN
// Capabilities are additive — an email in multiple lists gets the union.
//
// RESIDENT  = signed-in Google identity not on any privileged list.
// UNKNOWN   = anonymous (no verified email at all).
//
// TREASURER / CHAIRMAN / SECRETARY are ADDITIVE capability tags — they
// are NOT part of the precedence chain (so `primary` never changes when
// someone becomes treasurer). Presence in `roles.all[]` is what routes
// check via `hasAny(...)` and the treasury-access helpers below.

import type { AccessLists } from '../config/loader.ts';
import type { SiteConfig } from '../config/defaults.ts';
import { isFeatureOn } from '../config/defaults.ts';

export type Role =
  | 'ADMIN'
  | 'COMMITTEE'
  | 'MANAGER'
  | 'RESIDENT'
  | 'UNKNOWN'
  // Additive tags (not in PRECEDENCE):
  | 'TREASURER'
  | 'CHAIRMAN'
  | 'SECRETARY';

export interface RoleSet {
  primary: Role;
  all: Role[];          // additive set, sorted by precedence desc
  email: string | null; // null = anonymous
}

const PRECEDENCE: Role[] = ['ADMIN', 'COMMITTEE', 'MANAGER', 'RESIDENT'];

const includesCi = (list: string[], email: string): boolean =>
  list.some((e) => e.toLowerCase() === email);

export const resolveRoles = (access: AccessLists, email: string | null): RoleSet => {
  if (!email) return { primary: 'UNKNOWN', all: ['UNKNOWN'], email: null };
  const lower = email.toLowerCase();
  const roles: Role[] = [];
  if (includesCi(access.admins,    lower)) roles.push('ADMIN');
  if (includesCi(access.committee, lower)) roles.push('COMMITTEE');
  if (includesCi(access.managers,  lower)) roles.push('MANAGER');
  // Every signed-in identity is at minimum a Resident — the baseline
  // tier for any verified Gmail. This is what the badge shows when
  // there's no privileged mapping.
  roles.push('RESIDENT');
  // Additive capability tags — appended AFTER the primary chain so
  // roles[0] stays the highest precedence tier. Presence here powers
  // the treasury-access helpers without disturbing primary/isAtLeast.
  if (includesCi(access.treasurer ?? [], lower)) roles.push('TREASURER');
  if (includesCi(access.chairman  ?? [], lower)) roles.push('CHAIRMAN');
  if (includesCi(access.secretary ?? [], lower)) roles.push('SECRETARY');
  // Already in precedence order because we pushed in order
  return { primary: roles[0]!, all: roles, email: lower };
};

export const hasAny = (rs: RoleSet, ...allowed: Role[]): boolean =>
  allowed.some((r) => rs.all.includes(r));

export const isAtLeast = (rs: RoleSet, min: Role): boolean => {
  if (min === 'UNKNOWN') return true;
  if (min === 'RESIDENT') return rs.email !== null; // any signed-in user
  const minIdx = PRECEDENCE.indexOf(min);
  if (minIdx === -1) return false; // additive tags (TREASURER etc.) don't have a "at least" — use hasAny.
  return rs.all.some((r) => {
    const idx = PRECEDENCE.indexOf(r);
    return idx !== -1 && idx <= minIdx;
  });
};

/**
 * Returns true iff the caller may view the confidential treasury
 * dashboard (ledger, all reimbursements, expenses, summary, receipt
 * binaries).
 *
 * Rules (in order):
 *   1. ADMIN always allowed.
 *   2. CHAIRMAN or TREASURER always allowed.
 *   3. SECRETARY allowed only when FEATURE_TREASURY_SECRETARY_ACCESS
 *      is ON (opt-in per operator preference). Read-only — SECRETARY
 *      does NOT gain action rights via this helper (see
 *      `canActOnTreasuryLedger` for that).
 *   4. GRANDFATHER: if NONE of the three new lists (treasurer /
 *      chairman / secretary) are seeded yet, fall back to the legacy
 *      COMMITTEE+ADMIN gate so an operator upgrading in place doesn't
 *      lose access before they've had a chance to configure the new
 *      lists. Once ANY of the three lists has at least one email,
 *      the grandfather flips off automatically and the strict gate
 *      takes over. This is announced in the settings UI.
 *
 * Residents (their own claim + raise flow) are gated by
 * FEATURE_TREASURY_RESIDENT_RAISE elsewhere and are NOT affected by
 * this helper — this function is exclusively about the confidential
 * committee-side dashboard.
 */
export const canViewTreasuryLedger = (
  rs: RoleSet,
  access: AccessLists,
  config: SiteConfig,
): boolean => {
  if (hasAny(rs, 'ADMIN', 'CHAIRMAN', 'TREASURER')) return true;
  if (hasAny(rs, 'SECRETARY') && isFeatureOn(config, 'FEATURE_TREASURY_SECRETARY_ACCESS')) return true;
  if (isTreasuryGrandfatherActive(access) && hasAny(rs, 'COMMITTEE', 'ADMIN')) return true;
  return false;
};

/**
 * Returns true iff the caller may perform write actions on the
 * treasury ledger (approve reimbursements, mark paid, record direct
 * expenses, edit or soft-delete expense rows).
 *
 * Rules:
 *   1. ADMIN / CHAIRMAN / TREASURER always allowed.
 *   2. SECRETARY — NEVER allowed by this helper (secretary is
 *      view-only through `canViewTreasuryLedger`, even when the
 *      opt-in flag is on).
 *   3. GRANDFATHER: same as view — legacy COMMITTEE+ADMIN can act
 *      until any of the three new lists is seeded.
 *
 * MANAGER retains its opt-in per-action flags
 * (FEATURE_TREASURY_MANAGER_APPROVE / _PAY / _RECORD_EXPENSE) — those
 * are checked separately by the treasury route helpers, on top of
 * this baseline.
 */
export const canActOnTreasuryLedger = (
  rs: RoleSet,
  access: AccessLists,
): boolean => {
  if (hasAny(rs, 'ADMIN', 'CHAIRMAN', 'TREASURER')) return true;
  if (isTreasuryGrandfatherActive(access) && hasAny(rs, 'COMMITTEE', 'ADMIN')) return true;
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

// Hardcoded developer admin(s). Defined in code — NOT in config/admins.json.
//
// Purpose: the core company developer(s) must always have ADMIN access
// regardless of what config/admins.json contains. This is the escape
// hatch that guarantees:
//   1. The site can never be locked out by an accidental empty admin list.
//   2. The core developer can always sign in and recover any misconfig.
//
// Design rules:
//   • These emails are MERGED into `access.admins` at loader time, so
//     every downstream RBAC check (resolveRoles, ensureAllowed,
//     canEditAccessList, etc.) treats them as normal admins.
//   • The list is INVISIBLE in the Settings UI: GET /access-lists
//     strips these emails from the returned `admins` array, and
//     PUT /access-lists/admins silently strips them from any incoming
//     payload (defense in depth — the UI shouldn't be able to add or
//     remove them even if a caller crafts a raw request).
//   • Adding/removing entries requires a code change + redeploy. This
//     is intentional: a config-editable "hidden" admin would defeat
//     the purpose (any admin who could edit config could edit the
//     hidden list).
//
// Spec: tsh_requirement.md §2 (hardcoded developer admin).

export const HARDCODED_ADMINS: readonly string[] = [
  'samanasippa@gmail.com', // Shramana Labs — core developer
];

const HARDCODED_SET = new Set(HARDCODED_ADMINS.map((e) => e.toLowerCase()));

/** True if `email` is one of the hardcoded developer admins. */
export const isHardcodedAdmin = (email: string | null | undefined): boolean => {
  if (!email) return false;
  return HARDCODED_SET.has(email.toLowerCase());
};

/** Return a copy of `list` with every hardcoded admin removed (case-insensitive). */
export const stripHardcodedAdmins = (list: readonly string[]): string[] =>
  list.filter((e) => !HARDCODED_SET.has(e.toLowerCase()));

/**
 * Merge the hardcoded admins into an incoming admin list. Preserves order
 * of the file-defined admins and appends any hardcoded that aren't already
 * present. Case-insensitive dedup.
 */
export const mergeHardcodedAdmins = (list: readonly string[]): string[] => {
  const seen = new Set(list.map((e) => e.toLowerCase()));
  const out = [...list];
  for (const h of HARDCODED_ADMINS) {
    if (!seen.has(h.toLowerCase())) out.push(h);
  }
  return out;
};

// Vehicle Registry (parking / vehicle-to-flat mapping).
// -----------------------------------------------------------------------------
// GET    /vehicles          — signed-in only (any authenticated society user).
//                             Client builds an O(1) in-memory search index from
//                             this payload; no per-lookup round-trip.
// PUT    /vehicles          — bulk replace. Editor-role allowlist (see below).
// DELETE /vehicles/:id      — convenience one-shot removal, same allowlist.
//
// Storage: config/vehicles.json in the issues repo. In-Worker cache TTL
// = VEHICLES_CACHE_SECONDS (default 120 s).
//
// Editor allowlist:
//   Configured via `system.vehicles.editorRoles: Role[]` in site.json.
//   Default: ADMIN, CHAIRMAN, SECRETARY, TREASURER, COMMITTEE, MANAGER.
//   RESIDENT and CONTRIBUTOR are excluded by default per requirement:
//   "Vehicle details can be added, edited, or removed by authorized
//    society representatives (such as the Manager or Secretary)."
//   Admin edits site.json to change the allowlist; no code change needed.
//
// v2 hooks (design-in, feature-flagged — all default OFF):
//   • FEATURE_TSH_VEHICLES_EMAIL_FILTER — wired here. When on, GET
//     filters the returned list for non-editors so the caller only sees
//     vehicles whose `emails[]` contains their signed-in email. Editors
//     always see the full list.
//   • FEATURE_TSH_VEHICLES_STICKER_PATCH — stub only. See the comment
//     block near the bottom of mountVehicles() for the intended shape
//     of PATCH /vehicles/:id/sticker (used by a future SECURITY_GUARD).
//   • FEATURE_TSH_VEHICLES_BULK_EMAILS — stub only. See the comment block
//     for POST /vehicles/emails/import (manager+ uploads a paste/file,
//     parser extracts ≤ maxBulkEmails addresses).
//   • FEATURE_TSH_VEHICLES_RESIDENT_ADD — stub only. Gated by
//     `system.vehicles.residentAddRequiresIdCheck` (default true =
//     fail-closed); designed for a future id-validation flow.
//
// Spec: tsh_requirement.md §Vehicle Registry (§14.10).

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson, str, optStr, oneOf, isObj } from '../lib/validate.ts';
import { BadRequest, Forbidden, Conflict } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { tunable, isFeatureOn } from '../config/defaults.ts';
import type { Role } from '../auth/roles.ts';

const VEHICLES_PATH = 'config/vehicles.json';
const FEATURE = 'FEATURE_TSH_VEHICLES';

// v2 feature-flag names — exported for tests / documentation.
export const FEATURE_EMAIL_FILTER   = 'FEATURE_TSH_VEHICLES_EMAIL_FILTER';
export const FEATURE_STICKER_PATCH  = 'FEATURE_TSH_VEHICLES_STICKER_PATCH';
export const FEATURE_BULK_EMAILS    = 'FEATURE_TSH_VEHICLES_BULK_EMAILS';
export const FEATURE_RESIDENT_ADD   = 'FEATURE_TSH_VEHICLES_RESIDENT_ADD';

// Default editor allowlist. Overridden by site.json → system.vehicles.editorRoles.
// Includes MANAGER (parking-sticker workflow) and every tier at or above
// COMMITTEE. Excludes CONTRIBUTOR and RESIDENT.
const DEFAULT_EDITOR_ROLES: readonly Role[] = [
  'ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE', 'MANAGER',
];

// v2 defaults — mirror the editor allowlist plus one future-facing hint.
// `stickerRoles` includes the string 'SECURITY_GUARD' even though that role
// does not yet exist in the auth chain: set-membership treats unknown
// role strings as inert, so this is safe and makes the extension point
// obvious to a future admin without a code change.
const DEFAULT_STICKER_ROLES: readonly string[] = [
  'ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE', 'MANAGER', 'SECURITY_GUARD',
];
const DEFAULT_BULK_EMAIL_ROLES: readonly string[] = [
  'ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE', 'MANAGER',
];
const DEFAULT_RESIDENT_ADD_ROLES: readonly string[] = [];
const DEFAULT_RESIDENT_ADD_REQUIRES_ID_CHECK = true;
const DEFAULT_MAX_BULK_EMAILS = 300;

const VEHICLE_TYPES = ['2W', '4W'] as const;
type VehicleType = typeof VEHICLE_TYPES[number];

interface Vehicle {
  id: string;
  flat: string;
  regNo: string;              // normalised (uppercase, alphanumeric only)
  regNoDisplay: string;       // user-typed original, for UI
  type: VehicleType;
  sticker?: string;
  comments?: string;
  emails?: string[];          // optional owner contact emails (max 5)
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

interface VehicleFile {
  version: number;
  vehicles: Vehicle[];
}

const EMPTY_FILE: VehicleFile = { version: 1, vehicles: [] };

// ---- Cache ------------------------------------------------------------------
interface Cache { value: VehicleFile; sha?: string; expiresAt: number; }
let cache: Cache | undefined;
const invalidate = (): void => { cache = undefined; };

/** Test-only: clear the in-module cache between tests. */
export const _resetVehiclesCacheForTests = (): void => { cache = undefined; };

const loadFromGithub = async (env: Ctx['env']): Promise<{ value: VehicleFile; sha?: string }> => {
  const f = await getFile(env, VEHICLES_PATH);
  if (!f) return { value: structuredClone(EMPTY_FILE) };
  try {
    const parsed = JSON.parse(f.content) as Partial<VehicleFile>;
    return {
      value: {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        vehicles: Array.isArray(parsed.vehicles) ? (parsed.vehicles as Vehicle[]) : [],
      },
      sha: f.sha,
    };
  } catch {
    return { value: structuredClone(EMPTY_FILE), sha: f.sha };
  }
};

const loadVehicles = async (ctx: Ctx): Promise<VehicleFile> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const fresh = await loadFromGithub(ctx.env);
  const ttl = tunable(ctx.config, 'VEHICLES_CACHE_SECONDS', 120) * 1000;
  cache = {
    value: fresh.value,
    expiresAt: now + ttl,
    ...(fresh.sha !== undefined ? { sha: fresh.sha } : {}),
  };
  return fresh.value;
};

// ---- Editor allowlist -------------------------------------------------------
const readRoleList = (raw: unknown): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const filtered = raw
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.toUpperCase());
  return filtered.length > 0 ? filtered : undefined;
};

const getVehiclesCfg = (ctx: Ctx): Record<string, unknown> => {
  const sys = (ctx.config.system ?? {}) as Record<string, unknown>;
  const v = sys['vehicles'];
  return isObj(v) ? v : {};
};

const getEditorRoles = (ctx: Ctx): readonly Role[] => {
  const list = readRoleList(getVehiclesCfg(ctx)['editorRoles']);
  return (list as Role[] | undefined) ?? DEFAULT_EDITOR_ROLES;
};

// v2 hooks — exported for use once the matching feature flag is enabled.
// Each falls back to a sensible default so admins do not have to edit
// site.json twice (feature toggle + allowlist).
export const getStickerRoles = (ctx: Ctx): readonly string[] =>
  readRoleList(getVehiclesCfg(ctx)['stickerRoles']) ?? DEFAULT_STICKER_ROLES;

export const getBulkEmailRoles = (ctx: Ctx): readonly string[] =>
  readRoleList(getVehiclesCfg(ctx)['bulkEmailRoles']) ?? DEFAULT_BULK_EMAIL_ROLES;

export const getResidentAddRoles = (ctx: Ctx): readonly string[] =>
  readRoleList(getVehiclesCfg(ctx)['residentAddRoles']) ?? DEFAULT_RESIDENT_ADD_ROLES;

export const requiresIdCheckForResidentAdd = (ctx: Ctx): boolean => {
  const v = getVehiclesCfg(ctx)['residentAddRequiresIdCheck'];
  return typeof v === 'boolean' ? v : DEFAULT_RESIDENT_ADD_REQUIRES_ID_CHECK;
};

export const getMaxBulkEmails = (ctx: Ctx): number => {
  const v = getVehiclesCfg(ctx)['maxBulkEmails'];
  return typeof v === 'number' && v > 0 ? Math.floor(v) : DEFAULT_MAX_BULK_EMAILS;
};

const isEditor = (ctx: Ctx): boolean => {
  const allowed = new Set(getEditorRoles(ctx));
  return ctx.roles.all.some((r) => allowed.has(r));
};

const ensureEditor = (ctx: Ctx): void => {
  if (!isEditor(ctx)) {
    const allowed = getEditorRoles(ctx);
    throw new Forbidden(
      `Role ${ctx.roles.primary} is not permitted to edit the vehicle registry ` +
      `(allowed: ${Array.from(allowed).join(', ')})`,
    );
  }
};

// v2: per-caller filter. When FEATURE_TSH_VEHICLES_EMAIL_FILTER is on and
// the caller is not an editor, restrict the returned list to rows whose
// emails[] contains the caller's signed-in email. Editors always see the
// full list (they curate the emails[] mapping).
//
// Off by default → no-op → v1 behaviour preserved.
const filterVehiclesForCaller = (ctx: Ctx, vehicles: Vehicle[]): Vehicle[] => {
  if (!isFeatureOn(ctx.config, FEATURE_EMAIL_FILTER)) return vehicles;
  if (isEditor(ctx)) return vehicles;
  const email = ctx.identity?.email?.toLowerCase();
  if (!email) return [];
  return vehicles.filter((v) => (v.emails ?? []).some((e) => e.toLowerCase() === email));
};

// ---- Validation -------------------------------------------------------------
const FLAT_RE = /^[A-Z][0-9]{1,4}$/;   // A201, B12, C1004 … tower prefix + digits
const REG_NORM_RE = /^[A-Z0-9]{4,12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAILS = 5;

const normaliseRegNo = (raw: string): string =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

const validateFlat = (raw: unknown, allowedTowers: readonly string[]): string => {
  const s = str(raw, 'flat', { min: 2, max: 8 }).toUpperCase().replace(/\s+/g, '');
  if (!FLAT_RE.test(s)) {
    throw new BadRequest(`flat "${s}" must be a tower letter followed by digits (e.g. A201)`);
  }
  const tower = s.charAt(0);
  // Allow any letter-tower present in site.json → lists.towers (case-insensitive
  // single-letter comparison). Falls open if the towers list is misconfigured.
  const towerLetters = new Set(
    allowedTowers
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim().charAt(0).toUpperCase())
      .filter((c) => /^[A-Z]$/.test(c)),
  );
  if (towerLetters.size > 0 && !towerLetters.has(tower)) {
    throw new BadRequest(`flat "${s}" tower "${tower}" is not in the configured towers list`);
  }
  return s;
};

const validateEmails = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequest('emails must be an array');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') throw new BadRequest('emails entries must be strings');
    const s = v.trim().toLowerCase();
    if (!s) continue;
    if (!EMAIL_RE.test(s)) throw new BadRequest(`invalid email "${v}"`);
    if (s.length > 120) throw new BadRequest(`email too long "${v}"`);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length > MAX_EMAILS) throw new BadRequest(`at most ${MAX_EMAILS} emails per vehicle`);
  }
  return out;
};

const sanitiseVehicle = (raw: unknown, ctx: Ctx, actor: string): Vehicle => {
  if (!isObj(raw)) throw new BadRequest('vehicle entry must be an object');
  const towers = ctx.config.lists?.towers ?? [];
  const flat = validateFlat(raw['flat'], towers);
  const regNoRawStr = str(raw['regNo'], 'regNo', { min: 3, max: 20 });
  const regNo = normaliseRegNo(regNoRawStr);
  if (!REG_NORM_RE.test(regNo)) {
    throw new BadRequest(`regNo "${regNoRawStr}" must contain 4–12 alphanumerics (spaces/dashes ignored)`);
  }
  const type = oneOf(raw['type'], 'type', VEHICLE_TYPES);
  const sticker = optStr(raw['sticker'], 'sticker', { max: 20 });
  const comments = optStr(raw['comments'], 'comments', { max: 200 });
  const emails = validateEmails(raw['emails']);
  const now = new Date().toISOString();
  const createdAt = typeof raw['createdAt'] === 'string' ? raw['createdAt'] : now;
  // Deterministic id — one vehicle per (flat, regNo). Prevents dup-flat-move
  // silent duplicates: moving a vehicle between flats produces a new id and
  // is caught by the uniqueness check below.
  const id = `veh-${flat.toLowerCase()}-${regNo.toLowerCase()}`;
  // regNoDisplay preserves the user's original spacing (e.g. "MH 11 JJ 0234")
  // but is always uppercased so a lowercase entry stores as UPPERCASE.
  // Search is case-insensitive anyway (normReg lowers + strips), but the
  // display should read cleanly for anyone looking at the list.
  const out: Vehicle = {
    id,
    flat,
    regNo,
    regNoDisplay: regNoRawStr.trim().toUpperCase(),
    type,
    createdAt,
    updatedAt: now,
    updatedBy: actor,
  };
  if (sticker) out.sticker = sticker.toUpperCase();
  if (comments) out.comments = comments;
  if (emails.length) out.emails = emails;
  return out;
};

const enforceUnique = (vehicles: Vehicle[]): void => {
  const byReg = new Map<string, string>();  // regNo → flat
  for (const v of vehicles) {
    const seen = byReg.get(v.regNo);
    if (seen && seen !== v.flat) {
      throw new Conflict(
        `Vehicle "${v.regNoDisplay}" (regNo ${v.regNo}) is registered to two different flats (${seen}, ${v.flat}). ` +
        `A vehicle can belong to only one flat.`,
      );
    }
    if (seen && seen === v.flat) {
      throw new Conflict(`Duplicate vehicle "${v.regNoDisplay}" on flat ${v.flat}.`);
    }
    byReg.set(v.regNo, v.flat);
  }
};

// ---- Routes -----------------------------------------------------------------
export const mountVehicles = (r: Router): void => {
  // GET /vehicles — sign-in required.
  r.get('/vehicles', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FEATURE], requireIdentity: true });
    const file = await loadVehicles(ctx);
    // Advertise the caller's write permission and (for the v2 filter)
    // the current allowlist so the client can hide manage-controls without a
    // second request.
    const canWrite = isEditor(ctx);
    const editorRoles = getEditorRoles(ctx);
    // v2 hook: per-caller email filter. No-op when the flag is off.
    const vehicles = filterVehiclesForCaller(ctx, file.vehicles);
    return ok(ctx.env, ctx.req, {
      version: file.version,
      vehicles,
      canWrite,
      editorRoles: Array.from(editorRoles),
      // Tell the client whether the server-side filter is currently
      // active so it can render a hint ("showing only your vehicles").
      filtered: isFeatureOn(ctx.config, FEATURE_EMAIL_FILTER) && !canWrite,
    });
  });

  // PUT /vehicles — bulk replace. Editor-role allowlist.
  r.put('/vehicles', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FEATURE], requireIdentity: true });
    ensureEditor(ctx);
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const incoming = (body['vehicles'] ?? body['file'] ?? body) as unknown;
    let rawList: unknown[];
    if (Array.isArray(incoming)) {
      rawList = incoming;
    } else if (isObj(incoming) && Array.isArray((incoming as Record<string, unknown>)['vehicles'])) {
      rawList = (incoming as Record<string, unknown>)['vehicles'] as unknown[];
    } else {
      throw new BadRequest('body must contain a vehicles array');
    }

    const actor = ctx.identity!.email;
    const cleaned = rawList.map((raw) => sanitiseVehicle(raw, ctx, actor));
    enforceUnique(cleaned);

    // Preserve original createdAt for existing rows (match by id).
    const existing = await loadVehicles(ctx);
    const existingById = new Map(existing.vehicles.map((v) => [v.id, v]));
    for (const v of cleaned) {
      const prev = existingById.get(v.id);
      if (prev) v.createdAt = prev.createdAt;
    }

    const next: VehicleFile = { version: 1, vehicles: cleaned };
    const file = await getFile(ctx.env, VEHICLES_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(
      ctx.env,
      VEHICLES_PATH,
      serialised,
      `vehicles: update by ${actor} (${cleaned.length} rows)`,
      actor,
      file?.sha,
    );
    await writeAudit(ctx.env, {
      actor,
      action: 'vehicles:put',
      target: VEHICLES_PATH,
      detail: `count=${cleaned.length}`,
    });
    invalidate();
    return ok(ctx.env, ctx.req, { saved: true, count: cleaned.length });
  });

  // DELETE /vehicles/:id — remove one row, keep everything else.
  r.delete('/vehicles/:id', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, { flags: [FEATURE], requireIdentity: true });
    ensureEditor(ctx);
    const id = decodeURIComponent(params['id'] ?? '').trim();
    if (!id) throw new BadRequest('vehicle id required');
    const existing = await loadVehicles(ctx);
    const idx = existing.vehicles.findIndex((v) => v.id === id);
    if (idx < 0) throw new BadRequest(`vehicle "${id}" not found`);
    const removed = existing.vehicles[idx]!;
    const actor = ctx.identity!.email;
    const next: VehicleFile = {
      version: existing.version,
      vehicles: existing.vehicles.filter((_, i) => i !== idx),
    };
    const file = await getFile(ctx.env, VEHICLES_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(
      ctx.env,
      VEHICLES_PATH,
      serialised,
      `vehicles: delete ${removed.regNo} (flat ${removed.flat}) by ${actor}`,
      actor,
      file?.sha,
    );
    await writeAudit(ctx.env, {
      actor,
      action: 'vehicles:delete',
      target: VEHICLES_PATH,
      detail: `id=${id} flat=${removed.flat} regNo=${removed.regNo}`,
    });
    invalidate();
    return ok(ctx.env, ctx.req, { saved: true, count: next.vehicles.length, removed: { id, flat: removed.flat, regNo: removed.regNo } });
  });

  // ---------------------------------------------------------------------------
  // v2 STUBS — endpoints below are intentionally NOT mounted yet. They are
  // documented in code so future implementation is a matter of un-commenting
  // + adding tests, not redesigning the API surface.
  // ---------------------------------------------------------------------------
  //
  // PATCH /vehicles/:id/sticker
  //   Flag:   FEATURE_TSH_VEHICLES_STICKER_PATCH
  //   Roles:  set membership against system.vehicles.stickerRoles.
  //           Default allowlist adds 'SECURITY_GUARD' (a role that will
  //           exist in a future auth-chain revision) so the guard on the
  //           gate can update stickers without touching the rest of the
  //           record.
  //   Body:   { sticker: string }              // ≤20 chars, trim, empty = clear
  //   Effect: Loads the row by id, replaces ONLY the sticker field,
  //           stamps updatedAt / updatedBy, persists via putFile, writes
  //           audit `vehicles:patch-sticker id=<id> flat=<flat>`. Every
  //           other field is preserved verbatim.
  //   Notes:  Cache invalidated. Uniqueness / flat / regNo checks are
  //           unnecessary because they cannot change on this path.
  //
  // POST /vehicles/emails/import
  //   Flag:   FEATURE_TSH_VEHICLES_BULK_EMAILS
  //   Roles:  set membership against system.vehicles.bulkEmailRoles.
  //           Default = editor allowlist (manager+). Residents cannot upload.
  //   Body:   { text: string }                 // pasted CSV / TXT / whatever
  //           OR multipart/form-data with a text/plain / text/csv file.
  //   Effect: Parses `text` with a permissive regex (see EMAIL_RE + word
  //           boundaries), lowercases + dedupes, caps at
  //           system.vehicles.maxBulkEmails (default 300). Returns
  //           `{ emails: string[], skipped: string[], count: number }`
  //           WITHOUT persisting — the client attaches the extracted
  //           addresses to specific vehicles or flats via the existing
  //           PUT /vehicles. Keeps this endpoint idempotent and lets the
  //           admin review before commit.
  //   Audit:  `vehicles:emails-import count=<n> actor=<email>` on parse.
  //
  // POST /vehicles/mine
  //   Flag:   FEATURE_TSH_VEHICLES_RESIDENT_ADD
  //   Roles:  set membership against system.vehicles.residentAddRoles
  //           (typically ['RESIDENT'] once id-validation exists).
  //   Gate:   If system.vehicles.residentAddRequiresIdCheck === true
  //           (default), the caller's identity must be linked to a flat
  //           via an out-of-band id-verification flow (planned separately).
  //           Fails 403 with `id_check_pending` until then.
  //   Body:   Same shape as one vehicle in PUT /vehicles, but the `flat`
  //           is derived from the caller's verified flat mapping —
  //           client-supplied `flat` is ignored / cross-checked.
  //   Effect: Appends a single row. `updatedBy` is the resident's email;
  //           the row is marked `pending: true` until an editor re-saves
  //           it via PUT /vehicles (which strips the pending flag). Same
  //           uniqueness guarantees as PUT.
  //   Audit:  `vehicles:resident-add flat=<flat> regNo=<regNo>`.
};

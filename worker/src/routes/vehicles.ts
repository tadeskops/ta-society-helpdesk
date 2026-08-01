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
export const FEATURE_EMAIL_FILTER     = 'FEATURE_TSH_VEHICLES_EMAIL_FILTER';
export const FEATURE_STICKER_PATCH    = 'FEATURE_TSH_VEHICLES_STICKER_PATCH';
export const FEATURE_BULK_EMAILS      = 'FEATURE_TSH_VEHICLES_BULK_EMAILS';
export const FEATURE_RESIDENT_ADD     = 'FEATURE_TSH_VEHICLES_RESIDENT_ADD';
export const FEATURE_MEMBER_ALLOWLIST = 'FEATURE_TSH_VEHICLES_MEMBER_ALLOWLIST';
export const FEATURE_REPORT_PRINT     = 'FEATURE_TSH_VEHICLES_REPORT_PRINT';

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
// The member-allowlist is empty by default. When the matching feature
// flag flips on, only e-mails in this list (plus editors) can hit the
// registry; empty + flag on = editors only.
const DEFAULT_MEMBER_ALLOWLIST: readonly string[] = [];
// Who is allowed to add / remove entries in `memberAllowlist` itself.
// Kept separate from `editorRoles` so an admin can grant one committee
// member the power to curate the allowlist without also making them a
// general vehicle editor. Set-membership check.
const DEFAULT_MEMBER_ALLOWLIST_EDITOR_ROLES: readonly string[] = [
  'ADMIN', 'CHAIRMAN', 'SECRETARY',
];

// Vehicle type codes accepted by the registry.
//   • 2W    — two-wheeler (petrol / diesel / other non-EV)
//   • 4W    — four-wheeler (petrol / diesel / other non-EV)
//   • 2W_EV — electric two-wheeler
//   • 4W_EV — electric four-wheeler
// Existing rows written before EVs existed keep '2W'/'4W' and are treated
// as non-EV. The wheel class is the primary group key used by the seat-map
// bar chart on docs/vehicles.html (EVs are counted in the same 2W/4W bin).
const VEHICLE_TYPES = ['2W', '4W', '2W_EV', '4W_EV'] as const;
type VehicleType = typeof VEHICLE_TYPES[number];

interface Vehicle {
  id: string;
  flat: string;
  regNo: string;              // normalised (uppercase, alphanumeric only)
  regNoDisplay: string;       // user-typed original, for UI
  type: VehicleType;
  parkingNo?: string;         // assigned parking bay (e.g. "P-104")
  sticker?: string;           // society-issued vehicle sticker number
  comments?: string;
  emails?: string[];          // optional owner contact emails (max 5)
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

interface VehicleFile {
  version: number;
  vehicles: Vehicle[];
  // Per-flat parking bay assignments. Independent of the vehicles array
  // so a flat can have reserved parking slot(s) before any vehicle is
  // registered (or the parking outlives all its vehicles).
  //   key   = flat code (upper-case, e.g. "B905")
  //   value = list of bay labels (upper-case, e.g. ["P-104", "P-201"])
  // A single flat may be allocated multiple bays (some flats own two
  // parking spots) but every bay label is unique across the entire
  // society \u2014 no two flats may share the same bay code. Empty /
  // missing = unassigned.
  flatParking?: Record<string, string[]>;
}

const EMPTY_FILE: VehicleFile = { version: 1, vehicles: [], flatParking: {} };

// Society-wide cap on how many parking bays one flat may hold. Keeps
// the JSON compact and prevents accidental runaway lists from a UI bug.
const MAX_PARKING_PER_FLAT = 10;

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
    // Normalise flatParking: accept either the new array-per-flat shape
    // or the legacy string-per-flat shape (upgrades in-place on read).
    // Drop empty strings, drop within-flat duplicates, upper-case
    // keys+values, and enforce the society-wide cap.
    const rawFP = (parsed as { flatParking?: unknown }).flatParking;
    const flatParking: Record<string, string[]> = {};
    if (isObj(rawFP)) {
      for (const [k, v] of Object.entries(rawFP as Record<string, unknown>)) {
        if (typeof k !== 'string') continue;
        const key = k.trim().toUpperCase();
        if (!key) continue;
        let bays: string[] = [];
        if (typeof v === 'string') {
          // Legacy shape: single string. Wrap in an array so the rest
          // of the code path is uniform.
          const trimmed = v.trim().toUpperCase();
          if (trimmed) bays = [trimmed];
        } else if (Array.isArray(v)) {
          const seen = new Set<string>();
          for (const raw of v) {
            if (typeof raw !== 'string') continue;
            const bay = raw.trim().toUpperCase();
            if (!bay || seen.has(bay)) continue;
            seen.add(bay);
            bays.push(bay);
            if (bays.length >= MAX_PARKING_PER_FLAT) break;
          }
        }
        if (bays.length) flatParking[key] = bays;
      }
    }
    return {
      value: {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        vehicles: Array.isArray(parsed.vehicles) ? (parsed.vehicles as Vehicle[]) : [],
        flatParking,
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

// v2: curated member allowlist. Optional per-caller access-control layer
// on top of the normal RBAC. When the flag is off, this is a no-op and
// every signed-in society caller can search the registry — v1 behaviour.
// When on, only e-mails in the list may hit GET/PUT/DELETE /vehicles
// (editors always bypass, so the registry never locks its own admins out).
// Empty list + flag on = editors only.
export const getMemberAllowlist = (ctx: Ctx): readonly string[] => {
  const raw = getVehiclesCfg(ctx)['memberAllowlist'];
  if (!Array.isArray(raw)) return DEFAULT_MEMBER_ALLOWLIST;
  return raw
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
};

// Who may curate the `memberAllowlist` array itself from Settings.
// The endpoint that mutates the list is not yet built — this getter is
// wired in defaults so Settings UI can surface the field once the list-
// management view lands.
export const getMemberAllowlistEditorRoles = (ctx: Ctx): readonly string[] =>
  readRoleList(getVehiclesCfg(ctx)['memberAllowlistEditorRoles']) ??
  DEFAULT_MEMBER_ALLOWLIST_EDITOR_ROLES;

const isMember = (ctx: Ctx): boolean => {
  const list = getMemberAllowlist(ctx);
  const email = ctx.identity?.email?.toLowerCase();
  return !!email && list.includes(email);
};

const ensureMemberAccess = (ctx: Ctx): void => {
  if (!isFeatureOn(ctx.config, FEATURE_MEMBER_ALLOWLIST)) return;
  if (isEditor(ctx)) return;
  if (isMember(ctx)) return;
  throw new Forbidden(
    'Vehicle registry access is restricted to the configured member ' +
    'allowlist. Ask an admin to add your e-mail via Settings.',
  );
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
  const parkingNo = optStr(raw['parkingNo'], 'parkingNo', { max: 20 });
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
  if (parkingNo) out.parkingNo = parkingNo.toUpperCase();
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
    // v2 hook: curated e-mail allowlist. When the flag is off (default),
    // this is a no-op and any signed-in society caller can read the
    // registry. When on, non-editor callers whose e-mail is not in
    // `system.vehicles.memberAllowlist` are rejected with 403.
    ensureMemberAccess(ctx);
    const file = await loadVehicles(ctx);
    // Advertise the caller's write permission and (for the v2 filter)
    // the current allowlist so the client can hide manage-controls without a
    // second request.
    const canWrite = isEditor(ctx);
    const editorRoles = getEditorRoles(ctx);
    // v2 hook: per-caller email filter. No-op when the flag is off.
    const vehicles = filterVehiclesForCaller(ctx, file.vehicles);
    // Seat-map schematics for the client-side grid. Falls through to the
    // baked-in defaults when site.json omits it.
    const sys = (ctx.config.system ?? {}) as Record<string, unknown>;
    const vCfg = isObj(sys['vehicles']) ? (sys['vehicles'] as Record<string, unknown>) : {};
    const towerLayouts = isObj(vCfg['towerLayouts']) ? vCfg['towerLayouts'] : undefined;
    return ok(ctx.env, ctx.req, {
      version: file.version,
      vehicles,
      canWrite,
      editorRoles: Array.from(editorRoles),
      // Tell the client whether the server-side filter is currently
      // active so it can render a hint ("showing only your vehicles").
      filtered: isFeatureOn(ctx.config, FEATURE_EMAIL_FILTER) && !canWrite,
      // Report-print feature is a client-only affordance today; expose
      // its flag so the manage view can conditionally render the button
      // without a second /config round-trip.
      reportPrintEnabled: isFeatureOn(ctx.config, FEATURE_REPORT_PRINT),
      // Per-tower floors × unitsPerFloor. Client falls back to
      // 10 × 4 for towers absent from this map.
      towerLayouts,
      // Per-flat parking bay assignments (independent of vehicles).
      flatParking: file.flatParking ?? {},
    });
  });

  // PUT /vehicles — bulk replace. Editor-role allowlist.
  r.put('/vehicles', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FEATURE], requireIdentity: true });
    ensureMemberAccess(ctx);
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

    const next: VehicleFile = {
      version: 1,
      vehicles: cleaned,
      // Preserve the existing flatParking map — the bulk /vehicles PUT
      // only replaces the vehicles array. Parking assignments are
      // maintained via PUT /vehicles/flat-parking.
      flatParking: existing.flatParking ?? {},
    };
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
    ensureMemberAccess(ctx);
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
      // Preserve the flatParking map on delete — a flat's parking bay
      // survives even if its last vehicle is removed.
      flatParking: existing.flatParking ?? {},
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

  // PUT /vehicles/flat-parking — assign or clear a per-flat parking bay.
  // Body: { flat: "B905", parkingNo: "P-104" }.
  // PUT /vehicles/flat-parking — assign, extend, or rewrite a flat's list
  // of parking bays.
  //
  // Body accepts either shape:
  //   { flat: "B905", parkingNos: ["P-104", "P-201"] }   // full replace
  //   { flat: "B905", parkingNo:  "P-104" }              // legacy: single-item replace
  //
  // Rules (enforced server-side):
  //   * At least one non-empty bay (parking is a fixed, mandatory
  //     property of the flat \u2014 the list may not be blank).
  //   * Each entry \u2264 20 chars, upper-cased, no within-flat duplicates.
  //   * At most MAX_PARKING_PER_FLAT entries per flat.
  //   * Global uniqueness: no bay may appear at any *other* flat's list.
  //     Two flats sharing bay "P-104" is a data-model violation.
  //
  // Kept as a separate route because parking is a flat-level property,
  // not a vehicle-level one \u2014 a flat can be assigned bay(s) before any
  // vehicle is registered, and the assignment persists across vehicle
  // add/delete operations.
  r.put('/vehicles/flat-parking', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FEATURE], requireIdentity: true });
    ensureMemberAccess(ctx);
    ensureEditor(ctx);
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const towers = ctx.config.lists?.towers ?? [];
    const flat = validateFlat(body['flat'], towers);

    // Collect the incoming bays into an unnormalised string[] regardless
    // of which body shape was used.
    let rawList: unknown[];
    if (Array.isArray(body['parkingNos'])) {
      rawList = body['parkingNos'] as unknown[];
    } else if (typeof body['parkingNo'] === 'string') {
      rawList = [body['parkingNo']];
    } else if (body['parkingNos'] !== undefined) {
      throw new BadRequest('parkingNos must be an array of strings');
    } else {
      throw new BadRequest('parkingNo or parkingNos required');
    }

    // Normalise + validate every entry. Reject blanks and within-flat
    // duplicates up front so the caller gets a precise error, not a
    // silent dedupe.
    const seen = new Set<string>();
    const bays: string[] = [];
    for (const raw of rawList) {
      if (typeof raw !== 'string') {
        throw new BadRequest('parkingNos entries must all be strings');
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        throw new BadRequest(
          'Parking No. is fixed to the flat and cannot be blank. ' +
          'Remove the empty entry or fill it in.',
        );
      }
      if (trimmed.length > 20) {
        throw new BadRequest('Each parking No. must be at most 20 characters');
      }
      const bay = trimmed.toUpperCase();
      if (seen.has(bay)) {
        throw new BadRequest(`Duplicate parking No. "${bay}" for flat ${flat}.`);
      }
      seen.add(bay);
      bays.push(bay);
    }
    if (bays.length === 0) {
      // Mandatory rule: a flat must retain at least one bay.
      throw new BadRequest(
        'Parking No. is fixed to the flat and cannot be cleared. ' +
        'Submit at least one bay label.',
      );
    }
    if (bays.length > MAX_PARKING_PER_FLAT) {
      throw new BadRequest(
        `A flat may hold at most ${MAX_PARKING_PER_FLAT} parking bays.`,
      );
    }

    const actor = ctx.identity!.email;
    const existing = await loadVehicles(ctx);

    // Global uniqueness: reject if any bay is already assigned to a
    // *different* flat. A flat re-using its OWN previous bay is fine.
    const claimedBy = new Map<string, string>();
    for (const [otherFlat, otherBays] of Object.entries(existing.flatParking ?? {})) {
      if (otherFlat === flat) continue;
      for (const bay of otherBays) claimedBy.set(bay, otherFlat);
    }
    const clash = bays.find((bay) => claimedBy.has(bay));
    if (clash) {
      throw new Conflict(
        `Parking No. "${clash}" is already assigned to flat ${claimedBy.get(clash)}. ` +
        `Each bay may belong to only one flat.`,
      );
    }

    const nextMap: Record<string, string[]> = { ...(existing.flatParking ?? {}) };
    nextMap[flat] = bays;

    const next: VehicleFile = {
      version: existing.version,
      vehicles: existing.vehicles,
      flatParking: nextMap,
    };
    const file = await getFile(ctx.env, VEHICLES_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    const msg = `vehicles: parking ${bays.join('+')} @ ${flat} by ${actor}`;
    await putFile(ctx.env, VEHICLES_PATH, serialised, msg, actor, file?.sha);
    await writeAudit(ctx.env, {
      actor,
      action: 'vehicles:flat-parking-set',
      target: VEHICLES_PATH,
      detail: `flat=${flat} parkingNos=${bays.join(',')}`,
    });
    invalidate();
    return ok(ctx.env, ctx.req, { saved: true, flat, parkingNos: bays });
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

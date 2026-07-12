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
// Search-side (future): the payload will one day be filtered per-caller so
// a resident only sees vehicles registered to their own flat, based on a
// separate email→flat map. For v1 the whole list ships to any signed-in
// user (matches emergency use cases: "whose car is blocking me?").
//
// Spec: tsh_requirement.md §Vehicle Registry.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson, str, optStr, oneOf, isObj } from '../lib/validate.ts';
import { BadRequest, Forbidden, Conflict } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { tunable } from '../config/defaults.ts';
import type { Role } from '../auth/roles.ts';

const VEHICLES_PATH = 'config/vehicles.json';
const FEATURE = 'FEATURE_TSH_VEHICLES';

// Default editor allowlist. Overridden by site.json → system.vehicles.editorRoles.
// Includes MANAGER (parking-sticker workflow) and every tier at or above
// COMMITTEE. Excludes CONTRIBUTOR and RESIDENT.
const DEFAULT_EDITOR_ROLES: readonly Role[] = [
  'ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE', 'MANAGER',
];

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
const getEditorRoles = (ctx: Ctx): readonly Role[] => {
  const sys = (ctx.config.system ?? {}) as Record<string, unknown>;
  const vehiclesCfg = sys['vehicles'];
  if (isObj(vehiclesCfg)) {
    const raw = vehiclesCfg['editorRoles'];
    if (Array.isArray(raw)) {
      const filtered = raw
        .filter((r): r is string => typeof r === 'string')
        .map((r) => r.toUpperCase() as Role);
      // Drop obvious junk. Fall back to defaults if the config is empty.
      if (filtered.length > 0) return filtered;
    }
  }
  return DEFAULT_EDITOR_ROLES;
};

const ensureEditor = (ctx: Ctx): void => {
  const allowed = new Set(getEditorRoles(ctx));
  const has = ctx.roles.all.some((r) => allowed.has(r));
  if (!has) {
    throw new Forbidden(
      `Role ${ctx.roles.primary} is not permitted to edit the vehicle registry ` +
      `(allowed: ${Array.from(allowed).join(', ')})`,
    );
  }
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
  const out: Vehicle = {
    id,
    flat,
    regNo,
    regNoDisplay: regNoRawStr.trim(),
    type,
    createdAt,
    updatedAt: now,
    updatedBy: actor,
  };
  if (sticker) out.sticker = sticker;
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
    // Advertise the caller's write permission and (for the future v2 filter)
    // the current allowlist so the client can hide manage-controls without a
    // second request.
    const allowed = new Set(getEditorRoles(ctx));
    const canWrite = ctx.roles.all.some((r) => allowed.has(r));
    return ok(ctx.env, ctx.req, {
      version: file.version,
      vehicles: file.vehicles,
      canWrite,
      editorRoles: Array.from(allowed),
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
};

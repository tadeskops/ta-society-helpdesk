// EV Charging Services — resident-facing routes.
// -----------------------------------------------------------------------------
// Master feature flag: FEATURE_TSH_EV_CHARGING. Every /ev/* endpoint is
// gated by it. Sub-features (booking, receipt, admin dashboard, mirror,
// rfid, registration, support) have their own FEATURE_TSH_EV_* flag and
// are added in subsequent phases (see tsh_requirement.md §23).
//
// Phase 1 (shipped): /ev/config.
// Phase 2 (this ship): booking core behind FEATURE_TSH_EV_BOOKING —
//   GET  /ev/availability?from=&to=&stationId=
//   GET  /ev/bookings?scope=own|all
//   GET  /ev/bookings/:id
//   POST /ev/bookings
//   PATCH /ev/bookings/:id
// Storage: `config/ev-bookings.json` (bounded, same pattern as reservations).
//
// Spec: tsh_requirement.md §23.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { isFeatureOn, tunable } from '../config/defaults.ts';
import { BadRequest, NotFound, Forbidden } from '../lib/errors.ts';
import { parseJson, str, optStr, oneOf, num } from '../lib/validate.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { isAtLeast } from '../auth/roles.ts';
import { istDateStr, parseIstDateMidnight, normalizeFlat } from '../lib/reservation.ts';
import {
  EV_STATUSES, EV_ID_RE, EV_MAX_ACTIVE_ITEMS, EV_AVAILABILITY_MAX_DAYS,
  effectiveBookingPolicy, nextEvBookingId, canTransitionEv,
  validateBookingWindow, validateTimeRange, findEvOverlap,
  countActiveEvBookingsForFlat, computeAvailability,
  type EvBooking, type EvBookingStatus,
} from '../lib/ev-booking.ts';

// Master flag — every /ev/* handler passes it via ensureAllowed({ flags }).
export const FEATURE = 'FEATURE_TSH_EV_CHARGING';

// Sub-feature flags — exported so tests and the settings page can reference
// them without magic strings. Each one gates its own set of routes / UI
// blocks; see tsh_requirement.md §23.1 for the ship queue.
export const FEATURE_BOOKING          = 'FEATURE_TSH_EV_BOOKING';
export const FEATURE_RECEIPT          = 'FEATURE_TSH_EV_RECEIPT';
export const FEATURE_ADMIN_DASHBOARD  = 'FEATURE_TSH_EV_ADMIN_DASHBOARD';
export const FEATURE_AUTO_REPORTS     = 'FEATURE_TSH_EV_AUTO_REPORTS';
export const FEATURE_RFID             = 'FEATURE_TSH_EV_RFID';
export const FEATURE_REGISTRATION     = 'FEATURE_TSH_EV_REGISTRATION';
export const FEATURE_SUPPORT          = 'FEATURE_TSH_EV_SUPPORT';

// Shallow-merge a site.json override onto a defaults record. Preserves
// primitive types where the override supplies a value of the right type;
// falls back to the default otherwise. Kept local to this file — the
// merge is deliberately shallow so admins can drop a partial block into
// site.json without having to re-declare every leaf.
const mergeShallow = <T extends Record<string, unknown>>(
  defaults: T,
  override: unknown,
): T => {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return defaults;
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    // Only substitute when types match (or both are objects — deep-merge
    // is handled one level up by the caller for nested blocks).
    const dv = (defaults as Record<string, unknown>)[k];
    if (typeof dv === typeof v) out[k] = v;
    else if (dv === undefined) out[k] = v;
  }
  return out as T;
};

// Compute the effective ev block by merging site.json → system.ev onto
// the baked-in defaults. Sub-blocks (station, booking, provider, etc.)
// are shallow-merged individually so an admin can override just one
// leaf without dropping the whole sibling set.
const resolveEvConfig = (ctx: Ctx): {
  station: Record<string, unknown>;
  booking: Record<string, unknown>;
  usageGuidelines: string[];
  provider: Record<string, unknown>;
  faqs: Array<{ q: string; a: string }>;
  helpline: Record<string, unknown>;
  reports: Record<string, unknown>;
} => {
  const sysEv = (ctx.config.system as Record<string, unknown>).ev as Record<string, unknown> | undefined;
  const defaults = ((ctx.config.system as Record<string, unknown>).ev ?? {}) as Record<string, unknown>;
  const src = (sysEv ?? {}) as Record<string, unknown>;
  // Both defaults and src refer to the same block because config/loader.ts
  // shallow-merges site.json onto DEFAULT_CONFIG at load time. We still
  // pull leaf-level guarantees so a malformed override does not undefine
  // a required field. Keep the resolver defensive.
  const stationDefaults = { id: 'ev-1', name: 'EV Charger #1', location: 'Basement 1', capacityKw: 7.4, enabled: true };
  const bookingDefaults = {
    stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
    bufferMinutes: 5, advanceWindowDays: 7, maxActivePerFlat: 1,
    openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [] as string[],
  };
  const providerDefaults = { name: '', androidUrl: '', iosUrl: '', website: '', email: '', tollFree: '' };
  const helplineDefaults = { directoryEntryId: '' };
  const reportsDefaults  = { template: '', mirrorCron: 'monthly' as const };
  const station  = mergeShallow(stationDefaults,  (src['station']  ?? defaults['station']));
  const booking  = mergeShallow(bookingDefaults,  (src['booking']  ?? defaults['booking']));
  const provider = mergeShallow(providerDefaults, (src['provider'] ?? defaults['provider']));
  const helpline = mergeShallow(helplineDefaults, (src['helpline'] ?? defaults['helpline']));
  const reports  = mergeShallow(reportsDefaults,  (src['reports']  ?? defaults['reports']));
  const rawGuides = (src['usageGuidelines'] ?? defaults['usageGuidelines']);
  const usageGuidelines = Array.isArray(rawGuides)
    ? rawGuides.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  const rawFaqs = (src['faqs'] ?? defaults['faqs']);
  const faqs = Array.isArray(rawFaqs)
    ? rawFaqs
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({ q: String(r['q'] ?? ''), a: String(r['a'] ?? '') }))
        .filter((r) => r.q && r.a)
    : [];
  return { station, booking, usageGuidelines, provider, faqs, helpline, reports };
};

// ---- Storage: config/ev-bookings.json --------------------------------------
// Same bounded-file pattern as reservations.ts. Kept local to this module
// so no other route accidentally re-uses the cache.

const EV_BOOK_PATH = 'config/ev-bookings.json';

interface EvBookCache { value: { version: number; items: EvBooking[] }; sha?: string; expiresAt: number }
let evBookCache: EvBookCache | undefined;
const invalidateEvBookings = (): void => { evBookCache = undefined; };

/** Test-only reset — mirrors _resetReservationCachesForTests. */
export const _resetEvChargingCachesForTests = (): void => {
  evBookCache = undefined;
};

const loadEvBookings = async (ctx: Ctx): Promise<{ items: EvBooking[]; sha?: string }> => {
  const now = Date.now();
  if (evBookCache && evBookCache.expiresAt > now) {
    const out: { items: EvBooking[]; sha?: string } = { items: evBookCache.value.items };
    if (evBookCache.sha !== undefined) out.sha = evBookCache.sha;
    return out;
  }
  const ttl = tunable(ctx.config, 'EV_BOOKINGS_CACHE_SECONDS', 60) * 1000;
  const f = await getFile(ctx.env, EV_BOOK_PATH);
  if (!f) {
    evBookCache = { value: { version: 1, items: [] }, expiresAt: now + ttl };
    return { items: [] };
  }
  try {
    const parsed = JSON.parse(f.content) as { version?: number; items?: EvBooking[] };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    evBookCache = {
      value: { version: parsed.version ?? 1, items },
      expiresAt: now + ttl,
      ...(f.sha !== undefined ? { sha: f.sha } : {}),
    };
    const out: { items: EvBooking[]; sha?: string } = { items };
    if (f.sha !== undefined) out.sha = f.sha;
    return out;
  } catch {
    evBookCache = { value: { version: 1, items: [] }, expiresAt: now + ttl };
    return { items: [] };
  }
};

const saveEvBookings = async (
  ctx: Ctx,
  items: EvBooking[],
  sha: string | undefined,
  actor: string,
  reason: string,
): Promise<void> => {
  if (items.length > EV_MAX_ACTIVE_ITEMS) {
    throw new BadRequest(
      `ev-bookings file is full (${items.length}/${EV_MAX_ACTIVE_ITEMS}); archive older records`,
    );
  }
  const body = JSON.stringify({ version: 1, items }, null, 2) + '\n';
  await putFile(ctx.env, EV_BOOK_PATH, body, `ev-bookings: ${reason} by ${actor}`, actor, sha);
  invalidateEvBookings();
};

// ---- Small helpers ---------------------------------------------------------

const isStaff = (ctx: Ctx): boolean =>
  isAtLeast(ctx.roles, 'MANAGER');

// Roles that may hit the /ev/* booking endpoints. Same set as reservations.
const RESIDENT_UP: ('RESIDENT' | 'MANAGER' | 'COMMITTEE' | 'ADMIN')[] =
  ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'];

// ---- Routes -----------------------------------------------------------------
export const mountEvCharging = (r: Router): void => {
  // GET /ev/config — signed-in only. Returns the ev block plus a
  // subFlags map so the client can render / hide each sub-panel in
  // one round-trip.
  r.get('/ev/config', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FEATURE], requireIdentity: true });
    const ev = resolveEvConfig(ctx);
    const subFlags = {
      booking:         isFeatureOn(ctx.config, FEATURE_BOOKING),
      receipt:         isFeatureOn(ctx.config, FEATURE_RECEIPT),
      adminDashboard:  isFeatureOn(ctx.config, FEATURE_ADMIN_DASHBOARD),
      autoReports:     isFeatureOn(ctx.config, FEATURE_AUTO_REPORTS),
      rfid:            isFeatureOn(ctx.config, FEATURE_RFID),
      registration:    isFeatureOn(ctx.config, FEATURE_REGISTRATION),
      support:         isFeatureOn(ctx.config, FEATURE_SUPPORT),
    };
    return ok(ctx.env, ctx.req, {
      station:         ev.station,
      booking:         ev.booking,
      usageGuidelines: ev.usageGuidelines,
      provider:        ev.provider,
      faqs:            ev.faqs,
      helpline:        ev.helpline,
      reports: {
        // Never leak the report template body to residents in Phase 1;
        // only the cadence label is safe to publish. Phase 4 exposes the
        // template via a MANAGER+-gated endpoint.
        mirrorCron: ev.reports['mirrorCron'] ?? 'monthly',
      },
      subFlags,
    });
  });

  // GET /ev/availability?from=&to=&stationId= — RESIDENT+.
  // Both master and FEATURE_TSH_EV_BOOKING must be on.
  // Returns per-date slot grids so the client can paint one calendar.
  r.get('/ev/availability', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_BOOKING],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const params = ctx.url.searchParams;
    const today = istDateStr(Date.now());
    const from  = params.get('from') ?? today;
    const to    = params.get('to')   ?? from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new BadRequest('from / to must be YYYY-MM-DD');
    }
    const fromMs = parseIstDateMidnight(from);
    const toMs   = parseIstDateMidnight(to);
    if (toMs < fromMs) throw new BadRequest('to must be on or after from');
    const dayMs = 24 * 60 * 60 * 1000;
    const spanDays = Math.round((toMs - fromMs) / dayMs) + 1;
    if (spanDays > EV_AVAILABILITY_MAX_DAYS) {
      throw new BadRequest(`availability range is at most ${EV_AVAILABILITY_MAX_DAYS} days`);
    }
    const ev = resolveEvConfig(ctx);
    const policy = effectiveBookingPolicy(ev.booking);
    const wantedStation = (params.get('stationId') ?? String((ev.station as Record<string, unknown>)['id'] ?? '')).trim();
    const stationId = wantedStation || String((ev.station as Record<string, unknown>)['id'] ?? 'ev-1');
    const { items } = await loadEvBookings(ctx);
    const days: Array<{ date: string; slots: ReturnType<typeof computeAvailability> }> = [];
    for (let i = 0; i < spanDays; i++) {
      const d = istDateStr(fromMs + i * dayMs);
      days.push({ date: d, slots: computeAvailability(policy, stationId, d, items) });
    }
    return ok(ctx.env, ctx.req, {
      stationId,
      from,
      to,
      policy: {
        stepMinutes: policy.stepMinutes,
        minDurationMinutes: policy.minDurationMinutes,
        maxDurationMinutes: policy.maxDurationMinutes,
        openMin: policy.openMin,
        closeMin: policy.closeMin,
        advanceWindowDays: policy.advanceWindowDays,
        blackoutDates: policy.blackoutDates,
      },
      days,
    });
  });

  // GET /ev/bookings?scope=own|all — RESIDENT (own) / MANAGER+ (all).
  r.get('/ev/bookings', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_BOOKING],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const scope = ctx.url.searchParams.get('scope') ?? 'own';
    if (scope !== 'own' && scope !== 'all') {
      throw new BadRequest('scope must be "own" or "all"');
    }
    if (scope === 'all' && !isStaff(ctx)) {
      throw new Forbidden('scope=all requires MANAGER+');
    }
    const meEmail = ctx.identity!.email;
    const { items } = await loadEvBookings(ctx);
    const list = scope === 'all'
      ? items
      : items.filter((r) => r.owner.email.toLowerCase() === meEmail.toLowerCase());
    // Newest-first by createdAt for predictable resident lists.
    list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return ok(ctx.env, ctx.req, { items: list, scope });
  });

  // GET /ev/bookings/:id — owner / MANAGER+.
  r.get('/ev/bookings/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_BOOKING],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const id = String(params['id'] || '');
    if (!EV_ID_RE.test(id)) throw new BadRequest('booking id is malformed');
    const { items } = await loadEvBookings(ctx);
    const r0 = items.find((r) => r.id === id);
    if (!r0) throw new NotFound(`ev booking not found: ${id}`);
    const meEmail = ctx.identity!.email.toLowerCase();
    if (!isStaff(ctx) && r0.owner.email.toLowerCase() !== meEmail) {
      throw new Forbidden('You may only view your own bookings');
    }
    return ok(ctx.env, ctx.req, { item: r0 });
  });

  // POST /ev/bookings — RESIDENT+. Body:
  //   { date, startMin, endMin, ownerName?, ownerFlat, notes?, stationId? }
  r.post('/ev/bookings', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_BOOKING],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const date       = str(body['date'], 'date', { min: 10, max: 10 });
    const startMin   = num(body['startMin'], 'startMin', { min: 0, max: 24 * 60 });
    const endMin     = num(body['endMin'],   'endMin',   { min: 0, max: 24 * 60 });
    const ownerName  = optStr(body['ownerName'], 'ownerName', { max: 80 });
    const ownerFlatR = str(body['ownerFlat'], 'ownerFlat', { min: 1, max: 40 });
    const notes      = optStr(body['notes'], 'notes', { max: 500 });
    const flatNorm   = normalizeFlat(ownerFlatR);
    if (!flatNorm) throw new BadRequest('ownerFlat must contain at least one letter or digit');
    const ev = resolveEvConfig(ctx);
    const policy = effectiveBookingPolicy(ev.booking);
    const configuredStationId = String((ev.station as Record<string, unknown>)['id'] ?? 'ev-1');
    const stationId = (optStr(body['stationId'], 'stationId', { max: 40 }) ?? configuredStationId) || configuredStationId;
    if ((ev.station as Record<string, unknown>)['enabled'] === false) {
      throw new BadRequest('EV charger is currently offline');
    }
    validateBookingWindow(policy, date, Date.now());
    validateTimeRange(policy, startMin, endMin);
    const { items, sha } = await loadEvBookings(ctx);
    const conflict = findEvOverlap(items, stationId, date, startMin, endMin, policy.bufferMinutes);
    if (conflict) {
      throw new BadRequest(`slot conflicts with existing booking ${conflict}`);
    }
    const held = countActiveEvBookingsForFlat(items, stationId, flatNorm, istDateStr(Date.now()));
    if (held >= policy.maxActivePerFlat) {
      throw new BadRequest(
        `Flat ${ownerFlatR} already has ${held} active booking(s) on this charger ` +
        `(cap ${policy.maxActivePerFlat}). Cancel an existing booking first.`,
      );
    }
    const meEmail = ctx.identity!.email.toLowerCase();
    const meName  = ctx.identity!.name;
    const nowIso  = new Date().toISOString();
    const existingIds = new Set(items.map((r) => r.id));
    const id = nextEvBookingId(existingIds);
    const status: EvBookingStatus = policy.requiresApproval ? 'pending' : 'confirmed';
    const record: EvBooking = {
      id,
      stationId,
      date,
      startMin,
      endMin,
      status,
      owner: {
        email: meEmail,
        flat:  ownerFlatR,
        ...(ownerName ? { name: ownerName } : (meName ? { name: meName } : {})),
      },
      createdBy: {
        email: meEmail,
        ...(meName ? { name: meName } : {}),
        role:  ctx.roles.primary,
      },
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(notes ? { notes } : {}),
    };
    const next = [...items, record];
    await saveEvBookings(ctx, next, sha, meEmail, `create ${id}`);
    await writeAudit(ctx.env, {
      actor: meEmail,
      action: 'ev-booking:create',
      target: id,
      detail: `${date} ${startMin}-${endMin} flat=${ownerFlatR} status=${status}`,
    });
    return ok(ctx.env, ctx.req, { item: record });
  });

  // PATCH /ev/bookings/:id — owner (cancel only) / MANAGER+ (any status).
  // Body: { status: 'confirmed' | 'cancelled' | 'completed', reason? }
  r.patch('/ev/bookings/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_BOOKING],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const id = String(params['id'] || '');
    if (!EV_ID_RE.test(id)) throw new BadRequest('booking id is malformed');
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const nextStatus = oneOf(body['status'], 'status', EV_STATUSES);
    const reason = optStr(body['reason'], 'reason', { max: 300 });
    const { items, sha } = await loadEvBookings(ctx);
    const idx = items.findIndex((r) => r.id === id);
    if (idx < 0) throw new NotFound(`ev booking not found: ${id}`);
    const before = items[idx]!;
    const meEmail = ctx.identity!.email.toLowerCase();
    const isOwner = before.owner.email.toLowerCase() === meEmail;
    const canManage = isStaff(ctx);
    if (!canTransitionEv(before.status, nextStatus, { isOwner, canManage })) {
      throw new Forbidden(
        `Not allowed to transition ${id} from ${before.status} to ${nextStatus}`,
      );
    }
    const nowIso = new Date().toISOString();
    const patched: EvBooking = {
      ...before,
      status: nextStatus,
      updatedAt: nowIso,
    };
    if (nextStatus === 'cancelled') {
      patched.cancelledAt = nowIso;
      patched.cancelledBy = meEmail;
      if (reason) patched.cancelReason = reason;
    }
    const next = [...items];
    next[idx] = patched;
    await saveEvBookings(ctx, next, sha, meEmail, `${nextStatus} ${id}`);
    await writeAudit(ctx.env, {
      actor: meEmail,
      action: `ev-booking:${nextStatus}`,
      target: id,
      ...(reason ? { detail: reason } : {}),
    });
    return ok(ctx.env, ctx.req, { item: patched });
  });
};

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
  countTotalActiveEvBookingsForFlat, sumBookedMinutesForFlatOnDate,
  buildEvReceiptQr, isReceiptEligible,
  resolveAnalyticsRange, aggregateEvBookings, bookingsToCsv,
  type EvBooking, type EvBookingStatus, type EvAnalyticsPeriod,
} from '../lib/ev-booking.ts';
import { runEvMirror } from '../lib/ev-mirror.ts';
import {
  RFID_TYPES, RFID_STATUSES, RFID_ID_RE, RFID_MAX_ACTIVE_ITEMS,
  REG_STATUSES, REG_ID_RE, REG_MAX_ACTIVE_ITEMS,
  SUPPORT_CATEGORIES, SUPPORT_STATUSES, SUPPORT_ID_RE, SUPPORT_MAX_ACTIVE_ITEMS,
  nextRfidId, canTransitionRfid, nextRegId, nextSupportId, canTransitionSupport,
  normalizePlate,
  type RfidRequest,
  type EvRegistration,
  type SupportTicket,
} from '../lib/ev-lifecycle.ts';

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
  stations: Array<Record<string, unknown>>;
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

  // Multi-station support: `system.ev.stations` (plural) is authoritative
  // if present. When absent, we synthesize a single-item list from
  // `station` (singular) so single-charger deployments keep working.
  // Each entry is normalized to guarantee `id`, `name`, `enabled` are
  // present. Unknown keys pass through so admins can attach vendor
  // metadata (model, connector, currentType, kind) without a code change.
  const rawStations = (src['stations'] ?? defaults['stations']);
  const stationList: Array<Record<string, unknown>> = Array.isArray(rawStations)
    ? rawStations
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r, i) => {
          const id = String(r['id'] ?? `ev-${i + 1}`).trim() || `ev-${i + 1}`;
          const name = String(r['name'] ?? `EV Charger #${i + 1}`).trim() || `EV Charger #${i + 1}`;
          const enabled = r['enabled'] !== false;
          return { ...r, id, name, enabled };
        })
    : [];
  const stations = stationList.length > 0 ? stationList : [station as Record<string, unknown>];
  // Re-point `station` at the first entry so downstream callers keep
  // seeing a consistent "default station" without extra plumbing.
  const primaryStation = stations[0] ?? station;
  return { station: primaryStation, stations, booking, usageGuidelines, provider, faqs, helpline, reports };
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
  _resetPhase6Caches();
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

// ---- Phase 6 storage: RFID / Registration / Support ------------------------
// Same bounded-file pattern; separate 60 s in-memory caches so a heavy
// RFID list doesn't invalidate the booking cache. All three helpers
// share a small `loadListFile` helper for the common
// { version, items } round-trip.

const EV_RFID_PATH     = 'config/ev-rfid-requests.json';
const EV_REG_PATH      = 'config/ev-registrations.json';
const EV_SUPPORT_PATH  = 'config/ev-support-tickets.json';

interface ListCache<T> { value: { version: number; items: T[] }; sha?: string; expiresAt: number }
let rfidCache:    ListCache<RfidRequest>   | undefined;
let regCache:     ListCache<EvRegistration>| undefined;
let supportCache: ListCache<SupportTicket> | undefined;

const invalidateRfid    = (): void => { rfidCache    = undefined; };
const invalidateReg     = (): void => { regCache     = undefined; };
const invalidateSupport = (): void => { supportCache = undefined; };

// Extend the test-only reset so Phase 6 caches also clear between tests.
const _resetPhase6Caches = (): void => {
  rfidCache = undefined;
  regCache = undefined;
  supportCache = undefined;
};

const loadListFile = async <T>(
  ctx: Ctx,
  path: string,
  cache: ListCache<T> | undefined,
): Promise<{ items: T[]; sha?: string; cache: ListCache<T> }> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    const out: { items: T[]; sha?: string; cache: ListCache<T> } = { items: cache.value.items, cache };
    if (cache.sha !== undefined) out.sha = cache.sha;
    return out;
  }
  const ttl = tunable(ctx.config, 'EV_BOOKINGS_CACHE_SECONDS', 60) * 1000;
  const f = await getFile(ctx.env, path);
  if (!f) {
    const c: ListCache<T> = { value: { version: 1, items: [] }, expiresAt: now + ttl };
    return { items: [], cache: c };
  }
  try {
    const parsed = JSON.parse(f.content) as { version?: number; items?: T[] };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const c: ListCache<T> = {
      value: { version: parsed.version ?? 1, items },
      expiresAt: now + ttl,
      ...(f.sha !== undefined ? { sha: f.sha } : {}),
    };
    const out: { items: T[]; sha?: string; cache: ListCache<T> } = { items, cache: c };
    if (f.sha !== undefined) out.sha = f.sha;
    return out;
  } catch {
    const c: ListCache<T> = { value: { version: 1, items: [] }, expiresAt: now + ttl };
    return { items: [], cache: c };
  }
};

const saveListFile = async <T>(
  ctx: Ctx,
  path: string,
  items: T[],
  sha: string | undefined,
  actor: string,
  reason: string,
  invalidate: () => void,
): Promise<void> => {
  const body = JSON.stringify({ version: 1, items }, null, 2) + '\n';
  await putFile(ctx.env, path, body, `${path.replace('config/', '')}: ${reason} by ${actor}`, actor, sha);
  invalidate();
};

const loadRfidRequests = async (ctx: Ctx): Promise<{ items: RfidRequest[]; sha?: string }> => {
  const { items, sha, cache } = await loadListFile<RfidRequest>(ctx, EV_RFID_PATH, rfidCache);
  rfidCache = cache;
  const out: { items: RfidRequest[]; sha?: string } = { items };
  if (sha !== undefined) out.sha = sha;
  return out;
};
const saveRfidRequests = async (ctx: Ctx, items: RfidRequest[], sha: string | undefined, actor: string, reason: string): Promise<void> => {
  if (items.length > RFID_MAX_ACTIVE_ITEMS) throw new BadRequest(`ev-rfid file is full (${items.length}/${RFID_MAX_ACTIVE_ITEMS})`);
  await saveListFile(ctx, EV_RFID_PATH, items, sha, actor, reason, invalidateRfid);
};

const loadRegistrations = async (ctx: Ctx): Promise<{ items: EvRegistration[]; sha?: string }> => {
  const { items, sha, cache } = await loadListFile<EvRegistration>(ctx, EV_REG_PATH, regCache);
  regCache = cache;
  const out: { items: EvRegistration[]; sha?: string } = { items };
  if (sha !== undefined) out.sha = sha;
  return out;
};
const saveRegistrations = async (ctx: Ctx, items: EvRegistration[], sha: string | undefined, actor: string, reason: string): Promise<void> => {
  if (items.length > REG_MAX_ACTIVE_ITEMS) throw new BadRequest(`ev-registrations file is full (${items.length}/${REG_MAX_ACTIVE_ITEMS})`);
  await saveListFile(ctx, EV_REG_PATH, items, sha, actor, reason, invalidateReg);
};

const loadSupportTickets = async (ctx: Ctx): Promise<{ items: SupportTicket[]; sha?: string }> => {
  const { items, sha, cache } = await loadListFile<SupportTicket>(ctx, EV_SUPPORT_PATH, supportCache);
  supportCache = cache;
  const out: { items: SupportTicket[]; sha?: string } = { items };
  if (sha !== undefined) out.sha = sha;
  return out;
};
const saveSupportTickets = async (ctx: Ctx, items: SupportTicket[], sha: string | undefined, actor: string, reason: string): Promise<void> => {
  if (items.length > SUPPORT_MAX_ACTIVE_ITEMS) throw new BadRequest(`ev-support file is full (${items.length}/${SUPPORT_MAX_ACTIVE_ITEMS})`);
  await saveListFile(ctx, EV_SUPPORT_PATH, items, sha, actor, reason, invalidateSupport);
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
      stations:        ev.stations,
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
    // If a stationId was explicitly requested, ensure it's one of the
    // configured chargers. Callers omitting the param get the default
    // (first) station's grid.
    const stationIds = ev.stations.map((s) => String((s as Record<string, unknown>)['id'] ?? ''));
    if (params.get('stationId') !== null && stationIds.length > 0 && !stationIds.includes(stationId)) {
      throw new BadRequest(`unknown stationId "${stationId}"`);
    }
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
        // Cross-booking buffer: the resident must vacate the bay this
        // many minutes BEFORE their slot's nominal end so the next
        // booking can plug in on time. Surfaced so the UI can render
        // the "vacate by HH:MM" reminder next to the booking summary.
        bufferMinutes: policy.bufferMinutes,
        maxActivePerFlat: policy.maxActivePerFlat,
        maxTotalBookingsPerFlat: policy.maxTotalBookingsPerFlat,
        maxDailyMinutesPerFlat: policy.maxDailyMinutesPerFlat,
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
    // Multi-station guard: when the site has a `stations` array, only
    // allow ids that are in it. Single-station deployments (stations is
    // a 1-item list synthesized from `station`) still accept the
    // legacy default id.
    const stationIds = ev.stations.map((s) => String((s as Record<string, unknown>)['id'] ?? ''));
    if (stationIds.length > 0 && !stationIds.includes(stationId)) {
      throw new BadRequest(`unknown stationId "${stationId}"`);
    }
    const stationEntry = ev.stations.find((s) => String((s as Record<string, unknown>)['id'] ?? '') === stationId) ?? ev.station;
    if ((stationEntry as Record<string, unknown>)['enabled'] === false) {
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
    // Global (across-all-stations) upcoming-bookings cap. `null` skips.
    if (policy.maxTotalBookingsPerFlat !== null) {
      const heldAll = countTotalActiveEvBookingsForFlat(items, flatNorm, istDateStr(Date.now()));
      if (heldAll >= policy.maxTotalBookingsPerFlat) {
        throw new BadRequest(
          `Flat ${ownerFlatR} already has ${heldAll} active EV booking(s) ` +
          `(cap ${policy.maxTotalBookingsPerFlat} across all chargers). ` +
          `Cancel an existing booking first.`,
        );
      }
    }
    // Per-day booked-minutes cap for this flat, across all stations.
    // Sum only bookings on the same date — sits on top of the per-slot
    // `maxDurationMinutes` gate so residents can't queue up multiple
    // slots to exceed the daily allowance.
    if (policy.maxDailyMinutesPerFlat !== null) {
      const bookedToday   = sumBookedMinutesForFlatOnDate(items, flatNorm, date);
      const requested     = endMin - startMin;
      const wouldTotal    = bookedToday + requested;
      if (wouldTotal > policy.maxDailyMinutesPerFlat) {
        throw new BadRequest(
          `Flat ${ownerFlatR} would exceed the daily cap ` +
          `(${wouldTotal} min booked vs ${policy.maxDailyMinutesPerFlat} min allowed on ${date}). ` +
          `Reduce the duration or pick another day.`,
        );
      }
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

  // GET /ev/receipt/:id — digital receipt for a confirmed/completed booking.
  // Owner or MANAGER+. Gated by FEATURE_TSH_EV_CHARGING + FEATURE_TSH_EV_RECEIPT.
  // Spec: tsh_requirement.md §23.4 (Phase 3).
  r.get('/ev/receipt/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_RECEIPT],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const id = String(params['id'] || '');
    if (!EV_ID_RE.test(id)) throw new BadRequest('booking id is malformed');
    const { items } = await loadEvBookings(ctx);
    const row = items.find((r) => r.id === id);
    if (!row) throw new NotFound(`ev booking not found: ${id}`);
    const meEmail = ctx.identity!.email.toLowerCase();
    const isOwner = row.owner.email.toLowerCase() === meEmail;
    if (!isOwner && !isStaff(ctx)) {
      throw new Forbidden('Only the owner or a manager can view this receipt');
    }
    if (!isReceiptEligible(row)) {
      throw new BadRequest(
        `Receipt is only available for confirmed or completed bookings (current: ${row.status})`,
      );
    }
    const ev = resolveEvConfig(ctx);
    // Salt lets an admin rotate all receipt checksums by changing a single
    // system value without invalidating past bookings. Falls back to the
    // station id so a fresh install still produces stable checksums.
    const sys = ctx.config.system as Record<string, unknown>;
    const salt = String(
      (sys['evReceiptSalt'] as string | undefined)
      ?? (ev.station.id as string | undefined)
      ?? 'ev-1',
    );
    const qr = buildEvReceiptQr(row, salt);
    // Society block — pulled from system.society if present, else a
    // reasonable fallback so the receipt template always has something
    // to show. Editors can override any leaf via site.json.
    const societyRaw = (sys['society'] as Record<string, unknown> | undefined) || {};
    const society = {
      name:     String(societyRaw['name']    ?? 'The Address'),
      address:  String(societyRaw['address'] ?? ''),
      email:    String(societyRaw['email']   ?? ''),
      phone:    String(societyRaw['phone']   ?? ''),
      logoUrl:  String(sys['logoUrl']        ?? ''),
    };
    return ok(ctx.env, ctx.req, {
      item: row,
      station: {
        id:         ev.station.id,
        name:       ev.station.name,
        location:   ev.station.location,
        capacityKw: ev.station.capacityKw,
      },
      society,
      qr,
      provider: ev.provider,
      helpline: ev.helpline,
      generatedAt: new Date().toISOString(),
    });
  });

  // ---- Phase 4: Editor analytics dashboard --------------------------------
  // GET /ev/admin/dashboard?period=w|m|q|y — MANAGER+.
  // Gated by FEATURE_TSH_EV_CHARGING + FEATURE_TSH_EV_ADMIN_DASHBOARD.
  r.get('/ev/admin/dashboard', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_ADMIN_DASHBOARD],
      requireIdentity: true,
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
    });
    const url = new URL(ctx.req.url);
    const raw = String(url.searchParams.get('period') || 'm').toLowerCase();
    if (!['w','m','q','y'].includes(raw)) {
      throw new BadRequest('period must be one of: w, m, q, y');
    }
    const period = raw as EvAnalyticsPeriod;
    const range = resolveAnalyticsRange(period);
    const { items } = await loadEvBookings(ctx);
    const result = aggregateEvBookings(items, range, { topN: 5 });
    return ok(ctx.env, ctx.req, result);
  });

  // GET /ev/admin/export?period=w|m|q|y&format=csv|pdf — MANAGER+.
  // `csv` returns a text/csv attachment; `pdf` returns a print-ready
  // HTML doc that browsers can save-as-PDF (worker has no PDF gen dep).
  r.get('/ev/admin/export', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_ADMIN_DASHBOARD],
      requireIdentity: true,
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
    });
    const url = new URL(ctx.req.url);
    const raw = String(url.searchParams.get('period') || 'm').toLowerCase();
    if (!['w','m','q','y'].includes(raw)) {
      throw new BadRequest('period must be one of: w, m, q, y');
    }
    const format = String(url.searchParams.get('format') || 'csv').toLowerCase();
    if (!['csv','pdf'].includes(format)) {
      throw new BadRequest('format must be one of: csv, pdf');
    }
    const period = raw as EvAnalyticsPeriod;
    const range = resolveAnalyticsRange(period);
    const { items } = await loadEvBookings(ctx);
    const inRange = items.filter((b) => b.date >= range.from && b.date <= range.to);
    const stamp = `${range.from}_to_${range.to}`;
    if (format === 'csv') {
      const csv = bookingsToCsv(inRange);
      return new Response(csv, {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="ev-bookings_${stamp}.csv"`,
        },
      });
    }
    // format === 'pdf' → print-ready HTML.
    const ev = resolveEvConfig(ctx);
    const stationName = String(ev.station.name || 'EV Charger');
    const result = aggregateEvBookings(items, range, { topN: 10 });
    const escHtml = (s: unknown): string => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const pad = (n: number): string => (n < 10 ? '0' + n : '' + n);
    const hhmm = (m: number): string => pad(Math.floor(m/60)) + ':' + pad(m % 60);
    const rows = inRange.map((b) => `
      <tr>
        <td>${escHtml(b.id)}</td>
        <td>${escHtml(b.date)}</td>
        <td>${hhmm(b.startMin)}–${hhmm(b.endMin)}</td>
        <td>${escHtml(b.status)}</td>
        <td>${escHtml(b.owner.flat)}</td>
        <td>${escHtml(b.owner.email)}</td>
      </tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>EV Report ${escHtml(stamp)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; color: #111827; margin: 24px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  h2 { margin: 24px 0 8px; font-size: 15px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
  .meta { color: #6b7280; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  th { background: #f9fafb; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 12px 0; }
  .kpi { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; }
  .kpi .k { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
  .kpi .v { font-size: 20px; font-weight: 700; margin-top: 2px; }
  @media print { .no-print { display: none; } }
</style></head><body>
<h1>EV Charging Report</h1>
<p class="meta">${escHtml(stationName)} · ${escHtml(range.from)} to ${escHtml(range.to)} · Generated ${new Date().toISOString()}</p>
<h2>Key metrics</h2>
<div class="kpis">
  <div class="kpi"><div class="k">Total bookings</div><div class="v">${result.kpis.totalBookings}</div></div>
  <div class="kpi"><div class="k">Confirmed</div><div class="v">${result.kpis.confirmedBookings}</div></div>
  <div class="kpi"><div class="k">Completed</div><div class="v">${result.kpis.completedBookings}</div></div>
  <div class="kpi"><div class="k">Cancelled</div><div class="v">${result.kpis.cancelledBookings}</div></div>
  <div class="kpi"><div class="k">Hours booked</div><div class="v">${result.kpis.totalHours}</div></div>
  <div class="kpi"><div class="k">Unique flats</div><div class="v">${result.kpis.uniqueFlats}</div></div>
  <div class="kpi"><div class="k">Avg duration</div><div class="v">${result.kpis.avgMinutesPerBooking} min</div></div>
  <div class="kpi"><div class="k">Active now</div><div class="v">${result.kpis.activeBookings}</div></div>
</div>
<h2>Top flats</h2>
<table><thead><tr><th>Flat</th><th>Bookings</th><th>Minutes</th></tr></thead><tbody>
${result.topFlats.map((t) => `<tr><td>${escHtml(t.flat)}</td><td>${t.bookings}</td><td>${t.minutes}</td></tr>`).join('') || '<tr><td colspan="3">No confirmed/completed bookings in range.</td></tr>'}
</tbody></table>
<h2>Bookings (${inRange.length})</h2>
<table><thead><tr><th>ID</th><th>Date</th><th>Time</th><th>Status</th><th>Flat</th><th>Owner</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No bookings in range.</td></tr>'}</tbody></table>
<p class="no-print" style="margin-top:24px"><button onclick="window.print()">Print / Save as PDF</button></p>
</body></html>`;
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `inline; filename="ev-report_${stamp}.html"`,
      },
    });
  });

  // ---- Phase 5: mirror / auto reports ------------------------------------
  // POST /ev/admin/mirror — ADMIN only. Kicks off the monthly report + CSV
  // mirror job manually. Body: { month?: 'YYYY-MM' } (default = previous
  // full IST month). Gated by FEATURE_TSH_EV_CHARGING + FEATURE_TSH_EV_AUTO_REPORTS.
  //
  // See tsh_requirement.md §23.9 for the private-repo variant. The current
  // implementation writes to `backups/ev/YYYY-MM/{report.md,bookings.csv}`
  // in the same public repo; the private-repo split is a follow-up once
  // the ops grant is completed.
  r.post('/ev/admin/mirror', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_AUTO_REPORTS],
      requireIdentity: true,
      roles: ['ADMIN'],
    });
    const body = await parseJson<{ month?: unknown }>(ctx.req).catch(() => ({} as { month?: unknown }));
    const month = optStr((body as { month?: unknown }).month, 'month', { max: 7 });
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      throw new BadRequest('month must be YYYY-MM');
    }
    const ev = resolveEvConfig(ctx);
    const { items } = await loadEvBookings(ctx);
    const actorEmail = String(ctx.identity?.email || 'worker@tadeskops.local');
    const result = await runEvMirror(ctx.env, items, {
      month,
      stationName: String(ev.station.name ?? 'EV Charger'),
      authorEmail: actorEmail,
    });
    await writeAudit(ctx.env, {
      actor: actorEmail,
      action: 'ev.mirror.run',
      target: result.ran ? result.month : (month || 'auto'),
      detail: result.ran ? `changed=${result.changed} bookings=${result.bookings}` : `skipped: ${result.reason}`,
    });
    return ok(ctx.env, ctx.req, result);
  });

  // ==========================================================================
  //  Phase 6 — RFID lifecycle + Registration + Support ticket taxonomy.
  //  Three flag families, three data files. Same bounded-file pattern as
  //  ev-bookings.json. Spec: tsh_requirement.md §23.1 (Phase 6).
  // ==========================================================================

  // ---- RFID: config/ev-rfid-requests.json ----------------------------------

  r.post('/ev/rfid', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_RFID],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const body = await parseJson<{ type?: unknown; vehiclePlate?: unknown; cardCode?: unknown; notes?: unknown; ownerFlat?: unknown; ownerName?: unknown }>(ctx.req);
    const type = oneOf(body.type, 'type', RFID_TYPES);
    const vehiclePlate = optStr(body.vehiclePlate, 'vehiclePlate', { max: 20 });
    if (vehiclePlate && !normalizePlate(vehiclePlate)) {
      throw new BadRequest('vehiclePlate is malformed');
    }
    const cardCode = optStr(body.cardCode, 'cardCode', { max: 40 });
    const notes    = optStr(body.notes, 'notes', { max: 500 });
    const flat     = normalizeFlat(String(body.ownerFlat ?? ''));
    if (!flat) throw new BadRequest('ownerFlat is required');
    const email = ctx.identity!.email;
    const name  = optStr(body.ownerName, 'ownerName', { max: 80 }) || (ctx.identity!.name || email);

    const store = await loadRfidRequests(ctx);
    if (store.items.length >= RFID_MAX_ACTIVE_ITEMS) {
      throw new BadRequest(`ev-rfid file is full (${store.items.length}/${RFID_MAX_ACTIVE_ITEMS})`);
    }
    const nowIso = new Date().toISOString();
    const item: RfidRequest = {
      id: nextRfidId(),
      type,
      status: 'pending',
      owner: { email, name, flat },
      ...(vehiclePlate ? { vehiclePlate: normalizePlate(vehiclePlate)! } : {}),
      ...(cardCode ? { cardCode } : {}),
      ...(notes ? { notes } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const next = store.items.concat(item);
    await saveRfidRequests(ctx, next, store.sha, email, `create rfid ${item.id}`);
    await writeAudit(ctx.env, { actor: email, action: 'ev.rfid.create', target: item.id, detail: `type=${type}` });
    return ok(ctx.env, ctx.req, item);
  });

  r.get('/ev/rfid', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_RFID],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const url = new URL(ctx.req.url);
    const scope = (url.searchParams.get('scope') || 'own').toLowerCase();
    if (!['own', 'all'].includes(scope)) throw new BadRequest('scope must be own|all');
    if (scope === 'all' && !isStaff(ctx)) throw new Forbidden('scope=all requires Manager+');
    const { items } = await loadRfidRequests(ctx);
    const email = ctx.identity!.email;
    const filtered = scope === 'all' ? items : items.filter((it) => it.owner.email === email);
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return ok(ctx.env, ctx.req, { items: filtered });
  });

  r.patch('/ev/rfid/:id', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_RFID],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const id = String(params.id || '');
    if (!RFID_ID_RE.test(id)) throw new BadRequest('bad id');
    const body = await parseJson<{ status?: unknown; cardCode?: unknown; notes?: unknown }>(ctx.req);
    const nextStatus = oneOf(body.status, 'status', RFID_STATUSES);
    const cardCode   = optStr(body.cardCode, 'cardCode', { max: 40 });
    const notes      = optStr(body.notes, 'notes', { max: 500 });

    const { items, sha } = await loadRfidRequests(ctx);
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) throw new NotFound('rfid request not found');
    const it = items[idx]!;
    const email = ctx.identity!.email;
    // Residents can only cancel their own pending request. Staff can drive
    // the rest of the lifecycle.
    const staff = isStaff(ctx);
    const owner = it.owner.email === email;
    if (!staff && !owner) throw new Forbidden('not your request');
    if (!staff && nextStatus !== 'cancelled') throw new Forbidden('residents may only cancel');
    if (!canTransitionRfid(it.status, nextStatus)) {
      throw new BadRequest(`cannot go from ${it.status} to ${nextStatus}`);
    }
    const updated: RfidRequest = {
      ...it,
      status: nextStatus,
      ...(cardCode ? { cardCode } : {}),
      ...(notes ? { notes } : {}),
      ...(staff ? { reviewedBy: email } : {}),
      updatedAt: new Date().toISOString(),
    };
    const next = items.slice();
    next[idx] = updated;
    await saveRfidRequests(ctx, next, sha, email, `${nextStatus} rfid ${id}`);
    await writeAudit(ctx.env, { actor: email, action: 'ev.rfid.status', target: id, detail: `${it.status}->${nextStatus}` });
    return ok(ctx.env, ctx.req, updated);
  });

  // ---- Registration: config/ev-registrations.json --------------------------

  r.post('/ev/registration', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_REGISTRATION],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const body = await parseJson<{ vehicle?: unknown; ownerFlat?: unknown; ownerName?: unknown; notes?: unknown }>(ctx.req);
    const vRaw = body.vehicle as Record<string, unknown> | undefined;
    if (!vRaw || typeof vRaw !== 'object') throw new BadRequest('vehicle is required');
    const plate = normalizePlate(vRaw['plate']);
    if (!plate) throw new BadRequest('vehicle.plate is required (letters, digits, hyphens; 4..20 chars)');
    const make  = optStr(vRaw['make'],  'vehicle.make',  { max: 40 });
    const model = optStr(vRaw['model'], 'vehicle.model', { max: 60 });
    const connectorType = optStr(vRaw['connectorType'], 'vehicle.connectorType', { max: 20 });
    const batteryRaw = vRaw['batteryKwh'];
    let batteryKwh: number | undefined;
    if (batteryRaw !== undefined && batteryRaw !== null && batteryRaw !== '') {
      batteryKwh = num(batteryRaw, 'vehicle.batteryKwh', { min: 1, max: 500 });
    }
    const notes = optStr(body.notes, 'notes', { max: 500 });
    const flat  = normalizeFlat(String(body.ownerFlat ?? ''));
    if (!flat) throw new BadRequest('ownerFlat is required');
    const email = ctx.identity!.email;
    const name  = optStr(body.ownerName, 'ownerName', { max: 80 }) || (ctx.identity!.name || email);

    const store = await loadRegistrations(ctx);
    if (store.items.length >= REG_MAX_ACTIVE_ITEMS) {
      throw new BadRequest(`ev-registrations file is full (${store.items.length}/${REG_MAX_ACTIVE_ITEMS})`);
    }
    // Reject duplicate active registration for the same plate + owner.
    const dupe = store.items.find((it) => it.status === 'active' && it.vehicle.plate === plate && it.owner.email === email);
    if (dupe) throw new BadRequest('plate is already registered for this account');

    const nowIso = new Date().toISOString();
    const item: EvRegistration = {
      id: nextRegId(),
      status: 'active',
      owner: { email, name, flat },
      vehicle: {
        plate,
        ...(make ? { make } : {}),
        ...(model ? { model } : {}),
        ...(connectorType ? { connectorType } : {}),
        ...(batteryKwh !== undefined ? { batteryKwh } : {}),
      },
      ...(notes ? { notes } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const next = store.items.concat(item);
    await saveRegistrations(ctx, next, store.sha, email, `create registration ${item.id}`);
    await writeAudit(ctx.env, { actor: email, action: 'ev.registration.create', target: item.id, detail: `plate=${plate}` });
    return ok(ctx.env, ctx.req, item);
  });

  r.get('/ev/registration', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_REGISTRATION],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const url = new URL(ctx.req.url);
    const scope = (url.searchParams.get('scope') || 'own').toLowerCase();
    if (!['own', 'all'].includes(scope)) throw new BadRequest('scope must be own|all');
    if (scope === 'all' && !isStaff(ctx)) throw new Forbidden('scope=all requires Manager+');
    const { items } = await loadRegistrations(ctx);
    const email = ctx.identity!.email;
    const filtered = scope === 'all' ? items : items.filter((it) => it.owner.email === email);
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return ok(ctx.env, ctx.req, { items: filtered });
  });

  r.patch('/ev/registration/:id', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_REGISTRATION],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const id = String(params.id || '');
    if (!REG_ID_RE.test(id)) throw new BadRequest('bad id');
    const body = await parseJson<{ status?: unknown; notes?: unknown }>(ctx.req);
    const nextStatus = oneOf(body.status, 'status', REG_STATUSES);
    const notes = optStr(body.notes, 'notes', { max: 500 });

    const { items, sha } = await loadRegistrations(ctx);
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) throw new NotFound('registration not found');
    const it = items[idx]!;
    const email = ctx.identity!.email;
    if (it.owner.email !== email && !isStaff(ctx)) throw new Forbidden('not your registration');
    if (it.status === nextStatus) {
      // Idempotent no-op — return existing item without a save.
      return ok(ctx.env, ctx.req, it);
    }
    const updated: EvRegistration = {
      ...it,
      status: nextStatus,
      ...(notes ? { notes } : {}),
      updatedAt: new Date().toISOString(),
    };
    const next = items.slice();
    next[idx] = updated;
    await saveRegistrations(ctx, next, sha, email, `${nextStatus} registration ${id}`);
    await writeAudit(ctx.env, { actor: email, action: 'ev.registration.status', target: id, detail: `${it.status}->${nextStatus}` });
    return ok(ctx.env, ctx.req, updated);
  });

  // ---- Support: config/ev-support-tickets.json -----------------------------

  r.post('/ev/support', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_SUPPORT],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const body = await parseJson<{ category?: unknown; subject?: unknown; message?: unknown; relatedBookingId?: unknown; ownerFlat?: unknown; ownerName?: unknown }>(ctx.req);
    const category = oneOf(body.category, 'category', SUPPORT_CATEGORIES);
    const subject  = str(body.subject, 'subject', { min: 1, max: 120 });
    const message  = str(body.message, 'message', { min: 1, max: 2000 });
    const relatedBookingId = optStr(body.relatedBookingId, 'relatedBookingId', { max: 32 });
    if (relatedBookingId && !EV_ID_RE.test(relatedBookingId)) {
      throw new BadRequest('relatedBookingId is malformed');
    }
    const flat  = normalizeFlat(String(body.ownerFlat ?? ''));
    if (!flat) throw new BadRequest('ownerFlat is required');
    const email = ctx.identity!.email;
    const name  = optStr(body.ownerName, 'ownerName', { max: 80 }) || (ctx.identity!.name || email);

    const store = await loadSupportTickets(ctx);
    if (store.items.length >= SUPPORT_MAX_ACTIVE_ITEMS) {
      throw new BadRequest(`ev-support file is full (${store.items.length}/${SUPPORT_MAX_ACTIVE_ITEMS})`);
    }
    const nowIso = new Date().toISOString();
    const item: SupportTicket = {
      id: nextSupportId(),
      category,
      status: 'open',
      owner: { email, name, flat },
      subject,
      message,
      ...(relatedBookingId ? { relatedBookingId } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const next = store.items.concat(item);
    await saveSupportTickets(ctx, next, store.sha, email, `open support ${item.id}`);
    await writeAudit(ctx.env, { actor: email, action: 'ev.support.create', target: item.id, detail: `category=${category}` });
    return ok(ctx.env, ctx.req, item);
  });

  r.get('/ev/support', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_SUPPORT],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const url = new URL(ctx.req.url);
    const scope = (url.searchParams.get('scope') || 'own').toLowerCase();
    if (!['own', 'all'].includes(scope)) throw new BadRequest('scope must be own|all');
    if (scope === 'all' && !isStaff(ctx)) throw new Forbidden('scope=all requires Manager+');
    const { items } = await loadSupportTickets(ctx);
    const email = ctx.identity!.email;
    const filtered = scope === 'all' ? items : items.filter((it) => it.owner.email === email);
    filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return ok(ctx.env, ctx.req, { items: filtered });
  });

  r.patch('/ev/support/:id', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: [FEATURE, FEATURE_SUPPORT],
      requireIdentity: true,
      roles: RESIDENT_UP,
    });
    const id = String(params.id || '');
    if (!SUPPORT_ID_RE.test(id)) throw new BadRequest('bad id');
    const body = await parseJson<{ status?: unknown; resolutionNote?: unknown }>(ctx.req);
    const nextStatus = oneOf(body.status, 'status', SUPPORT_STATUSES);
    const resolutionNote = optStr(body.resolutionNote, 'resolutionNote', { max: 500 });

    const { items, sha } = await loadSupportTickets(ctx);
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) throw new NotFound('support ticket not found');
    const it = items[idx]!;
    const email = ctx.identity!.email;
    // Only staff can update support ticket status. Residents can only
    // "close" their own tickets.
    const staff = isStaff(ctx);
    const owner = it.owner.email === email;
    if (!staff && !owner) throw new Forbidden('not your ticket');
    if (!staff && nextStatus !== 'closed') throw new Forbidden('residents may only close');
    if (!canTransitionSupport(it.status, nextStatus)) {
      throw new BadRequest(`cannot go from ${it.status} to ${nextStatus}`);
    }
    const updated: SupportTicket = {
      ...it,
      status: nextStatus,
      ...(resolutionNote ? { resolutionNote } : {}),
      ...(staff ? { handledBy: email } : {}),
      updatedAt: new Date().toISOString(),
    };
    const next = items.slice();
    next[idx] = updated;
    await saveSupportTickets(ctx, next, sha, email, `${nextStatus} support ${id}`);
    await writeAudit(ctx.env, { actor: email, action: 'ev.support.status', target: id, detail: `${it.status}->${nextStatus}` });
    return ok(ctx.env, ctx.req, updated);
  });

  // ---- Phase 7: Station online/offline toggle (2026-08-02) ----------------
  // PATCH /ev/stations/:id — MANAGER+ can flip a station between ONLINE
  // and UNDER MAINTENANCE without leaving the page. Persists directly to
  // system.ev.stations[i] in config/site.json so the change is durable
  // and visible to every visitor immediately (subject to the 60s config
  // cache). Kept narrow (only `enabled` + optional `maintenanceReason`)
  // so operators can toggle without accidentally clobbering other
  // station metadata (image, series, capacityKw, etc.).
  //
  // Body:
  //   { enabled: boolean, maintenanceReason?: string }
  // When enabled=false and no reason supplied, defaults to "Temporarily
  // unavailable". When enabled=true, the maintenanceReason field is
  // cleared so the next disable can supply a fresh reason.
  r.patch('/ev/stations/:id', async (ctx: Ctx, params: Record<string, string>) => {
    ensureAllowed(ctx, {
      flags: [FEATURE],
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
      requireIdentity: true,
    });
    const id = String(params['id'] || '').trim();
    if (!id) throw new BadRequest('station id is required');
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    if (typeof body['enabled'] !== 'boolean') {
      throw new BadRequest('enabled must be a boolean');
    }
    const nextEnabled = body['enabled'] as boolean;
    const nextReason  = nextEnabled
      ? ''
      : (optStr(body['maintenanceReason'], 'maintenanceReason', { max: 200 })
          ?? 'Temporarily unavailable');

    const siteFile = await getFile(ctx.env, 'config/site.json');
    if (!siteFile) throw new BadRequest('config/site.json not found');
    let site: Record<string, unknown>;
    try { site = JSON.parse(siteFile.content) as Record<string, unknown>; }
    catch { throw new BadRequest('config/site.json is not valid JSON'); }

    const system = (site['system'] && typeof site['system'] === 'object')
      ? site['system'] as Record<string, unknown>
      : {};
    const ev = (system['ev'] && typeof system['ev'] === 'object')
      ? system['ev'] as Record<string, unknown>
      : {};
    const rawStations = ev['stations'];
    if (!Array.isArray(rawStations) || rawStations.length === 0) {
      throw new NotFound('no stations configured');
    }
    const idx = rawStations.findIndex((s: unknown) =>
      s && typeof s === 'object' && String((s as Record<string, unknown>)['id'] ?? '') === id,
    );
    if (idx === -1) throw new NotFound(`station not found: ${id}`);

    const before = rawStations[idx] as Record<string, unknown>;
    const updated: Record<string, unknown> = { ...before, enabled: nextEnabled };
    if (nextEnabled) {
      // Clear the maintenance reason on re-enable so a stale message
      // does not linger.
      delete updated['maintenanceReason'];
    } else {
      updated['maintenanceReason'] = nextReason;
    }
    // Short-circuit if nothing actually changed — avoids a no-op commit.
    if (
      (before['enabled'] !== false) === nextEnabled &&
      String(before['maintenanceReason'] ?? '') === nextReason
    ) {
      return ok(ctx.env, ctx.req, { station: updated });
    }
    const nextStations = rawStations.slice();
    nextStations[idx] = updated;
    ev['stations'] = nextStations;
    system['ev']   = ev;
    site['system'] = system;

    const actor = ctx.identity!.email;
    const serialised = JSON.stringify(site, null, 2) + '\n';
    const label = nextEnabled ? 'online' : 'maintenance';
    await putFile(
      ctx.env, 'config/site.json', serialised,
      `ev: station ${id} → ${label} by ${actor}`,
      actor, siteFile.sha,
    );
    await writeAudit(ctx.env, {
      actor, action: 'ev.station.toggle', target: id,
      detail: nextEnabled ? 'online' : `maintenance: ${nextReason}`,
    });
    return ok(ctx.env, ctx.req, { station: updated });
  });
};

// EV Charging booking domain helpers (Phase 2).
// Pure functions — no I/O, no ctx — so they can be unit-tested in isolation.
// Spec: tsh_requirement.md §23.4 (Phase 2).

import { BadRequest } from './errors.ts';
import { istDateStr, parseIstDateMidnight, normalizeFlat, overlapsRange } from './reservation.ts';

// ---- Types -----------------------------------------------------------------

export const EV_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'] as const;
export type EvBookingStatus = typeof EV_STATUSES[number];

// EV-DDMMYYHHMM[-N]  — same shape as reservation IDs (10 digits after prefix)
export const EV_ID_RE = /^EV-\d{10}(?:-\d+)?$/;

/** One booking record on the community EV charger. Persisted in
 *  `config/ev-bookings.json` as an item of `{ version, items[] }`. */
export interface EvBooking {
  id: string;              // EV-DDMMYYHHMM[-N]
  stationId: string;       // ev.station.id
  date: string;            // YYYY-MM-DD, IST
  startMin: number;        // minutes-since-midnight IST
  endMin: number;
  status: EvBookingStatus;
  owner: { email: string; name?: string; flat: string };
  createdBy: { email: string; name?: string; role?: string };
  createdAt: string;       // ISO
  updatedAt: string;       // ISO
  notes?: string;
  cancelledAt?: string;    // ISO — set when moving to 'cancelled'
  cancelledBy?: string;    // email — actor that cancelled
  cancelReason?: string;
}

/** Effective booking policy — either straight from site.json → ev.booking
 *  or filled in from DEFAULT_CONFIG. Every field is guaranteed present.
 *
 *  Editor-tunable knobs (Aug-2026):
 *  - `advanceWindowDays` — Tatkal-style cap on how many days ahead a
 *    resident may book. Default 2. Config lives in `site.json`.
 *  - `maxDailyMinutesPerFlat` — max total booked minutes per flat per
 *    IST calendar date, summed across ALL stations. `null` = no cap.
 *  - `maxTotalBookingsPerFlat` — hard cap on active (upcoming) bookings
 *    held by a single flat across ALL stations. `null` = no cap.
 *  The legacy per-station `maxActivePerFlat` continues to apply on top
 *  of these globals so a single-station deployment behaves unchanged. */
export interface EvBookingPolicy {
  stepMinutes: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  bufferMinutes: number;
  advanceWindowDays: number;
  maxActivePerFlat: number;
  /** Max total upcoming bookings held by a flat across ALL stations.
   *  `null` = unlimited. */
  maxTotalBookingsPerFlat: number | null;
  /** Max total booked minutes per flat per IST calendar date across
   *  ALL stations. `null` = unlimited. */
  maxDailyMinutesPerFlat: number | null;
  openMin: number;
  closeMin: number;
  requiresApproval: boolean;
  blackoutDates: string[];
}

/** A time-slot cell returned by the availability grid. */
export interface EvSlot {
  startMin: number;
  endMin: number;
  booked: boolean;
  bookingId?: string;
}

// ---- Constants -------------------------------------------------------------

/** Cap for `config/ev-bookings.json` to keep the file GitHub-Contents-friendly.
 *  Phase 5 archives older records into the private mirror. */
export const EV_MAX_ACTIVE_ITEMS = 500;

/** Maximum window (in days) an availability GET may span in one call. */
export const EV_AVAILABILITY_MAX_DAYS = 14;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const p2 = (n: number): string => String(n).padStart(2, '0');
const istParts = (ms: number) => {
  const t = new Date(ms + IST_OFFSET_MS);
  return {
    d:  t.getUTCDate(),
    m:  t.getUTCMonth() + 1,
    y:  t.getUTCFullYear() % 100,
    h:  t.getUTCHours(),
    mi: t.getUTCMinutes(),
  };
};

// ---- Policy resolution -----------------------------------------------------

/** Merge a partial `ev.booking` block onto the baked-in defaults. Missing /
 *  wrong-typed leaves fall back to the DEFAULT_CONFIG values, so downstream
 *  code never has to guard for undefined. */
export const effectiveBookingPolicy = (raw: unknown): EvBookingPolicy => {
  const DEF: EvBookingPolicy = {
    stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
    bufferMinutes: 5, advanceWindowDays: 2, maxActivePerFlat: 1,
    maxTotalBookingsPerFlat: null, maxDailyMinutesPerFlat: null,
    openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [],
  };
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  const numOr = (k: string, def: number): number => {
    const v = src[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  };
  // Nullable knobs: `null` (or the string "null" / missing / non-finite)
  // means "no cap". Positive finite numbers are honoured verbatim. A
  // number <= 0 also flips to unlimited so admins can type 0 to disable.
  const nullableNum = (k: string): number | null => {
    const v = src[k];
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    return null;
  };
  const boolOr = (k: string, def: boolean): boolean => {
    const v = src[k];
    return typeof v === 'boolean' ? v : def;
  };
  const dates = Array.isArray(src['blackoutDates'])
    ? (src['blackoutDates'] as unknown[]).filter((s): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s))
    : DEF.blackoutDates;
  return {
    stepMinutes:             numOr('stepMinutes',        DEF.stepMinutes),
    minDurationMinutes:      numOr('minDurationMinutes', DEF.minDurationMinutes),
    maxDurationMinutes:      numOr('maxDurationMinutes', DEF.maxDurationMinutes),
    bufferMinutes:           numOr('bufferMinutes',      DEF.bufferMinutes),
    advanceWindowDays:       numOr('advanceWindowDays',  DEF.advanceWindowDays),
    maxActivePerFlat:        numOr('maxActivePerFlat',   DEF.maxActivePerFlat),
    maxTotalBookingsPerFlat: nullableNum('maxTotalBookingsPerFlat'),
    maxDailyMinutesPerFlat:  nullableNum('maxDailyMinutesPerFlat'),
    openMin:                 numOr('openMin',            DEF.openMin),
    closeMin:                numOr('closeMin',           DEF.closeMin),
    requiresApproval:        boolOr('requiresApproval',  DEF.requiresApproval),
    blackoutDates:           dates,
  };
};

// ---- ID allocation ---------------------------------------------------------

const EV_PREFIX = 'EV';

const formatEvIdBase = (ms: number): string => {
  const { d, m, y, h, mi } = istParts(ms);
  return `${EV_PREFIX}-${p2(d)}${p2(m)}${p2(y)}${p2(h)}${p2(mi)}`;
};

/** Allocate a fresh `EV-…` id that does not collide with `existing`. */
export const nextEvBookingId = (existing: ReadonlySet<string>, now?: number): string => {
  const base = formatEvIdBase(typeof now === 'number' ? now : Date.now());
  if (!existing.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const cand = `${base}-${n}`;
    if (!existing.has(cand)) return cand;
  }
  throw new Error('Could not allocate unique EV booking id in the same minute');
};

// ---- Status helpers --------------------------------------------------------

/** Whether the booking occupies a slot (blocks concurrent bookings). */
export const isActiveEvBooking = (r: Pick<EvBooking, 'status'>): boolean =>
  r.status === 'pending' || r.status === 'confirmed';

/**
 * Whether a status transition is allowed.
 *   - Owners may cancel their own PENDING/CONFIRMED booking.
 *   - Managers (canManage=true) may drive any transition, including
 *     PENDING→CONFIRMED (approve), CONFIRMED→COMPLETED (close out), or
 *     anything→CANCELLED (override). Terminal statuses stay terminal.
 */
export const canTransitionEv = (
  from: EvBookingStatus,
  to: EvBookingStatus,
  opts: { isOwner: boolean; canManage: boolean },
): boolean => {
  if (from === to) return false;
  if (from === 'cancelled' || from === 'completed') return false;
  if (opts.canManage) {
    // Manager transitions
    if (from === 'pending'   && (to === 'confirmed' || to === 'cancelled')) return true;
    if (from === 'confirmed' && (to === 'completed' || to === 'cancelled')) return true;
    return false;
  }
  if (opts.isOwner) {
    // Owner can only cancel an upcoming booking of their own
    return to === 'cancelled' && (from === 'pending' || from === 'confirmed');
  }
  return false;
};

// ---- Window / range validation --------------------------------------------

/** IST midnight ms for the calendar day containing `nowMs`. */
const istMidnightOf = (nowMs: number): number => parseIstDateMidnight(istDateStr(nowMs));

/** Whether `date` (YYYY-MM-DD) falls inside the allowed booking window,
 *  i.e. `today .. today + advanceWindowDays`, and is NOT blacked-out. */
export const validateBookingWindow = (
  policy: EvBookingPolicy,
  date: string,
  nowMs: number,
): void => {
  const dateMs   = parseIstDateMidnight(date);
  const todayMs  = istMidnightOf(nowMs);
  const dayMs    = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((dateMs - todayMs) / dayMs);
  if (diffDays < 0) {
    throw new BadRequest(`date is in the past (IST): ${date}`);
  }
  if (diffDays > policy.advanceWindowDays) {
    throw new BadRequest(
      `date is beyond the advance-booking window (${policy.advanceWindowDays} days): ${date}`,
    );
  }
  if (policy.blackoutDates.includes(date)) {
    throw new BadRequest(`date ${date} is blacked out for EV charging`);
  }
};

/** Validate a proposed [startMin, endMin) range against the policy:
 *  ordering, step alignment, duration bounds, and open/close bounds. */
export const validateTimeRange = (
  policy: EvBookingPolicy,
  startMin: number,
  endMin: number,
): void => {
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) {
    throw new BadRequest('startMin / endMin must be numbers');
  }
  if (startMin < 0 || endMin > 24 * 60) {
    throw new BadRequest('startMin / endMin must be within 0..1440');
  }
  if (endMin <= startMin) {
    throw new BadRequest('endMin must be strictly after startMin');
  }
  if (startMin < policy.openMin || endMin > policy.closeMin) {
    throw new BadRequest(
      `booking must lie within ${policy.openMin}..${policy.closeMin} minutes`,
    );
  }
  if (policy.stepMinutes > 0) {
    if ((startMin - policy.openMin) % policy.stepMinutes !== 0
        || (endMin - policy.openMin) % policy.stepMinutes !== 0) {
      throw new BadRequest(`booking edges must align to ${policy.stepMinutes}-min steps`);
    }
  }
  const dur = endMin - startMin;
  if (dur < policy.minDurationMinutes) {
    throw new BadRequest(`booking is shorter than the minimum (${policy.minDurationMinutes} min)`);
  }
  if (dur > policy.maxDurationMinutes) {
    throw new BadRequest(`booking is longer than the maximum (${policy.maxDurationMinutes} min)`);
  }
};

// ---- Overlap / quota checks -----------------------------------------------

/** Find an existing active booking that would overlap (respecting the
 *  policy `bufferMinutes`) the proposed [startMin, endMin) on `stationId`
 *  on `date`. Returns the conflicting booking's id, or null if free. */
export const findEvOverlap = (
  items: readonly EvBooking[],
  stationId: string,
  date: string,
  startMin: number,
  endMin: number,
  bufferMinutes: number,
  excludeId?: string,
): string | null => {
  const b = Math.max(0, bufferMinutes);
  for (const r of items) {
    if (excludeId && r.id === excludeId) continue;
    if (r.stationId !== stationId) continue;
    if (r.date !== date) continue;
    if (!isActiveEvBooking(r)) continue;
    if (overlapsRange(startMin - b, endMin + b, r.startMin, r.endMin)) {
      return r.id;
    }
  }
  return null;
};

/** Count the number of active (upcoming) bookings held by a given flat on
 *  a specific station. Anchor is IST calendar date — anything strictly
 *  before `today` is not counted (the caller supplies `todayIstDate`). */
export const countActiveEvBookingsForFlat = (
  items: readonly EvBooking[],
  stationId: string,
  flatNorm: string,
  todayIstDate: string,
): number => {
  let n = 0;
  for (const r of items) {
    if (r.stationId !== stationId) continue;
    if (!isActiveEvBooking(r)) continue;
    if (r.date < todayIstDate) continue;
    if (!r.owner.flat) continue;
    if (normalizeFlat(r.owner.flat) !== flatNorm) continue;
    n++;
  }
  return n;
};

/** Count TOTAL active (upcoming) bookings held by a flat across ALL
 *  stations. Anchor is `todayIstDate`; past dates do not count. Used to
 *  enforce the editor-tunable `maxTotalBookingsPerFlat` cap. */
export const countTotalActiveEvBookingsForFlat = (
  items: readonly EvBooking[],
  flatNorm: string,
  todayIstDate: string,
): number => {
  let n = 0;
  for (const r of items) {
    if (!isActiveEvBooking(r)) continue;
    if (r.date < todayIstDate) continue;
    if (!r.owner.flat) continue;
    if (normalizeFlat(r.owner.flat) !== flatNorm) continue;
    n++;
  }
  return n;
};

/** Sum the total booked MINUTES for a flat on a specific IST date,
 *  across ALL stations. Used to enforce `maxDailyMinutesPerFlat`. */
export const sumBookedMinutesForFlatOnDate = (
  items: readonly EvBooking[],
  flatNorm: string,
  date: string,
): number => {
  let total = 0;
  for (const r of items) {
    if (r.date !== date) continue;
    if (!isActiveEvBooking(r)) continue;
    if (!r.owner.flat) continue;
    if (normalizeFlat(r.owner.flat) !== flatNorm) continue;
    total += Math.max(0, r.endMin - r.startMin);
  }
  return total;
};

// ---- Availability grid -----------------------------------------------------

/** Build the slot grid for a single date. Each slot spans `stepMinutes`
 *  and is marked `booked: true` when it (or any minute of it) collides
 *  with an active booking on `stationId` — buffer is intentionally NOT
 *  applied to the grid so residents can see the raw availability; only
 *  `findEvOverlap` at booking-time uses the buffer. */
export const computeAvailability = (
  policy: EvBookingPolicy,
  stationId: string,
  date: string,
  items: readonly EvBooking[],
): EvSlot[] => {
  const step = policy.stepMinutes > 0 ? policy.stepMinutes : 30;
  const slots: EvSlot[] = [];
  const busy: Array<{ startMin: number; endMin: number; id: string }> = [];
  for (const r of items) {
    if (r.stationId !== stationId) continue;
    if (r.date !== date) continue;
    if (!isActiveEvBooking(r)) continue;
    busy.push({ startMin: r.startMin, endMin: r.endMin, id: r.id });
  }
  for (let s = policy.openMin; s + step <= policy.closeMin; s += step) {
    const e = s + step;
    const hit = busy.find((b) => overlapsRange(s, e, b.startMin, b.endMin));
    const slot: EvSlot = {
      startMin: s,
      endMin:   e,
      booked:   Boolean(hit),
    };
    if (hit) slot.bookingId = hit.id;
    slots.push(slot);
  }
  return slots;
};


// ---- Phase 3: Digital receipt helpers ---------------------------------------

/** Payload embedded in the QR code on the digital receipt. Everything a
 *  verifier needs to prove the booking's authenticity without a network
 *  hop: the id, station, time-range and a deterministic checksum. */
export interface EvReceiptQrPayload {
  v: 1;
  id: string;
  station: string;
  date: string;
  startMin: number;
  endMin: number;
  ownerFlat: string;
  checksum: string;
}

// Small djb2-style hash — deterministic across runs, no crypto dependency.
// Used only as a tamper-evident checksum on the printed QR, not as an
// authentication token. Salt lets an editor rotate hashes without
// invalidating past receipts they still have in email.
export const evReceiptChecksum = (b: EvBooking, salt: string): string => {
  const src = [
    b.id, b.stationId, b.date,
    String(b.startMin), String(b.endMin),
    b.owner.flat.toLowerCase(),
    b.status,
    salt || '',
  ].join('|');
  let h = 5381;
  for (let i = 0; i < src.length; i++) {
    h = ((h << 5) + h + src.charCodeAt(i)) & 0xffffffff;
  }
  // Return as 8-hex-char string (unsigned) so the QR payload stays compact.
  return (h >>> 0).toString(16).padStart(8, '0');
};

export const buildEvReceiptQr = (b: EvBooking, salt: string): EvReceiptQrPayload => ({
  v: 1,
  id: b.id,
  station: b.stationId,
  date: b.date,
  startMin: b.startMin,
  endMin: b.endMin,
  ownerFlat: b.owner.flat,
  checksum: evReceiptChecksum(b, salt),
});

/** True when the booking is in a state where a printable receipt makes
 *  sense — confirmed / completed. Pending is deliberately excluded (no
 *  legal booking yet); cancelled is excluded (voided). */
export const isReceiptEligible = (b: EvBooking): boolean =>
  b.status === 'confirmed' || b.status === 'completed';

// ---- Phase 4: Editor analytics dashboard helpers ---------------------------

export type EvAnalyticsPeriod = 'w' | 'm' | 'q' | 'y';

export interface EvAnalyticsRange {
  period: EvAnalyticsPeriod;
  from: string;              // YYYY-MM-DD (inclusive, IST)
  to: string;                // YYYY-MM-DD (inclusive, IST)
}

export interface EvAnalyticsKpis {
  totalBookings:     number;
  activeBookings:    number;  // pending + confirmed
  completedBookings: number;
  cancelledBookings: number;
  pendingBookings:   number;
  confirmedBookings: number;
  totalMinutes:      number;
  totalHours:        number;
  uniqueFlats:       number;
  uniqueOwners:      number;
  avgMinutesPerBooking: number;
}

export interface EvAnalyticsResult {
  period: EvAnalyticsPeriod;
  from: string;
  to: string;
  kpis: EvAnalyticsKpis;
  byDay:   Array<{ date: string; count: number; minutes: number }>;
  byHour:  Array<{ hour: number; count: number; minutes: number }>;   // 0..23
  byStatus: Array<{ status: EvBookingStatus; count: number }>;
  topFlats: Array<{ flat: string; bookings: number; minutes: number }>;
  bookings: EvBooking[];
}

// Resolve the [from, to] window (inclusive, IST YYYY-MM-DD) for a period
// relative to the given "now" epoch-ms. Kept pure so the caller decides
// what "now" means (tests inject a fixed timestamp). The window is
// past-heavy — it ends `advanceWindowDays` days into the future so
// upcoming (already-confirmed) bookings are counted alongside history.
export const resolveAnalyticsRange = (
  period: EvAnalyticsPeriod,
  nowMs: number = Date.now(),
  advanceWindowDays: number = 30,
): EvAnalyticsRange => {
  const dayMs = 24 * 60 * 60 * 1000;
  let spanDays: number;
  switch (period) {
    case 'w': spanDays = 7; break;
    case 'm': spanDays = 30; break;
    case 'q': spanDays = 90; break;
    case 'y': spanDays = 365; break;
    default:  spanDays = 30;
  }
  const fromMs = nowMs - (spanDays - 1) * dayMs;
  const toMs   = nowMs + advanceWindowDays * dayMs;
  return { period, from: istDateStr(fromMs), to: istDateStr(toMs) };
};

const withinRange = (dateStr: string, from: string, to: string): boolean =>
  dateStr >= from && dateStr <= to;

// Aggregate a booking list over a resolved period. All counts are integer
// booking counts; minutes are summed durations. Booked-then-cancelled
// entries still contribute to cancelledBookings but not to totalMinutes.
export const aggregateEvBookings = (
  items: readonly EvBooking[],
  range: EvAnalyticsRange,
  { topN = 5 }: { topN?: number } = {},
): EvAnalyticsResult => {
  const inRange = items.filter((b) => withinRange(b.date, range.from, range.to));

  // KPIs.
  let totalMinutes = 0;
  let pending = 0, confirmed = 0, completed = 0, cancelled = 0;
  const flats = new Set<string>();
  const owners = new Set<string>();
  for (const b of inRange) {
    const dur = Math.max(0, b.endMin - b.startMin);
    if (b.status === 'pending')   { pending++; }
    if (b.status === 'confirmed') { confirmed++; totalMinutes += dur; }
    if (b.status === 'completed') { completed++; totalMinutes += dur; }
    if (b.status === 'cancelled') { cancelled++; }
    flats.add(normalizeFlat(b.owner.flat));
    owners.add(b.owner.email.toLowerCase());
  }

  const totalBookings = inRange.length;
  const activeBookings = pending + confirmed;
  const kpis: EvAnalyticsKpis = {
    totalBookings,
    activeBookings,
    pendingBookings:   pending,
    confirmedBookings: confirmed,
    completedBookings: completed,
    cancelledBookings: cancelled,
    totalMinutes,
    totalHours: Math.round((totalMinutes / 60) * 100) / 100,
    uniqueFlats:  flats.size,
    uniqueOwners: owners.size,
    avgMinutesPerBooking: totalBookings > 0
      ? Math.round(totalMinutes / totalBookings)
      : 0,
  };

  // By day (fill zero days so the chart never has gaps).
  const dayMap = new Map<string, { count: number; minutes: number }>();
  const dayMs = 24 * 60 * 60 * 1000;
  const fromMs = parseIstDateMidnight(range.from);
  const toMs   = parseIstDateMidnight(range.to);
  for (let t = fromMs; t <= toMs; t += dayMs) {
    dayMap.set(istDateStr(t), { count: 0, minutes: 0 });
  }
  for (const b of inRange) {
    const bucket = dayMap.get(b.date);
    if (bucket) {
      bucket.count += 1;
      if (b.status !== 'cancelled') bucket.minutes += Math.max(0, b.endMin - b.startMin);
    }
  }
  const byDay = Array.from(dayMap.entries()).map(([date, v]) => ({ date, ...v }));

  // By hour of day (0..23). Uses startMin's hour bucket.
  const hourBuckets: Array<{ hour: number; count: number; minutes: number }> = [];
  for (let h = 0; h < 24; h++) hourBuckets.push({ hour: h, count: 0, minutes: 0 });
  for (const b of inRange) {
    if (b.status === 'cancelled') continue;
    const h = Math.max(0, Math.min(23, Math.floor(b.startMin / 60)));
    const bucket = hourBuckets[h]!;
    bucket.count += 1;
    bucket.minutes += Math.max(0, b.endMin - b.startMin);
  }

  const byStatus: Array<{ status: EvBookingStatus; count: number }> = [
    { status: 'pending',   count: pending   },
    { status: 'confirmed', count: confirmed },
    { status: 'completed', count: completed },
    { status: 'cancelled', count: cancelled },
  ];

  // Top flats by minutes booked (confirmed + completed only). Excludes
  // cancelled records so a spam-booker cannot rank higher.
  const flatMap = new Map<string, { bookings: number; minutes: number }>();
  for (const b of inRange) {
    if (b.status === 'cancelled' || b.status === 'pending') continue;
    const key = normalizeFlat(b.owner.flat);
    const bucket = flatMap.get(key) || { bookings: 0, minutes: 0 };
    bucket.bookings += 1;
    bucket.minutes  += Math.max(0, b.endMin - b.startMin);
    flatMap.set(key, bucket);
  }
  const topFlats = Array.from(flatMap.entries())
    .map(([flat, v]) => ({ flat, ...v }))
    .sort((a, b) => (b.minutes - a.minutes) || (b.bookings - a.bookings))
    .slice(0, topN);

  return { period: range.period, from: range.from, to: range.to, kpis, byDay, byHour: hourBuckets, byStatus, topFlats, bookings: inRange };
};

// CSV export of the in-range booking list. Kept dependency-free — quote
// fields containing commas/quotes/newlines with RFC-4180 doubling.
const csvEscape = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
};
export const bookingsToCsv = (items: readonly EvBooking[]): string => {
  const header = [
    'id','stationId','date','startTime','endTime','minutes','status',
    'ownerEmail','ownerName','ownerFlat','createdAt','updatedAt',
    'cancelledAt','cancelledBy','cancelReason','notes',
  ];
  const rows = items.map((b) => {
    const mins = Math.max(0, b.endMin - b.startMin);
    const pad = (n: number): string => (n < 10 ? '0' + n : '' + n);
    const hhmm = (m: number): string => pad(Math.floor(m/60)) + ':' + pad(m % 60);
    return [
      b.id, b.stationId, b.date, hhmm(b.startMin), hhmm(b.endMin), mins, b.status,
      b.owner.email, b.owner.name || '', b.owner.flat,
      b.createdAt, b.updatedAt,
      b.cancelledAt || '', b.cancelledBy || '', b.cancelReason || '',
      b.notes || '',
    ].map(csvEscape).join(',');
  });
  return [header.join(','), ...rows].join('\n') + '\n';
};
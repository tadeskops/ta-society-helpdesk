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
 *  or filled in from DEFAULT_CONFIG. Every field is guaranteed present. */
export interface EvBookingPolicy {
  stepMinutes: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  bufferMinutes: number;
  advanceWindowDays: number;
  maxActivePerFlat: number;
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
    bufferMinutes: 5, advanceWindowDays: 7, maxActivePerFlat: 1,
    openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [],
  };
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? raw as Record<string, unknown>
    : {};
  const numOr = (k: keyof EvBookingPolicy, def: number): number => {
    const v = src[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  };
  const boolOr = (k: keyof EvBookingPolicy, def: boolean): boolean => {
    const v = src[k];
    return typeof v === 'boolean' ? v : def;
  };
  const dates = Array.isArray(src['blackoutDates'])
    ? (src['blackoutDates'] as unknown[]).filter((s): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s))
    : DEF.blackoutDates;
  return {
    stepMinutes:        numOr('stepMinutes',        DEF.stepMinutes),
    minDurationMinutes: numOr('minDurationMinutes', DEF.minDurationMinutes),
    maxDurationMinutes: numOr('maxDurationMinutes', DEF.maxDurationMinutes),
    bufferMinutes:      numOr('bufferMinutes',      DEF.bufferMinutes),
    advanceWindowDays:  numOr('advanceWindowDays',  DEF.advanceWindowDays),
    maxActivePerFlat:   numOr('maxActivePerFlat',   DEF.maxActivePerFlat),
    openMin:            numOr('openMin',            DEF.openMin),
    closeMin:           numOr('closeMin',           DEF.closeMin),
    requiresApproval:   boolOr('requiresApproval',  DEF.requiresApproval),
    blackoutDates:      dates,
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
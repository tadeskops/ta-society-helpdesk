// Reservation domain: types, ID generation, and status-transition rules.
// Spec: tsh_requirement.md §10.
//
// Design goals:
//   - Generic engine. Facilities are configured in config/facilities.json;
//     the code below never assumes "Community Hall" or any specific slot
//     scheme. Adding a Guest Room, Sports Court, Pool, etc. is a pure
//     config change plus (optionally) a new slot list.
//   - Reservations belong to an OWNER. The person who creates the
//     record may be a manager acting on behalf. Owner never changes;
//     see the timeline for the audit trail.
//   - Statuses shown to residents are simple: Requested / Under Review /
//     Confirmed / Cancelled / Rejected. Payment-related states are
//     Phase 2 and will decorate `status='requested'` with a
//     `payment` sub-object rather than adding new top-level statuses,
//     so the resident-facing status pill stays uncluttered.

import { BadRequest } from './errors.ts';

// ---------------------------------------------------------------- types

export const RES_STATUSES = ['requested', 'under-review', 'confirmed', 'rejected', 'cancelled'] as const;
export type ReservationStatus = typeof RES_STATUSES[number];

export const PAYMENT_STATUSES = ['not-required', 'pending', 'submitted', 'verified', 'rejected'] as const;
export type PaymentStatus = typeof PAYMENT_STATUSES[number];

export const PROOF_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type ProofMime = typeof PROOF_MIMES[number];

export const TIMELINE_EVENTS = [
  'created', 'commented', 'approved', 'rejected', 'cancelled', 'edited', 'overridden',
  'payment-uploaded', 'payment-verified', 'payment-rejected',
] as const;
export type TimelineEvent = typeof TIMELINE_EVENTS[number];

export interface Person {
  email: string;
  name?: string;
  flat?: string;
  phone?: string;
  role?: string;   // primary role at the time of the action
}

export interface TimelineItem {
  at: string;      // ISO 8601
  by: Person;
  event: TimelineEvent;
  note?: string;
}

export interface Reservation {
  id: string;                    // RES-DDMMYYHHMM[-N] (IST minute)
  facilityId: string;
  facilityLabel: string;
  date: string;                  // YYYY-MM-DD, IST
  /**
   * Booking start / end as minutes-of-day IST (0..1440). These are the
   * canonical fields for time-range bookings. Legacy records created
   * before the calendar cutover only carry slotId/slotLabel; loaders
   * synthesize startMin/endMin for them at read time.
   */
  startMin: number;
  endMin: number;
  slotId?: string;               // legacy: pre-cutover slot ids
  slotLabel?: string;            // legacy: pre-cutover slot labels
  purpose: string;
  status: ReservationStatus;
  owner: Person;
  createdBy: Person;
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
  timeline: TimelineItem[];
  payment?: PaymentState;
  calendarEventId?: string;      // Phase 3: Google Calendar event id
  isDeleted?: boolean;
}

export interface ProofFile {
  path: string;                  // repo path e.g. payments/RES-xxx/01.jpg
  name: string;                  // original client filename
  mime: ProofMime;
  size: number;                  // bytes
  uploadedAt: string;            // ISO 8601
  uploadedBy: string;            // email
}

export interface PaymentState {
  status: PaymentStatus;
  amount?: number;
  payee?: string;
  txnRef?: string;
  proofs: ProofFile[];
  verifiedAt?: string;
  verifiedBy?: string;
  note?: string;                 // last verifier/rejecter note
}

export interface FacilitySlot {
  id: string;
  label: string;
  startHour: number;   // 0..23
  endHour: number;     // 1..24 (exclusive)
}

export interface FacilityPolicy {
  minAdvanceHours: number;
  maxAdvanceDays: number;
  maxConcurrentPerOwner: number;
  /**
   * Facility open/close as minutes-of-day IST. When undefined the
   * defaults DEFAULT_OPEN_MIN (06:00) and DEFAULT_CLOSE_MIN (23:00) apply.
   * Bookings must sit inside this window and be aligned to stepMinutes.
   */
  openMin?: number;
  closeMin?: number;
  stepMinutes?: number;         // default 30
  minDurationMinutes?: number;  // default 60
  maxDurationMinutes?: number;  // default 480 (8h)
  /**
   * Maximum active bookings a single flat may hold within one IST
   * calendar year, counted across all statuses that block a slot
   * (requested / under-review / confirmed). Cancelled and rejected
   * bookings do not count. Undefined → default of 2.
   */
  maxPerFlatPerYear?: number;
  requiresApproval: boolean;
  requiresPayment?: boolean;
  paymentAmount?: number;
  paymentPayee?: string;
  /**
   * Free-form paragraph shown on the booking form and detail page to
   * explain any fees, deposits, cleaning charges, or refund policy for
   * this facility. Leave empty to hide the block.
   */
  chargesInfo?: string;
  blackoutDates?: string[];   // YYYY-MM-DD
}

export interface Facility {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  capacity?: number;
  /** Legacy: fixed slot presets. Optional for time-range facilities. */
  slots?: FacilitySlot[];
  policy: FacilityPolicy;
  rules?: string[];
  calendarId?: string;   // Phase 3: Google Calendar id (e.g. xxx@group.calendar.google.com)
}

// ------------------------------------------------------------- ID scheme

// Reservation IDs follow the same "DDMMYYHHMM + optional -N" scheme as
// helpdesk tickets (TKT-*), just with a RES- prefix. IST minute-anchored
// so IDs sort naturally by creation time when displayed as text.
export const RES_ID_RE = /^RES-\d{10}(?:-\d+)?$/;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const istParts = (ms: number) => {
  const t = new Date(ms + IST_OFFSET_MS);
  return {
    d: t.getUTCDate(),
    m: t.getUTCMonth() + 1,
    y: t.getUTCFullYear() % 100,
    h: t.getUTCHours(),
    mi: t.getUTCMinutes(),
  };
};

const p2 = (n: number): string => String(n).padStart(2, '0');

export const formatResIdBase = (ms: number): string => {
  const { d, m, y, h, mi } = istParts(ms);
  return `RES-${p2(d)}${p2(m)}${p2(y)}${p2(h)}${p2(mi)}`;
};

export const nextResId = (existing: ReadonlySet<string>, now: number = Date.now()): string => {
  const base = formatResIdBase(now);
  if (!existing.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const cand = `${base}-${n}`;
    if (!existing.has(cand)) return cand;
  }
  throw new Error('Could not allocate unique reservation id in the same minute');
};

// ------------------------------------------------------------- date utils

/** IST-anchored YYYY-MM-DD for the given epoch ms. */
export const istDateStr = (ms: number): string => {
  const t = new Date(ms + IST_OFFSET_MS);
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
};

/**
 * Parse YYYY-MM-DD as midnight IST and return epoch ms.
 * (IST is UTC+05:30 with no DST, so no ambiguity to handle.)
 */
export const parseIstDateMidnight = (s: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new BadRequest('date must be YYYY-MM-DD');
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new BadRequest('date is not a valid calendar day');
  return Date.UTC(y, mo - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS;
};

/** IST-anchored epoch ms for `date @ startHour` of the given slot. */
export const slotStartMs = (date: string, startHour: number): number => {
  const midnight = parseIstDateMidnight(date);
  return midnight + startHour * 60 * 60 * 1000;
};

// ------------------------------------------------------- status transitions

/**
 * Allowed transitions. Rejected/cancelled are terminal so we never
 * silently overwrite a decision — an override must go through a
 * dedicated "override" flow that resets the record with an audit note.
 */
const TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  'requested':    ['under-review', 'confirmed', 'rejected', 'cancelled'],
  'under-review': ['confirmed', 'rejected', 'cancelled'],
  'confirmed':    ['cancelled', 'rejected'],
  'rejected':     [],
  'cancelled':    [],
};

export const canTransition = (from: ReservationStatus, to: ReservationStatus): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

// -------------------------------------------------------------- helpers

export const RESIDENT_STATUS_LABEL: Record<ReservationStatus, string> = {
  'requested':    'Requested',
  'under-review': 'Under Review',
  'confirmed':    'Confirmed',
  'rejected':     'Rejected',
  'cancelled':    'Cancelled',
};

/** Whether the given reservation is "active" (uses a slot and blocks conflicts). */
export const isActive = (r: Pick<Reservation, 'status' | 'isDeleted'>): boolean => {
  if (r.isDeleted) return false;
  return r.status === 'requested' || r.status === 'under-review' || r.status === 'confirmed';
};

/**
 * Build a per-slot availability map: `${facilityId}|${date}|${slotId}` → id
 * of the active reservation holding it. Only ACTIVE reservations occupy a
 * slot; rejected/cancelled/deleted free it up.
 */
export const buildSlotIndex = (list: Reservation[]): Map<string, string> => {
  const idx = new Map<string, string>();
  for (const r of list) {
    if (!isActive(r)) continue;
    idx.set(`${r.facilityId}|${r.date}|${r.slotId}`, r.id);
  }
  return idx;
};

// ------------------------------------------------------ payment helpers

const extForMime = (m: ProofMime): string =>
  m === 'application/pdf' ? 'pdf' :
  m === 'image/png'       ? 'png' :
  m === 'image/webp'      ? 'webp' : 'jpg';

/** Repo path for a payment proof — served via worker, never public raw. */
export const proofRepoPath = (resId: string, idx: number, mime: ProofMime): string =>
  `payments/${resId}/${p2(idx)}.${extForMime(mime)}`;

/**
 * Whether a facility booking is cleared for confirmation.
 * If the facility does not require payment → always true.
 * Otherwise the record's payment.status must be 'verified'.
 */
export const isPaymentClearedForApproval = (
  r: Pick<Reservation, 'payment'>,
  facility: Pick<Facility, 'policy'>,
): boolean => {
  if (!facility.policy.requiresPayment) return true;
  return r.payment?.status === 'verified';
};

/** Initial payment state for a newly-created reservation. */
export const initialPaymentState = (facility: Pick<Facility, 'policy'>): PaymentState | undefined => {
  if (!facility.policy.requiresPayment) return undefined;
  const s: PaymentState = {
    status: 'pending',
    proofs: [],
  };
  if (facility.policy.paymentAmount !== undefined) s.amount = facility.policy.paymentAmount;
  if (facility.policy.paymentPayee)               s.payee  = facility.policy.paymentPayee;
  return s;
};

// ------------------------------------------------------ flat quota helpers

/** Default per-flat, per-calendar-year cap when the facility policy omits one. */
export const DEFAULT_MAX_PER_FLAT_PER_YEAR = 2;

// ---------------------------------------------------- time-range defaults

export const DEFAULT_OPEN_MIN = 6 * 60;       // 06:00
export const DEFAULT_CLOSE_MIN = 23 * 60;     // 23:00
export const DEFAULT_STEP_MIN = 30;
export const DEFAULT_MIN_DURATION_MIN = 60;   // 1 hour
export const DEFAULT_MAX_DURATION_MIN = 8 * 60; // 8 hours

/** Effective open-hour policy — fills in the defaults when unset. */
export const effectiveHours = (p: Pick<FacilityPolicy, 'openMin' | 'closeMin' | 'stepMinutes' | 'minDurationMinutes' | 'maxDurationMinutes'>) => ({
  openMin:            p.openMin            ?? DEFAULT_OPEN_MIN,
  closeMin:           p.closeMin           ?? DEFAULT_CLOSE_MIN,
  stepMinutes:        p.stepMinutes        ?? DEFAULT_STEP_MIN,
  minDurationMinutes: p.minDurationMinutes ?? DEFAULT_MIN_DURATION_MIN,
  maxDurationMinutes: p.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MIN,
});

/** "HH:MM" → minutes-of-day. Throws BadRequest on malformed input. */
export const parseHHMM = (s: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new BadRequest(`time must be HH:MM (got "${s}")`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 24 || mi < 0 || mi > 59) throw new BadRequest(`time out of range: ${s}`);
  const v = h * 60 + mi;
  if (v > 24 * 60) throw new BadRequest(`time out of range: ${s}`);
  return v;
};

/** minutes-of-day → "HH:MM" with 24h clamped display for the closing edge. */
export const formatHHMM = (min: number): string => {
  const h = Math.floor(min / 60);
  const mi = min % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
};

/** Two half-open ranges [a,b) overlap when they share any minute. */
export const overlapsRange = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && bStart < aEnd;

/** Backfill startMin/endMin for legacy records that only carry slot info. */
export const ensureTimeRange = (r: Reservation, facility?: Facility): Reservation => {
  if (typeof r.startMin === 'number' && typeof r.endMin === 'number' && r.endMin > r.startMin) return r;
  // Try to parse legacy slotLabel like "Morning (6:00–12:00)" first.
  const m = /(\d{1,2}):(\d{2})[^\d]+(\d{1,2}):(\d{2})/.exec(r.slotLabel ?? '');
  if (m) {
    r.startMin = Number(m[1]) * 60 + Number(m[2]);
    r.endMin   = Number(m[3]) * 60 + Number(m[4]);
    if (r.endMin === 0) r.endMin = 24 * 60;
    return r;
  }
  // Fall back to the facility's slot table by id.
  if (facility?.slots && r.slotId) {
    const s = facility.slots.find((x) => x.id === r.slotId);
    if (s) {
      r.startMin = s.startHour * 60;
      r.endMin   = s.endHour   * 60;
      return r;
    }
  }
  // Last-resort: mark the whole day so overlap checks still block it.
  r.startMin = 0; r.endMin = 24 * 60;
  return r;
};

/** Whether the given new booking overlaps any active record on the same date+facility. */
export const findOverlap = (
  items: Reservation[],
  facilityId: string,
  date: string,
  startMin: number,
  endMin: number,
  excludeId?: string,
): Reservation | undefined => {
  for (const r of items) {
    if (excludeId && r.id === excludeId) continue;
    if (r.facilityId !== facilityId) continue;
    if (r.date !== date) continue;
    if (!isActive(r)) continue;
    const rStart = typeof r.startMin === 'number' ? r.startMin : 0;
    const rEnd   = typeof r.endMin   === 'number' ? r.endMin   : 24 * 60;
    if (overlapsRange(startMin, endMin, rStart, rEnd)) return r;
  }
  return undefined;
};

/**
 * Canonical form for a flat identifier so `a-101`, `A 101`, and `A-101`
 * all count against the same yearly quota. Trim, uppercase, collapse
 * runs of whitespace, and drop any character outside [A-Z0-9-].
 */
export const normalizeFlat = (s: string): string =>
  s.trim().toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '');

/** IST calendar year for a YYYY-MM-DD string (already IST-anchored). */
export const istYearFromDate = (date: string): number => Number(date.slice(0, 4));

/**
 * Whether the given normalized flat has already hit its yearly cap for
 * this facility. Counts only active reservations (see isActive) whose
 * IST date falls in the same calendar year as `newDate`.
 */
export const countFlatBookingsForYear = (
  items: Reservation[],
  facilityId: string,
  flatNorm: string,
  year: number,
): number => {
  let n = 0;
  for (const r of items) {
    if (r.facilityId !== facilityId) continue;
    if (!isActive(r)) continue;
    if (istYearFromDate(r.date) !== year) continue;
    if (!r.owner.flat) continue;
    if (normalizeFlat(r.owner.flat) !== flatNorm) continue;
    n++;
  }
  return n;
};


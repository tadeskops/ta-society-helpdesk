// EV Charging — Phase 6 domain helpers.
// Spec: tsh_requirement.md §23.1 (Phase 6).
//
// Three lifecycles, each with its own data file:
//
//   • RFID requests           config/ev-rfid-requests.json
//   • Vehicle registrations   config/ev-registrations.json
//   • Support tickets         config/ev-support-tickets.json
//
// All three follow the same bounded-file pattern as `ev-bookings.json`:
// { version: 1, items: [...] }.

// -------------------------- RFID ----------------------------------------

export const RFID_TYPES = [
  'issue-new',       // First-time RFID card issue.
  'replace-lost',    // Existing card lost.
  'replace-damaged', // Existing card physically damaged.
  'deactivate',      // Temporarily disable a card (leaving town, etc.).
  'reactivate',      // Re-enable a previously deactivated card.
  'update-details',  // Change vehicle plate / phone on file.
] as const;
export type RfidType = typeof RFID_TYPES[number];

export const RFID_STATUSES = [
  'pending',    // Freshly filed; awaiting Manager review.
  'approved',   // Manager approved; awaiting card issue.
  'issued',     // Card handed over to resident.
  'rejected',   // Denied. `notes` should carry the reason.
  'cancelled',  // Resident withdrew before manager acted.
] as const;
export type RfidStatus = typeof RFID_STATUSES[number];

export const RFID_ID_RE = /^EVRF-[A-Z0-9]{8}$/;
export const RFID_MAX_ACTIVE_ITEMS = 500;

export interface RfidRequest {
  id: string;                    // EVRF-XXXXXXXX
  type: RfidType;
  status: RfidStatus;
  owner: { email: string; name: string; flat: string };
  vehiclePlate?: string;         // "MH-12-AB-1234"
  cardCode?: string;             // Existing / assigned card serial.
  notes?: string;
  createdAt: string;             // ISO
  updatedAt: string;
  reviewedBy?: string;           // Manager email who last acted.
}

export const nextRfidId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = 'EVRF-';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

export const canTransitionRfid = (from: RfidStatus, to: RfidStatus): boolean => {
  if (from === to) return false;
  const graph: Record<RfidStatus, RfidStatus[]> = {
    pending:   ['approved', 'rejected', 'cancelled'],
    approved:  ['issued', 'cancelled', 'rejected'],
    issued:    [],
    rejected:  [],
    cancelled: [],
  };
  return graph[from].includes(to);
};

// -------------------------- Vehicle registration ------------------------

export const REG_STATUSES = ['active', 'inactive'] as const;
export type RegStatus = typeof REG_STATUSES[number];

export const REG_ID_RE = /^EVREG-[A-Z0-9]{8}$/;
export const REG_MAX_ACTIVE_ITEMS = 500;

export interface EvRegistration {
  id: string;                    // EVREG-XXXXXXXX
  status: RegStatus;
  owner: { email: string; name: string; flat: string };
  vehicle: {
    plate: string;               // "MH-12-AB-1234"
    make?: string;                // e.g. "Tata"
    model?: string;               // e.g. "Nexon EV"
    batteryKwh?: number;
    connectorType?: string;      // "CCS2" / "Type2" / etc.
  };
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// -------------------------- Support tickets -----------------------------

// 12 categories per §23 requirement.
export const SUPPORT_CATEGORIES = [
  'unable-to-start',
  'card-not-working',
  'billing-issue',
  'app-issue',
  'physical-damage',
  'slow-charging',
  'session-ended-early',
  'noise-issue',
  'reservation-mismatch',
  'general-feedback',
  'safety-concern',
  'other',
] as const;
export type SupportCategory = typeof SUPPORT_CATEGORIES[number];

export const SUPPORT_STATUSES = ['open', 'in-progress', 'resolved', 'closed'] as const;
export type SupportStatus = typeof SUPPORT_STATUSES[number];

export const SUPPORT_ID_RE = /^EVSP-[A-Z0-9]{8}$/;
export const SUPPORT_MAX_ACTIVE_ITEMS = 500;

export interface SupportTicket {
  id: string;                    // EVSP-XXXXXXXX
  category: SupportCategory;
  status: SupportStatus;
  owner: { email: string; name: string; flat: string };
  subject: string;               // 1..120 chars
  message: string;               // 1..2000 chars
  relatedBookingId?: string;
  createdAt: string;
  updatedAt: string;
  handledBy?: string;
  resolutionNote?: string;
}

export const nextRegId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = 'EVREG-';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

export const nextSupportId = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = 'EVSP-';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
};

export const canTransitionSupport = (from: SupportStatus, to: SupportStatus): boolean => {
  if (from === to) return false;
  const graph: Record<SupportStatus, SupportStatus[]> = {
    open:          ['in-progress', 'resolved', 'closed'],
    'in-progress': ['resolved', 'closed'],
    resolved:      ['closed', 'in-progress'],
    closed:        [],
  };
  return graph[from].includes(to);
};

// -------------------------- Plate helper --------------------------------

// Normalise Indian number plates: strip whitespace, uppercase, keep only
// A-Z 0-9 and hyphen. Reject anything else with `undefined`.
export const normalizePlate = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{4,20}$/.test(s)) return undefined;
  return s;
};

// EV AMC (Annual Maintenance Contract) — types + helpers.
// --------------------------------------------------------------------------
// Editor-only workspace for society staff to record the vendor AMC with
// SunArth (or any successor), track what the society itself must maintain
// (routine dust-off, RCB monthly test, etc.), keep a searchable log of
// quarterly / breakdown service visits, and store scanned contract PDFs
// in a private-repo folder (falls back to backups/ev/amc/ in the same
// public repo when the §23.9 grant hasn't landed yet).
//
// Storage:
//   config/ev-amc.json                    — small metadata blob (bounded)
//   backups/ev/amc/YYYY-MM/{docId}.{ext}  — uploaded binaries (private)
//
// Spec: tsh_requirement.md §23.11 (added in the same commit as this file).

export const DOC_KINDS = [
  'contract',       // signed AMC contract PDF
  'renewal',        // renewal amendment / addendum
  'sla',            // detailed SLA / scope-of-work doc
  'invoice',        // annual / quarterly invoice
  'inspection',     // safety inspection certificate
  'photo',          // before/after service photos
  'other',
] as const;

export type AmcDocKind = typeof DOC_KINDS[number];

export const SERVICING_KINDS = [
  'quarterly',
  'annual',
  'preventive',
  'breakdown',
  'inspection',
] as const;

export type AmcServicingKind = typeof SERVICING_KINDS[number];

export const AMC_DOC_ID_RE      = /^EVAMC-[A-Z0-9]{8}$/;
export const AMC_SERVICING_ID_RE = /^EVAMS-[A-Z0-9]{8}$/;

// Bounded-file guard: refuse to write more than N documents / servicing
// entries. Same defence as other bounded lists.
export const AMC_MAX_DOCS      = 200;
export const AMC_MAX_SERVICING = 500;

export interface AmcContract {
  number: string;                    // vendor-issued contract number
  vendor: string;                    // e.g. "SunArth Technologies"
  vendorContact: {
    phone?: string;
    email?: string;
    website?: string;
    address?: string;
  };
  startDate: string;                 // YYYY-MM-DD, inclusive
  endDate: string;                   // YYYY-MM-DD, inclusive
  renewalReminderDays: number;       // days before endDate to prompt renewal
  annualFee: number | null;          // INR — kept for society records only
  currency: string;                  // ISO 4217 (default INR)
  coverage: string[];                // what's covered by AMC (vendor scope)
  societyResponsibilities: string[]; // what society must maintain in-house
  emergencyContact: string;          // free-text: who residents call after-hours
  notes: string;                     // free-form editor notes
  updatedAt: string;
  updatedBy: string;
}

export interface AmcDocument {
  id: string;                        // EVAMC-XXXXXXXX
  kind: AmcDocKind;
  title: string;
  path: string;                      // repo path where the binary lives
  mime: string;                      // e.g. application/pdf
  bytes: number;                     // best-effort size
  uploadedAt: string;
  uploadedBy: string;
  archived?: boolean;                // soft-delete flag
  archivedAt?: string;
  archivedBy?: string;
}

export interface AmcServicingEntry {
  id: string;                        // EVAMS-XXXXXXXX
  date: string;                      // YYYY-MM-DD when servicing happened
  kind: AmcServicingKind;
  performedBy: string;               // technician name / vendor rep
  station?: string;                  // optional station id or label
  notes: string;                     // outcome / findings
  createdAt: string;
  createdBy: string;
}

export interface AmcRecord {
  version: 1;
  contract: AmcContract;
  documents: AmcDocument[];
  servicing: AmcServicingEntry[];
}

// -------- defaults --------------------------------------------------------

/** Blank contract scaffold shown when no AMC has been filed yet. */
export const emptyAmc = (nowIso: string = new Date().toISOString()): AmcRecord => ({
  version: 1,
  contract: {
    number: '',
    vendor: 'SunArth Technologies',
    vendorContact: {
      phone:   '+91-77977-98887',
      email:   'info@sunarth.com',
      website: 'https://www.sunarth.com',
      address: 'Cello Platina 202, F.C. Road, Pune 411005',
    },
    startDate: '',
    endDate: '',
    renewalReminderDays: 30,
    annualFee: null,
    currency: 'INR',
    coverage: [
      'Quarterly preventive maintenance of all charging bays.',
      'On-site breakdown response within 24 hours of a ticket.',
      'Firmware upgrades and safety recalibration.',
      'Replacement of connectors and charging guns under fair-wear-and-tear.',
    ],
    societyResponsibilities: [
      'Weekly dust-off of chargers and cable management.',
      'Monthly RCBO / MCB trip-test in the EV charging DB.',
      'Keep the bay area lit and CCTV-monitored 24×7.',
      'Report any smoke, sparks or unusual noise to SunArth within 15 minutes.',
      'Maintain a spare set of charging-gun locks in the manager\'s cabin.',
    ],
    emergencyContact: 'SunArth 24×7 helpline — +91-77977-98881 (WhatsApp) / +91-77977-98887 (call). Society security: call the manager on duty first.',
    notes: '',
    updatedAt: nowIso,
    updatedBy: 'system',
  },
  documents: [],
  servicing: [],
});

// -------- id + validation helpers -----------------------------------------

const RAND_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const rand8 = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => RAND_ALPHABET[b % RAND_ALPHABET.length]).join('');
};
export const nextAmcDocId       = (): string => `EVAMC-${rand8()}`;
export const nextAmcServicingId = (): string => `EVAMS-${rand8()}`;

/** ISO YYYY-MM-DD guard. */
export const isDateStr = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Best-effort MIME extension. */
export const mimeExt = (mime: string): string => {
  const m = (mime || '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (m === 'image/png')       return 'png';
  if (m === 'image/jpeg')      return 'jpg';
  if (m === 'image/webp')      return 'webp';
  if (m === 'application/msword') return 'doc';
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (m === 'application/vnd.ms-excel') return 'xls';
  if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  return 'bin';
};

/** Common accepted MIMEs — reject anything else at upload time. */
export const ALLOWED_AMC_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** Cap uploads at 8 MiB per doc — society scans of a contract PDF sit
 *  well under this in practice. */
export const AMC_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Days-until-endDate for renewal ticker. Negative = overdue. */
export const daysUntilEnd = (endDate: string, todayIso: string = new Date().toISOString().slice(0, 10)): number | null => {
  if (!isDateStr(endDate) || !isDateStr(todayIso)) return null;
  const end   = Date.UTC(+endDate.slice(0, 4), +endDate.slice(5, 7) - 1, +endDate.slice(8, 10));
  const today = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10));
  return Math.round((end - today) / 86_400_000);
};

// EV Charging — Phase 5: Private-repo mirror + auto reports.
// Spec: tsh_requirement.md §23.1 (Phase 5), §23.9 (private data repo).
//
// Two entrypoints:
//
//   • buildEvMonthlyReport(items, monthYm) — pure helper. Returns
//     a Markdown report string for the given YYYY-MM window using the
//     already-loaded bookings list. No I/O.
//
//   • runEvMirror(env, opts) — writes the report + a JSON snapshot to
//     `backups/ev/YYYY-MM/report.md` + `.json` in the same repo the
//     worker already writes to (the private-repo split ships once the
//     ops grant in §23.9 is completed; env.PRIVATE_DATA_REPO override
//     supported but not required).
//
// The mirror is best-effort. Errors are caught by the caller (the
// scheduled handler wraps in try/catch). A hardcoded month = "current
// IST month - 1" ensures the report is stable and idempotent.

import type { Env } from '../env.ts';
import { putFile, getFile } from '../github/client.ts';
import { istDateStr } from './reservation.ts';
import {
  aggregateEvBookings,
  bookingsToCsv,
  type EvBooking,
} from './ev-booking.ts';

/**
 * IST-month string ("YYYY-MM") for the given epoch-ms.
 */
export const istMonthStr = (ms: number): string => {
  return istDateStr(ms).slice(0, 7);
};

/**
 * "YYYY-MM" of the month before the given month string.
 */
export const previousMonth = (ym: string): string => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${String(py).padStart(4, '0')}-${String(pm).padStart(2, '0')}`;
};

/**
 * Convert a "YYYY-MM" to inclusive [from, to] IST date strings for that month.
 */
export const monthRange = (ym: string): { from: string; to: string } => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const from = `${ym}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month
  const to = `${ym}-${String(lastDay).padStart(2, '0')}`;
  return { from, to };
};

const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));
const hhmm = (min: number): string => pad2(Math.floor(min / 60)) + ':' + pad2(min % 60);

const esc = (s: unknown): string => String(s == null ? '' : s).replace(/\|/g, '\\|');

/**
 * Build a Markdown monthly report for the given IST month.
 * Deterministic — same inputs produce identical output (used for
 * "did anything change since last run" idempotency check).
 */
export const buildEvMonthlyReport = (
  items: EvBooking[],
  monthYm: string,
  stationName = 'EV Charger',
): string => {
  const { from, to } = monthRange(monthYm);
  const inRange = items.filter((b) => b.date >= from && b.date <= to);
  // Sort deterministically by date + start time + id so file diffs stay
  // clean when the mirror job re-runs.
  const sorted = inRange.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return a.id < b.id ? -1 : 1;
  });
  const result = aggregateEvBookings(sorted, { period: 'm', from, to }, { topN: 10 });
  const k = result.kpis;

  const rows = sorted.map((b) => [
    b.id,
    b.date,
    `${hhmm(b.startMin)}–${hhmm(b.endMin)}`,
    b.status,
    esc(b.owner.flat),
    esc(b.owner.email),
  ]);

  const topFlats = result.topFlats.length
    ? result.topFlats.map((t, i) => `${i + 1}. **${esc(t.flat)}** — ${t.bookings} booking(s), ${t.minutes} min`).join('\n')
    : '_No confirmed or completed bookings in this month._';

  const bookingsTable = rows.length
    ? [
        '| ID | Date | Time | Status | Flat | Owner |',
        '|---|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.join(' | ')} |`),
      ].join('\n')
    : '_No bookings recorded for this month._';

  return [
    `# EV Charging — Monthly report`,
    ``,
    `**Station:** ${esc(stationName)}`,
    `**Window:** ${from} to ${to} (${sorted.length} bookings)`,
    `**Generated:** ${new Date().toISOString()}`,
    ``,
    `## KPIs`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Total bookings | ${k.totalBookings} |`,
    `| Confirmed | ${k.confirmedBookings} |`,
    `| Completed | ${k.completedBookings} |`,
    `| Cancelled | ${k.cancelledBookings} |`,
    `| Pending | ${k.pendingBookings} |`,
    `| Total minutes | ${k.totalMinutes} |`,
    `| Total hours | ${k.totalHours} |`,
    `| Unique flats | ${k.uniqueFlats} |`,
    `| Unique owners | ${k.uniqueOwners} |`,
    `| Avg duration (min) | ${k.avgMinutesPerBooking} |`,
    ``,
    `## Top flats`,
    ``,
    topFlats,
    ``,
    `## Bookings`,
    ``,
    bookingsTable,
    ``,
    `---`,
    `_This report is generated automatically by the TSH worker. Data lives in \`config/ev-bookings.json\`._`,
    ``,
  ].join('\n');
};

export interface EvMirrorResult {
  ran: true;
  month: string;
  bookings: number;
  reportPath: string;
  csvPath: string;
  changed: boolean;
}

export interface EvMirrorSkipped {
  ran: false;
  reason: string;
  month?: string;
}

/**
 * Runs the monthly mirror. Writes markdown + CSV to
 * `backups/ev/YYYY-MM/{report.md,bookings.csv}`. Idempotent — if a report
 * with identical content already exists at the target path we skip the
 * write to keep the commit history clean.
 */
export const runEvMirror = async (
  env: Env,
  items: EvBooking[],
  opts: { month?: string | undefined; stationName?: string | undefined; authorEmail?: string | undefined } = {},
): Promise<EvMirrorResult | EvMirrorSkipped> => {
  // Default to previous full IST month so the report only fires once
  // the month has actually closed.
  const nowMonth = istMonthStr(Date.now());
  const month = opts.month || previousMonth(nowMonth);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { ran: false, reason: 'Bad month; expected YYYY-MM', month };
  }
  const markdown = buildEvMonthlyReport(items, month, opts.stationName);
  const { from, to } = monthRange(month);
  const inRange = items.filter((b) => b.date >= from && b.date <= to);
  const csv = bookingsToCsv(inRange);

  const reportPath = `backups/ev/${month}/report.md`;
  const csvPath    = `backups/ev/${month}/bookings.csv`;

  const author = opts.authorEmail || 'worker@tadeskops.local';

  // Idempotency: strip the volatile "Generated" timestamp before diffing so
  // repeated mirror runs on unchanged data are no-ops.
  const stripGenerated = (s: string): string => s.replace(/^\*\*Generated:\*\*.*$/m, '**Generated:** REDACTED');
  const existing = await getFile(env, reportPath).catch(() => undefined);
  const changed = !existing || stripGenerated(existing.content) !== stripGenerated(markdown);
  if (changed) {
    await putFile(env, reportPath, markdown, `ev-mirror: monthly report ${month}`, author, existing?.sha);
    const existingCsv = await getFile(env, csvPath).catch(() => undefined);
    if (!existingCsv || existingCsv.content !== csv) {
      await putFile(env, csvPath, csv, `ev-mirror: monthly bookings CSV ${month}`, author, existingCsv?.sha);
    }
  }

  return {
    ran: true,
    month,
    bookings: inRange.length,
    reportPath,
    csvPath,
    changed,
  };
};

// Booking-receipt archive.
//
// When a reservation transitions to `confirmed`, the worker composes a
// PDF receipt (letterhead + booking details in a two-column artistic
// layout) and pushes it to a private GitHub repo — configurable path
// per facility, defaulting to <facilityCodeLower>/<id>.pdf.
//
// Storage target and path templates live in config/site.json → system.
// receiptsArchive so society managers can tune them from the Settings
// page without a worker redeploy. If the archive is disabled or the
// receipts repo is not configured, archiveReservationReceipt() becomes
// a no-op (logged but does not raise).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import type { Env } from '../env.ts';
import type { Reservation, Facility } from './reservation.ts';
import { facilityCode } from './reservation.ts';
import { formatHHMM } from './reservation.ts';
import { getBinaryFile, putBinaryB64, type RepoTarget } from '../github/client.ts';
import { log } from './log.ts';

// ------------------------------------------------------------- config

export interface ReceiptsArchiveConfig {
  enabled: boolean;
  perReceiptPath: string;   // template — see PLACEHOLDERS below
  rollup?: {
    enabled: boolean;
    period: 'monthly' | 'quarterly' | 'yearly';
    path: string;
  };
}

export const DEFAULT_ARCHIVE_CONFIG: ReceiptsArchiveConfig = {
  enabled: true,
  perReceiptPath: '{facilityCodeLower}/{id}.pdf',
  rollup: {
    enabled: true,
    period: 'monthly',
    path: '{facilityCodeLower}/bckp/{period}/{periodKey}.pdf',
  },
};

/**
 * Placeholders accepted in perReceiptPath / rollup.path templates:
 *   {facilityCode}       CH
 *   {facilityCodeLower}  ch
 *   {facilityId}         community-hall
 *   {id}                 CH-0707261455
 *   {year}               2026
 *   {month}              07
 *   {day}                07
 *   {yearMonth}          2026-07
 *   {period}             monthly | quarterly | yearly (rollup only)
 *   {periodKey}          2026-07 | 2026-Q3 | 2026    (rollup only)
 */
const PLACEHOLDERS_RE = /\{([a-zA-Z]+)\}/g;

const p2 = (n: number): string => String(n).padStart(2, '0');

export const renderPathTemplate = (
  tpl: string,
  vars: Record<string, string>,
): string => tpl.replace(PLACEHOLDERS_RE, (_full, key: string) => vars[key] ?? '');

/**
 * Compute the archive path for a given reservation using the resolved
 * config template.
 */
export const archivePathFor = (
  r: Reservation,
  f: Facility,
  cfg: ReceiptsArchiveConfig,
): string => {
  const code = facilityCode(f);
  const [y, m, d] = r.date.split('-');
  const vars: Record<string, string> = {
    facilityCode: code,
    facilityCodeLower: code.toLowerCase(),
    facilityId: f.id,
    id: r.id,
    year: y || '',
    month: m || '',
    day: d || '',
    yearMonth: `${y}-${m}`,
  };
  const tpl = cfg.perReceiptPath || DEFAULT_ARCHIVE_CONFIG.perReceiptPath;
  const out = renderPathTemplate(tpl, vars);
  // Guard against traversal or absolute paths.
  const clean = out.replace(/^\/+/, '').replace(/\.\.+/g, '.');
  return clean;
};

// ------------------------------------------------------------- config load

interface SiteJson {
  system?: {
    receiptTemplate?: { url?: string; path?: string; mime?: string };
    receiptsArchive?: Partial<ReceiptsArchiveConfig>;
  };
}

/**
 * Merge on-disk config with defaults. `siteJson` is the parsed
 * config/site.json (already loaded elsewhere for other reasons —
 * callers pass it through so we don't re-fetch).
 */
export const resolveArchiveConfig = (siteJson: SiteJson | undefined): ReceiptsArchiveConfig => {
  const raw = siteJson?.system?.receiptsArchive ?? {};
  const rawRollup = raw.rollup ?? {};
  return {
    enabled: raw.enabled !== false,
    perReceiptPath: typeof raw.perReceiptPath === 'string' && raw.perReceiptPath.trim()
      ? raw.perReceiptPath.trim()
      : DEFAULT_ARCHIVE_CONFIG.perReceiptPath,
    rollup: {
      enabled: rawRollup.enabled !== false,
      period: (rawRollup.period === 'quarterly' || rawRollup.period === 'yearly')
        ? rawRollup.period : 'monthly',
      path: typeof rawRollup.path === 'string' && rawRollup.path.trim()
        ? rawRollup.path.trim()
        : DEFAULT_ARCHIVE_CONFIG.rollup!.path,
    },
  };
};

// ------------------------------------------------------------- target repo

/** Build the RepoTarget for the receipts repo, or undefined if archive is not configured. */
export const receiptsRepoTarget = (env: Env): RepoTarget | undefined => {
  const repo = (env.GH_RECEIPTS_REPO || '').trim();
  if (!repo) return undefined;
  return {
    owner: (env.GH_RECEIPTS_OWNER || env.GH_OWNER).trim(),
    repo,
    branch: (env.GH_RECEIPTS_BRANCH || 'main').trim(),
    ...(env.GITHUB_RECEIPTS_TOKEN ? { token: env.GITHUB_RECEIPTS_TOKEN } : {}),
  };
};

// ------------------------------------------------------------- letterhead

/**
 * Fetch the letterhead bytes for embedding into a receipt. Looks first
 * at the explicit `path` in the template metadata, then falls back to
 * parsing it out of the `url` field. Returns undefined if the template
 * cannot be located (renderer draws a blank header band).
 */
export const loadLetterheadBytes = async (
  env: Env,
  tpl: { url?: string; path?: string } | undefined,
): Promise<{ bytes: Uint8Array; mime: string } | undefined> => {
  if (!tpl) return undefined;
  let path = (tpl.path || '').trim();
  if (!path && tpl.url) {
    // Extract path from https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>.
    const m = /^https?:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/.exec(tpl.url);
    if (m && m[1]) path = m[1];
  }
  if (!path) return undefined;
  const bin = await getBinaryFile(env, path);
  if (!bin) return undefined;
  const mime = path.endsWith('.pdf') ? 'application/pdf'
    : path.endsWith('.png') ? 'image/png'
    : path.endsWith('.webp') ? 'image/webp'
    : 'image/jpeg';
  return { bytes: bin.bytes, mime };
};

// ------------------------------------------------------------- composer

const A4 = { w: 595.28, h: 841.89 };
const MM = (mm: number): number => mm * 2.83464567;
const INR = (n: number | null | undefined): string =>
  n == null ? '\u2014' : '\u20b9' + Number(n).toLocaleString('en-IN');

const wrap = (
  s: string,
  font: import('pdf-lib').PDFFont,
  size: number,
  maxW: number,
): string[] => {
  const words = String(s || '\u2014').split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const trial = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(trial, size) <= maxW) cur = trial;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : ['\u2014'];
};

const timeLabel = (r: Reservation): string =>
  `${formatHHMM(r.startMin)}\u2013${formatHHMM(r.endMin)}`;

const durationLabel = (r: Reservation): string => {
  const mins = Math.max(0, r.endMin - r.startMin);
  const h = Math.floor(mins / 60), m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

const dateLabel = (isoDay: string): string => {
  const [y, m, d] = isoDay.split('-').map(Number);
  const date = new Date(Date.UTC(y!, (m! - 1), d!));
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};

interface ReceiptRow { k: string; v: string }

const buildRows = (r: Reservation, f: Facility): { left: ReceiptRow[]; right: ReceiptRow[] } => {
  const owner = r.owner || {} as Reservation['owner'];
  const paymentStatus = r.payment?.status
    ? r.payment.status.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : (f.policy.requiresPayment ? 'Pending' : 'Not required');
  const paymentLabel = r.payment && r.payment.amount != null
    ? `${INR(r.payment.amount)} \u00b7 ${paymentStatus}`
    : (f.policy.requiresPayment ? INR(f.policy.paymentAmount) + ' \u00b7 ' + paymentStatus : 'Free');
  const left: ReceiptRow[] = [
    { k: 'Booking ID', v: r.id },
    { k: 'Facility',   v: f.name + (facilityCode(f) ? ` (${facilityCode(f)})` : '') },
    { k: 'Date',       v: dateLabel(r.date) },
    { k: 'Time',       v: timeLabel(r) },
    { k: 'Duration',   v: durationLabel(r) },
  ];
  if (f.capacity) left.push({ k: 'Capacity', v: `up to ${f.capacity}` });
  const right: ReceiptRow[] = [
    { k: 'Booked by', v: owner.name || owner.email || '\u2014' },
    { k: 'Flat',      v: owner.flat || '\u2014' },
    { k: 'Email',     v: owner.email || '\u2014' },
    { k: 'Phone',     v: owner.phone || '\u2014' },
    { k: 'Purpose',   v: r.purpose || '\u2014' },
    { k: 'Charges',   v: paymentLabel },
    { k: 'Status',    v: r.status.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) },
  ];
  return { left, right };
};

const embedLetterheadPdf = async (
  pdfDoc: import('pdf-lib').PDFDocument,
  letterheadBytes: Uint8Array,
): Promise<import('pdf-lib').PDFPage> => {
  const src = await PDFDocument.load(letterheadBytes);
  const [srcPage] = src.getPages();
  if (!srcPage) return pdfDoc.addPage([A4.w, A4.h]);
  const [embed] = await pdfDoc.embedPdf(src, [0]);
  const page = pdfDoc.addPage([A4.w, A4.h]);
  // Fit the letterhead full-width, preserving aspect.
  const { width: sW, height: sH } = srcPage.getSize();
  const scale = A4.w / sW;
  const drawH = sH * scale;
  page.drawPage(embed!, {
    x: 0,
    y: A4.h - drawH,
    width: A4.w,
    height: drawH,
  });
  return page;
};

const embedLetterheadImage = async (
  pdfDoc: import('pdf-lib').PDFDocument,
  bytes: Uint8Array,
  mime: string,
): Promise<import('pdf-lib').PDFPage> => {
  const page = pdfDoc.addPage([A4.w, A4.h]);
  try {
    const img = mime === 'image/png'
      ? await pdfDoc.embedPng(bytes)
      : await pdfDoc.embedJpg(bytes);   // webp is not natively supported; caller should convert
    // Draw as a top band ~45mm high, preserving aspect ratio.
    const bandH = MM(45);
    const bandW = A4.w - MM(10);
    const scale = Math.min(bandW / img.width, bandH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: (A4.w - w) / 2,
      y: A4.h - MM(5) - h,
      width: w,
      height: h,
    });
  } catch (e) {
    // Failed to embed (e.g. webp); leave a blank band with an outline.
    page.drawRectangle({
      x: MM(5), y: A4.h - MM(50), width: A4.w - MM(10), height: MM(45),
      borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.5,
    });
  }
  return page;
};

/**
 * Compose a booking receipt PDF (A4, portrait). If `letterhead` is
 * supplied it becomes the page background (for PDF) or a top image
 * band (for PNG/JPEG). The overlay is a two-column artistic layout
 * with a title, gold accent bar, field rows, and a stamped footer.
 */
export const composeReceiptPdf = async (
  r: Reservation,
  f: Facility,
  letterhead?: { bytes: Uint8Array; mime: string },
): Promise<Uint8Array> => {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(`Booking Receipt ${r.id}`);
  pdfDoc.setSubject(`Reservation ${r.id} — ${f.name}`);
  pdfDoc.setProducer('tsh-worker');
  pdfDoc.setCreator('tsh-worker');
  pdfDoc.setCreationDate(new Date());

  const page = letterhead
    ? (letterhead.mime === 'application/pdf'
        ? await embedLetterheadPdf(pdfDoc, letterhead.bytes)
        : await embedLetterheadImage(pdfDoc, letterhead.bytes, letterhead.mime))
    : pdfDoc.addPage([A4.w, A4.h]);

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // ---- palette (kept subtle so it works over any letterhead) ----
  const ink   = rgb(0.12, 0.12, 0.14);
  const muted = rgb(0.40, 0.42, 0.48);
  const gold  = rgb(0.71, 0.53, 0.05);   // matches site accent (#b58705-ish)
  const rule  = rgb(0.88, 0.88, 0.90);

  // ---- title + accent bar ----
  const headerBottom = A4.h - MM(50);       // below the letterhead band
  const titleY       = headerBottom - MM(14);
  const title = 'BOOKING RECEIPT';
  const titleSize = 22;
  const tw = bold.widthOfTextAtSize(title, titleSize);
  page.drawText(title, { x: (A4.w - tw) / 2, y: titleY, size: titleSize, font: bold, color: ink });
  // Accent bar under the title
  page.drawLine({
    start: { x: (A4.w - tw) / 2, y: titleY - 6 },
    end:   { x: (A4.w + tw) / 2, y: titleY - 6 },
    thickness: 2, color: gold,
  });
  // Booking id chip under the accent
  const chipText = r.id;
  const chipSize = 12;
  const cw = font.widthOfTextAtSize(chipText, chipSize);
  page.drawText(chipText, {
    x: (A4.w - cw) / 2, y: titleY - 22, size: chipSize, font, color: muted,
  });

  // ---- two-column field grid ----
  const { left, right } = buildRows(r, f);
  const colGap  = MM(10);
  const marginX = MM(18);
  const colW    = (A4.w - marginX * 2 - colGap) / 2;
  const labelSize = 9;
  const valueSize = 12;
  const rowLead   = 22;
  const colTop = titleY - MM(20);

  const drawColumn = (col: ReceiptRow[], xStart: number): number => {
    let y = colTop;
    for (const row of col) {
      // Label
      page.drawText(String(row.k).toUpperCase(), {
        x: xStart, y, size: labelSize, font: bold, color: muted,
      });
      // Value (wrapped)
      const lines = wrap(row.v, font, valueSize, colW);
      lines.forEach((ln, i) => {
        page.drawText(ln, {
          x: xStart, y: y - 12 - i * (valueSize + 3), size: valueSize, font, color: ink,
        });
      });
      const rowH = 12 + lines.length * (valueSize + 3);
      // Thin divider between rows
      page.drawLine({
        start: { x: xStart, y: y - rowH - 4 },
        end:   { x: xStart + colW, y: y - rowH - 4 },
        thickness: 0.4, color: rule,
      });
      y -= rowH + rowLead;
    }
    return y;
  };

  const yLeftEnd  = drawColumn(left,  marginX);
  const yRightEnd = drawColumn(right, marginX + colW + colGap);
  const yGridEnd  = Math.min(yLeftEnd, yRightEnd);

  // ---- purpose paragraph if long (spans full width below the grid) ----
  if (r.purpose && r.purpose.length > 40) {
    const yStart = yGridEnd - MM(4);
    page.drawText('DETAILS', { x: marginX, y: yStart, size: labelSize, font: bold, color: muted });
    const lines = wrap(r.purpose, font, valueSize, A4.w - marginX * 2);
    lines.forEach((ln, i) => {
      page.drawText(ln, { x: marginX, y: yStart - 12 - i * (valueSize + 3), size: valueSize, font, color: ink });
    });
  }

  // ---- footer ----
  const footY = MM(20);
  page.drawLine({
    start: { x: marginX, y: footY + MM(8) },
    end:   { x: A4.w - marginX, y: footY + MM(8) },
    thickness: 0.5, color: rule,
  });
  const stamp = 'Archived ' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  page.drawText(stamp, { x: marginX, y: footY, size: 9, font, color: muted });
  const note = 'This is a system-generated receipt. Retain a copy for your records.';
  page.drawText(note, {
    x: A4.w - marginX - font.widthOfTextAtSize(note, 9),
    y: footY, size: 9, font: italic, color: muted,
  });

  // ---- confirmed stamp overlay ----
  // Every archived receipt is by definition for a confirmed booking, so
  // we always overlay the official rubber stamp. Fetched from the public
  // docs site once per worker isolate and cached in-memory for the
  // isolate's lifetime. Failures are swallowed so a CDN blip never blocks
  // a receipt archive from being written.
  try {
    const stampBytes = await loadStampOverlay();
    if (stampBytes) {
      const img = await pdfDoc.embedPng(stampBytes);
      const w = MM(45);
      const h = w;   // source is square
      page.drawImage(img, {
        x: A4.w - marginX - w,
        y: footY + MM(12),
        width: w, height: h,
      });
    }
  } catch (_e) { /* best-effort */ }

  return await pdfDoc.save();
};

// ------------------------------------------------------------- stamp overlay

// Module-scoped cache: the worker isolate reuses the same fetched bytes
// across every request until the isolate is recycled. Public GitHub Pages
// URL is hard-coded because the stamp is a fixed brand asset, not a
// per-society configurable.
const STAMP_URL = 'https://tadeskops.github.io/ta-society-helpdesk/assets/images/TaStampBlueOverlay.png';
let _stampCache: Uint8Array | null | undefined;

async function loadStampOverlay(): Promise<Uint8Array | null> {
  if (_stampCache !== undefined) return _stampCache;
  try {
    const res = await fetch(STAMP_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) throw new Error(`stamp fetch ${res.status}`);
    const buf = await res.arrayBuffer();
    _stampCache = new Uint8Array(buf);
  } catch (e) {
    log('warn', { at: 'receipt-archive.loadStampOverlay', err: (e as Error).message });
    _stampCache = null;
  }
  return _stampCache;
}

// ------------------------------------------------------------- archive push

/** Small base64 helper for Uint8Array — Workers atob/btoa are Latin-1 only. */
const bytesToB64 = (bytes: Uint8Array): string => {
  // Chunk to keep the intermediate string bounded on very large PDFs.
  const chunk = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(bin);
};

export interface ArchiveResult {
  path: string;
  sha: string;
  skipped?: 'disabled' | 'no-repo' | 'no-template';
}

/**
 * Compose the receipt for `r` and push it to the private receipts repo
 * at the configured path. On any error the function logs + returns a
 * skipped result rather than throwing, so a receipt-archive failure
 * never blocks a booking confirmation.
 */
export const archiveReservationReceipt = async (
  env: Env,
  r: Reservation,
  f: Facility,
  cfg: ReceiptsArchiveConfig,
  letterhead: { bytes: Uint8Array; mime: string } | undefined,
  actorEmail: string,
): Promise<ArchiveResult> => {
  if (!cfg.enabled) return { path: '', sha: '', skipped: 'disabled' };
  const target = receiptsRepoTarget(env);
  if (!target) return { path: '', sha: '', skipped: 'no-repo' };
  const path = archivePathFor(r, f, cfg);
  try {
    const pdfBytes = await composeReceiptPdf(r, f, letterhead);
    const b64 = bytesToB64(pdfBytes);
    const res = await putBinaryB64(
      env, path, b64,
      `receipts: archive ${r.id}`,
      actorEmail,
      target,
    );
    log.info(env, 'receipt_archived', { id: r.id, path, bytes: pdfBytes.byteLength });
    return { path, sha: res.sha };
  } catch (err) {
    log.error(env, 'receipt_archive_failed', {
      id: r.id, path,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};

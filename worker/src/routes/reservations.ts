// Reservation Engine — Phase 1.
// Spec: tsh_requirement.md §10.
//
// Endpoints:
//   GET  /facilities                                  list enabled facilities (signed-in)
//   GET  /facilities/:id                              one facility with policy + slots
//   GET  /facilities/:id/availability?from=&to=       per-day per-slot availability
//
//   POST /reservations                                create (resident+; staff may act
//                                                     on-behalf-of by setting ownerEmail)
//   GET  /reservations                                list (resident sees own;
//                                                     manager+ sees all when scope=all)
//   GET  /reservations/:id                            details (owner or manager+)
//   PATCH /reservations/:id                           status transition + optional note
//                                                     (rules per §10.4)
//   POST /reservations/:id/comments                   append a timeline comment
//
// All persistence is a single JSON file at config/reservations.json,
// written through GitHub Contents API — same pattern as announcements.
// Facilities live at config/facilities.json (read-only via API in Phase 1;
// admins edit through the checked-in file today).

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { BadRequest, NotFound, Forbidden } from '../lib/errors.ts';
import { parseJson, str, optStr, oneOf } from '../lib/validate.ts';
import { getFile, putFile, putBinaryB64, getBinaryFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { isAtLeast } from '../auth/roles.ts';
import { tunable } from '../config/defaults.ts';
import { emit as emitNotification } from '../lib/notify.ts';
import { mirrorConfirm, mirrorRemove } from '../lib/google-calendar.ts';
import {
  resolveArchiveConfig,
  receiptsRepoTarget,
  loadLetterheadBytes,
  archiveReservationReceipt,
  archivePathFor,
} from '../lib/receipt-archive.ts';
import {
  RES_STATUSES, RES_ID_RE, nextResId, facilityCode, canTransition,
  isActive, istDateStr, parseIstDateMidnight,
  PROOF_MIMES, proofRepoPath, initialPaymentState, isPaymentClearedForApproval,
  DEFAULT_MAX_PER_FLAT_PER_YEAR, normalizeFlat, istYearFromDate,
  countFlatBookingsForYear,
  parseHHMM, formatHHMM, findOverlap, ensureTimeRange, effectiveHours,
  DEFAULT_OPEN_MIN, DEFAULT_CLOSE_MIN, DEFAULT_MIN_DURATION_MIN, DEFAULT_MAX_DURATION_MIN,
  type Reservation, type Facility, type FacilityPolicy, type Person,
  type TimelineItem, type ProofFile, type ProofMime,
} from '../lib/reservation.ts';

const RES_PATH = 'config/reservations.json';
const FAC_PATH = 'config/facilities.json';
const FLAG = 'FEATURE_TSH_RESERVATIONS';
const MAX_ACTIVE_ITEMS = 500;   // keep the file bounded; archive job is Phase 4
const MAX_TIMELINE = 200;

// -------------------------------------------------- storage + tiny cache

interface Cache<T> { value: T; sha?: string; expiresAt: number }
let facCache: Cache<{ version: number; facilities: Facility[] }> | undefined;
let resCache: Cache<{ version: number; items: Reservation[] }> | undefined;

const invalidateReservations = (): void => { resCache = undefined; };
const invalidateFacilities   = (): void => { facCache = undefined; };

export const _resetReservationCachesForTests = (): void => {
  facCache = undefined;
  resCache = undefined;
};

const loadFacilities = async (ctx: Ctx): Promise<Facility[]> => {
  const now = Date.now();
  if (facCache && facCache.expiresAt > now) return facCache.value.facilities;
  const ttl = tunable(ctx.config, 'RESERVATIONS_CACHE_SECONDS', 60) * 1000;
  const f = await getFile(ctx.env, FAC_PATH);
  if (!f) {
    facCache = { value: { version: 1, facilities: [] }, expiresAt: now + ttl };
    return [];
  }
  try {
    const parsed = JSON.parse(f.content) as { version?: number; facilities?: Facility[] };
    const facilities = Array.isArray(parsed.facilities) ? parsed.facilities : [];
    facCache = {
      value: { version: parsed.version ?? 1, facilities },
      expiresAt: now + ttl,
      ...(f.sha !== undefined ? { sha: f.sha } : {}),
    };
    return facilities;
  } catch {
    facCache = { value: { version: 1, facilities: [] }, expiresAt: now + ttl };
    return [];
  }
};

const loadReservations = async (ctx: Ctx): Promise<{ items: Reservation[]; sha?: string }> => {
  const now = Date.now();
  if (resCache && resCache.expiresAt > now) {
    const out: { items: Reservation[]; sha?: string } = { items: resCache.value.items };
    if (resCache.sha !== undefined) out.sha = resCache.sha;
    return out;
  }
  const ttl = tunable(ctx.config, 'RESERVATIONS_CACHE_SECONDS', 60) * 1000;
  const f = await getFile(ctx.env, RES_PATH);
  if (!f) {
    resCache = { value: { version: 1, items: [] }, expiresAt: now + ttl };
    return { items: [] };
  }
  try {
    const parsed = JSON.parse(f.content) as { version?: number; items?: Reservation[] };
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    resCache = {
      value: { version: parsed.version ?? 1, items },
      expiresAt: now + ttl,
      ...(f.sha !== undefined ? { sha: f.sha } : {}),
    };
    const out: { items: Reservation[]; sha?: string } = { items };
    if (f.sha !== undefined) out.sha = f.sha;
    return out;
  } catch {
    resCache = { value: { version: 1, items: [] }, expiresAt: now + ttl };
    return { items: [] };
  }
};

const saveReservations = async (
  ctx: Ctx,
  items: Reservation[],
  sha: string | undefined,
  actor: string,
  reason: string,
): Promise<void> => {
  if (items.length > MAX_ACTIVE_ITEMS) {
    throw new BadRequest(`reservations file is full (${items.length}/${MAX_ACTIVE_ITEMS}); archive older records`);
  }
  const body = JSON.stringify({ version: 1, items }, null, 2) + '\n';
  await putFile(ctx.env, RES_PATH, body, `reservations: ${reason} by ${actor}`, actor, sha);
  invalidateReservations();
};

// Persist config/facilities.json. Reads the current sha lazily to avoid
// stomping a concurrent admin edit — GitHub returns 409 on stale sha and
// the caller surfaces that as a 409 to the client.
const saveFacilities = async (
  ctx: Ctx,
  facilities: Facility[],
  actor: string,
  reason: string,
): Promise<void> => {
  // Fetch fresh sha (cache may be stale).
  const f = await getFile(ctx.env, FAC_PATH);
  const body = JSON.stringify({ version: 1, facilities }, null, 2) + '\n';
  await putFile(ctx.env, FAC_PATH, body, `facilities: ${reason} by ${actor}`, actor, f?.sha);
  invalidateFacilities();
};

// -------------------------------------------------------- person helpers

const personFromCtx = (ctx: Ctx, overrides: Partial<Person> = {}): Person => {
  const email = ctx.identity?.email ?? '';
  const p: Person = {
    email,
    role: ctx.roles.primary,
  };
  if (overrides.name) p.name = overrides.name;
  if (overrides.flat) p.flat = overrides.flat;
  if (overrides.phone) p.phone = overrides.phone;
  if (overrides.role) p.role = overrides.role;
  return p;
};

const pushTimeline = (r: Reservation, item: TimelineItem): void => {
  r.timeline.push(item);
  if (r.timeline.length > MAX_TIMELINE) r.timeline.splice(0, r.timeline.length - MAX_TIMELINE);
  r.updatedAt = item.at;
};

// ---- Notifications helper -------------------------------------------

const staffEmails = (ctx: Ctx): string[] => {
  const s = new Set<string>();
  for (const e of ctx.access.managers)  s.add(e);
  for (const e of ctx.access.committee) s.add(e);
  for (const e of ctx.access.admins)    s.add(e);
  return Array.from(s);
};

const linkTo = (id: string): string => `reservations.html?open=${encodeURIComponent(id)}`;

const notify = async (
  ctx: Ctx,
  recipients: string[],
  event: Parameters<typeof emitNotification>[2]['event'],
  title: string,
  body: string,
  link?: string,
): Promise<void> => {
  try {
    const input: Parameters<typeof emitNotification>[2] = {
      recipients,
      event,
      title,
      body,
      actor: ctx.identity?.email || 'system',
    };
    if (link) input.link = link;
    await emitNotification(ctx.env, ctx.config, input);
  } catch {
    // Notifications are best-effort. Never fail the parent op because
    // the inbox file is temporarily unreachable.
  }
};

// -------------------------------------------------------------- serialise

const publicFacility = (f: Facility) => {
  const eh = effectiveHours(f.policy);
  return {
    id: f.id,
    name: f.name,
    /** Short uppercase code used as the reservation-id prefix (CH, GA, …). */
    code: facilityCode(f),
    description: f.description ?? '',
    enabled: !!f.enabled,
    capacity: f.capacity ?? 0,
    /** Legacy slots — present when the facility hasn't been migrated. */
    slots: (f.slots ?? []).map((s) => ({ id: s.id, label: s.label, startHour: s.startHour, endHour: s.endHour })),
    policy: {
      minAdvanceHours: f.policy.minAdvanceHours,
      maxAdvanceDays: f.policy.maxAdvanceDays,
      maxConcurrentPerOwner: f.policy.maxConcurrentPerOwner,
      maxPerFlatPerYear: f.policy.maxPerFlatPerYear ?? DEFAULT_MAX_PER_FLAT_PER_YEAR,
      openMin: eh.openMin,
      closeMin: eh.closeMin,
      stepMinutes: eh.stepMinutes,
      minDurationMinutes: eh.minDurationMinutes,
      maxDurationMinutes: eh.maxDurationMinutes,
      requiresApproval: f.policy.requiresApproval,
      requiresPayment: !!f.policy.requiresPayment,
      paymentAmount: f.policy.paymentAmount ?? 0,
      paymentPayee: f.policy.paymentPayee ?? '',
      chargesInfo: f.policy.chargesInfo ?? '',
      rateCard: Array.isArray(f.policy.rateCard)
        ? f.policy.rateCard.map((r) => ({
            label: String(r.label ?? ''),
            ...(typeof r.amount === 'number' ? { amount: r.amount } : {}),
            ...(r.note ? { note: String(r.note) } : {}),
          }))
        : [],
      priceHistory: Array.isArray(f.policy.priceHistory)
        ? f.policy.priceHistory.map((h) => ({
            effectiveDate: String(h.effectiveDate ?? ''),
            ...(typeof h.paymentAmount === 'number' ? { paymentAmount: h.paymentAmount } : {}),
            ...(Array.isArray(h.rateCard)
              ? {
                  rateCard: h.rateCard.map((r) => ({
                    label: String(r.label ?? ''),
                    ...(typeof r.amount === 'number' ? { amount: r.amount } : {}),
                    ...(r.note ? { note: String(r.note) } : {}),
                  })),
                }
              : {}),
            ...(h.chargesInfo ? { chargesInfo: String(h.chargesInfo) } : {}),
            ...(h.source ? { source: String(h.source) } : {}),
            ...(h.recordedBy ? { recordedBy: String(h.recordedBy) } : {}),
            ...(h.recordedAt ? { recordedAt: String(h.recordedAt) } : {}),
            ...(h.note ? { note: String(h.note) } : {}),
          }))
        : [],
      usageGuidelines: {
        before: Array.isArray(f.policy.usageGuidelines?.before) ? f.policy.usageGuidelines!.before! : [],
        after:  Array.isArray(f.policy.usageGuidelines?.after)  ? f.policy.usageGuidelines!.after!  : [],
      },
      blackoutDates: Array.isArray(f.policy.blackoutDates) ? f.policy.blackoutDates : [],
    },
    rules: Array.isArray(f.rules) ? f.rules : [],
  };
};

// ---------------------------------------------------------------- routes

export const mountReservations = (r: Router): void => {

  // ---- Facilities ------------------------------------------------------

  r.get('/facilities', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const list = await loadFacilities(ctx);
    const facilities = list.filter((f) => f.enabled !== false).map(publicFacility);
    return ok(ctx.env, ctx.req, { facilities });
  });

  r.get('/facilities/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const list = await loadFacilities(ctx);
    const f = list.find((x) => x.id === params['id']);
    if (!f) throw new NotFound(`Facility ${params['id']} not found`);
    return ok(ctx.env, ctx.req, { facility: publicFacility(f) });
  });

  // Editable settings (descriptive + policy). Restricted to MANAGER+ so
  // that society managers, committee members and admins can maintain the
  // charges paragraph, rate card, usage guidelines and advance-booking
  // windows without a code deploy. Facility id, legacy `slots` array and
  // Calendar linkage are intentionally NOT editable here.
  r.patch('/facilities/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, {
      flags: [FLAG],
      requireIdentity: true,
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
    });
    const list = await loadFacilities(ctx);
    const idx = list.findIndex((x) => x.id === params['id']);
    if (idx === -1) throw new NotFound(`Facility ${params['id']} not found`);
    const target = list[idx]!;
    const body = await parseJson<Record<string, unknown>>(ctx.req);

    // ---- top-level (name/description/enabled/capacity/rules) ----
    if (typeof body['name'] === 'string') {
      const n = (body['name'] as string).trim();
      if (n.length < 2 || n.length > 80) throw new BadRequest('name must be 2..80 chars');
      target.name = n;
    }
    if (typeof body['description'] === 'string') {
      target.description = (body['description'] as string).slice(0, 800);
    }
    if (typeof body['enabled'] === 'boolean') target.enabled = body['enabled'] as boolean;
    if (typeof body['capacity'] === 'number' && Number.isFinite(body['capacity'])) {
      target.capacity = Math.max(0, Math.floor(body['capacity'] as number));
    }
    if (typeof body['code'] === 'string') {
      // Facility code drives the reservation-id prefix (CH-…, GA-…).
      // 2–6 uppercase letters only; empty string clears the override so
      // facilityCode() falls back to deriving from id.
      const c = (body['code'] as string).trim().toUpperCase();
      if (c === '') delete target.code;
      else if (/^[A-Z]{2,6}$/.test(c)) target.code = c;
      else throw new BadRequest('code must be 2–6 uppercase letters');
    }
    if (Array.isArray(body['rules'])) {
      target.rules = (body['rules'] as unknown[])
        .map((r) => (typeof r === 'string' ? r.trim() : ''))
        .filter((s) => s.length > 0 && s.length <= 240)
        .slice(0, 30);
    }

    // ---- policy ----
    const pIn = (body['policy'] ?? {}) as Record<string, unknown>;
    const pOut = { ...target.policy };
    const setNum = (k: keyof FacilityPolicy, lo: number, hi: number): void => {
      const v = pIn[k as string];
      if (typeof v === 'number' && Number.isFinite(v)) {
        const n = Math.max(lo, Math.min(hi, Math.floor(v)));
        (pOut as Record<string, unknown>)[k as string] = n;
      }
    };
    setNum('minAdvanceHours',       0, 24 * 30);
    setNum('maxAdvanceDays',        1, 365);
    setNum('maxConcurrentPerOwner', 1, 20);
    setNum('maxPerFlatPerYear',     1, 52);
    setNum('openMin',               0, 24 * 60);
    setNum('closeMin',              0, 24 * 60);
    setNum('stepMinutes',           5, 240);
    setNum('minDurationMinutes',    5, 24 * 60);
    setNum('maxDurationMinutes',    5, 24 * 60);
    setNum('defaultDurationMinutes', 5, 24 * 60);
    setNum('baseIncludedHours',     0, 24);
    setNum('overtimeHourlyAmount',  0, 10_000_000);
    setNum('paymentAmount',         0, 10_000_000);
    if (typeof pIn['requiresApproval'] === 'boolean') pOut.requiresApproval = pIn['requiresApproval'] as boolean;
    if (typeof pIn['requiresPayment']  === 'boolean') pOut.requiresPayment  = pIn['requiresPayment']  as boolean;
    if (typeof pIn['paymentPayee']     === 'string')  pOut.paymentPayee     = (pIn['paymentPayee'] as string).slice(0, 120);
    if (typeof pIn['chargesInfo']      === 'string')  pOut.chargesInfo      = (pIn['chargesInfo']  as string).slice(0, 2000);
    if (Array.isArray(pIn['rateCard'])) {
      pOut.rateCard = (pIn['rateCard'] as unknown[])
        .map((row) => {
          const r = (row ?? {}) as Record<string, unknown>;
          const label = typeof r['label'] === 'string' ? (r['label'] as string).trim().slice(0, 120) : '';
          if (!label) return null;
          const out: { label: string; amount?: number; note?: string } = { label };
          if (typeof r['amount'] === 'number' && Number.isFinite(r['amount'])) {
            out.amount = Math.max(0, Math.floor(r['amount'] as number));
          }
          if (typeof r['note'] === 'string' && (r['note'] as string).trim()) {
            out.note = (r['note'] as string).trim().slice(0, 240);
          }
          return out;
        })
        .filter((r): r is { label: string; amount?: number; note?: string } => r !== null)
        .slice(0, 24);
    }
    // Price history: full replacement, validated. Managers, committee
    // and admins can add / edit / reorder entries via this endpoint.
    // Empty array clears the log. Anything not an array is ignored so
    // partial PATCHes (that don't mention priceHistory) preserve the
    // existing log.
    if (Array.isArray(pIn['priceHistory'])) {
      const nowIso = new Date().toISOString();
      pOut.priceHistory = (pIn['priceHistory'] as unknown[])
        .map((row) => {
          const h = (row ?? {}) as Record<string, unknown>;
          const effectiveDate = typeof h['effectiveDate'] === 'string' ? (h['effectiveDate'] as string).trim() : '';
          if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return null;
          const out: NonNullable<FacilityPolicy['priceHistory']>[number] = { effectiveDate };
          if (typeof h['paymentAmount'] === 'number' && Number.isFinite(h['paymentAmount'])) {
            out.paymentAmount = Math.max(0, Math.floor(h['paymentAmount'] as number));
          }
          if (Array.isArray(h['rateCard'])) {
            out.rateCard = (h['rateCard'] as unknown[])
              .map((rr) => {
                const r = (rr ?? {}) as Record<string, unknown>;
                const label = typeof r['label'] === 'string' ? (r['label'] as string).trim().slice(0, 120) : '';
                if (!label) return null;
                const rowOut: { label: string; amount?: number; note?: string } = { label };
                if (typeof r['amount'] === 'number' && Number.isFinite(r['amount'])) {
                  rowOut.amount = Math.max(0, Math.floor(r['amount'] as number));
                }
                if (typeof r['note'] === 'string' && (r['note'] as string).trim()) {
                  rowOut.note = (r['note'] as string).trim().slice(0, 240);
                }
                return rowOut;
              })
              .filter((r): r is { label: string; amount?: number; note?: string } => r !== null)
              .slice(0, 24);
          }
          if (typeof h['chargesInfo'] === 'string' && (h['chargesInfo'] as string).trim()) {
            out.chargesInfo = (h['chargesInfo'] as string).slice(0, 2000);
          }
          if (typeof h['source'] === 'string' && (h['source'] as string).trim()) {
            out.source = (h['source'] as string).trim().slice(0, 240);
          }
          if (typeof h['note'] === 'string' && (h['note'] as string).trim()) {
            out.note = (h['note'] as string).trim().slice(0, 500);
          }
          // recordedBy / recordedAt are set server-side when the entry
          // arrives without them; if the client supplied values (e.g.
          // preserving an existing entry) we keep them as-is.
          if (typeof h['recordedBy'] === 'string' && (h['recordedBy'] as string).trim()) {
            out.recordedBy = (h['recordedBy'] as string).trim().slice(0, 240);
          } else {
            out.recordedBy = ctx.identity?.email || 'system';
          }
          if (typeof h['recordedAt'] === 'string' && (h['recordedAt'] as string).trim()) {
            out.recordedAt = (h['recordedAt'] as string).trim().slice(0, 40);
          } else {
            out.recordedAt = nowIso;
          }
          return out;
        })
        .filter((h): h is NonNullable<FacilityPolicy['priceHistory']>[number] => h !== null)
        .slice(0, 100);
    }
    if (pIn['usageGuidelines'] && typeof pIn['usageGuidelines'] === 'object') {
      const g = pIn['usageGuidelines'] as Record<string, unknown>;
      const cleanList = (arr: unknown): string[] =>
        Array.isArray(arr)
          ? (arr as unknown[])
              .map((s) => (typeof s === 'string' ? s.trim() : ''))
              .filter((s) => s.length > 0 && s.length <= 240)
              .slice(0, 20)
          : [];
      pOut.usageGuidelines = {
        before: cleanList(g['before']),
        after:  cleanList(g['after']),
      };
    }
    if (Array.isArray(pIn['blackoutDates'])) {
      pOut.blackoutDates = (pIn['blackoutDates'] as unknown[])
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
        .slice(0, 200);
    }

    // Cross-field validation: closeMin > openMin, maxDuration >= minDuration.
    const openM  = pOut.openMin  ?? DEFAULT_OPEN_MIN;
    const closeM = pOut.closeMin ?? DEFAULT_CLOSE_MIN;
    if (closeM <= openM) throw new BadRequest('closeMin must be greater than openMin');
    const minD = pOut.minDurationMinutes ?? DEFAULT_MIN_DURATION_MIN;
    const maxD = pOut.maxDurationMinutes ?? DEFAULT_MAX_DURATION_MIN;
    if (maxD < minD) throw new BadRequest('maxDurationMinutes must be >= minDurationMinutes');

    // Auto-append a priceHistory entry when the rate (paymentAmount or
    // rateCard) actually changed AND the caller didn't hand-craft the
    // priceHistory array. Keeps the revision log honest without asking
    // the UI to build the entry.
    if (!Array.isArray(pIn['priceHistory'])) {
      const oldAmount = typeof target.policy.paymentAmount === 'number' ? target.policy.paymentAmount : undefined;
      const newAmount = typeof pOut.paymentAmount === 'number' ? pOut.paymentAmount : undefined;
      const oldRateCard = Array.isArray(target.policy.rateCard) ? target.policy.rateCard : [];
      const newRateCard = Array.isArray(pOut.rateCard) ? pOut.rateCard : [];
      const rateChanged =
        oldAmount !== newAmount ||
        JSON.stringify(oldRateCard) !== JSON.stringify(newRateCard);
      if (rateChanged) {
        const nowIso = new Date().toISOString();
        const entry: NonNullable<FacilityPolicy['priceHistory']>[number] = {
          effectiveDate: nowIso.slice(0, 10),
          source: 'auto (edited via Facility settings)',
          recordedBy: ctx.identity?.email || 'system',
          recordedAt: nowIso,
        };
        if (typeof newAmount === 'number') entry.paymentAmount = newAmount;
        if (newRateCard.length) entry.rateCard = newRateCard.map((r) => ({ ...r }));
        if (typeof pOut.chargesInfo === 'string' && pOut.chargesInfo.trim()) {
          entry.chargesInfo = pOut.chargesInfo;
        }
        const existing = Array.isArray(target.policy.priceHistory) ? target.policy.priceHistory : [];
        pOut.priceHistory = [...existing, entry].slice(-100);
      }
    }

    target.policy = pOut;
    list[idx] = target;

    const actor = ctx.identity?.email || 'system';
    await saveFacilities(ctx, list, actor, `${target.id} updated`);
    await writeAudit(ctx.env, {
      actor,
      action: 'facility:update',
      target: target.id,
      detail: `role=${ctx.roles.primary}`,
    });
    return ok(ctx.env, ctx.req, { facility: publicFacility(target) });
  });

  r.get('/facilities/:id/availability', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const list = await loadFacilities(ctx);
    const f = list.find((x) => x.id === params['id']);
    if (!f) throw new NotFound(`Facility ${params['id']} not found`);
    const from = ctx.url.searchParams.get('from') ?? istDateStr(Date.now());
    const to   = ctx.url.searchParams.get('to')   ?? from;
    const fromMs = parseIstDateMidnight(from);
    const toMs   = parseIstDateMidnight(to);
    if (toMs < fromMs) throw new BadRequest('to must be >= from');
    // Cap the range to keep the payload small; the UI only ever asks for
    // ~30-90 days at a time.
    const spanDays = Math.floor((toMs - fromMs) / (24 * 60 * 60 * 1000)) + 1;
    if (spanDays > 120) throw new BadRequest('date range must be <= 120 days');

    const { items } = await loadReservations(ctx);
    const forFac = items.filter((x) => x.facilityId === f.id && !x.isDeleted && isActive(x)).map((r) => ensureTimeRange(r, f));
    const blackout = new Set<string>(f.policy.blackoutDates ?? []);
    const eh = effectiveHours(f.policy);

    const days: Array<{
      date: string;
      blackout: boolean;
      busy: Array<{ startMin: number; endMin: number; status: 'held' | 'confirmed'; reservationId: string }>;
    }> = [];
    for (let ms = fromMs; ms <= toMs; ms += 24 * 60 * 60 * 1000) {
      const dstr = istDateStr(ms);
      const isBlackout = blackout.has(dstr);
      const busy = forFac
        .filter((r) => r.date === dstr)
        .map((r) => ({
          startMin: r.startMin,
          endMin: r.endMin,
          status: (r.status === 'confirmed' ? 'confirmed' : 'held') as 'held' | 'confirmed',
          reservationId: r.id,
        }))
        .sort((a, b) => a.startMin - b.startMin);
      days.push({ date: dstr, blackout: isBlackout, busy });
    }
    return ok(ctx.env, ctx.req, {
      facilityId: f.id,
      from, to,
      open: {
        openMin:            eh.openMin,
        closeMin:           eh.closeMin,
        stepMinutes:        eh.stepMinutes,
        minDurationMinutes: eh.minDurationMinutes,
        maxDurationMinutes: eh.maxDurationMinutes,
      },
      days,
    });
  });

  // ---- Reservations: LIST + GET ---------------------------------------

  r.get('/reservations', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const { items } = await loadReservations(ctx);
    const scope = ctx.url.searchParams.get('scope') ?? 'mine';
    const statusFilter = ctx.url.searchParams.get('status');
    const facilityFilter = ctx.url.searchParams.get('facilityId');
    const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();

    const meEmail = ctx.identity!.email.toLowerCase();
    const isStaff = isAtLeast(ctx.roles, 'MANAGER');

    let out = items.filter((r) => !r.isDeleted);
    if (scope === 'mine' || !isStaff) {
      out = out.filter((r) => r.owner.email.toLowerCase() === meEmail);
    }
    if (statusFilter && statusFilter !== 'all') {
      out = out.filter((r) => r.status === statusFilter);
    }
    if (facilityFilter) {
      out = out.filter((r) => r.facilityId === facilityFilter);
    }
    if (q) {
      out = out.filter((r) =>
        r.id.toLowerCase().includes(q) ||
        (r.owner.name || '').toLowerCase().includes(q) ||
        (r.owner.flat || '').toLowerCase().includes(q) ||
        (r.owner.phone || '').toLowerCase().includes(q) ||
        (r.purpose || '').toLowerCase().includes(q) ||
        r.date.includes(q));
    }
    // newest first
    out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return ok(ctx.env, ctx.req, { items: out, count: out.length });
  });

  r.get('/reservations/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const { items } = await loadReservations(ctx);
    const rec = items.find((x) => x.id === params['id'] && !x.isDeleted);
    if (!rec) throw new NotFound(`Reservation ${params['id']} not found`);
    const meEmail = ctx.identity!.email.toLowerCase();
    const isStaff = isAtLeast(ctx.roles, 'MANAGER');
    if (!isStaff && rec.owner.email.toLowerCase() !== meEmail) throw new Forbidden('Not your reservation');
    return ok(ctx.env, ctx.req, { reservation: rec });
  });

  // ---- Reservations: CREATE -------------------------------------------

  r.post('/reservations', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const facilityId = str(body['facilityId'], 'facilityId', { min: 1, max: 60 });
    const date       = str(body['date'], 'date', { min: 10, max: 10 });
    const purpose    = str(body['purpose'], 'purpose', { min: 3, max: 400 });
    // Flat number is required so we can enforce the per-flat annual quota.
    // Normalized form is stored so "A-101", "a 101", etc. share a bucket.
    const ownerFlatRaw = str(body['ownerFlat'], 'ownerFlat', { min: 1, max: 40 });
    const ownerFlatNorm = normalizeFlat(ownerFlatRaw);
    if (!ownerFlatNorm) throw new BadRequest('ownerFlat must contain at least one letter or digit');
    const ownerEmailIn = optStr(body['ownerEmail'], 'ownerEmail', { max: 120 });
    const ownerName    = optStr(body['ownerName'], 'ownerName', { max: 120 });
    const ownerPhone   = optStr(body['ownerPhone'], 'ownerPhone', { max: 40 });
    // Time range \u2014 canonical inputs. Legacy `slotId` is still accepted
    // for compatibility and mapped to the facility's slot table.
    const startTimeIn = optStr(body['startTime'], 'startTime', { max: 5 });
    const endTimeIn   = optStr(body['endTime'],   'endTime',   { max: 5 });
    const slotIdIn    = optStr(body['slotId'],    'slotId',    { max: 40 });

    const facilities = await loadFacilities(ctx);
    const facility = facilities.find((f) => f.id === facilityId);
    if (!facility) throw new BadRequest(`Unknown facility ${facilityId}`);
    if (!facility.enabled) throw new BadRequest(`Facility ${facility.name} is not accepting bookings`);

    // Resolve the effective time range.
    let startMin: number;
    let endMin: number;
    let legacySlotId: string | undefined;
    let legacySlotLabel: string | undefined;
    if (startTimeIn && endTimeIn) {
      startMin = parseHHMM(startTimeIn);
      endMin   = parseHHMM(endTimeIn);
    } else if (slotIdIn) {
      const slot = (facility.slots ?? []).find((s) => s.id === slotIdIn);
      if (!slot) throw new BadRequest(`Unknown slot ${slotIdIn} for ${facility.name}`);
      startMin = slot.startHour * 60;
      endMin   = slot.endHour * 60;
      legacySlotId = slot.id;
      legacySlotLabel = `${slot.label} (${slot.startHour}:00\u2013${slot.endHour}:00)`;
    } else {
      throw new BadRequest('startTime + endTime (HH:MM) are required');
    }
    if (endMin <= startMin) throw new BadRequest('endTime must be strictly after startTime');

    const eh = effectiveHours(facility.policy);
    if (startMin < eh.openMin || endMin > eh.closeMin) {
      throw new BadRequest(`Bookings must fall between ${formatHHMM(eh.openMin)} and ${formatHHMM(eh.closeMin)}`);
    }
    if (startMin % eh.stepMinutes !== 0 || endMin % eh.stepMinutes !== 0) {
      throw new BadRequest(`Booking times must be aligned to ${eh.stepMinutes}-minute increments`);
    }
    const duration = endMin - startMin;
    if (duration < eh.minDurationMinutes) {
      throw new BadRequest(`Minimum booking length is ${eh.minDurationMinutes} minutes`);
    }
    if (duration > eh.maxDurationMinutes) {
      throw new BadRequest(`Maximum booking length is ${eh.maxDurationMinutes} minutes`);
    }

    // Policy checks. Committee & Admin bypass the advance-notice,
    // advance-window, blackout, per-owner-cap and per-flat-quota rules so
    // they can book "anytime" (spec: any staff-priority booking). Society
    // Manager (MANAGER) still follows the resident rules and must request
    // approval like everyone else.
    const meEmail = ctx.identity!.email.toLowerCase();
    const isStaff = isAtLeast(ctx.roles, 'MANAGER');
    const bypassPolicy = ctx.roles.primary === 'COMMITTEE' || ctx.roles.primary === 'ADMIN';
    const now = Date.now();
    const startMs = parseIstDateMidnight(date) + startMin * 60 * 1000;
    if (!bypassPolicy) {
      const minAdvanceMs = facility.policy.minAdvanceHours * 60 * 60 * 1000;
      const maxAdvanceMs = facility.policy.maxAdvanceDays * 24 * 60 * 60 * 1000;
      if (startMs - now < minAdvanceMs) {
        throw new BadRequest(`This facility requires at least ${facility.policy.minAdvanceHours}h advance notice`);
      }
      if (startMs - now > maxAdvanceMs) {
        throw new BadRequest(`This facility can only be booked up to ${facility.policy.maxAdvanceDays} days ahead`);
      }
      if ((facility.policy.blackoutDates ?? []).includes(date)) {
        throw new BadRequest('That date is blocked for this facility');
      }
    }

    // Owner resolution: residents may only book for themselves.
    // Staff (MANAGER+) may book on-behalf by providing ownerEmail.
    let ownerEmail = meEmail;
    if (ownerEmailIn) {
      const requested = ownerEmailIn.toLowerCase();
      if (requested !== meEmail && !isStaff) throw new Forbidden('Only staff may book on behalf of another resident');
      ownerEmail = requested;
    }

    // Load current state.
    const { items, sha } = await loadReservations(ctx);
    const active = items.filter((r) => !r.isDeleted);

    // Overlap check on the target date.
    const clash = findOverlap(active, facility.id, date, startMin, endMin);
    if (clash) {
      throw new BadRequest(
        `Overlaps existing booking ${clash.id} (${formatHHMM(clash.startMin)}\u2013${formatHHMM(clash.endMin)}). Please pick another time.`,
      );
    }

    if (!bypassPolicy) {
      // Per-owner concurrency cap.
      const held = active.filter((r) => r.owner.email.toLowerCase() === ownerEmail && isActive(r));
      if (held.length >= facility.policy.maxConcurrentPerOwner) {
        throw new BadRequest(`You already have ${held.length} active reservation(s); cancel one before creating another.`);
      }

      // Per-flat, per-year quota. Cancelled/rejected records do not count,
      // so a flat that hits the cap can free a slot by cancelling first.
      const perFlatCap = facility.policy.maxPerFlatPerYear ?? DEFAULT_MAX_PER_FLAT_PER_YEAR;
      const year = istYearFromDate(date);
      const flatUsed = countFlatBookingsForYear(active, facility.id, ownerFlatNorm, year);
      if (flatUsed >= perFlatCap) {
        throw new BadRequest(
          `Flat ${ownerFlatRaw} already has ${flatUsed} booking(s) at ${facility.name} in ${year} ` +
          `(limit ${perFlatCap} per calendar year). Cancel an existing booking or wait for next year.`,
        );
      }
    }

    // Allocate ID and record.
    const existing = new Set<string>(items.map((r) => r.id));
    const id = nextResId(existing, facilityCode(facility), now);

    const owner: Person = {
      email: ownerEmail,
      flat: ownerFlatRaw,
      ...(ownerName ? { name: ownerName } : {}),
      ...(ownerPhone ? { phone: ownerPhone } : {}),
    };
    const createdBy = personFromCtx(ctx);

    const nowIso = new Date(now).toISOString();
    const rec: Reservation = {
      id,
      facilityId: facility.id,
      facilityLabel: facility.name,
      date,
      startMin,
      endMin,
      ...(legacySlotId ? { slotId: legacySlotId } : {}),
      ...(legacySlotLabel ? { slotLabel: legacySlotLabel } : {}),
      purpose,
      status: facility.policy.requiresApproval ? 'requested' : 'confirmed',
      owner,
      createdBy,
      createdAt: nowIso,
      updatedAt: nowIso,
      timeline: [
        {
          at: nowIso,
          by: createdBy,
          event: 'created',
          note: ownerEmail !== meEmail
            ? `on behalf of ${ownerEmail}`
            : (facility.policy.requiresApproval ? 'Awaiting manager review.' : 'Auto-confirmed by facility policy.'),
        },
      ],
    };
    const initialPayment = initialPaymentState(facility);
    if (initialPayment) rec.payment = initialPayment;

    items.push(rec);
    await saveReservations(ctx, items, sha, ctx.identity!.email, `create ${id}`);
    await writeAudit(ctx.env, {
      actor: ctx.identity!.email,
      action: 'reservations:create',
      target: id,
      detail: `facility=${facility.id} date=${date} time=${formatHHMM(startMin)}-${formatHHMM(endMin)} owner=${ownerEmail}`,
    });
    // Notifications: tell the owner (if the creator is not the owner) and
    // all staff so the manage queue lights up in real time.
    const notifyRecipients = new Set<string>();
    if (ownerEmail !== meEmail) notifyRecipients.add(ownerEmail);
    for (const s of staffEmails(ctx)) notifyRecipients.add(s);
    if (notifyRecipients.size) {
      const title = `New reservation · ${facility.name}`;
      const body = `${date} · ${formatHHMM(startMin)}–${formatHHMM(endMin)} · ${owner.flat ? owner.flat + ' · ' : ''}${purpose.slice(0, 100)}`;
      await notify(ctx, Array.from(notifyRecipients), 'reservation-created', title, body, linkTo(id));
    }
    return ok(ctx.env, ctx.req, { reservation: rec }, 201);
  });

  // ---- Reservations: PATCH (status transition) ------------------------

  r.patch('/reservations/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const to = oneOf(body['status'], 'status', RES_STATUSES);
    const note = optStr(body['note'], 'note', { max: 500 });

    const { items, sha } = await loadReservations(ctx);
    const idx = items.findIndex((x) => x.id === params['id'] && !x.isDeleted);
    if (idx === -1) throw new NotFound(`Reservation ${params['id']} not found`);
    const rec = items[idx]!;

    const meEmail = ctx.identity!.email.toLowerCase();
    const isOwner = rec.owner.email.toLowerCase() === meEmail;
    const isStaff = isAtLeast(ctx.roles, 'MANAGER');
    const isCommittee = isAtLeast(ctx.roles, 'COMMITTEE');

    // Authorisation matrix.
    //  - approve (-> confirmed / under-review) : MANAGER+
    //  - reject                                : MANAGER+ (reason required)
    //  - cancel                                : OWNER or MANAGER+
    if (to === 'confirmed' || to === 'under-review') {
      if (!isStaff) throw new Forbidden('Only managers can approve or move to Under Review');
    } else if (to === 'rejected') {
      if (!isStaff) throw new Forbidden('Only managers can reject');
      if (!note || !note.trim()) throw new BadRequest('reason (note) is required when rejecting');
    } else if (to === 'cancelled') {
      if (!isOwner && !isStaff) throw new Forbidden('Only the owner or a manager can cancel');
    } else if (to === 'requested') {
      throw new BadRequest('Cannot reset a reservation to Requested');
    }

    // Payment gate: cannot confirm a reservation on a paid facility until
    // the payment proof has been verified (see §18.6).
    let facilityForMirror: import('../lib/reservation.ts').Facility | undefined;
    if (to === 'confirmed' || to === 'cancelled' || to === 'rejected') {
      const facilities = await loadFacilities(ctx);
      facilityForMirror = facilities.find((f) => f.id === rec.facilityId);
    }
    if (to === 'confirmed') {
      if (facilityForMirror && !isPaymentClearedForApproval(rec, facilityForMirror)) {
        throw new BadRequest('Cannot confirm: payment has not been verified yet');
      }
    }

    if (!canTransition(rec.status, to)) {
      // Committee override: allow moving out of any terminal state by first
      // re-opening. For Phase 1 we simply refuse and record the attempt.
      throw new BadRequest(`Cannot transition from ${rec.status} to ${to}`);
    }

    rec.status = to;
    const nowIso = new Date().toISOString();
    const eventName: TimelineItem['event'] =
      to === 'confirmed' ? 'approved' :
      to === 'rejected'  ? 'rejected' :
      to === 'cancelled' ? 'cancelled' :
      'edited';
    const by = personFromCtx(ctx);
    const item: TimelineItem = { at: nowIso, by, event: eventName };
    if (note) item.note = note;
    if (isCommittee && !isOwner) {
      // Committee acting on a reservation not their own is an override
      // worth preserving in the timeline label for later audits.
      item.event = eventName;
    }
    pushTimeline(rec, item);

    items[idx] = rec;
    await saveReservations(ctx, items, sha, ctx.identity!.email, `${eventName} ${rec.id}`);
    await writeAudit(ctx.env, {
      actor: ctx.identity!.email,
      action: `reservations:${eventName}`,
      target: rec.id,
      detail: note ? `note=${note}` : '',
    });
    // Google Calendar mirror (Phase 3). Best-effort; failures are queued
    // and never break the transition. Only fires when the feature flag is
    // on AND the facility declares a `calendarId`.
    if (facilityForMirror) {
      try {
        if (to === 'confirmed') {
          const evId = await mirrorConfirm(ctx.env, ctx.config, rec, facilityForMirror);
          if (evId) {
            rec.calendarEventId = evId;
            // Persist the event id so a later cancel can find + delete it.
            const { items: items2, sha: sha2 } = await loadReservations(ctx);
            const j = items2.findIndex((x) => x.id === rec.id);
            if (j !== -1) {
              items2[j] = rec;
              await saveReservations(ctx, items2, sha2, 'system', `calendar-event-id ${rec.id}`);
            }
          }
        } else if (to === 'cancelled' || to === 'rejected') {
          await mirrorRemove(ctx.env, ctx.config, rec, facilityForMirror);
        }
      } catch { /* silent — queue handled inside mirror helpers */ }
    }
    // Receipt archive (private repo push). Fires on confirm only.
    // Best-effort: failures are audited but never block the transition.
    if (to === 'confirmed' && facilityForMirror) {
      try {
        const siteFile = await getFile(ctx.env, 'config/site.json');
        const siteJson = siteFile
          ? (JSON.parse(siteFile.content) as { system?: { receiptTemplate?: { url?: string; path?: string }; receiptsArchive?: unknown } })
          : undefined;
        const archiveCfg = resolveArchiveConfig(siteJson);
        if (archiveCfg.enabled && receiptsRepoTarget(ctx.env)) {
          const letterhead = await loadLetterheadBytes(ctx.env, siteJson?.system?.receiptTemplate);
          const result = await archiveReservationReceipt(
            ctx.env, rec, facilityForMirror, archiveCfg, letterhead, ctx.identity!.email,
          );
          if (!result.skipped) {
            rec.archive = {
              path: result.path,
              sha: result.sha,
              archivedAt: new Date().toISOString(),
            };
            const { items: items3, sha: sha3 } = await loadReservations(ctx);
            const k = items3.findIndex((x) => x.id === rec.id);
            if (k !== -1) {
              items3[k] = rec;
              await saveReservations(ctx, items3, sha3, 'system', `receipt-archive ${rec.id}`);
            }
            await writeAudit(ctx.env, {
              actor: 'system',
              action: 'receipts:archive',
              target: rec.id,
              detail: `path=${result.path}`,
            });
          }
        }
      } catch (err) {
        await writeAudit(ctx.env, {
          actor: 'system',
          action: 'receipts:archive-failed',
          target: rec.id,
          detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
      }
    }
    // Notify the owner (and, if a resident cancels, the staff).
    const notifEvent: Parameters<typeof emitNotification>[2]['event'] =
      to === 'confirmed' ? 'reservation-approved' :
      to === 'rejected'  ? 'reservation-rejected' :
      to === 'cancelled' ? 'reservation-cancelled' :
      'reservation-created';
    const recipients = new Set<string>();
    recipients.add(rec.owner.email);
    if (to === 'cancelled' && isOwner) {
      for (const s of staffEmails(ctx)) recipients.add(s);
    }
    recipients.delete(meEmail);   // no self-notify
    if (recipients.size) {
      const title = `Reservation ${to} · ${rec.facilityLabel}`;
      const timeStr = typeof rec.startMin === 'number' && typeof rec.endMin === 'number'
        ? `${formatHHMM(rec.startMin)}–${formatHHMM(rec.endMin)}`
        : (rec.slotLabel ?? '');
      const body = `${rec.date} · ${timeStr}${note ? ' · ' + note.slice(0, 100) : ''}`;
      await notify(ctx, Array.from(recipients), notifEvent, title, body, linkTo(rec.id));
    }
    return ok(ctx.env, ctx.req, { reservation: rec });
  });

  // ---- Reservations: delete (soft) ------------------------------------
  //
  // Admin: can remove any reservation (any status). Should include a
  // reason when the reservation was still active.
  // Committee: can remove only reservations already in a terminal state
  // (cancelled or rejected) so the list of past requests can be pruned.
  // Manager and residents: not permitted — residents cancel active
  // reservations via PATCH; managers coordinate but don't erase.
  r.delete('/reservations/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, {
      flags: [FLAG],
      requireIdentity: true,
      roles: ['COMMITTEE', 'ADMIN'],
    });
    let body: Record<string, unknown> = {};
    try {
      body = await parseJson<Record<string, unknown>>(ctx.req);
    } catch { /* body optional */ }
    const reason = typeof body['reason'] === 'string' ? (body['reason'] as string).trim().slice(0, 500) : '';

    const { items, sha } = await loadReservations(ctx);
    const idx = items.findIndex((x) => x.id === params['id'] && !x.isDeleted);
    if (idx === -1) throw new NotFound(`Reservation ${params['id']} not found`);
    const rec = items[idx]!;
    const isAdmin = ctx.roles.primary === 'ADMIN';
    const isTerminal = rec.status === 'cancelled' || rec.status === 'rejected';
    if (!isAdmin && !isTerminal) {
      throw new Forbidden('Only cancelled or rejected reservations can be removed. Ask an admin to delete active ones.');
    }

    const nowIso = new Date().toISOString();
    const wasConfirmed = rec.status === 'confirmed';
    rec.isDeleted = true;
    pushTimeline(rec, {
      at: nowIso,
      by: personFromCtx(ctx),
      event: 'deleted',
      note: reason || (isAdmin ? 'removed by admin' : 'removed from list'),
    });
    items[idx] = rec;
    const actor = ctx.identity!.email;
    await saveReservations(ctx, items, sha, actor, `delete ${rec.id}`);

    // Best-effort calendar cleanup: only meaningful if it was confirmed.
    if (wasConfirmed) {
      const facilities = await loadFacilities(ctx);
      const fac = facilities.find((f) => f.id === rec.facilityId);
      if (fac) {
        try { await mirrorRemove(ctx.env, ctx.config, rec, fac); } catch { /* queue handles retries */ }
      }
    }

    await writeAudit(ctx.env, {
      actor,
      action: 'reservation:delete',
      target: rec.id,
      detail: `role=${ctx.roles.primary} status-was=${rec.status}${reason ? ' reason=' + reason.slice(0, 200) : ''}`,
    });

    return ok(ctx.env, ctx.req, { id: rec.id, deleted: true });
  });

  // ---- Reservations: comment ------------------------------------------

  r.post('/reservations/:id/comments', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const note = str(body['note'], 'note', { min: 1, max: 500 });

    const { items, sha } = await loadReservations(ctx);
    const idx = items.findIndex((x) => x.id === params['id'] && !x.isDeleted);
    if (idx === -1) throw new NotFound(`Reservation ${params['id']} not found`);
    const rec = items[idx]!;
    const meEmail = ctx.identity!.email.toLowerCase();
    const isOwner = rec.owner.email.toLowerCase() === meEmail;
    const isStaff = isAtLeast(ctx.roles, 'MANAGER');
    if (!isOwner && !isStaff) throw new Forbidden('Only the owner or a manager can comment');

    const nowIso = new Date().toISOString();
    pushTimeline(rec, { at: nowIso, by: personFromCtx(ctx), event: 'commented', note });
    items[idx] = rec;
    await saveReservations(ctx, items, sha, ctx.identity!.email, `comment ${rec.id}`);
    // Notify the other party. If a resident commented, ping staff; if
    // staff commented, ping the owner.
    const recipients = new Set<string>();
    if (isOwner) {
      for (const s of staffEmails(ctx)) recipients.add(s);
    } else {
      recipients.add(rec.owner.email);
    }
    recipients.delete(meEmail);
    if (recipients.size) {
      await notify(
        ctx, Array.from(recipients), 'reservation-commented',
        `Note on ${rec.id}`, note.slice(0, 140), linkTo(rec.id),
      );
    }
    return ok(ctx.env, ctx.req, { reservation: rec });
  });

  // ---- Payment proofs (Phase 2) ---------------------------------------

  const DATA_URL_RE = /^data:([\w+/.-]+);base64,([A-Za-z0-9+/=]+)$/;

  r.post('/reservations/:id/payment-proof', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const dataUrl = str(body['dataUrl'], 'dataUrl', { min: 30, max: 10_000_000 });
    const nameIn  = optStr(body['name'], 'name', { max: 120 });
    const txnRef  = optStr(body['txnRef'], 'txnRef', { max: 80 });

    const { items, sha } = await loadReservations(ctx);
    const idx = items.findIndex((x) => x.id === params['id'] && !x.isDeleted);
    if (idx === -1) throw new NotFound(`Reservation ${params['id']} not found`);
    const rec = items[idx]!;
    const meEmail = ctx.identity!.email.toLowerCase();
    const isOwner = rec.owner.email.toLowerCase() === meEmail;
    const isStaff = isAtLeast(ctx.roles, 'MANAGER');
    if (!isOwner && !isStaff) throw new Forbidden('Only the owner or a manager can upload a payment proof');

    const facilities = await loadFacilities(ctx);
    const facility = facilities.find((f) => f.id === rec.facilityId);
    if (!facility) throw new BadRequest('Facility for this reservation is missing');
    if (!facility.policy.requiresPayment) throw new BadRequest('This facility does not require payment');

    if (!rec.payment) rec.payment = { status: 'pending', proofs: [] };
    const maxProofs = tunable(ctx.config, 'RESERVATION_MAX_PROOFS', 5);
    if (rec.payment.proofs.length >= maxProofs) {
      throw new BadRequest(`Already ${rec.payment.proofs.length} proof(s) on file (max ${maxProofs})`);
    }

    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) throw new BadRequest('dataUrl must be data:<mime>;base64,<payload>');
    const mime = m[1]!;
    const b64  = m[2]!;
    if (!(PROOF_MIMES as readonly string[]).includes(mime)) {
      throw new BadRequest(`unsupported mime type: ${mime}`);
    }
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const byteSize = Math.floor((b64.length * 3) / 4) - padding;
    const maxBytes = tunable(ctx.config, 'RESERVATION_PROOF_MAX_BYTES', 5_242_880);
    if (byteSize > maxBytes) {
      throw new BadRequest(`file is ${byteSize} bytes; exceeds RESERVATION_PROOF_MAX_BYTES (${maxBytes})`);
    }

    const nextIdx = rec.payment.proofs.length + 1;
    // Route the upload to the private receipts repo when it is configured
    // (env.GH_RECEIPTS_REPO is set). Falls back to the legacy public path
    // in the main repo so a mis-configured worker still functions. Legacy
    // proofs already sitting under payments/... in the main repo remain
    // readable via the path-prefix fallback in the GET handler.
    const receiptsTarget = receiptsRepoTarget(ctx.env);
    // Flat layout: files live directly under `<fac>/proofs/` with the reservation
    // id + zero-padded index as the filename, so all proofs for a booking sort
    // together without spawning a subfolder per reservation.
    const path = receiptsTarget
      ? `${facilityCode(facility).toLowerCase()}/proofs/${rec.id}-${String(nextIdx).padStart(2, '0')}.${
          mime === 'application/pdf' ? 'pdf' :
          mime === 'image/png'       ? 'png' :
          mime === 'image/webp'      ? 'webp' : 'jpg'
        }`
      : proofRepoPath(rec.id, nextIdx, mime as ProofMime);
    await putBinaryB64(
      ctx.env, path, b64,
      `reservations: payment proof for ${rec.id} by ${ctx.identity!.email}`,
      ctx.identity!.email,
      receiptsTarget,
    );

    const nowIso = new Date().toISOString();
    const proof: ProofFile = {
      path,
      name: nameIn || `proof-${nextIdx}`,
      mime: mime as ProofMime,
      size: byteSize,
      uploadedAt: nowIso,
      uploadedBy: ctx.identity!.email,
    };
    rec.payment.proofs.push(proof);
    rec.payment.status = 'submitted';
    if (txnRef) rec.payment.txnRef = txnRef;

    pushTimeline(rec, {
      at: nowIso,
      by: personFromCtx(ctx),
      event: 'payment-uploaded',
      note: txnRef ? `txn: ${txnRef}` : `${proof.name} (${Math.round(byteSize / 1024)} KB)`,
    });

    items[idx] = rec;
    await saveReservations(ctx, items, sha, ctx.identity!.email, `payment-uploaded ${rec.id}`);
    await writeAudit(ctx.env, {
      actor: ctx.identity!.email,
      action: 'reservations:payment-uploaded',
      target: rec.id,
      detail: `path=${path} bytes=${byteSize} txnRef=${txnRef ?? ''}`,
    });
    // Notify staff so someone can verify quickly.
    const staff = staffEmails(ctx).filter((e) => e.toLowerCase() !== ctx.identity!.email.toLowerCase());
    if (staff.length) {
      await notify(
        ctx, staff, 'payment-uploaded',
        `Payment proof · ${rec.id}`,
        `${rec.facilityLabel} · ${rec.date} · ${Math.round(byteSize / 1024)} KB`,
        linkTo(rec.id),
      );
    }
    return ok(ctx.env, ctx.req, { reservation: rec }, 201);
  });

  r.get('/reservations/:id/payment-proof/:idx', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const { items } = await loadReservations(ctx);
    const rec = items.find((x) => x.id === params['id'] && !x.isDeleted);
    if (!rec) throw new NotFound(`Reservation ${params['id']} not found`);
    const meEmail = ctx.identity!.email.toLowerCase();
    const isOwner = rec.owner.email.toLowerCase() === meEmail;
    const isStaff = isAtLeast(ctx.roles, 'MANAGER');
    if (!isOwner && !isStaff) throw new Forbidden('Not your reservation');
    const n = Number.parseInt(params['idx'] ?? '', 10);
    if (!Number.isFinite(n) || n < 1) throw new BadRequest('proof index must be >= 1');
    const proof = rec.payment?.proofs[n - 1];
    if (!proof) throw new NotFound(`Proof #${n} not found`);
    // Legacy proofs live in the public main repo under `payments/…`.
    // New proofs land in the private receipts repo (per-facility folder).
    // The stored path is the discriminator so old records keep working
    // even after the migration to the private repo.
    const proofTarget = proof.path.startsWith('payments/')
      ? undefined
      : receiptsRepoTarget(ctx.env);
    const bin = await getBinaryFile(ctx.env, proof.path, proofTarget);
    if (!bin) throw new NotFound(`Proof file ${proof.path} missing`);
    // Stream bytes with the recorded mime. No cache (PII).
    return new Response(bin.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': proof.mime,
        'Content-Length': String(bin.bytes.length),
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `inline; filename="${encodeURIComponent(proof.name)}"`,
      },
    });
  });

  r.patch('/reservations/:id/payment', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['MANAGER', 'COMMITTEE', 'ADMIN'] });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const status = oneOf(body['status'], 'status', ['verified', 'rejected', 'pending'] as const);
    const note = optStr(body['note'], 'note', { max: 500 });
    const txnRef = optStr(body['txnRef'], 'txnRef', { max: 80 });

    const { items, sha } = await loadReservations(ctx);
    const idx = items.findIndex((x) => x.id === params['id'] && !x.isDeleted);
    if (idx === -1) throw new NotFound(`Reservation ${params['id']} not found`);
    const rec = items[idx]!;
    if (!rec.payment) throw new BadRequest('This reservation has no payment on file');
    if (status === 'rejected' && (!note || !note.trim())) {
      throw new BadRequest('reason (note) is required when rejecting a payment');
    }
    if (status === 'verified' && rec.payment.proofs.length === 0) {
      throw new BadRequest('Cannot verify: no proof has been uploaded');
    }

    const nowIso = new Date().toISOString();
    rec.payment.status = status;
    if (txnRef) rec.payment.txnRef = txnRef;
    if (note) rec.payment.note = note;
    if (status === 'verified') {
      rec.payment.verifiedAt = nowIso;
      rec.payment.verifiedBy = ctx.identity!.email;
    }

    const event: TimelineItem['event'] =
      status === 'verified' ? 'payment-verified' :
      status === 'rejected' ? 'payment-rejected' :
      'edited';
    const item: TimelineItem = { at: nowIso, by: personFromCtx(ctx), event };
    if (note) item.note = note;
    pushTimeline(rec, item);

    items[idx] = rec;
    await saveReservations(ctx, items, sha, ctx.identity!.email, `${event} ${rec.id}`);
    await writeAudit(ctx.env, {
      actor: ctx.identity!.email,
      action: `reservations:${event}`,
      target: rec.id,
      detail: note ? `note=${note}` : '',
    });
    // Tell the owner about the verification outcome.
    if (status === 'verified' || status === 'rejected') {
      const notifEvent = status === 'verified' ? 'payment-verified' : 'payment-rejected';
      await notify(
        ctx, [rec.owner.email], notifEvent,
        `Payment ${status} · ${rec.id}`,
        `${rec.facilityLabel} · ${rec.date}${note ? ' · ' + note.slice(0, 100) : ''}`,
        linkTo(rec.id),
      );
    }
    return ok(ctx.env, ctx.req, { reservation: rec });
  });

  // ---- Receipt template (staff-upload of the letterhead/background used
  // when generating the confirmation-receipt PDF). Stored as a committed
  // image or PDF under photos/receipts/, with the current pointer + metadata
  // held in config/site.json → system.receiptTemplate. Public GET so the
  // client can render receipts without a preflight admin round-trip.

  r.get('/receipts/template', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG] });
    const f = await getFile(ctx.env, 'config/site.json');
    let tpl: unknown = null;
    let defaultSealLang: 'en' | 'hi' | 'mr' = 'en';
    let defaultReceiptTheme: 'default' | 'cheque-classic' | 'certificate-brand' = 'default';
    if (f) {
      try {
        const parsed = JSON.parse(f.content) as { system?: { receiptTemplate?: unknown; receiptSealLang?: unknown; receiptTheme?: unknown } };
        tpl = parsed.system?.receiptTemplate ?? null;
        const lang = parsed.system?.receiptSealLang;
        if (lang === 'hi' || lang === 'mr' || lang === 'en') defaultSealLang = lang;
        const th = parsed.system?.receiptTheme;
        if (th === 'cheque-classic' || th === 'certificate-brand' || th === 'default') defaultReceiptTheme = th;
      } catch { /* ignore */ }
    }
    // Overlay the admin-configured seal language + theme onto the
    // template object so one round-trip gives the client every default
    // it needs. Not persisted inside receiptTemplate — read from
    // system.receiptSealLang / system.receiptTheme each time so admins
    // can flip either live.
    if (tpl && typeof tpl === 'object') {
      (tpl as Record<string, unknown>).defaultSealLang = defaultSealLang;
      (tpl as Record<string, unknown>).defaultReceiptTheme = defaultReceiptTheme;
    } else if (defaultReceiptTheme !== 'default') {
      // Non-default themes don't need a letterhead. Return a synthetic
      // stub so the client can still render.
      tpl = { defaultSealLang, defaultReceiptTheme } as Record<string, unknown>;
    }
    return ok(ctx.env, ctx.req, { template: tpl });
  });

  r.post('/receipts/template', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FLAG],
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
      requireIdentity: true,
    });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const dataUrl = str(body['dataUrl'], 'dataUrl', { min: 30, max: 12_000_000 });
    const note = optStr(body['note'], 'note', { max: 200 });
    const m = /^data:(image\/(?:jpe?g|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) throw new BadRequest('dataUrl must be image/jpeg|png|webp or application/pdf base64');
    const mime = m[1]!;
    const b64  = m[2]!;
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const byteSize = Math.floor((b64.length * 3) / 4) - padding;
    const maxBytes = tunable(ctx.config, 'DAILY_PHOTO_MAX_BYTES', 5_242_880);
    if (byteSize > maxBytes) throw new BadRequest(`template ${byteSize} bytes exceeds DAILY_PHOTO_MAX_BYTES (${maxBytes})`);
    const ext = mime === 'image/png' ? 'png'
      : mime === 'image/webp' ? 'webp'
      : mime === 'application/pdf' ? 'pdf' : 'jpg';
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    const hex = Array.from(buf).map((x) => x.toString(16).padStart(2, '0')).join('');
    const path = `photos/receipts/template-${hex}.${ext}`;
    const url = `https://raw.githubusercontent.com/${ctx.env.GH_OWNER}/${ctx.env.GH_REPO}/${ctx.env.GH_BRANCH}/${path}`;
    const actor = ctx.identity!.email;
    await putBinaryB64(ctx.env, path, b64, `receipts: template ${hex}.${ext} by ${actor}`, actor);

    // Merge into config/site.json.system.receiptTemplate.
    const siteFile = await getFile(ctx.env, 'config/site.json');
    if (!siteFile) throw new BadRequest('config/site.json not found');
    let site: Record<string, unknown>;
    try { site = JSON.parse(siteFile.content) as Record<string, unknown>; }
    catch { throw new BadRequest('config/site.json is not valid JSON'); }
    const system = (site['system'] && typeof site['system'] === 'object')
      ? site['system'] as Record<string, unknown>
      : {};
    system['receiptTemplate'] = {
      url,
      path,
      mime,
      bytes: byteSize,
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
      ...(note ? { note } : {}),
    };
    site['system'] = system;
    const serialised = JSON.stringify(site, null, 2) + '\n';
    await putFile(
      ctx.env, 'config/site.json', serialised,
      `receipts: update template pointer by ${actor}`,
      actor, siteFile.sha,
    );
    await writeAudit(ctx.env, {
      actor, action: 'receipts:template',
      target: path,
      detail: `bytes=${byteSize} mime=${mime}${note ? ' note=' + note.slice(0, 60) : ''}`,
    });
    return ok(ctx.env, ctx.req, { template: system['receiptTemplate'] });
  });

  // ---- Receipts archive (private repo) --------------------------------
  //
  // GET  /receipts/archive/:id           stream the archived PDF (MANAGER+)
  // POST /receipts/archive/:id/rebuild   re-compose and re-upload (MANAGER+)
  //
  // The archive itself is written implicitly on the confirmed transition
  // in PATCH /reservations/:id. These endpoints are the read + manual
  // rebuild affordances. Residents intentionally cannot pull the
  // archived copy — they use the on-page receipt modal.

  r.get('/receipts/archive/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, {
      flags: [FLAG],
      requireIdentity: true,
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
    });
    const target = receiptsRepoTarget(ctx.env);
    if (!target) throw new NotFound('Receipts archive is not configured');
    const { items } = await loadReservations(ctx);
    const rec = items.find((x) => x.id === params['id'] && !x.isDeleted);
    if (!rec) throw new NotFound(`Reservation ${params['id']} not found`);
    if (!rec.archive?.path) throw new NotFound('No archived receipt for this reservation yet');
    const bin = await getBinaryFile(ctx.env, rec.archive.path, target);
    if (!bin) throw new NotFound('Archived receipt file is missing from the receipts repo');
    return new Response(bin.bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="receipt-${rec.id}.pdf"`,
        'Cache-Control': 'private, max-age=0, must-revalidate',
      },
    });
  });

  r.post('/receipts/archive/:id/rebuild', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, {
      flags: [FLAG],
      requireIdentity: true,
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
    });
    if (!receiptsRepoTarget(ctx.env)) {
      throw new BadRequest('Receipts archive is not configured (GH_RECEIPTS_REPO unset)');
    }
    const { items, sha } = await loadReservations(ctx);
    const idx = items.findIndex((x) => x.id === params['id'] && !x.isDeleted);
    if (idx === -1) throw new NotFound(`Reservation ${params['id']} not found`);
    const rec = items[idx]!;
    if (rec.status !== 'confirmed') {
      throw new BadRequest('Only confirmed reservations can be archived');
    }
    const facilities = await loadFacilities(ctx);
    const facility = facilities.find((f) => f.id === rec.facilityId);
    if (!facility) throw new NotFound(`Facility ${rec.facilityId} not found`);
    const siteFile = await getFile(ctx.env, 'config/site.json');
    const siteJson = siteFile
      ? (JSON.parse(siteFile.content) as { system?: { receiptTemplate?: { url?: string; path?: string }; receiptsArchive?: unknown } })
      : undefined;
    const archiveCfg = resolveArchiveConfig(siteJson);
    const letterhead = await loadLetterheadBytes(ctx.env, siteJson?.system?.receiptTemplate);
    const result = await archiveReservationReceipt(
      ctx.env, rec, facility, archiveCfg, letterhead, ctx.identity!.email,
    );
    rec.archive = {
      path: result.path,
      sha: result.sha,
      archivedAt: new Date().toISOString(),
    };
    items[idx] = rec;
    await saveReservations(ctx, items, sha, ctx.identity!.email, `receipt-archive-rebuild ${rec.id}`);
    await writeAudit(ctx.env, {
      actor: ctx.identity!.email,
      action: 'receipts:archive-rebuild',
      target: rec.id,
      detail: `path=${result.path}`,
    });
    return ok(ctx.env, ctx.req, { archive: rec.archive });
  });

  // ---- Receipts archive config (Settings page) -----------------------

  r.get('/receipts/archive/config', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FLAG],
      requireIdentity: true,
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
    });
    const siteFile = await getFile(ctx.env, 'config/site.json');
    const siteJson = siteFile
      ? (JSON.parse(siteFile.content) as { system?: { receiptsArchive?: unknown } })
      : undefined;
    const cfg = resolveArchiveConfig(siteJson);
    const target = receiptsRepoTarget(ctx.env);
    return ok(ctx.env, ctx.req, {
      config: cfg,
      target: target ? {
        owner: target.owner,
        repo: target.repo,
        branch: target.branch,
        hasSeparateToken: !!ctx.env.GITHUB_RECEIPTS_TOKEN,
      } : null,
    });
  });

  r.patch('/receipts/archive/config', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: [FLAG],
      requireIdentity: true,
      roles: ['MANAGER', 'COMMITTEE', 'ADMIN'],
    });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const siteFile = await getFile(ctx.env, 'config/site.json');
    if (!siteFile) throw new BadRequest('config/site.json not found');
    let site: Record<string, unknown>;
    try { site = JSON.parse(siteFile.content) as Record<string, unknown>; }
    catch { throw new BadRequest('config/site.json is not valid JSON'); }
    const system = (site['system'] && typeof site['system'] === 'object')
      ? site['system'] as Record<string, unknown>
      : {};
    const current = (system['receiptsArchive'] && typeof system['receiptsArchive'] === 'object')
      ? system['receiptsArchive'] as Record<string, unknown>
      : {};
    if (typeof body['enabled'] === 'boolean') current['enabled'] = body['enabled'];
    if (typeof body['perReceiptPath'] === 'string') {
      const t = (body['perReceiptPath'] as string).trim();
      if (!t) throw new BadRequest('perReceiptPath cannot be empty');
      if (t.length > 240) throw new BadRequest('perReceiptPath too long');
      current['perReceiptPath'] = t;
    }
    if (body['rollup'] && typeof body['rollup'] === 'object') {
      const rIn = body['rollup'] as Record<string, unknown>;
      const rOut = (current['rollup'] && typeof current['rollup'] === 'object')
        ? current['rollup'] as Record<string, unknown>
        : {};
      if (typeof rIn['enabled'] === 'boolean') rOut['enabled'] = rIn['enabled'];
      if (typeof rIn['period'] === 'string' && ['monthly', 'quarterly', 'yearly'].includes(rIn['period'] as string)) {
        rOut['period'] = rIn['period'];
      }
      if (typeof rIn['path'] === 'string') {
        const t = (rIn['path'] as string).trim();
        if (!t) throw new BadRequest('rollup.path cannot be empty');
        if (t.length > 240) throw new BadRequest('rollup.path too long');
        rOut['path'] = t;
      }
      current['rollup'] = rOut;
    }
    system['receiptsArchive'] = current;
    site['system'] = system;
    const serialised = JSON.stringify(site, null, 2) + '\n';
    const actor = ctx.identity!.email;
    await putFile(
      ctx.env, 'config/site.json', serialised,
      `receipts: update archive config by ${actor}`,
      actor, siteFile.sha,
    );
    await writeAudit(ctx.env, {
      actor, action: 'receipts:archive-config',
      target: 'config/site.json',
      detail: JSON.stringify(current).slice(0, 200),
    });
    return ok(ctx.env, ctx.req, { config: resolveArchiveConfig({ system: { receiptsArchive: current } }) });
  });

};

// Re-export ID validator so tests can share the regex.
export { RES_ID_RE };

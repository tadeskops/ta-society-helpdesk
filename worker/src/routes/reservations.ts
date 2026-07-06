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
  RES_STATUSES, RES_ID_RE, nextResId, canTransition, buildSlotIndex,
  isActive, istDateStr, parseIstDateMidnight, slotStartMs,
  PROOF_MIMES, proofRepoPath, initialPaymentState, isPaymentClearedForApproval,
  DEFAULT_MAX_PER_FLAT_PER_YEAR, normalizeFlat, istYearFromDate,
  countFlatBookingsForYear,
  type Reservation, type Facility, type FacilitySlot, type Person,
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

const publicFacility = (f: Facility) => ({
  id: f.id,
  name: f.name,
  description: f.description ?? '',
  enabled: !!f.enabled,
  capacity: f.capacity ?? 0,
  slots: f.slots.map((s) => ({ id: s.id, label: s.label, startHour: s.startHour, endHour: s.endHour })),
  policy: {
    minAdvanceHours: f.policy.minAdvanceHours,
    maxAdvanceDays: f.policy.maxAdvanceDays,
    maxConcurrentPerOwner: f.policy.maxConcurrentPerOwner,
    maxPerFlatPerYear: f.policy.maxPerFlatPerYear ?? DEFAULT_MAX_PER_FLAT_PER_YEAR,
    requiresApproval: f.policy.requiresApproval,
    requiresPayment: !!f.policy.requiresPayment,
    paymentAmount: f.policy.paymentAmount ?? 0,
    paymentPayee: f.policy.paymentPayee ?? '',
    chargesInfo: f.policy.chargesInfo ?? '',
    blackoutDates: Array.isArray(f.policy.blackoutDates) ? f.policy.blackoutDates : [],
  },
  rules: Array.isArray(f.rules) ? f.rules : [],
});

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
    const slotIdx = buildSlotIndex(items.filter((x) => x.facilityId === f.id));
    const blackout = new Set<string>(f.policy.blackoutDates ?? []);

    const days: Array<{ date: string; blackout: boolean; slots: Array<{ id: string; label: string; startHour: number; endHour: number; status: 'available' | 'held' | 'confirmed' | 'blackout'; reservationId?: string }> }> = [];
    for (let ms = fromMs; ms <= toMs; ms += 24 * 60 * 60 * 1000) {
      const dstr = istDateStr(ms);
      const isBlackout = blackout.has(dstr);
      const slots = f.slots.map((s: FacilitySlot) => {
        if (isBlackout) return { id: s.id, label: s.label, startHour: s.startHour, endHour: s.endHour, status: 'blackout' as const };
        const key = `${f.id}|${dstr}|${s.id}`;
        const rid = slotIdx.get(key);
        if (!rid) return { id: s.id, label: s.label, startHour: s.startHour, endHour: s.endHour, status: 'available' as const };
        const held = items.find((x) => x.id === rid);
        const status = held?.status === 'confirmed' ? 'confirmed' as const : 'held' as const;
        return { id: s.id, label: s.label, startHour: s.startHour, endHour: s.endHour, status, reservationId: rid };
      });
      days.push({ date: dstr, blackout: isBlackout, slots });
    }
    return ok(ctx.env, ctx.req, { facilityId: f.id, from, to, days });
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
    const slotId     = str(body['slotId'], 'slotId', { min: 1, max: 40 });
    const purpose    = str(body['purpose'], 'purpose', { min: 3, max: 400 });
    // Flat number is required so we can enforce the per-flat annual quota.
    // Normalized form is stored so "A-101", "a 101", etc. share a bucket.
    const ownerFlatRaw = str(body['ownerFlat'], 'ownerFlat', { min: 1, max: 40 });
    const ownerFlatNorm = normalizeFlat(ownerFlatRaw);
    if (!ownerFlatNorm) throw new BadRequest('ownerFlat must contain at least one letter or digit');
    const ownerEmailIn = optStr(body['ownerEmail'], 'ownerEmail', { max: 120 });
    const ownerName    = optStr(body['ownerName'], 'ownerName', { max: 120 });
    const ownerPhone   = optStr(body['ownerPhone'], 'ownerPhone', { max: 40 });

    const facilities = await loadFacilities(ctx);
    const facility = facilities.find((f) => f.id === facilityId);
    if (!facility) throw new BadRequest(`Unknown facility ${facilityId}`);
    if (!facility.enabled) throw new BadRequest(`Facility ${facility.name} is not accepting bookings`);
    const slot = facility.slots.find((s) => s.id === slotId);
    if (!slot) throw new BadRequest(`Unknown slot ${slotId} for ${facility.name}`);

    // Policy checks
    const now = Date.now();
    const startMs = slotStartMs(date, slot.startHour);
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

    // Owner resolution: residents may only book for themselves.
    // Staff (MANAGER+) may book on-behalf by providing ownerEmail.
    const meEmail = ctx.identity!.email.toLowerCase();
    const isStaff = isAtLeast(ctx.roles, 'MANAGER');
    let ownerEmail = meEmail;
    if (ownerEmailIn) {
      const requested = ownerEmailIn.toLowerCase();
      if (requested !== meEmail && !isStaff) throw new Forbidden('Only staff may book on behalf of another resident');
      ownerEmail = requested;
    }

    // Load current state.
    const { items, sha } = await loadReservations(ctx);
    const active = items.filter((r) => !r.isDeleted);

    // Slot conflict.
    const slotIdx = buildSlotIndex(active.filter((r) => r.facilityId === facility.id));
    if (slotIdx.has(`${facility.id}|${date}|${slot.id}`)) {
      throw new BadRequest('That slot has just been taken by another booking. Please pick a different slot.');
    }

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

    // Allocate ID and record.
    const existing = new Set<string>(items.map((r) => r.id));
    const id = nextResId(existing, now);

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
      slotId: slot.id,
      slotLabel: `${slot.label} (${slot.startHour}:00–${slot.endHour}:00)`,
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
      detail: `facility=${facility.id} date=${date} slot=${slot.id} owner=${ownerEmail}`,
    });
    // Notifications: tell the owner (if the creator is not the owner) and
    // all staff so the manage queue lights up in real time.
    const notifyRecipients = new Set<string>();
    if (ownerEmail !== meEmail) notifyRecipients.add(ownerEmail);
    for (const s of staffEmails(ctx)) notifyRecipients.add(s);
    if (notifyRecipients.size) {
      const title = `New reservation · ${facility.name}`;
      const body = `${date} · ${slot.label} · ${owner.flat ? owner.flat + ' · ' : ''}${purpose.slice(0, 100)}`;
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
      const body = `${rec.date} · ${rec.slotLabel}${note ? ' · ' + note.slice(0, 100) : ''}`;
      await notify(ctx, Array.from(recipients), notifEvent, title, body, linkTo(rec.id));
    }
    return ok(ctx.env, ctx.req, { reservation: rec });
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
    const path = proofRepoPath(rec.id, nextIdx, mime as ProofMime);
    await putBinaryB64(
      ctx.env, path, b64,
      `reservations: payment proof for ${rec.id} by ${ctx.identity!.email}`,
      ctx.identity!.email,
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
    const bin = await getBinaryFile(ctx.env, proof.path);
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

};

// Re-export ID validator so tests can share the regex.
export { RES_ID_RE };

// Treasury & Reimbursements — Phase 1.
// Spec: temp/treasury-requirements.md (staged for merge into tsh_requirement.md).
//
// Endpoints (all under FEATURE_TREASURY):
//   GET   /treasury/reimbursements              list (resident: own only)
//   POST  /treasury/reimbursements              raise a request (Resident+)
//   PATCH /treasury/reimbursements/:id          transition (review/approve/reject/reopen)
//   POST  /treasury/reimbursements/:id/payment  mark paid + payment slip metadata
//                                               (binary upload = phase 2)
//   GET   /treasury/expenses                    ledger list
//   POST  /treasury/expenses                    manual expense entry
//   PATCH /treasury/expenses/:id                edit (Committee+)
//   POST  /treasury/expenses/:id/delete         soft-delete (Committee+, reason required)
//   GET   /treasury/summary?month=YYYY-MM       KPI + category breakdown
//
// Storage: two JSON files in the treasury private repo.
//   config/treasury-reimbursements.json
//   config/treasury-expenses.json
// Binary proofs (bill scans, payment slips) are Phase 2 — the routes
// accept file metadata today, but /files uploads land in a follow-up
// commit alongside a dedicated file-streaming endpoint.
//
// If GH_TREASURY_REPO is not configured, all writes 503 with a clear
// message so a mis-provisioned worker fails obviously instead of losing
// data. Reads return an empty envelope so the UI still renders.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import type { Env } from '../env.ts';
import type { Role } from '../auth/roles.ts';
import type { RepoTarget } from '../github/client.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { BadRequest, NotFound, Forbidden, FeatureDisabled } from '../lib/errors.ts';
import { parseJson, str, optStr, oneOf, num, optNum } from '../lib/validate.ts';
import { getFile, putFile, putBinaryB64 } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { isAtLeast, hasAny } from '../auth/roles.ts';
import { tunable, isFeatureOn } from '../config/defaults.ts';
import { log } from '../lib/log.ts';

const FLAG = 'FEATURE_TREASURY';
const RMB_PATH = 'config/treasury-reimbursements.json';
const EXP_PATH = 'config/treasury-expenses.json';
const MAX_ACTIVE = 500;                 // per file — bounded; monthly rollup is phase 2

// ---------------------------------------------------------------- types

export type ReimbursementStatus =
  | 'requested' | 'under-review' | 'approved' | 'paid' | 'rejected' | 'closed';

export type PaymentMode =
  | 'cash' | 'upi' | 'card' | 'cheque' | 'bank' | 'auto-debit' | 'other';

const ALL_STATUSES: readonly ReimbursementStatus[] = [
  'requested', 'under-review', 'approved', 'paid', 'rejected', 'closed',
];
const ALL_MODES: readonly PaymentMode[] = [
  'cash', 'upi', 'card', 'cheque', 'bank', 'auto-debit', 'other',
];

/** Allowed transitions. Any pair not listed here is rejected. */
const TRANSITIONS: Record<ReimbursementStatus, ReimbursementStatus[]> = {
  requested:     ['under-review', 'approved', 'rejected'],
  'under-review':['approved', 'rejected', 'requested'],
  approved:      ['paid', 'rejected', 'under-review'],
  paid:          ['closed'],
  rejected:      ['requested'],
  closed:        [],
};

export interface FileRef {
  name: string;         // display name
  mime: string;         // image/jpeg | image/png | image/webp | application/pdf
  size: number;         // bytes (client-declared; binary upload lands in phase 2)
  path?: string;        // set once the binary is uploaded (phase 2)
  addedAt: string;
  addedBy: string;
}

export interface TimelineItem {
  at: string;
  by: string;           // email
  action: string;       // 'created' | 'commented' | 'status:<from>-><to>' | 'paid' | ...
  note?: string;
}

export interface Reimbursement {
  id: string;                    // RMB-<ts>
  createdAt: string;
  createdBy: string;             // email
  createdByFlat?: string;
  category: string;
  purpose: string;               // 5-500 chars
  amount: number;                // positive rupees
  expenseDate: string;           // YYYY-MM-DD IST
  mode: PaymentMode;
  originalRef?: string;          // UTR / UPI / cheque no
  status: ReimbursementStatus;
  proofs: FileRef[];             // uploaded by requester
  paymentProofs: FileRef[];      // uploaded at Paid step
  timeline: TimelineItem[];
  approvals: string[];           // committee emails that approved (for quorum)
  rejectReason?: string;
  linkedExpenseId?: string;
  updatedAt: string;
}

export interface Expense {
  id: string;                    // EXP-<ts>
  createdAt: string;
  createdBy: string;
  date: string;                  // YYYY-MM-DD
  payee: string;
  category: string;
  amount: number;
  mode: PaymentMode;
  reference?: string;
  notes?: string;
  receipts: FileRef[];
  linkedReimbursementId?: string;
  updatedAt: string;
  deletedAt?: string;
  deletedBy?: string;
  deletedReason?: string;
}

interface RmbFile { version: number; items: Reimbursement[] }
interface ExpFile { version: number; items: Expense[] }

const EMPTY_RMB: RmbFile = { version: 1, items: [] };
const EMPTY_EXP: ExpFile = { version: 1, items: [] };

// ---------------------------------------------------------------- target repo

/** Build the RepoTarget for the treasury private repo, or undefined if unset. */
export const treasuryRepoTarget = (env: Env): RepoTarget | undefined => {
  const repo = (env.GH_TREASURY_REPO || '').trim();
  if (!repo) return undefined;
  return {
    owner: (env.GH_TREASURY_OWNER || env.GH_OWNER).trim(),
    repo,
    branch: (env.GH_TREASURY_BRANCH || 'main').trim(),
    ...(env.GITHUB_TREASURY_TOKEN ? { token: env.GITHUB_TREASURY_TOKEN } : {}),
  };
};

// ---------------------------------------------------------------- storage

interface Cache<T> { value: T; sha?: string; expiresAt: number }
let rmbCache: Cache<RmbFile> | undefined;
let expCache: Cache<ExpFile> | undefined;

const invalidateReimbursements = (): void => { rmbCache = undefined; };
const invalidateExpenses      = (): void => { expCache = undefined; };

/** Test-only reset. */
export const _resetTreasuryCachesForTests = (): void => {
  rmbCache = undefined;
  expCache = undefined;
};

const loadReimbursements = async (ctx: Ctx): Promise<{ items: Reimbursement[]; sha?: string }> => {
  const now = Date.now();
  if (rmbCache && rmbCache.expiresAt > now) {
    const cached: { items: Reimbursement[]; sha?: string } = { items: rmbCache.value.items };
    if (rmbCache.sha !== undefined) cached.sha = rmbCache.sha;
    return cached;
  }
  const ttl = tunable(ctx.config, 'TREASURY_CACHE_SECONDS', 60) * 1000;
  const target = treasuryRepoTarget(ctx.env);
  if (!target) {
    rmbCache = { value: EMPTY_RMB, expiresAt: now + ttl };
    return { items: [] };
  }
  const f = await getFile(ctx.env, RMB_PATH, target);
  if (!f) {
    rmbCache = { value: EMPTY_RMB, expiresAt: now + ttl };
    return { items: [] };
  }
  try {
    const parsed = JSON.parse(f.content) as RmbFile;
    const value: RmbFile = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
    rmbCache = { value, sha: f.sha, expiresAt: now + ttl };
    return { items: value.items, sha: f.sha };
  } catch {
    rmbCache = { value: EMPTY_RMB, sha: f.sha, expiresAt: now + ttl };
    return { items: [], sha: f.sha };
  }
};

const loadExpenses = async (ctx: Ctx): Promise<{ items: Expense[]; sha?: string }> => {
  const now = Date.now();
  if (expCache && expCache.expiresAt > now) {
    const cached: { items: Expense[]; sha?: string } = { items: expCache.value.items };
    if (expCache.sha !== undefined) cached.sha = expCache.sha;
    return cached;
  }
  const ttl = tunable(ctx.config, 'TREASURY_CACHE_SECONDS', 60) * 1000;
  const target = treasuryRepoTarget(ctx.env);
  if (!target) {
    expCache = { value: EMPTY_EXP, expiresAt: now + ttl };
    return { items: [] };
  }
  const f = await getFile(ctx.env, EXP_PATH, target);
  if (!f) {
    expCache = { value: EMPTY_EXP, expiresAt: now + ttl };
    return { items: [] };
  }
  try {
    const parsed = JSON.parse(f.content) as ExpFile;
    const value: ExpFile = {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
    expCache = { value, sha: f.sha, expiresAt: now + ttl };
    return { items: value.items, sha: f.sha };
  } catch {
    expCache = { value: EMPTY_EXP, sha: f.sha, expiresAt: now + ttl };
    return { items: [], sha: f.sha };
  }
};

const saveReimbursements = async (
  ctx: Ctx, items: Reimbursement[], sha: string | undefined, actor: string, message: string,
): Promise<void> => {
  const target = treasuryRepoTarget(ctx.env);
  if (!target) throw new FeatureDisabled('GH_TREASURY_REPO'); // 503 with clear message
  if (items.length > MAX_ACTIVE) {
    // Archive-by-rotation is phase 2. For now, refuse to write beyond
    // the soft cap so the file stays under GitHub Contents API limits.
    throw new BadRequest(`Reimbursement file at cap (${MAX_ACTIVE} items). Archive some closed ones.`);
  }
  const body = JSON.stringify({ version: 1, items }, null, 2);
  await putFile(ctx.env, RMB_PATH, body, `treasury: ${message}`, actor, sha, target);
  invalidateReimbursements();
};

const saveExpenses = async (
  ctx: Ctx, items: Expense[], sha: string | undefined, actor: string, message: string,
): Promise<void> => {
  const target = treasuryRepoTarget(ctx.env);
  if (!target) throw new FeatureDisabled('GH_TREASURY_REPO');
  if (items.length > MAX_ACTIVE) {
    throw new BadRequest(`Expense file at cap (${MAX_ACTIVE} items). Archive older entries.`);
  }
  const body = JSON.stringify({ version: 1, items }, null, 2);
  await putFile(ctx.env, EXP_PATH, body, `treasury: ${message}`, actor, sha, target);
  invalidateExpenses();
};

// ---------------------------------------------------------------- helpers

/** Human-typable id from timestamp: RMB-DDMMYYHHMM (IST). */
const mintId = (kind: 'RMB' | 'EXP', existing: string[], nowMs = Date.now()): string => {
  const d = new Date(nowMs + 5.5 * 3600_000); // shift to IST
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mn = String(d.getUTCMinutes()).padStart(2, '0');
  const base = `${kind}-${dd}${mm}${yy}${hh}${mn}`;
  if (!existing.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const c = `${base}-${n}`;
    if (!existing.includes(c)) return c;
  }
  return `${base}-${Date.now()}`; // pathological fallback
};

const nowIso = (): string => new Date().toISOString();

const roleCanApprove = (ctx: Ctx): boolean => {
  if (isAtLeast(ctx.roles, 'COMMITTEE')) return true;
  return hasAny(ctx.roles, 'MANAGER') && isFeatureOn(ctx.config, 'FEATURE_TREASURY_MANAGER_APPROVE');
};

const roleCanPay = (ctx: Ctx): boolean => {
  if (isAtLeast(ctx.roles, 'COMMITTEE')) return true;
  return hasAny(ctx.roles, 'MANAGER') && isFeatureOn(ctx.config, 'FEATURE_TREASURY_MANAGER_PAY');
};

const roleCanRecordExpense = (ctx: Ctx): boolean => {
  if (isAtLeast(ctx.roles, 'COMMITTEE')) return true;
  return hasAny(ctx.roles, 'MANAGER')
    && isFeatureOn(ctx.config, 'FEATURE_TREASURY_MANAGER_RECORD_EXPENSE');
};

const isOwnerOrStaff = (ctx: Ctx, ownerEmail: string): boolean => {
  const me = ctx.identity?.email.toLowerCase();
  if (!me) return false;
  if (me === ownerEmail.toLowerCase()) return true;
  return isAtLeast(ctx.roles, 'MANAGER');
};

const canRaise = (ctx: Ctx): boolean => {
  // Residents may raise unless explicitly disabled; staff always may.
  if (isAtLeast(ctx.roles, 'MANAGER')) return true;
  return isFeatureOn(ctx.config, 'FEATURE_TREASURY_RESIDENT_RAISE');
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const MIME_ALLOW = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const DEFAULT_RECEIPT_PATH = 'treasury/receipts/{yearMonth}/{kind}/{id}/{seq}-{name}';
const NAME_SAFE = /[^A-Za-z0-9._-]+/g;
const sanitiseName = (name: string): string => name.replace(NAME_SAFE, '_').slice(0, 80);

/**
 * A file the client staged for upload: `ref` is the metadata that gets
 * persisted into the reimbursement/expense JSON. `dataBase64` (if present)
 * is the raw file content that `persistFileBinaries` uploads to the
 * treasury private repo — after which `ref.path` is set to the target
 * path so viewers can retrieve the blob.
 */
interface StagedFileRef {
  ref: FileRef;
  dataBase64?: string;
}

/** Validate the client-declared file metadata list (proof / receipt).
 *  Optionally carries a `dataBase64` payload for binary upload. */
const parseFileRefs = (
  raw: unknown, field: string, maxCount: number, maxBytes: number, actor: string,
): StagedFileRef[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequest(`${field} must be an array`);
  if (raw.length > maxCount) throw new BadRequest(`${field}: too many files (max ${maxCount})`);
  const at = nowIso();
  // base64 encodes 3 bytes into 4 chars → allow 2× the byte cap on the
  // string length so a slightly-over payload gets caught by the byte
  // cap and we still reject truly oversized junk here.
  const maxB64 = Math.ceil(maxBytes * 4 / 3) + 4;
  return raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new BadRequest(`${field}[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const name = str(e['name'], `${field}[${i}].name`, { max: 120 });
    const mime = str(e['mime'], `${field}[${i}].mime`);
    if (!MIME_ALLOW.has(mime)) throw new BadRequest(`${field}[${i}].mime unsupported: ${mime}`);
    const size = num(e['size'], `${field}[${i}].size`, { min: 1, max: maxBytes });
    const ref: FileRef = { name, mime, size, addedAt: at, addedBy: actor };
    const staged: StagedFileRef = { ref };
    if (e['dataBase64'] !== undefined) {
      const b64 = str(e['dataBase64'], `${field}[${i}].dataBase64`, { max: maxB64 });
      staged.dataBase64 = b64;
    }
    return staged;
  });
};

/**
 * Persist any staged binaries to the treasury private repo and return the
 * FileRefs (with `path` set for any uploaded file). When no repo is
 * configured, or when a staged entry has no binary payload, we fall back
 * to metadata-only storage — the earlier behaviour, kept for backward
 * compatibility with clients that only send file names/sizes.
 */
const persistFileBinaries = async (
  ctx: Ctx,
  staged: StagedFileRef[],
  kind: 'proof' | 'payment' | 'receipt',
  ownerId: string,
  actor: string,
): Promise<FileRef[]> => {
  if (staged.length === 0) return [];
  const target = treasuryRepoTarget(ctx.env);
  const rawPath = ctx.config.tunables['TREASURY_RECEIPT_PATH'];
  const template = typeof rawPath === 'string' && rawPath.length > 0 ? rawPath : DEFAULT_RECEIPT_PATH;
  const yearMonth = new Date().toISOString().slice(0, 7);
  const out: FileRef[] = [];
  for (let i = 0; i < staged.length; i++) {
    const s = staged[i]!;
    const base = s.ref;
    if (!s.dataBase64 || !target) { out.push(base); continue; }
    const path = template
      .split('{yearMonth}').join(yearMonth)
      .split('{kind}').join(kind)
      .split('{id}').join(ownerId)
      .split('{seq}').join(String(i + 1).padStart(2, '0'))
      .split('{name}').join(sanitiseName(base.name));
    try {
      await putBinaryB64(ctx.env, path, s.dataBase64, `treasury: upload ${kind} ${ownerId}/${sanitiseName(base.name)}`, actor, target);
      out.push({ ...base, path });
    } catch (e) {
      log.error(ctx.env, 'treasury_file_upload_failed', { path, error: String(e) });
      out.push(base); // keep the record; caller sees no `path` and can retry later
    }
  }
  return out;
};

const pushTimeline = (rec: Reimbursement, item: TimelineItem): void => {
  rec.timeline = [...(rec.timeline ?? []), item].slice(-200);
};

// ---------------------------------------------------------------- routes

export const mountTreasury = (r: Router): void => {
  // -------------------------- GET /treasury/reimbursements
  r.get('/treasury/reimbursements', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true });
    const { items } = await loadReimbursements(ctx);

    const isStaff = isAtLeast(ctx.roles, 'MANAGER');
    const me = ctx.identity!.email.toLowerCase();
    const scope = ctx.url.searchParams.get('scope'); // 'mine' | 'all'
    const status = ctx.url.searchParams.get('status');
    const category = ctx.url.searchParams.get('category');

    let out = items.slice();
    if (!isStaff || scope === 'mine') {
      out = out.filter((x) => x.createdBy.toLowerCase() === me);
    }
    if (status && (ALL_STATUSES as readonly string[]).includes(status)) {
      out = out.filter((x) => x.status === status);
    }
    if (category) {
      out = out.filter((x) => x.category.toLowerCase() === category.toLowerCase());
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return ok(ctx.env, ctx.req, { items: out, storageConfigured: !!treasuryRepoTarget(ctx.env) });
  });

  // -------------------------- POST /treasury/reimbursements
  r.post('/treasury/reimbursements', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    if (!canRaise(ctx)) throw new Forbidden('Resident raise is disabled (FEATURE_TREASURY_RESIDENT_RAISE)');
    const body = await parseJson<Record<string, unknown>>(ctx.req);

    const category    = str(body['category'], 'category', { max: 60 });
    const purpose     = str(body['purpose'], 'purpose', { min: 5, max: 500 });
    const amount      = num(body['amount'], 'amount', { min: 1, max: 10_000_000 });
    const expenseDate = str(body['expenseDate'], 'expenseDate', { max: 10 });
    if (!DATE_RE.test(expenseDate)) throw new BadRequest('expenseDate must be YYYY-MM-DD');
    const mode        = oneOf(body['mode'], 'mode', ALL_MODES);
    const originalRef = optStr(body['originalRef'], 'originalRef', { max: 80 });
    const flat        = optStr(body['flat'], 'flat', { max: 20 });

    const maxFiles = tunable(ctx.config, 'TREASURY_MAX_FILES_PER_ITEM', 5);
    const maxBytes = tunable(ctx.config, 'TREASURY_MAX_FILE_BYTES', 5_242_880);
    const actor = ctx.identity!.email;
    const stagedProofs = parseFileRefs(body['proofs'], 'proofs', maxFiles, maxBytes, actor);

    const { items, sha } = await loadReimbursements(ctx);
    const id = mintId('RMB', items.map((x) => x.id));
    const now = nowIso();
    const proofs = await persistFileBinaries(ctx, stagedProofs, 'proof', id, actor);
    const rec: Reimbursement = {
      id,
      createdAt: now,
      createdBy: actor,
      ...(flat ? { createdByFlat: flat } : {}),
      category,
      purpose,
      amount,
      expenseDate,
      mode,
      ...(originalRef ? { originalRef } : {}),
      status: 'requested',
      proofs,
      paymentProofs: [],
      timeline: [{ at: now, by: actor, action: 'created' }],
      approvals: [],
      updatedAt: now,
    };
    items.unshift(rec);
    await saveReimbursements(ctx, items, sha, actor, `raise ${id}`);
    await writeAudit(ctx.env, {
      actor, action: 'treasury:raise', target: id,
      detail: `${category} · ₹${amount} · ${proofs.length} proof(s)`,
    });
    return ok(ctx.env, ctx.req, { reimbursement: rec }, 201);
  });

  // -------------------------- PATCH /treasury/reimbursements/:id
  r.patch('/treasury/reimbursements/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['RESIDENT', 'MANAGER', 'COMMITTEE', 'ADMIN'] });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const nextStatus = optStr(body['status'], 'status') as ReimbursementStatus | undefined;
    const note = optStr(body['note'], 'note', { max: 500 });

    const { items, sha } = await loadReimbursements(ctx);
    const idx = items.findIndex((x) => x.id === params['id']);
    if (idx === -1) throw new NotFound(`Reimbursement ${params['id']} not found`);
    const rec = items[idx]!;
    const actor = ctx.identity!.email;
    const now = nowIso();

    // Comment-only mode when no status change is provided.
    if (!nextStatus) {
      if (!note) throw new BadRequest('Provide `status` or a `note` comment');
      if (!isOwnerOrStaff(ctx, rec.createdBy)) throw new Forbidden('Not your request');
      pushTimeline(rec, { at: now, by: actor, action: 'commented', note });
      rec.updatedAt = now;
      items[idx] = rec;
      await saveReimbursements(ctx, items, sha, actor, `comment ${rec.id}`);
      return ok(ctx.env, ctx.req, { reimbursement: rec });
    }

    if (!(ALL_STATUSES as readonly string[]).includes(nextStatus)) {
      throw new BadRequest(`Unknown status: ${nextStatus}`);
    }
    const allowed = TRANSITIONS[rec.status];
    if (!allowed.includes(nextStatus)) {
      throw new BadRequest(`Forbidden transition: ${rec.status} → ${nextStatus}`);
    }

    // Role gating per target status.
    if (nextStatus === 'approved' || nextStatus === 'under-review') {
      if (!roleCanApprove(ctx)) throw new Forbidden('You cannot approve reimbursements');
    }
    if (nextStatus === 'rejected') {
      if (!roleCanApprove(ctx)) throw new Forbidden('You cannot reject reimbursements');
      if (!note) throw new BadRequest('Rejection reason (note) is required');
      rec.rejectReason = note;
    }
    if (nextStatus === 'paid') {
      // Route through the payment endpoint instead — it captures the slip.
      throw new BadRequest('Use POST /treasury/reimbursements/:id/payment to mark paid');
    }
    if (nextStatus === 'closed') {
      if (!isAtLeast(ctx.roles, 'COMMITTEE')) throw new Forbidden('Only committee/admin can close');
    }
    if (nextStatus === 'requested' && rec.status === 'rejected') {
      // Reopen — allow owner or staff.
      if (!isOwnerOrStaff(ctx, rec.createdBy)) throw new Forbidden('Not your request');
    }

    // Approval quorum bookkeeping.
    if (nextStatus === 'approved') {
      const q = tunable(ctx.config, 'TREASURY_APPROVAL_QUORUM', 1);
      const email = actor.toLowerCase();
      if (!rec.approvals.includes(email)) rec.approvals.push(email);
      if (rec.approvals.length < q) {
        // Park in under-review with a quorum note; do NOT flip to approved.
        rec.status = 'under-review';
        pushTimeline(rec, {
          at: now, by: actor, action: `quorum:${rec.approvals.length}/${q}`,
          ...(note ? { note } : {}),
        });
        rec.updatedAt = now;
        items[idx] = rec;
        await saveReimbursements(ctx, items, sha, actor, `quorum ${rec.id}`);
        return ok(ctx.env, ctx.req, { reimbursement: rec });
      }
    }

    const from = rec.status;
    rec.status = nextStatus;
    pushTimeline(rec, {
      at: now, by: actor, action: `status:${from}->${nextStatus}`,
      ...(note ? { note } : {}),
    });
    rec.updatedAt = now;
    items[idx] = rec;
    await saveReimbursements(ctx, items, sha, actor, `${from}->${nextStatus} ${rec.id}`);
    await writeAudit(ctx.env, {
      actor, action: `treasury:${nextStatus}`, target: rec.id,
      ...(note ? { detail: note } : {}),
    });
    return ok(ctx.env, ctx.req, { reimbursement: rec });
  });

  // -------------------------- POST /treasury/reimbursements/:id/payment
  r.post('/treasury/reimbursements/:id/payment', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['MANAGER', 'COMMITTEE', 'ADMIN'] });
    if (!roleCanPay(ctx)) throw new Forbidden('You cannot mark reimbursements as paid');

    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const payMode = oneOf(body['payMode'], 'payMode', ALL_MODES);
    const payRef  = optStr(body['payRef'], 'payRef', { max: 80 });
    const note    = optStr(body['note'], 'note', { max: 500 });
    const maxFiles = tunable(ctx.config, 'TREASURY_MAX_FILES_PER_ITEM', 5);
    const maxBytes = tunable(ctx.config, 'TREASURY_MAX_FILE_BYTES', 5_242_880);
    const actor = ctx.identity!.email;
    const stagedSlips = parseFileRefs(body['paymentProofs'], 'paymentProofs', maxFiles, maxBytes, actor);

    const { items, sha } = await loadReimbursements(ctx);
    const idx = items.findIndex((x) => x.id === params['id']);
    if (idx === -1) throw new NotFound(`Reimbursement ${params['id']} not found`);
    const rec = items[idx]!;
    if (rec.status !== 'approved') {
      throw new BadRequest(`Cannot pay a request in status "${rec.status}"; must be "approved"`);
    }
    if (payMode === 'cash' && stagedSlips.length === 0) {
      throw new BadRequest('Cash payments require at least one signed hand-note attached');
    }

    const now = nowIso();
    const slips = await persistFileBinaries(ctx, stagedSlips, 'payment', rec.id, actor);
    rec.paymentProofs = [...rec.paymentProofs, ...slips];
    rec.status = 'paid';
    pushTimeline(rec, {
      at: now, by: actor, action: 'paid',
      note: `${payMode}${payRef ? ` · ref ${payRef}` : ''}${note ? ` · ${note}` : ''}`,
    });
    rec.updatedAt = now;

    // Auto-book into expense ledger.
    const exp = await loadExpenses(ctx);
    const expId = mintId('EXP', exp.items.map((x) => x.id));
    const expNow = now;
    const newExpense: Expense = {
      id: expId,
      createdAt: expNow,
      createdBy: actor,
      date: rec.expenseDate,
      payee: rec.createdBy,
      category: rec.category,
      amount: rec.amount,
      mode: payMode,
      ...(payRef ? { reference: payRef } : {}),
      notes: `Auto-booked from ${rec.id}: ${rec.purpose}`,
      receipts: rec.proofs.slice(),  // mirror; still stored under the reimbursement
      linkedReimbursementId: rec.id,
      updatedAt: expNow,
    };
    rec.linkedExpenseId = expId;

    items[idx] = rec;
    exp.items.unshift(newExpense);
    await saveReimbursements(ctx, items, sha, actor, `paid ${rec.id}`);
    await saveExpenses(ctx, exp.items, exp.sha, actor, `book ${expId} from ${rec.id}`);
    await writeAudit(ctx.env, {
      actor, action: 'treasury:paid', target: rec.id,
      detail: `booked as ${expId}; mode=${payMode}; slips=${slips.length}`,
    });
    return ok(ctx.env, ctx.req, { reimbursement: rec, expense: newExpense });
  });

  // -------------------------- GET /treasury/expenses
  r.get('/treasury/expenses', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['MANAGER', 'COMMITTEE', 'ADMIN'] });
    const { items } = await loadExpenses(ctx);
    const showDeleted = ctx.url.searchParams.get('showDeleted') === '1'
      && isAtLeast(ctx.roles, 'COMMITTEE');
    const month = ctx.url.searchParams.get('month');
    const category = ctx.url.searchParams.get('category');

    let out = items.slice();
    if (!showDeleted) out = out.filter((x) => !x.deletedAt);
    if (month && MONTH_RE.test(month)) {
      out = out.filter((x) => x.date.startsWith(month));
    }
    if (category) {
      out = out.filter((x) => x.category.toLowerCase() === category.toLowerCase());
    }
    out.sort((a, b) => b.date.localeCompare(a.date));

    return ok(ctx.env, ctx.req, { items: out, storageConfigured: !!treasuryRepoTarget(ctx.env) });
  });

  // -------------------------- POST /treasury/expenses  (manual entry)
  r.post('/treasury/expenses', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['MANAGER', 'COMMITTEE', 'ADMIN'] });
    if (!roleCanRecordExpense(ctx)) throw new Forbidden('You cannot record direct expenses');
    const body = await parseJson<Record<string, unknown>>(ctx.req);

    const payee    = str(body['payee'], 'payee', { max: 120 });
    const category = str(body['category'], 'category', { max: 60 });
    const amount   = num(body['amount'], 'amount', { min: 1, max: 10_000_000 });
    const date     = str(body['date'], 'date');
    if (!DATE_RE.test(date)) throw new BadRequest('date must be YYYY-MM-DD');
    const mode      = oneOf(body['mode'], 'mode', ALL_MODES);
    const reference = optStr(body['reference'], 'reference', { max: 80 });
    const notes     = optStr(body['notes'], 'notes', { max: 500 });

    const maxFiles = tunable(ctx.config, 'TREASURY_MAX_FILES_PER_ITEM', 5);
    const maxBytes = tunable(ctx.config, 'TREASURY_MAX_FILE_BYTES', 5_242_880);
    const actor = ctx.identity!.email;
    const stagedReceipts = parseFileRefs(body['receipts'], 'receipts', maxFiles, maxBytes, actor);

    const { items, sha } = await loadExpenses(ctx);
    const id = mintId('EXP', items.map((x) => x.id));
    const now = nowIso();
    const receipts = await persistFileBinaries(ctx, stagedReceipts, 'receipt', id, actor);
    const rec: Expense = {
      id,
      createdAt: now,
      createdBy: actor,
      date,
      payee,
      category,
      amount,
      mode,
      ...(reference ? { reference } : {}),
      ...(notes ? { notes } : {}),
      receipts,
      updatedAt: now,
    };
    items.unshift(rec);
    await saveExpenses(ctx, items, sha, actor, `add ${id}`);
    await writeAudit(ctx.env, {
      actor, action: 'treasury:expense-add', target: id,
      detail: `${category} · ₹${amount} · ${payee}`,
    });
    return ok(ctx.env, ctx.req, { expense: rec }, 201);
  });

  // -------------------------- PATCH /treasury/expenses/:id
  r.patch('/treasury/expenses/:id', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['COMMITTEE', 'ADMIN'] });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const { items, sha } = await loadExpenses(ctx);
    const idx = items.findIndex((x) => x.id === params['id']);
    if (idx === -1) throw new NotFound(`Expense ${params['id']} not found`);
    const rec = items[idx]!;

    if (body['payee']    !== undefined) rec.payee    = str(body['payee'], 'payee', { max: 120 });
    if (body['category'] !== undefined) rec.category = str(body['category'], 'category', { max: 60 });
    if (body['amount']   !== undefined) rec.amount   = num(body['amount'], 'amount', { min: 1, max: 10_000_000 });
    if (body['date']     !== undefined) {
      const d = str(body['date'], 'date');
      if (!DATE_RE.test(d)) throw new BadRequest('date must be YYYY-MM-DD');
      rec.date = d;
    }
    if (body['mode']      !== undefined) rec.mode      = oneOf(body['mode'], 'mode', ALL_MODES);
    if (body['reference'] !== undefined) {
      const v = optStr(body['reference'], 'reference', { max: 80 });
      if (v === undefined) delete rec.reference; else rec.reference = v;
    }
    if (body['notes']     !== undefined) {
      const v = optStr(body['notes'], 'notes', { max: 500 });
      if (v === undefined) delete rec.notes; else rec.notes = v;
    }

    rec.updatedAt = nowIso();
    items[idx] = rec;
    const actor = ctx.identity!.email;
    await saveExpenses(ctx, items, sha, actor, `edit ${rec.id}`);
    await writeAudit(ctx.env, { actor, action: 'treasury:expense-edit', target: rec.id });
    return ok(ctx.env, ctx.req, { expense: rec });
  });

  // -------------------------- POST /treasury/expenses/:id/delete
  r.post('/treasury/expenses/:id/delete', async (ctx: Ctx, params) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['COMMITTEE', 'ADMIN'] });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const reason = str(body['reason'], 'reason', { min: 3, max: 240 });

    const { items, sha } = await loadExpenses(ctx);
    const idx = items.findIndex((x) => x.id === params['id']);
    if (idx === -1) throw new NotFound(`Expense ${params['id']} not found`);
    const rec = items[idx]!;
    const actor = ctx.identity!.email;
    const now = nowIso();
    rec.deletedAt = now;
    rec.deletedBy = actor;
    rec.deletedReason = reason;
    rec.updatedAt = now;
    items[idx] = rec;
    await saveExpenses(ctx, items, sha, actor, `soft-delete ${rec.id}`);
    await writeAudit(ctx.env, {
      actor, action: 'treasury:expense-delete', target: rec.id, detail: reason,
    });
    return ok(ctx.env, ctx.req, { expense: rec });
  });

  // -------------------------- GET /treasury/summary
  r.get('/treasury/summary', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FLAG], requireIdentity: true, roles: ['MANAGER', 'COMMITTEE', 'ADMIN'] });
    const month = ctx.url.searchParams.get('month') ?? monthKeyIst();
    if (!MONTH_RE.test(month)) throw new BadRequest('month must be YYYY-MM');

    const [{ items: exps }, { items: rmbs }] = await Promise.all([
      loadExpenses(ctx), loadReimbursements(ctx),
    ]);

    const monthExp = exps.filter((x) => !x.deletedAt && x.date.startsWith(month));
    const totalMonth = monthExp.reduce((s, x) => s + x.amount, 0);
    const byCategory: Record<string, number> = {};
    for (const e of monthExp) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount;
    }
    const openRmb = rmbs.filter((r) => r.status === 'requested' || r.status === 'under-review' || r.status === 'approved');
    const openLiability = openRmb.reduce((s, x) => s + x.amount, 0);
    const paidMonthRmb = rmbs.filter((r) => r.status === 'paid' && r.updatedAt.startsWith(month));
    const paidMonth = paidMonthRmb.reduce((s, x) => s + x.amount, 0);

    return ok(ctx.env, ctx.req, {
      month,
      totalMonth,
      byCategory,
      openLiability,
      openCount: openRmb.length,
      paidMonth,
      paidMonthCount: paidMonthRmb.length,
      expenseCount: monthExp.length,
    });
  });
};

/** IST-anchored current month key (YYYY-MM). */
const monthKeyIst = (nowMs = Date.now()): string => {
  const d = new Date(nowMs + 5.5 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

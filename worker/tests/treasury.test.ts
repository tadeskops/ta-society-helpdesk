// Smoke tests for /treasury/* endpoints.
// Covers: RBAC (resident/manager/committee), envelope shape, mode/status
// validation, forbidden transitions, quorum bookkeeping, cash-slip
// requirement, auto-booked expense on payment, soft-delete requires
// reason, storage-not-configured behaviour (empty on read, 503 on write).

import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../src/auth/jwt.ts', () => ({
  verifyGoogleJwt: vi.fn(async (_env: any, req: Request) => {
    const h = req.headers.get('X-Test-Identity');
    if (!h) return undefined;
    const [email] = h.split('|');
    return { email: email!.toLowerCase(), emailVerified: true, sub: 'test-sub' };
  }),
  requireIdentity: vi.fn(),
}));

// In-memory file store shared across mock reads/writes.
const files = new Map<string, { sha: string; content: string }>();
let putCount = 0;

vi.mock('../src/github/client.ts', () => ({
  getFile: vi.fn(async (_env: any, path: string) => {
    const f = files.get(path);
    if (!f) return undefined;
    return { sha: f.sha, content: f.content, encoding: 'utf-8' as const };
  }),
  getJson: vi.fn(async () => undefined),
  putFile: vi.fn(async (_env: any, path: string, content: string) => {
    putCount++;
    files.set(path, { sha: `sha-${putCount}`, content });
    return { sha: `sha-${putCount}` };
  }),
  appendToFile: vi.fn(async () => undefined),
  putBinaryB64: vi.fn(async () => ({ sha: 'bin-sha' })),
  getBinaryFile: vi.fn(async () => undefined),
  createIssue: vi.fn(),
  listIssues: vi.fn(async () => []),
  getIssue: vi.fn(),
  updateIssue: vi.fn(),
  lockIssue: vi.fn(),
  commentOnIssue: vi.fn(),
}));

let featureOverrides: Record<string, boolean> = {};
let tunableOverrides: Record<string, number | string> = {};
let accessOverrides: Partial<{
  managers: string[]; committee: string[]; admins: string[];
  treasurer: string[]; chairman: string[]; secretary: string[];
}> = {};

vi.mock('../src/config/loader.ts', async () => {
  const { DEFAULT_CONFIG } = await import('../src/config/defaults.ts');
  return {
    loadConfig: vi.fn(async () => ({
      config: {
        ...DEFAULT_CONFIG,
        features: {
          ...DEFAULT_CONFIG.features,
          FEATURE_TREASURY: true,
          FEATURE_TREASURY_RESIDENT_RAISE: true,
          FEATURE_TREASURY_MANAGER_APPROVE: false,
          FEATURE_TREASURY_MANAGER_PAY: false,
          FEATURE_TREASURY_MANAGER_RECORD_EXPENSE: true,
          ...featureOverrides,
        },
        tunables: {
          ...DEFAULT_CONFIG.tunables,
          TREASURY_APPROVAL_QUORUM: 1,
          ...tunableOverrides,
        },
      },
      access: {
        managers:  accessOverrides.managers  ?? ['mgr@x.com'],
        committee: accessOverrides.committee ?? ['cmt@x.com'],
        admins:    accessOverrides.admins    ?? ['dev@x.com'],
        // Empty by default → grandfather clause active → legacy
        // Committee+Admin retain ledger access, matching pre-migration
        // behaviour. Individual tests set these via `accessOverrides`
        // to exercise the additive Treasurer/Chairman/Secretary tags.
        treasurer: accessOverrides.treasurer ?? [],
        chairman:  accessOverrides.chairman  ?? [],
        secretary: accessOverrides.secretary ?? [],
      },
    })),
    invalidateCache: vi.fn(),
  };
});

import worker from '../src/index.ts';
import { _resetTreasuryCachesForTests } from '../src/routes/treasury.ts';
import * as ghClient from '../src/github/client.ts';

const envConfigured = {
  GH_OWNER: 'tadeskops',
  GH_REPO: 'ta-society-helpdesk',
  GH_BRANCH: 'main',
  GH_TREASURY_OWNER: 'tadeskops',
  GH_TREASURY_REPO: 'tsh-treasury',
  GH_TREASURY_BRANCH: 'main',
  GITHUB_TREASURY_TOKEN: 'fake-treasury',
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  ALLOWED_ORIGINS: 'http://localhost:8080',
  LOG_LEVEL: 'error',
  GITHUB_TOKEN: 'fake',
};

const envUnconfigured = {
  GH_OWNER: 'tadeskops',
  GH_REPO: 'ta-society-helpdesk',
  GH_BRANCH: 'main',
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  ALLOWED_ORIGINS: 'http://localhost:8080',
  LOG_LEVEL: 'error',
  GITHUB_TOKEN: 'fake',
};

const send = (
  method: string, path: string, body?: any, identity?: string,
  env: Record<string, string> = envConfigured,
) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Origin': 'http://localhost:8080' };
  if (identity) {
    headers['X-Test-Identity'] = identity;
    headers['Authorization'] = `Bearer fake-jwt-for-${identity}`;
  }
  return worker.fetch(
    new Request(`https://w.x${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }),
    env as any,
  );
};

const readJson = async (res: Response) => {
  const j = await res.json() as { ok: boolean; data?: any; error?: any };
  return j;
};

const buildRaiseBody = (over: Partial<Record<string, unknown>> = {}) => ({
  category: 'Repairs',
  purpose: 'Replaced ballcock in pump-room #2',
  amount: 1250,
  expenseDate: '2026-01-05',
  mode: 'upi',
  originalRef: 'UPI-9911',
  flat: 'A-1204',
  proofs: [],
  ...over,
});

beforeEach(() => {
  files.clear();
  putCount = 0;
  featureOverrides = {};
  tunableOverrides = {};
  accessOverrides = {};
  _resetTreasuryCachesForTests();
  (ghClient.putBinaryB64 as any).mockClear?.();
  (ghClient.getBinaryFile as any).mockClear?.();
});

// ---------------------------------------------------------------- routing

describe('treasury: envelope + gating', () => {
  it('rejects unauthenticated GET (identity required)', async () => {
    const res = await send('GET', '/treasury/reimbursements');
    expect(res.status).toBe(401);
  });

  it('returns empty list + storageConfigured=true for a resident', async () => {
    const res = await send('GET', '/treasury/reimbursements', undefined, 'res@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.ok).toBe(true);
    expect(j.data.items).toEqual([]);
    expect(j.data.storageConfigured).toBe(true);
  });

  it('reports storageConfigured=false when treasury repo is not set', async () => {
    const res = await send('GET', '/treasury/reimbursements', undefined, 'res@x.com', envUnconfigured);
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.storageConfigured).toBe(false);
    expect(j.data.items).toEqual([]);
  });

  it('503s on POST when treasury repo is not configured', async () => {
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody(), 'res@x.com', envUnconfigured);
    expect(res.status).toBe(503);
  });

  it('respects the master FEATURE_TREASURY flag', async () => {
    featureOverrides = { FEATURE_TREASURY: false };
    const res = await send('GET', '/treasury/reimbursements', undefined, 'res@x.com');
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------- raise + validation

describe('treasury: raise a reimbursement', () => {
  it('accepts a valid resident request and mints an RMB id', async () => {
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody(), 'res@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(201);
    expect(j.ok).toBe(true);
    const rec = j.data.reimbursement;
    expect(rec.id).toMatch(/^RMB-\d{10}(-\d+)?$/);
    expect(rec.status).toBe('requested');
    expect(rec.createdBy).toBe('res@x.com');
    expect(rec.createdByFlat).toBe('A-1204');
    expect(rec.category).toBe('Repairs');
    expect(rec.amount).toBe(1250);
    expect(rec.mode).toBe('upi');
    expect(rec.paymentProofs).toEqual([]);
    expect(rec.timeline).toHaveLength(1);
    expect(rec.timeline[0].action).toBe('created');
  });

  it('rejects unknown payment modes', async () => {
    const res = await send('POST', '/treasury/reimbursements',
      buildRaiseBody({ mode: 'bitcoin' }), 'res@x.com');
    expect(res.status).toBe(400);
  });

  it('rejects malformed expenseDate', async () => {
    const res = await send('POST', '/treasury/reimbursements',
      buildRaiseBody({ expenseDate: 'yesterday' }), 'res@x.com');
    expect(res.status).toBe(400);
  });

  it('rejects a purpose that is too short (<5 chars)', async () => {
    const res = await send('POST', '/treasury/reimbursements',
      buildRaiseBody({ purpose: 'hi' }), 'res@x.com');
    expect(res.status).toBe(400);
  });

  it('rejects zero / negative amount', async () => {
    const res = await send('POST', '/treasury/reimbursements',
      buildRaiseBody({ amount: 0 }), 'res@x.com');
    expect(res.status).toBe(400);
  });

  it('accepts new "cheque" payment mode', async () => {
    const res = await send('POST', '/treasury/reimbursements',
      buildRaiseBody({ mode: 'cheque' }), 'res@x.com');
    expect(res.status).toBe(201);
  });

  it('honours FEATURE_TREASURY_RESIDENT_RAISE=false for residents', async () => {
    featureOverrides = { FEATURE_TREASURY_RESIDENT_RAISE: false };
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody(), 'res@x.com');
    expect(res.status).toBe(403);
  });

  it('still lets staff raise even when resident-raise is off', async () => {
    featureOverrides = { FEATURE_TREASURY_RESIDENT_RAISE: false };
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody(), 'mgr@x.com');
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------- scope

describe('treasury: list scoping', () => {
  const seedTwo = async () => {
    await send('POST', '/treasury/reimbursements', buildRaiseBody({ purpose: 'Pump-room ballcock replacement' }), 'res@x.com');
    await send('POST', '/treasury/reimbursements', buildRaiseBody({ purpose: 'Hall fan belt replacement' }), 'mgr@x.com');
  };

  it('resident sees only their own', async () => {
    await seedTwo();
    const res = await send('GET', '/treasury/reimbursements', undefined, 'res@x.com');
    const j = await readJson(res);
    expect(j.data.items).toHaveLength(1);
    expect(j.data.items[0].createdBy).toBe('res@x.com');
  });

  it('manager without treasury tag can NOT see others (own only)', async () => {
    // Under the additive-tag model, a plain MANAGER is NOT covered by
    // the confidential-ledger gate (only Treasurer / Chairman / Admin
    // are; SECRETARY when the opt-in flag is on; COMMITTEE via the
    // grandfather clause when none of the three new lists is seeded).
    // So even with `scope=all` the manager sees only their own claim.
    await seedTwo();
    const res = await send('GET', '/treasury/reimbursements?scope=all', undefined, 'mgr@x.com');
    const j = await readJson(res);
    expect(j.data.items).toHaveLength(1);
    expect(j.data.items[0].createdBy).toBe('mgr@x.com');
  });

  it('committee CAN see all with scope=all (grandfathered)', async () => {
    await seedTwo();
    const res = await send('GET', '/treasury/reimbursements?scope=all', undefined, 'cmt@x.com');
    const j = await readJson(res);
    expect(j.data.items).toHaveLength(2);
  });

  it('treasurer tag alone grants full ledger view', async () => {
    accessOverrides = {
      // Seeding treasurer disables the grandfather clause too.
      treasurer: ['tre@x.com'],
    };
    await seedTwo();
    const res = await send('GET', '/treasury/reimbursements?scope=all', undefined, 'tre@x.com');
    const j = await readJson(res);
    expect(j.data.items).toHaveLength(2);
  });

  it('manager can narrow to scope=mine', async () => {
    await seedTwo();
    const res = await send('GET', '/treasury/reimbursements?scope=mine', undefined, 'mgr@x.com');
    const j = await readJson(res);
    expect(j.data.items).toHaveLength(1);
    expect(j.data.items[0].createdBy).toBe('mgr@x.com');
  });

  it('filters by status', async () => {
    await seedTwo();
    const res = await send('GET', '/treasury/reimbursements?scope=all&status=paid', undefined, 'cmt@x.com');
    const j = await readJson(res);
    expect(j.data.items).toHaveLength(0);
  });

  it('filters by category (case-insensitive)', async () => {
    await seedTwo();
    const res = await send('GET', '/treasury/reimbursements?scope=all&category=repairs', undefined, 'cmt@x.com');
    const j = await readJson(res);
    expect(j.data.items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- transitions

describe('treasury: status transitions', () => {
  const seedOne = async () => {
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody(), 'res@x.com');
    const j = await readJson(res);
    return j.data.reimbursement.id as string;
  };

  it('manager without APPROVE flag cannot approve', async () => {
    const id = await seedOne();
    const res = await send('PATCH', `/treasury/reimbursements/${id}`, { status: 'approved' }, 'mgr@x.com');
    expect(res.status).toBe(403);
  });

  it('committee can approve directly (quorum=1)', async () => {
    const id = await seedOne();
    const res = await send('PATCH', `/treasury/reimbursements/${id}`, { status: 'approved' }, 'cmt@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.reimbursement.status).toBe('approved');
    expect(j.data.reimbursement.approvals).toContain('cmt@x.com');
  });

  it('manager with APPROVE flag can approve', async () => {
    featureOverrides = { FEATURE_TREASURY_MANAGER_APPROVE: true };
    const id = await seedOne();
    const res = await send('PATCH', `/treasury/reimbursements/${id}`, { status: 'approved' }, 'mgr@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.reimbursement.status).toBe('approved');
  });

  it('quorum=2 parks the first approval at under-review', async () => {
    tunableOverrides = { TREASURY_APPROVAL_QUORUM: 2 };
    const id = await seedOne();
    const res = await send('PATCH', `/treasury/reimbursements/${id}`, { status: 'approved' }, 'cmt@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.reimbursement.status).toBe('under-review');
    expect(j.data.reimbursement.approvals).toEqual(['cmt@x.com']);
  });

  it('rejects requested → paid direct transition', async () => {
    const id = await seedOne();
    // Even with permissions, paid must go through the payment endpoint.
    const res = await send('PATCH', `/treasury/reimbursements/${id}`, { status: 'paid' }, 'cmt@x.com');
    expect(res.status).toBe(400);
  });

  it('reject requires a note', async () => {
    const id = await seedOne();
    const res = await send('PATCH', `/treasury/reimbursements/${id}`, { status: 'rejected' }, 'cmt@x.com');
    expect(res.status).toBe(400);
  });

  it('reject stores the reason', async () => {
    const id = await seedOne();
    const res = await send('PATCH', `/treasury/reimbursements/${id}`,
      { status: 'rejected', note: 'no receipt attached' }, 'cmt@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.reimbursement.rejectReason).toBe('no receipt attached');
  });

  it('owner can resubmit after rejection', async () => {
    const id = await seedOne();
    await send('PATCH', `/treasury/reimbursements/${id}`,
      { status: 'rejected', note: 'no receipt' }, 'cmt@x.com');
    const res = await send('PATCH', `/treasury/reimbursements/${id}`,
      { status: 'requested', note: 'attached now' }, 'res@x.com');
    expect(res.status).toBe(200);
  });

  it('comment-only PATCH works for the owner', async () => {
    const id = await seedOne();
    const res = await send('PATCH', `/treasury/reimbursements/${id}`, { note: 'ping' }, 'res@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.reimbursement.timeline.at(-1).action).toBe('commented');
  });
});

// ---------------------------------------------------------------- payment

describe('treasury: payment', () => {
  const seedApproved = async (): Promise<string> => {
    const raise = await send('POST', '/treasury/reimbursements', buildRaiseBody(), 'res@x.com');
    const id = (await readJson(raise)).data.reimbursement.id as string;
    await send('PATCH', `/treasury/reimbursements/${id}`, { status: 'approved' }, 'cmt@x.com');
    return id;
  };

  it('rejects payment when not yet approved', async () => {
    const raise = await send('POST', '/treasury/reimbursements', buildRaiseBody(), 'res@x.com');
    const id = (await readJson(raise)).data.reimbursement.id as string;
    const res = await send('POST', `/treasury/reimbursements/${id}/payment`,
      { payMode: 'bank', payRef: 'UTR-1' }, 'cmt@x.com');
    expect(res.status).toBe(400);
  });

  it('manager without PAY flag cannot pay', async () => {
    const id = await seedApproved();
    const res = await send('POST', `/treasury/reimbursements/${id}/payment`,
      { payMode: 'bank', payRef: 'UTR-1' }, 'mgr@x.com');
    expect(res.status).toBe(403);
  });

  it('cash payment without a slip is rejected', async () => {
    const id = await seedApproved();
    const res = await send('POST', `/treasury/reimbursements/${id}/payment`,
      { payMode: 'cash' }, 'cmt@x.com');
    expect(res.status).toBe(400);
  });

  it('cash payment with a slip is accepted', async () => {
    const id = await seedApproved();
    const res = await send('POST', `/treasury/reimbursements/${id}/payment`, {
      payMode: 'cash',
      paymentProofs: [{ name: 'slip.jpg', mime: 'image/jpeg', size: 4000 }],
    }, 'cmt@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.reimbursement.status).toBe('paid');
    expect(j.data.reimbursement.paymentProofs).toHaveLength(1);
  });

  it('bank payment auto-books a matching expense', async () => {
    const id = await seedApproved();
    const res = await send('POST', `/treasury/reimbursements/${id}/payment`,
      { payMode: 'bank', payRef: 'UTR-9911' }, 'cmt@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.reimbursement.status).toBe('paid');
    expect(j.data.expense).toBeTruthy();
    expect(j.data.expense.id).toMatch(/^EXP-/);
    expect(j.data.expense.amount).toBe(1250);
    expect(j.data.expense.linkedReimbursementId).toBe(id);
    expect(j.data.expense.mode).toBe('bank');
    expect(j.data.expense.reference).toBe('UTR-9911');
  });
});

// ---------------------------------------------------------------- expenses

describe('treasury: direct expenses', () => {
  const expBody = (over: Partial<Record<string, unknown>> = {}) => ({
    payee: 'Adarsh Plumbing',
    category: 'Plumbing',
    amount: 800,
    date: '2026-01-06',
    mode: 'upi',
    reference: 'UPI-88',
    notes: 'Emergency call-out.',
    ...over,
  });

  it('residents cannot record direct expenses', async () => {
    const res = await send('POST', '/treasury/expenses', expBody(), 'res@x.com');
    expect(res.status).toBe(403);
  });

  it('manager without RECORD_EXPENSE flag cannot record', async () => {
    featureOverrides = { FEATURE_TREASURY_MANAGER_RECORD_EXPENSE: false };
    const res = await send('POST', '/treasury/expenses', expBody(), 'mgr@x.com');
    expect(res.status).toBe(403);
  });

  it('manager with the RECORD_EXPENSE flag cannot record without ledger tag', async () => {
    // Under the additive-tag model, the MANAGER_RECORD_EXPENSE flag
    // alone no longer grants treasury access. The manager must also
    // be on a treasury list (Treasurer/Chairman) OR be an Admin.
    const res = await send('POST', '/treasury/expenses', expBody(), 'mgr@x.com');
    expect(res.status).toBe(403);
  });

  it('manager tagged as treasurer CAN record with the flag', async () => {
    accessOverrides = { treasurer: ['mgr@x.com'] };
    const res = await send('POST', '/treasury/expenses', expBody(), 'mgr@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(201);
    expect(j.data.expense.id).toMatch(/^EXP-/);
    expect(j.data.expense.payee).toBe('Adarsh Plumbing');
  });

  it('committee can list expenses filtered by month', async () => {
    await send('POST', '/treasury/expenses', expBody({ date: '2026-01-06' }), 'cmt@x.com');
    await send('POST', '/treasury/expenses', expBody({ date: '2026-02-11', payee: 'Vasant Electricals', category: 'Electrical' }), 'cmt@x.com');
    const res = await send('GET', '/treasury/expenses?month=2026-01', undefined, 'cmt@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.items.every((e: any) => (e.date || '').startsWith('2026-01'))).toBe(true);
    expect(j.data.items).toHaveLength(1);
  });

  it('soft-delete requires a reason and hides the record', async () => {
    const create = await send('POST', '/treasury/expenses', expBody(), 'cmt@x.com');
    const id = (await readJson(create)).data.expense.id as string;
    const noReason = await send('POST', `/treasury/expenses/${id}/delete`, {}, 'cmt@x.com');
    expect(noReason.status).toBe(400);
    const ok = await send('POST', `/treasury/expenses/${id}/delete`, { reason: 'duplicate entry' }, 'cmt@x.com');
    expect(ok.status).toBe(200);
    const list = await send('GET', '/treasury/expenses', undefined, 'cmt@x.com');
    const j = await readJson(list);
    // Deleted rows are tombstoned; the default list excludes them.
    expect(j.data.items.find((e: any) => e.id === id)).toBeUndefined();
  });

  it('manager (non-committee) cannot delete an expense', async () => {
    // Create the expense as a committee member (grandfathered), then
    // try to delete as a plain manager → blocked by ensureCanActLedger.
    const create = await send('POST', '/treasury/expenses', expBody(), 'cmt@x.com');
    const id = (await readJson(create)).data.expense.id as string;
    const res = await send('POST', `/treasury/expenses/${id}/delete`, { reason: 'oops' }, 'mgr@x.com');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------- summary

describe('treasury: monthly summary', () => {
  it('aggregates paid reimbursements + expenses for the requested month', async () => {
    // Manager records a direct expense in the target month.
    await send('POST', '/treasury/expenses', {
      payee: 'BSNL', category: 'Utilities', amount: 3500,
      date: '2026-03-04', mode: 'bank', reference: 'UTR-1',
    }, 'cmt@x.com');
    await send('POST', '/treasury/expenses', {
      payee: 'Balaji Housekeeping', category: 'Housekeeping', amount: 12000,
      date: '2026-03-15', mode: 'bank', reference: 'UTR-2',
    }, 'cmt@x.com');

    const res = await send('GET', '/treasury/summary?month=2026-03', undefined, 'cmt@x.com');
    const j = await readJson(res);
    expect(res.status).toBe(200);
    expect(j.data.month).toBe('2026-03');
    expect(j.data.totalMonth).toBe(15500);
    expect(j.data.byCategory.Utilities).toBe(3500);
    expect(j.data.byCategory.Housekeeping).toBe(12000);
    expect(j.data.expenseCount).toBe(2);
  });

  it('residents cannot see the summary', async () => {
    const res = await send('GET', '/treasury/summary?month=2026-03', undefined, 'res@x.com');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------- file validation

describe('treasury: file metadata validation', () => {
  it('rejects unsupported mime types', async () => {
    const res = await send('POST', '/treasury/reimbursements',
      buildRaiseBody({ proofs: [{ name: 'x.exe', mime: 'application/octet-stream', size: 100 }] }),
      'res@x.com');
    expect(res.status).toBe(400);
  });

  it('rejects proofs list larger than the configured cap', async () => {
    tunableOverrides = { TREASURY_MAX_FILES_PER_ITEM: 2 };
    const three = [
      { name: 'a.pdf', mime: 'application/pdf', size: 1000 },
      { name: 'b.pdf', mime: 'application/pdf', size: 1000 },
      { name: 'c.pdf', mime: 'application/pdf', size: 1000 },
    ];
    const res = await send('POST', '/treasury/reimbursements',
      buildRaiseBody({ proofs: three }), 'res@x.com');
    expect(res.status).toBe(400);
  });

  it('accepts allowed image and pdf mimes', async () => {
    const res = await send('POST', '/treasury/reimbursements',
      buildRaiseBody({ proofs: [
        { name: 'a.pdf', mime: 'application/pdf', size: 5000 },
        { name: 'b.jpg', mime: 'image/jpeg', size: 5000 },
      ] }), 'res@x.com');
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------- binary receipt storage

describe('treasury: binary receipt upload to private repo', () => {
  const b64 = 'AAECAwQFBgcICQ=='; // 10 bytes of dummy content

  it('uploads proofs to the configured treasury repo when dataBase64 is present', async () => {
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody({
      proofs: [{ name: 'receipt one.pdf', mime: 'application/pdf', size: 10, dataBase64: b64 }],
    }), 'res@x.com');
    expect(res.status).toBe(201);
    const j = await readJson(res);
    expect(j.ok).toBe(true);
    expect((ghClient.putBinaryB64 as any).mock.calls.length).toBe(1);
    const [envArg, pathArg, contentArg, , actor, targetArg] = (ghClient.putBinaryB64 as any).mock.calls[0];
    expect(envArg.GH_TREASURY_REPO).toBe('tsh-treasury');
    expect(contentArg).toBe(b64);
    expect(actor).toBe('res@x.com');
    expect(targetArg).toBeDefined();
    expect(targetArg.owner).toBe('tadeskops');
    expect(targetArg.repo).toBe('tsh-treasury');
    // Path uses the default template: yearMonth / kind / id / seq-name
    expect(pathArg).toMatch(/^treasury\/receipts\/\d{4}-\d{2}\/proof\/RMB-\d+\/01-receipt_one\.pdf$/);
    // FileRef in the returned record carries the storage path
    expect(j.data.reimbursement.proofs[0].path).toBe(pathArg);
  });

  it('does not upload when dataBase64 is absent (backward compatible)', async () => {
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody({
      proofs: [{ name: 'note.pdf', mime: 'application/pdf', size: 100 }],
    }), 'res@x.com');
    expect(res.status).toBe(201);
    expect((ghClient.putBinaryB64 as any).mock.calls.length).toBe(0);
    const j = await readJson(res);
    expect(j.data.reimbursement.proofs[0].path).toBeUndefined();
  });

  it('uploads cash payment slips under kind=payment with the reimbursement id', async () => {
    // Raise & approve first.
    const raise = await readJson(await send('POST', '/treasury/reimbursements', buildRaiseBody(), 'res@x.com'));
    const id = raise.data.reimbursement.id as string;
    await send('PATCH', `/treasury/reimbursements/${id}`, { status: 'approved' }, 'cmt@x.com');
    (ghClient.putBinaryB64 as any).mockClear();

    const res = await send('POST', `/treasury/reimbursements/${id}/payment`, {
      payMode: 'cash',
      payRef: 'CASH-1',
      paymentProofs: [{ name: 'signed.jpg', mime: 'image/jpeg', size: 10, dataBase64: b64 }],
    }, 'cmt@x.com');
    expect(res.status).toBe(200);
    expect((ghClient.putBinaryB64 as any).mock.calls.length).toBe(1);
    const [, pathArg] = (ghClient.putBinaryB64 as any).mock.calls[0];
    expect(pathArg).toMatch(new RegExp(`^treasury/receipts/\\d{4}-\\d{2}/payment/${id}/01-signed\\.jpg$`));
  });

  it('uploads expense receipts under kind=receipt with the expense id', async () => {
    const res = await send('POST', '/treasury/expenses', {
      payee: 'BESCOM',
      category: 'Utilities',
      amount: 5000,
      date: '2026-02-01',
      mode: 'bank',
      reference: 'NEFT-1',
      receipts: [{ name: 'bill.pdf', mime: 'application/pdf', size: 10, dataBase64: b64 }],
    }, 'cmt@x.com');
    expect(res.status).toBe(201);
    const j = await readJson(res);
    expect((ghClient.putBinaryB64 as any).mock.calls.length).toBe(1);
    const [, pathArg] = (ghClient.putBinaryB64 as any).mock.calls[0];
    expect(pathArg).toMatch(new RegExp(`^treasury/receipts/\\d{4}-\\d{2}/receipt/${j.data.expense.id}/01-bill\\.pdf$`));
    expect(j.data.expense.receipts[0].path).toBe(pathArg);
  });

  it('honours the TREASURY_RECEIPT_PATH tunable override', async () => {
    tunableOverrides = { TREASURY_RECEIPT_PATH: 'custom/{kind}/{id}/{name}' } as any;
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody({
      proofs: [{ name: 'a.pdf', mime: 'application/pdf', size: 10, dataBase64: b64 }],
    }), 'res@x.com');
    expect(res.status).toBe(201);
    const [, pathArg] = (ghClient.putBinaryB64 as any).mock.calls[0];
    expect(pathArg).toMatch(/^custom\/proof\/RMB-\d+\/a\.pdf$/);
  });

  it('falls back to metadata-only when the treasury repo is not configured', async () => {
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody({
      proofs: [{ name: 'a.pdf', mime: 'application/pdf', size: 10, dataBase64: b64 }],
    }), 'res@x.com', envUnconfigured);
    // envUnconfigured has no treasury repo, so the raise itself falls back
    // to storage-not-configured behaviour — no upload happens.
    expect(res.status).toBe(503);
    expect((ghClient.putBinaryB64 as any).mock.calls.length).toBe(0);
  });

  it('preserves the record even when binary upload throws', async () => {
    (ghClient.putBinaryB64 as any).mockImplementationOnce(async () => {
      throw new Error('gh 500');
    });
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody({
      proofs: [{ name: 'a.pdf', mime: 'application/pdf', size: 10, dataBase64: b64 }],
    }), 'res@x.com');
    expect(res.status).toBe(201);
    const j = await readJson(res);
    // Upload attempted…
    expect((ghClient.putBinaryB64 as any).mock.calls.length).toBe(1);
    // …but failed → FileRef persisted without `path` so the request isn't lost
    expect(j.data.reimbursement.proofs[0].path).toBeUndefined();
    expect(j.data.reimbursement.proofs[0].name).toBe('a.pdf');
  });

  it('rejects dataBase64 that is larger than TREASURY_MAX_FILE_BYTES', async () => {
    tunableOverrides = { TREASURY_MAX_FILE_BYTES: 8 } as any;
    // b64 above decodes to 10 bytes → over the 8-byte cap
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody({
      proofs: [{ name: 'a.pdf', mime: 'application/pdf', size: 10, dataBase64: b64 }],
    }), 'res@x.com');
    expect(res.status).toBe(400);
    expect((ghClient.putBinaryB64 as any).mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------- receipt streaming

describe('treasury: GET /treasury/file (receipt streaming)', () => {
  const b64 = 'AAECAwQFBgcICQ=='; // 10 bytes

  // Helper: raise a reimbursement that has an uploaded proof, return its path.
  const raiseWithProof = async () => {
    const res = await send('POST', '/treasury/reimbursements', buildRaiseBody({
      proofs: [{ name: 'bill.pdf', mime: 'application/pdf', size: 10, dataBase64: b64 }],
    }), 'res@x.com');
    const j = await readJson(res);
    return j.data.reimbursement.proofs[0].path as string;
  };

  it('residents cannot fetch receipts (Manager+ only)', async () => {
    const path = await raiseWithProof();
    const res = await send('GET', '/treasury/file?path=' + encodeURIComponent(path), undefined, 'res@x.com');
    expect(res.status).toBe(403);
  });

  it('committee can fetch a stored receipt and gets binary + correct headers', async () => {
    const path = await raiseWithProof();
    // Stub the binary read to return known bytes.
    (ghClient.getBinaryFile as any).mockImplementationOnce(async () => ({
      sha: 'x', bytes: new Uint8Array([1, 2, 3, 4]),
    }));
    const res = await send('GET', '/treasury/file?path=' + encodeURIComponent(path), undefined, 'cmt@x.com');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Disposition')).toContain('bill.pdf');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
  });

  it('rejects missing path query', async () => {
    const res = await send('GET', '/treasury/file', undefined, 'cmt@x.com');
    expect(res.status).toBe(400);
  });

  it('rejects paths outside the treasury/ tree (traversal defence)', async () => {
    const res = await send('GET', '/treasury/file?path=' + encodeURIComponent('config/site.json'), undefined, 'cmt@x.com');
    expect(res.status).toBe(400);
  });

  it('rejects paths that contain `..` or `//`', async () => {
    const res1 = await send('GET', '/treasury/file?path=' + encodeURIComponent('treasury/../config/site.json'), undefined, 'cmt@x.com');
    expect(res1.status).toBe(400);
    const res2 = await send('GET', '/treasury/file?path=' + encodeURIComponent('treasury//x.pdf'), undefined, 'cmt@x.com');
    expect(res2.status).toBe(400);
  });

  it('returns 404 for a treasury path that no FileRef references', async () => {
    // Path shape valid, but no reimbursement/expense has it.
    const res = await send('GET', '/treasury/file?path=' + encodeURIComponent('treasury/receipts/2026-07/proof/RMB-999/01-ghost.pdf'), undefined, 'cmt@x.com');
    expect(res.status).toBe(404);
    // Should not touch the binary read either.
    expect((ghClient.getBinaryFile as any).mock.calls.length).toBe(0);
  });

  it('returns 404 when the FileRef exists but the blob is gone from the repo', async () => {
    const path = await raiseWithProof();
    (ghClient.getBinaryFile as any).mockImplementationOnce(async () => undefined);
    const res = await send('GET', '/treasury/file?path=' + encodeURIComponent(path), undefined, 'cmt@x.com');
    expect(res.status).toBe(404);
  });

  it('returns 404 when treasury storage is not configured', async () => {
    const res = await send('GET', '/treasury/file?path=' + encodeURIComponent('treasury/receipts/2026-07/proof/RMB-1/01-a.pdf'),
      undefined, 'cmt@x.com', envUnconfigured);
    expect(res.status).toBe(404);
  });
});

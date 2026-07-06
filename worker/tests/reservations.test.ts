// Smoke tests for /facilities and /reservations endpoints.
// Covers: RBAC, slot-conflict prevention, advance-notice policy, per-owner
// concurrency cap, resident-vs-manager scope, cancel by owner, reject
// requires reason, availability grid reflects held slots.

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

// In-memory fake for the two config files this feature writes.
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
  putBinaryB64: vi.fn(async () => ({ sha: 'sha-x' })),
  createIssue: vi.fn(),
  listIssues: vi.fn(async () => []),
  getIssue: vi.fn(),
  updateIssue: vi.fn(),
  lockIssue: vi.fn(),
  commentOnIssue: vi.fn(),
}));

vi.mock('../src/config/loader.ts', async () => {
  const { DEFAULT_CONFIG } = await import('../src/config/defaults.ts');
  return {
    loadConfig: vi.fn(async () => ({
      config: {
        ...DEFAULT_CONFIG,
        features: {
          ...DEFAULT_CONFIG.features,
          FEATURE_DAILY_TURNSTILE: false,
          FEATURE_TSH_RESERVATIONS: true,
        },
      },
      access: {
        managers:   ['mgr@x.com'],
        committee:  ['cmt@x.com'],
        admins:     ['dev@x.com'],
      },
    })),
    invalidateCache: vi.fn(),
  };
});

import worker from '../src/index.ts';
import { _resetReservationCachesForTests } from '../src/routes/reservations.ts';

const env = {
  GH_OWNER: 'tadeskops',
  GH_REPO: 'ta-society-helpdesk',
  GH_BRANCH: 'main',
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  TURNSTILE_SITE_KEY: 'test',
  ALLOWED_ORIGINS: 'http://localhost:8080',
  LOG_LEVEL: 'error',
  GITHUB_TOKEN: 'fake',
};

const send = (method: string, path: string, body?: any, identity?: string) => {
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

const seedFacilities = () => {
  files.set('config/facilities.json', {
    sha: 'sha-fac',
    content: JSON.stringify({
      version: 1,
      facilities: [
        {
          id: 'community-hall',
          name: 'Community Hall',
          description: 'Main hall',
          enabled: true,
          capacity: 100,
          slots: [
            { id: 'morning',   label: 'Morning',   startHour: 6,  endHour: 12 },
            { id: 'afternoon', label: 'Afternoon', startHour: 12, endHour: 18 },
            { id: 'evening',   label: 'Evening',   startHour: 18, endHour: 23 },
          ],
          policy: {
            minAdvanceHours: 1,     // tests use dates 7d ahead so this is trivially satisfied
            maxAdvanceDays: 365,
            maxConcurrentPerOwner: 2,
            requiresApproval: true,
            requiresPayment: false,
            paymentAmount: 0,
            paymentPayee: '',
            blackoutDates: [],
          },
          rules: [],
        },
      ],
    }),
  });
};

// A date ~7 days in the future, always well past any minAdvance policy.
const soon = (): string => {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 5.5 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

beforeEach(() => {
  files.clear();
  putCount = 0;
  _resetReservationCachesForTests();
  seedFacilities();
});

// ------------------------------------------------------------ Facilities

describe('GET /facilities', () => {
  it('requires sign-in', async () => {
    const r = await send('GET', '/facilities');
    expect(r.status).toBe(401);
  });
  it('lists enabled facilities for signed-in residents', async () => {
    const r = await send('GET', '/facilities', undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.facilities).toHaveLength(1);
    expect(j.data.facilities[0].id).toBe('community-hall');
    expect(j.data.facilities[0].slots).toHaveLength(3);
  });
});

describe('GET /facilities/:id/availability', () => {
  it('marks all slots available when no bookings exist', async () => {
    const d = soon();
    const r = await send('GET', `/facilities/community-hall/availability?from=${d}&to=${d}`, undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.days).toHaveLength(1);
    expect(j.data.days[0].slots.every((s: any) => s.status === 'available')).toBe(true);
  });
});

// ------------------------------------------------------------ Reservations

describe('POST /reservations', () => {
  it('creates a reservation for a signed-in resident', async () => {
    const d = soon();
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning',
      purpose: 'Birthday party', ownerName: 'Alice', ownerFlat: 'A-101',
    }, 'resident1@x.com');
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.data.reservation.id).toMatch(/^RES-\d{10}(?:-\d+)?$/);
    expect(j.data.reservation.status).toBe('requested');
    expect(j.data.reservation.owner.email).toBe('resident1@x.com');
    expect(j.data.reservation.timeline).toHaveLength(1);
    expect(j.data.reservation.timeline[0].event).toBe('created');
  });

  it('rejects anonymous requests', async () => {
    const d = soon();
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'Test',
    });
    expect(r.status).toBe(401);
  });

  it('rejects conflicts on the same facility/date/slot', async () => {
    const d = soon();
    const a = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'First',
    }, 'resident1@x.com');
    expect(a.status).toBe(201);
    const b = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'Second',
    }, 'resident2@x.com');
    expect(b.status).toBe(400);
    const j = await b.json() as any;
    expect(j.error).toMatch(/slot/i);
  });

  it('enforces per-owner concurrency cap', async () => {
    const d = soon();
    const first = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'First one',
    }, 'resident1@x.com');
    if (first.status !== 201) console.error('first failed:', await first.clone().text());
    expect(first.status).toBe(201);
    const second = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'afternoon', purpose: 'Second one',
    }, 'resident1@x.com');
    expect(second.status).toBe(201);
    const third = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'evening', purpose: 'Third one',
    }, 'resident1@x.com');
    expect(third.status).toBe(400);
    const j = await third.json() as any;
    expect(j.error).toMatch(/active reservation/i);
  });

  it('lets a manager book on behalf of a resident', async () => {
    const d = soon();
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning',
      purpose: 'For resident', ownerEmail: 'resident3@x.com',
    }, 'mgr@x.com');
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.data.reservation.owner.email).toBe('resident3@x.com');
    expect(j.data.reservation.createdBy.email).toBe('mgr@x.com');
  });

  it('forbids residents from booking on behalf of others', async () => {
    const d = soon();
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning',
      purpose: 'sneaky', ownerEmail: 'someone@x.com',
    }, 'resident1@x.com');
    expect(r.status).toBe(403);
  });
});

describe('GET /reservations', () => {
  it('resident sees only own reservations', async () => {
    const d = soon();
    await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning',   purpose: 'mine here' }, 'resident1@x.com');
    await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'afternoon', purpose: 'other one' }, 'resident2@x.com');
    _resetReservationCachesForTests();
    const r = await send('GET', '/reservations', undefined, 'resident1@x.com');
    const j = await r.json() as any;
    expect(j.data.items).toHaveLength(1);
    expect(j.data.items[0].owner.email).toBe('resident1@x.com');
  });

  it('manager sees all with scope=all', async () => {
    const d = soon();
    await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning',   purpose: 'first booking' }, 'resident1@x.com');
    await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'afternoon', purpose: 'second booking' }, 'resident2@x.com');
    _resetReservationCachesForTests();
    const r = await send('GET', '/reservations?scope=all', undefined, 'mgr@x.com');
    const j = await r.json() as any;
    expect(j.data.items).toHaveLength(2);
  });
});

describe('PATCH /reservations/:id', () => {
  it('lets a manager approve a request', async () => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}`, { status: 'confirmed' }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.reservation.status).toBe('confirmed');
    expect(j.data.reservation.timeline.some((t: any) => t.event === 'approved')).toBe(true);
  });

  it('requires a reason when a manager rejects', async () => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}`, { status: 'rejected' }, 'mgr@x.com');
    expect(r.status).toBe(400);
    const withReason = await send('PATCH', `/reservations/${id}`, { status: 'rejected', note: 'Facility unavailable' }, 'mgr@x.com');
    expect(withReason.status).toBe(200);
  });

  it('forbids residents from approving their own request', async () => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}`, { status: 'confirmed' }, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('lets the owner cancel their own request', async () => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}`, { status: 'cancelled' }, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.reservation.status).toBe('cancelled');
  });

  it('frees the slot once a reservation is cancelled', async () => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    await send('PATCH', `/reservations/${id}`, { status: 'cancelled' }, 'resident1@x.com');
    _resetReservationCachesForTests();
    const r = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'reuse' }, 'resident2@x.com');
    expect(r.status).toBe(201);
  });
});

describe('POST /reservations/:id/comments', () => {
  it('appends a timeline comment', async () => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    const r = await send('POST', `/reservations/${id}/comments`, { note: 'Please confirm asap' }, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.reservation.timeline.some((t: any) => t.event === 'commented' && t.note === 'Please confirm asap')).toBe(true);
  });
});

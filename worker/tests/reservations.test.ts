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
const binaries = new Map<string, { sha: string; bytes: Uint8Array }>();
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
  putBinaryB64: vi.fn(async (_env: any, path: string, b64: string) => {
    putCount++;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    binaries.set(path, { sha: `sha-${putCount}`, bytes });
    return { sha: `sha-${putCount}` };
  }),
  getBinaryFile: vi.fn(async (_env: any, path: string) => {
    const b = binaries.get(path);
    if (!b) return undefined;
    return { sha: b.sha, bytes: b.bytes };
  }),
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
  // Convenience shim for legacy tests written against the fixed-slot
  // engine. On POST /reservations we translate a shorthand slotId into
  // startTime/endTime and inject a default ownerFlat when absent, so
  // the pre-cutover test bodies keep working. Focused time-range and
  // flat-required tests pass their own values and are unaffected.
  let effectiveBody = body;
  if (method === 'POST' && path === '/reservations' && body && typeof body === 'object') {
    const b: any = { ...body };
    if (!('ownerFlat' in b)) b.ownerFlat = 'A-101';
    if (!('startTime' in b) && !('endTime' in b) && typeof b.slotId === 'string') {
      const map: Record<string, [string, string]> = {
        morning:   ['06:00', '12:00'],
        afternoon: ['12:00', '18:00'],
        evening:   ['18:00', '23:00'],
        day:       ['08:00', '20:00'],
      };
      const times = map[b.slotId];
      if (times) { b.startTime = times[0]; b.endTime = times[1]; }
      delete b.slotId;
    }
    effectiveBody = b;
  }
  return worker.fetch(
    new Request(`https://w.x${path}`, { method, headers, ...(effectiveBody ? { body: JSON.stringify(effectiveBody) } : {}) }),
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
            maxPerFlatPerYear: 99,
            openMin: 6 * 60,
            closeMin: 23 * 60,
            stepMinutes: 30,
            minDurationMinutes: 60,
            maxDurationMinutes: 8 * 60,
            requiresApproval: true,
            requiresPayment: false,
            paymentAmount: 0,
            paymentPayee: '',
            chargesInfo: '',
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
  binaries.clear();
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

describe('PATCH /facilities/:id', () => {
  it('rejects residents (MANAGER+ only)', async () => {
    const r = await send('PATCH', '/facilities/community-hall', {
      policy: { minAdvanceHours: 48 },
    }, 'resident1@x.com');
    expect(r.status).toBe(403);
  });
  it('allows a manager to update charges, rate card and guidelines', async () => {
    const r = await send('PATCH', '/facilities/community-hall', {
      policy: {
        minAdvanceHours: 48,
        maxAdvanceDays: 30,
        chargesInfo: 'Deposit ₹2000 refundable after inspection.',
        rateCard: [
          { label: 'Half day', amount: 1500 },
          { label: 'Full day', amount: 2500, note: 'Cleaning included.' },
        ],
        usageGuidelines: {
          before: ['Check the space for damage.', 'Bring your own decor.'],
          after:  ['Sweep the floor.', 'Segregate waste.'],
        },
      },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.facility.policy.minAdvanceHours).toBe(48);
    expect(j.data.facility.policy.maxAdvanceDays).toBe(30);
    expect(j.data.facility.policy.rateCard).toHaveLength(2);
    expect(j.data.facility.policy.rateCard[1].note).toContain('Cleaning');
    expect(j.data.facility.policy.usageGuidelines.before).toHaveLength(2);
    expect(j.data.facility.policy.usageGuidelines.after).toHaveLength(2);
    // Re-fetch from GET to confirm persistence through the cache invalidation.
    const g = await send('GET', '/facilities/community-hall', undefined, 'resident1@x.com');
    const gj = await g.json() as any;
    expect(gj.data.facility.policy.chargesInfo).toContain('Deposit');
    expect(gj.data.facility.policy.usageGuidelines.before[0]).toBe('Check the space for damage.');
  });
  it('rejects closeMin <= openMin', async () => {
    const r = await send('PATCH', '/facilities/community-hall', {
      policy: { openMin: 720, closeMin: 600 },
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(String(j.error || j.message || '')).toMatch(/closeMin/i);
  });
});

describe('GET /facilities/:id/availability', () => {
  it('returns an empty busy list when no bookings exist', async () => {
    const d = soon();
    const r = await send('GET', `/facilities/community-hall/availability?from=${d}&to=${d}`, undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.days).toHaveLength(1);
    expect(j.data.days[0].busy).toEqual([]);
    expect(j.data.open.stepMinutes).toBe(30);
    expect(j.data.open.openMin).toBeGreaterThanOrEqual(0);
    expect(j.data.open.closeMin).toBeGreaterThan(j.data.open.openMin);
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

  it('rejects overlapping bookings on the same facility/date', async () => {
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
    expect(j.error).toMatch(/overlap/i);
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

describe('POST /reservations — time-range validation', () => {
  const dbase = () => soon();

  it('accepts a free-form 90-minute booking', async () => {
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: dbase(),
      startTime: '10:00', endTime: '11:30',
      purpose: 'Yoga class', ownerFlat: 'C-303',
    }, 'resident1@x.com');
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.data.reservation.startMin).toBe(600);
    expect(j.data.reservation.endMin).toBe(690);
  });

  it('rejects step-misaligned times (step=30)', async () => {
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: dbase(),
      startTime: '10:15', endTime: '11:15',
      purpose: 'test x', ownerFlat: 'C-303',
    }, 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(j.error).toMatch(/aligned/i);
  });

  it('rejects durations shorter than the minimum', async () => {
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: dbase(),
      startTime: '10:00', endTime: '10:30',
      purpose: 'too short', ownerFlat: 'C-303',
    }, 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(j.error).toMatch(/minimum/i);
  });

  it('rejects durations longer than the maximum', async () => {
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: dbase(),
      startTime: '06:00', endTime: '17:00',
      purpose: 'too long', ownerFlat: 'C-303',
    }, 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(j.error).toMatch(/maximum/i);
  });

  it('allows non-overlapping back-to-back bookings that touch endpoints', async () => {
    const d = dbase();
    const a = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d,
      startTime: '10:00', endTime: '11:00', purpose: 'first', ownerFlat: 'D-404',
    }, 'resident1@x.com');
    expect(a.status).toBe(201);
    const b = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d,
      startTime: '11:00', endTime: '12:00', purpose: 'second', ownerFlat: 'D-405',
    }, 'resident2@x.com');
    expect(b.status).toBe(201);
  });

  it('rejects overlapping bookings with a helpful message', async () => {
    const d = dbase();
    await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d,
      startTime: '10:00', endTime: '12:00', purpose: 'first', ownerFlat: 'E-505',
    }, 'resident1@x.com');
    const b = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d,
      startTime: '11:00', endTime: '13:00', purpose: 'second', ownerFlat: 'E-506',
    }, 'resident2@x.com');
    expect(b.status).toBe(400);
    const j = await b.json() as any;
    expect(j.error).toMatch(/overlap/i);
  });
});

describe('POST /reservations — flat quota', () => {
  it('requires ownerFlat', async () => {
    const d = soon();
    // Bypass the helper default by explicitly setting an empty string.
    const r = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning',
      purpose: 'no flat', ownerFlat: '',
    }, 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(j.error).toMatch(/ownerFlat/i);
  });

  it('enforces the per-flat, per-year cap', async () => {
    // Seed a facility with cap=2 so we can hit it deterministically.
    files.set('config/facilities.json', {
      sha: 'sha-fac-cap',
      content: JSON.stringify({
        version: 1,
        facilities: [
          {
            id: 'community-hall',
            name: 'Community Hall',
            enabled: true,
            slots: [
              { id: 'morning',   label: 'Morning',   startHour: 6,  endHour: 12 },
              { id: 'afternoon', label: 'Afternoon', startHour: 12, endHour: 18 },
              { id: 'evening',   label: 'Evening',   startHour: 18, endHour: 23 },
            ],
            policy: {
              minAdvanceHours: 1, maxAdvanceDays: 365,
              maxConcurrentPerOwner: 99, maxPerFlatPerYear: 2,
              requiresApproval: true, requiresPayment: false,
              paymentAmount: 0, paymentPayee: '', chargesInfo: '', blackoutDates: [],
            },
            rules: [],
          },
        ],
      }),
    });
    _resetReservationCachesForTests();
    const d = soon();
    const first = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning',
      purpose: 'one', ownerFlat: 'B-202',
    }, 'resident1@x.com');
    expect(first.status).toBe(201);
    const second = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'afternoon',
      // Different case + spacing normalizes to the same bucket.
      purpose: 'two', ownerFlat: 'b 202',
    }, 'resident2@x.com');
    expect(second.status).toBe(201);
    const third = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'evening',
      purpose: 'three', ownerFlat: 'B-202',
    }, 'resident3@x.com');
    expect(third.status).toBe(400);
    const j = await third.json() as any;
    expect(j.error).toMatch(/limit 2 per calendar year|already has/i);
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

// ============================================================ Payments (Phase 2)

const seedPaidFacility = () => {
  files.set('config/facilities.json', {
    sha: 'sha-fac',
    content: JSON.stringify({
      version: 1,
      facilities: [
        {
          id: 'guest-room',
          name: 'Guest Room',
          enabled: true,
          slots: [{ id: 'day', label: 'Full day', startHour: 8, endHour: 20 }],
          policy: {
            minAdvanceHours: 1,
            maxAdvanceDays: 365,
            maxConcurrentPerOwner: 2,
            maxPerFlatPerYear: 99,
            openMin: 8 * 60,
            closeMin: 20 * 60,
            stepMinutes: 30,
            minDurationMinutes: 60,
            maxDurationMinutes: 12 * 60,
            requiresApproval: true,
            requiresPayment: true,
            paymentAmount: 500,
            paymentPayee: 'TA Society Welfare',
            chargesInfo: '',
            blackoutDates: [],
          },
          rules: [],
        },
      ],
    }),
  });
};

// A tiny 1x1 PNG (67 bytes) encoded in base64 — smallest usable image blob.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_1X1}`;

const bookPaid = async (identity = 'resident1@x.com') => {
  _resetReservationCachesForTests();
  seedPaidFacility();
  const d = soon();
  const c = await send('POST', '/reservations', {
    facilityId: 'guest-room', date: d, slotId: 'day', purpose: 'guest stay',
  }, identity);
  return (await c.json() as any).data.reservation.id as string;
};

describe('POST /reservations (payment gating)', () => {
  it('seeds payment.status=pending on paid facilities', async () => {
    _resetReservationCachesForTests();
    seedPaidFacility();
    const d = soon();
    const r = await send('POST', '/reservations', {
      facilityId: 'guest-room', date: d, slotId: 'day', purpose: 'guest stay',
    }, 'resident1@x.com');
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.data.reservation.payment).toBeDefined();
    expect(j.data.reservation.payment.status).toBe('pending');
    expect(j.data.reservation.payment.amount).toBe(500);
    expect(j.data.reservation.payment.payee).toBe('TA Society Welfare');
  });
});

describe('POST /reservations/:id/payment-proof', () => {
  it('uploads a proof and flips status to submitted', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    const r = await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'upi-screenshot.png', txnRef: 'UPI-999',
    }, 'resident1@x.com');
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.data.reservation.payment.status).toBe('submitted');
    expect(j.data.reservation.payment.proofs).toHaveLength(1);
    expect(j.data.reservation.payment.proofs[0].mime).toBe('image/png');
    expect(j.data.reservation.payment.txnRef).toBe('UPI-999');
    expect(j.data.reservation.timeline.some((t: any) => t.event === 'payment-uploaded')).toBe(true);
  });

  it('forbids upload by a non-owner resident', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    const r = await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'x.png',
    }, 'resident2@x.com');
    expect(r.status).toBe(403);
  });

  it('rejects unsupported mime types', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    const r = await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: 'data:text/plain;base64,SGVsbG8=', name: 'x.txt',
    }, 'resident1@x.com');
    expect(r.status).toBe(400);
  });

  it('refuses uploads on facilities that do not require payment', async () => {
    // Community-Hall facility already seeded (no payment required).
    const d = soon();
    const c = await send('POST', '/reservations', {
      facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'no-pay',
    }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    const r = await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'x.png',
    }, 'resident1@x.com');
    expect(r.status).toBe(400);
  });
});

describe('GET /reservations/:id/payment-proof/:idx', () => {
  it('streams the file to the owner', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'a.png',
    }, 'resident1@x.com');
    _resetReservationCachesForTests();
    const r = await send('GET', `/reservations/${id}/payment-proof/1`, undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toBe('image/png');
    expect(r.headers.get('Cache-Control')).toContain('no-store');
    const buf = new Uint8Array(await r.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('forbids a non-owner resident from downloading', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'a.png',
    }, 'resident1@x.com');
    _resetReservationCachesForTests();
    const r = await send('GET', `/reservations/${id}/payment-proof/1`, undefined, 'resident2@x.com');
    expect(r.status).toBe(403);
  });

  it('allows a manager to download any proof', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'a.png',
    }, 'resident1@x.com');
    _resetReservationCachesForTests();
    const r = await send('GET', `/reservations/${id}/payment-proof/1`, undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
  });
});

describe('PATCH /reservations/:id/payment', () => {
  it('requires MANAGER+ to verify', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'a.png',
    }, 'resident1@x.com');
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}/payment`, { status: 'verified' }, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('rejects verify when no proof has been uploaded', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}/payment`, { status: 'verified' }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('requires a note when rejecting a payment', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'a.png',
    }, 'resident1@x.com');
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}/payment`, { status: 'rejected' }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('verifies the payment and records the timeline event', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'a.png', txnRef: 'UPI-42',
    }, 'resident1@x.com');
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}/payment`, {
      status: 'verified', note: 'seen in bank statement',
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.reservation.payment.status).toBe('verified');
    expect(j.data.reservation.payment.verifiedBy).toBe('mgr@x.com');
    expect(j.data.reservation.timeline.some((t: any) => t.event === 'payment-verified')).toBe(true);
  });
});

describe('PATCH /reservations/:id (payment gate)', () => {
  it('blocks confirming a paid booking until payment is verified', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}`, { status: 'confirmed' }, 'mgr@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(String(j.error || '')).toMatch(/payment/i);
  });

  it('lets a manager confirm once payment is verified', async () => {
    const id = await bookPaid();
    _resetReservationCachesForTests();
    await send('POST', `/reservations/${id}/payment-proof`, {
      dataUrl: PNG_DATA_URL, name: 'a.png',
    }, 'resident1@x.com');
    _resetReservationCachesForTests();
    await send('PATCH', `/reservations/${id}/payment`, { status: 'verified' }, 'mgr@x.com');
    _resetReservationCachesForTests();
    const r = await send('PATCH', `/reservations/${id}`, { status: 'confirmed' }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.reservation.status).toBe('confirmed');
  });
});


// ------------------------------------------------------------ DELETE /reservations/:id

describe('DELETE /reservations/:id', () => {
  const createAndCancel = async (): Promise<string> => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    await send('PATCH', `/reservations/${id}`, { status: 'cancelled' }, 'resident1@x.com');
    _resetReservationCachesForTests();
    return id;
  };

  it('lets an admin remove any reservation, including active ones', async () => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    const r = await send('DELETE', `/reservations/${id}`, { reason: 'duplicate' }, 'dev@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.deleted).toBe(true);
    // Record should now be hidden from the queue.
    _resetReservationCachesForTests();
    const list = await send('GET', '/reservations?scope=all&status=requested', undefined, 'mgr@x.com');
    const lj = await list.json() as any;
    expect((lj.data.items || []).find((x: any) => x.id === id)).toBeUndefined();
  });

  it('lets committee remove cancelled reservations', async () => {
    const id = await createAndCancel();
    const r = await send('DELETE', `/reservations/${id}`, undefined, 'cmt@x.com');
    expect(r.status).toBe(200);
  });

  it('blocks committee from deleting an active (requested) reservation', async () => {
    const d = soon();
    const c = await send('POST', '/reservations', { facilityId: 'community-hall', date: d, slotId: 'morning', purpose: 'test' }, 'resident1@x.com');
    const id = (await c.json() as any).data.reservation.id;
    _resetReservationCachesForTests();
    const r = await send('DELETE', `/reservations/${id}`, undefined, 'cmt@x.com');
    expect(r.status).toBe(403);
  });

  it('blocks managers entirely', async () => {
    const id = await createAndCancel();
    const r = await send('DELETE', `/reservations/${id}`, undefined, 'mgr@x.com');
    expect(r.status).toBe(403);
  });

  it('blocks residents entirely', async () => {
    const id = await createAndCancel();
    const r = await send('DELETE', `/reservations/${id}`, undefined, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('returns 404 for an unknown or already-deleted id', async () => {
    const id = await createAndCancel();
    const r1 = await send('DELETE', `/reservations/${id}`, undefined, 'dev@x.com');
    expect(r1.status).toBe(200);
    _resetReservationCachesForTests();
    const r2 = await send('DELETE', `/reservations/${id}`, undefined, 'dev@x.com');
    expect(r2.status).toBe(404);
  });
});

// -------------------------------------------------- PATCH /facilities auto-priceHistory

describe('PATCH /facilities auto-priceHistory', () => {
  it('auto-appends a snapshot when paymentAmount changes', async () => {
    const r = await send('PATCH', '/facilities/community-hall', {
      policy: { paymentAmount: 5000 },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    _resetReservationCachesForTests();
    const g = await send('GET', '/facilities/community-hall', undefined, 'mgr@x.com');
    const gj = await g.json() as any;
    const hist = gj.data.facility.policy.priceHistory || [];
    expect(hist.length).toBe(1);
    expect(hist[0].paymentAmount).toBe(5000);
    expect(hist[0].source).toMatch(/auto/);
    expect(hist[0].recordedBy).toBe('mgr@x.com');
  });

  it('auto-appends a snapshot when rateCard changes', async () => {
    const r = await send('PATCH', '/facilities/community-hall', {
      policy: {
        rateCard: [{ label: 'Base', amount: 1500 }],
      },
    }, 'cmt@x.com');
    expect(r.status).toBe(200);
    _resetReservationCachesForTests();
    const g = await send('GET', '/facilities/community-hall', undefined, 'mgr@x.com');
    const gj = await g.json() as any;
    const hist = gj.data.facility.policy.priceHistory || [];
    expect(hist.length).toBe(1);
    expect(hist[0].rateCard[0].label).toBe('Base');
    expect(hist[0].recordedBy).toBe('cmt@x.com');
  });

  it('does not append when unrelated fields change', async () => {
    const r = await send('PATCH', '/facilities/community-hall', {
      policy: { minAdvanceHours: 6 },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    _resetReservationCachesForTests();
    const g = await send('GET', '/facilities/community-hall', undefined, 'mgr@x.com');
    const gj = await g.json() as any;
    expect((gj.data.facility.policy.priceHistory || []).length).toBe(0);
  });

  it('preserves client-supplied priceHistory instead of auto-appending', async () => {
    const custom = [{
      effectiveDate: '2026-06-01',
      paymentAmount: 1500,
      source: 'manual entry',
    }];
    const r = await send('PATCH', '/facilities/community-hall', {
      policy: {
        paymentAmount: 5000,
        priceHistory: custom,
      },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    _resetReservationCachesForTests();
    const g = await send('GET', '/facilities/community-hall', undefined, 'mgr@x.com');
    const gj = await g.json() as any;
    const hist = gj.data.facility.policy.priceHistory || [];
    expect(hist.length).toBe(1);
    expect(hist[0].effectiveDate).toBe('2026-06-01');
    expect(hist[0].source).toBe('manual entry');
  });
});

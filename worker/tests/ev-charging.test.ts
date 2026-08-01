// Smoke tests for the /ev/* routes (Phase 1: /ev/config, Phase 2: booking core).
// See tsh_requirement.md §23.
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

// Per-test overlays so we can flip the master flag + sub-flags without
// re-mocking the whole config loader.
let featureOverrides: Record<string, boolean> = {};
let systemOverrides: Record<string, unknown> = {};

// In-memory fake for GitHub Contents API so Phase 2 tests can round-trip
// bookings between POST → GET without the underlying getFile/putFile mocks
// dropping the state.
const files = new Map<string, { sha: string; content: string }>();
let putCount = 0;

vi.mock('../src/github/client.ts', () => ({
  getFile: vi.fn(async (_env: any, path: string) => {
    const f = files.get(path);
    if (!f) return undefined;
    return { sha: f.sha, content: f.content, encoding: 'utf-8' as const };
  }),
  getJson:      vi.fn(async () => undefined),
  putFile:      vi.fn(async (_env: any, path: string, content: string) => {
    putCount++;
    files.set(path, { sha: `sha-${putCount}`, content });
    return { sha: `sha-${putCount}` };
  }),
  appendToFile: vi.fn(async () => undefined),
  putBinaryB64: vi.fn(async () => ({ sha: 'sha-x' })),
  createIssue:  vi.fn(),
  listIssues:   vi.fn(async () => []),
  getIssue:     vi.fn(),
  updateIssue:  vi.fn(),
  lockIssue:    vi.fn(),
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
          // Master flag defaults OFF; individual tests flip it via
          // featureOverrides. Sub-flags stay at their DEFAULT_CONFIG
          // values (booking on, receipt on, admin on, everything else off).
          ...featureOverrides,
        },
        system: { ...DEFAULT_CONFIG.system, ...systemOverrides },
      },
      access: {
        managers:    ['mgr@x.com'],
        committee:   ['cmt@x.com'],
        admins:      ['dev@x.com'],
        treasurer:   ['tres@x.com'],
        chairman:    [],
        secretary:   [],
        contributor: [],
      },
    })),
    invalidateCache: vi.fn(),
  };
});

import worker from '../src/index.ts';
import { _resetEvChargingCachesForTests } from '../src/routes/ev-charging.ts';

const env = {
  GH_OWNER: 'tadeskops',
  GH_REPO:  'ta-society-helpdesk',
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

beforeEach(() => {
  featureOverrides = {};
  systemOverrides = {};
  files.clear();
  putCount = 0;
  _resetEvChargingCachesForTests();
});

describe('GET /ev/config — master flag', () => {
  it('returns feature-disabled (503) when FEATURE_TSH_EV_CHARGING is OFF', async () => {
    // Master defaults off; leave overrides empty.
    const r = await send('GET', '/ev/config', undefined, 'resident1@x.com');
    expect(r.status).toBe(503);
    const j = await r.json() as any;
    expect(j.ok).toBe(false);
    // The FeatureDisabled envelope carries the flag name in the error
    // message so the client can render a targeted "ask an admin" gate.
    expect(String(j.error)).toContain('FEATURE_TSH_EV_CHARGING');
  });

  it('requires sign-in (401 for anonymous) even when the flag is ON', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/config');
    expect(r.status).toBe(401);
  });

  it('returns the ev block to any signed-in user when master flag is ON', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/config', undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.station.name).toBe('EV Charger #1');
    expect(j.data.station.enabled).toBe(true);
    expect(j.data.booking.stepMinutes).toBe(30);
    expect(j.data.booking.openMin).toBe(360);
    expect(j.data.booking.closeMin).toBe(1380);
    expect(Array.isArray(j.data.usageGuidelines)).toBe(true);
    expect(j.data.usageGuidelines.length).toBeGreaterThan(0);
    expect(j.data.reports.mirrorCron).toBe('monthly');
  });
});

describe('GET /ev/config — sub-flags surface', () => {
  it('reflects DEFAULT_CONFIG sub-flag values in the subFlags map', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/config', undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    // DEFAULT_CONFIG seeds these three ON and the rest OFF.
    expect(data.subFlags.booking).toBe(true);
    expect(data.subFlags.receipt).toBe(true);
    expect(data.subFlags.adminDashboard).toBe(true);
    expect(data.subFlags.autoReports).toBe(false);
    expect(data.subFlags.rfid).toBe(false);
    expect(data.subFlags.registration).toBe(false);
    expect(data.subFlags.support).toBe(false);
  });

  it('honours an admin-flipped sub-flag override', async () => {
    featureOverrides = {
      FEATURE_TSH_EV_CHARGING: true,
      FEATURE_TSH_EV_BOOKING:  false,
      FEATURE_TSH_EV_RFID:     true,
    };
    const r = await send('GET', '/ev/config', undefined, 'mgr@x.com');
    const { data } = await r.json() as any;
    expect(data.subFlags.booking).toBe(false);
    expect(data.subFlags.rfid).toBe(true);
  });
});

describe('GET /ev/config — site.json overrides', () => {
  it('surfaces a custom station name from system.ev', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = {
      ev: {
        station: { id: 'ev-a', name: 'Tower A Charger', location: 'B2', capacityKw: 11, enabled: true },
        booking: { stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
                   bufferMinutes: 5, advanceWindowDays: 7, maxActivePerFlat: 1,
                   openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [] },
        usageGuidelines: ['Custom guideline #1', 'Custom guideline #2'],
        provider: { name: 'Provider Co', androidUrl: '', iosUrl: '', website: '', email: '', tollFree: '' },
        faqs: [{ q: 'How to book?', a: 'Use the grid.' }],
        helpline: { directoryEntryId: 'dir-42' },
        reports: { template: '', mirrorCron: 'weekly' },
      },
    };
    const r = await send('GET', '/ev/config', undefined, 'resident1@x.com');
    const { data } = await r.json() as any;
    expect(data.station.name).toBe('Tower A Charger');
    expect(data.station.capacityKw).toBe(11);
    expect(data.usageGuidelines).toEqual(['Custom guideline #1', 'Custom guideline #2']);
    expect(data.faqs).toEqual([{ q: 'How to book?', a: 'Use the grid.' }]);
    expect(data.helpline.directoryEntryId).toBe('dir-42');
    expect(data.reports.mirrorCron).toBe('weekly');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — booking core (§23.4). Tests below assume master flag ON and
// FEATURE_TSH_EV_BOOKING at its DEFAULT_CONFIG value (on).
// ---------------------------------------------------------------------------

const dayMs = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDate = (offsetDays = 0): string => {
  const t = new Date(Date.now() + IST_OFFSET_MS + offsetDays * dayMs);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

describe('GET /ev/availability', () => {
  it('returns feature-disabled (503) when the master flag is OFF', async () => {
    const r = await send('GET', '/ev/availability', undefined, 'resident1@x.com');
    expect(r.status).toBe(503);
  });

  it('returns feature-disabled (503) when only FEATURE_TSH_EV_BOOKING is OFF', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_BOOKING: false };
    const r = await send('GET', '/ev/availability', undefined, 'resident1@x.com');
    expect(r.status).toBe(503);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('FEATURE_TSH_EV_BOOKING');
  });

  it('requires sign-in (401 for anonymous)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/availability');
    expect(r.status).toBe(401);
  });

  it('renders a per-day slot grid when the flag is ON', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const date = istDate(1);
    const r = await send('GET', `/ev/availability?from=${date}&to=${date}`, undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.days).toHaveLength(1);
    expect(data.days[0].date).toBe(date);
    // Default policy: 06:00-23:00 in 30-min steps = 34 slots.
    expect(data.days[0].slots.length).toBe(34);
    expect(data.days[0].slots.every((s: any) => s.booked === false)).toBe(true);
    expect(data.policy.stepMinutes).toBe(30);
  });

  it('rejects a range larger than the availability window', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const from = istDate(0);
    const to   = istDate(30);
    const r = await send('GET', `/ev/availability?from=${from}&to=${to}`, undefined, 'resident1@x.com');
    expect(r.status).toBe(400);
  });
});

describe('POST /ev/bookings — happy path & guardrails', () => {
  const validBody = (overrides: Record<string, unknown> = {}) => ({
    date: istDate(1),
    startMin: 9 * 60,   // 09:00
    endMin: 10 * 60,    // 10:00 (1h → within min/max, aligned to 30-min step)
    ownerFlat: 'A-101',
    ownerName: 'Test Resident',
    ...overrides,
  });

  it('creates a booking with status=confirmed when requiresApproval is false', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('POST', '/ev/bookings', validBody(), 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.item.status).toBe('confirmed');
    expect(data.item.owner.email).toBe('resident1@x.com');
    expect(data.item.owner.flat).toBe('A-101');
    expect(data.item.stationId).toBe('ev-1');
    expect(data.item.id).toMatch(/^EV-\d{10}(-\d+)?$/);
  });

  it('blocks a conflicting slot on the same station/day', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const first = await send('POST', '/ev/bookings', validBody(), 'resident1@x.com');
    expect(first.status).toBe(200);
    const second = await send('POST', '/ev/bookings', validBody({ ownerFlat: 'B-202' }), 'mgr@x.com');
    expect(second.status).toBe(400);
    const j = await second.json() as any;
    expect(String(j.error)).toContain('conflicts');
  });

  it('enforces the maxActivePerFlat quota', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    // First booking OK.
    const first = await send('POST', '/ev/bookings', validBody(), 'resident1@x.com');
    expect(first.status).toBe(200);
    // Second booking, different day, same flat → hits maxActivePerFlat=1.
    const second = await send('POST', '/ev/bookings', validBody({ date: istDate(2) }), 'resident1@x.com');
    expect(second.status).toBe(400);
    const j = await second.json() as any;
    expect(String(j.error)).toContain('active booking');
  });

  it('rejects a booking that spans past close-time', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('POST', '/ev/bookings', validBody({
      startMin: 23 * 60,
      endMin:   24 * 60,   // beyond default closeMin=23:00
    }), 'resident1@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects a date beyond the advance window', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('POST', '/ev/bookings', validBody({ date: istDate(30) }), 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('advance-booking window');
  });

  it('rejects a blacked-out date', async () => {
    const black = istDate(2);
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: { booking: {
      stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
      bufferMinutes: 5, advanceWindowDays: 7, maxActivePerFlat: 1,
      openMin: 360, closeMin: 1380, requiresApproval: false,
      blackoutDates: [black],
    }}};
    const r = await send('POST', '/ev/bookings', validBody({ date: black }), 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('blacked out');
  });

  it('creates PENDING when requiresApproval=true', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: { booking: {
      stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
      bufferMinutes: 5, advanceWindowDays: 7, maxActivePerFlat: 1,
      openMin: 360, closeMin: 1380, requiresApproval: true, blackoutDates: [],
    }}};
    const r = await send('POST', '/ev/bookings', validBody(), 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.item.status).toBe('pending');
  });
});

describe('GET /ev/bookings — scope resolution', () => {
  it('resident sees only their own bookings under scope=own', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    await send('POST', '/ev/bookings', { date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-1' }, 'resident1@x.com');
    await send('POST', '/ev/bookings', { date: istDate(1), startMin: 11*60, endMin: 12*60, ownerFlat: 'B-2' }, 'mgr@x.com');
    const r = await send('GET', '/ev/bookings?scope=own', undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.items).toHaveLength(1);
    expect(data.items[0].owner.email).toBe('resident1@x.com');
  });

  it('resident is forbidden (403) from scope=all', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/bookings?scope=all', undefined, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('manager can list every booking under scope=all', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    await send('POST', '/ev/bookings', { date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-1' }, 'resident1@x.com');
    await send('POST', '/ev/bookings', { date: istDate(1), startMin: 11*60, endMin: 12*60, ownerFlat: 'B-2' }, 'mgr@x.com');
    const r = await send('GET', '/ev/bookings?scope=all', undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.items.length).toBe(2);
  });
});

describe('PATCH /ev/bookings/:id — status transitions', () => {
  it('owner can cancel their own confirmed booking', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const created = await send('POST', '/ev/bookings', {
      date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-1',
    }, 'resident1@x.com');
    const { data: cData } = await created.json() as any;
    const id = cData.item.id;
    const r = await send('PATCH', `/ev/bookings/${id}`, { status: 'cancelled', reason: 'not needed' }, 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.item.status).toBe('cancelled');
    expect(data.item.cancelReason).toBe('not needed');
    expect(data.item.cancelledBy).toBe('resident1@x.com');
  });

  it('owner cannot mark their own booking as completed (staff-only transition)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const created = await send('POST', '/ev/bookings', {
      date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-1',
    }, 'resident1@x.com');
    const { data: cData } = await created.json() as any;
    const id = cData.item.id;
    const r = await send('PATCH', `/ev/bookings/${id}`, { status: 'completed' }, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('non-owner resident cannot cancel someone elses booking', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const created = await send('POST', '/ev/bookings', {
      date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-1',
    }, 'resident1@x.com');
    const { data: cData } = await created.json() as any;
    const id = cData.item.id;
    // A different contributor tries to cancel — same role, not owner.
    const r = await send('PATCH', `/ev/bookings/${id}`, { status: 'cancelled' }, 'other@x.com');
    expect(r.status).toBe(403);
  });

  it('manager can approve a PENDING booking to CONFIRMED', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: { booking: {
      stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
      bufferMinutes: 5, advanceWindowDays: 7, maxActivePerFlat: 1,
      openMin: 360, closeMin: 1380, requiresApproval: true, blackoutDates: [],
    }}};
    const created = await send('POST', '/ev/bookings', {
      date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-1',
    }, 'resident1@x.com');
    const { data: cData } = await created.json() as any;
    expect(cData.item.status).toBe('pending');
    const id = cData.item.id;
    const r = await send('PATCH', `/ev/bookings/${id}`, { status: 'confirmed' }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.item.status).toBe('confirmed');
  });
});


// ---------------------------------------------------------------------------
// Phase 3 - digital receipt tests (FEATURE_TSH_EV_RECEIPT default on).
// Spec: tsh_requirement.md sec 23.4 (Phase 3).
// ---------------------------------------------------------------------------

describe('GET /ev/receipt/:id', () => {
  const bookOne = async (identity: string) => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('POST', '/ev/bookings', {
      date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-101',
    }, identity);
    const { data } = await r.json() as any;
    return data.item.id as string;
  };

  it('returns feature-disabled (503) when master flag is OFF', async () => {
    const r = await send('GET', '/ev/receipt/EV-0102261200', undefined, 'resident1@x.com');
    expect(r.status).toBe(503);
  });

  it('returns feature-disabled (503) when only FEATURE_TSH_EV_RECEIPT is OFF', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_RECEIPT: false };
    const r = await send('GET', '/ev/receipt/EV-0102261200', undefined, 'resident1@x.com');
    expect(r.status).toBe(503);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('FEATURE_TSH_EV_RECEIPT');
  });

  it('requires sign-in (401 for anonymous)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/receipt/EV-0102261200');
    expect(r.status).toBe(401);
  });

  it('404 when the booking id does not exist', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/receipt/EV-0102261200', undefined, 'resident1@x.com');
    expect(r.status).toBe(404);
  });

  it('owner can fetch their own receipt and payload has qr + checksum', async () => {
    const id = await bookOne('resident1@x.com');
    const r = await send('GET', '/ev/receipt/'+id, undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.item.id).toBe(id);
    expect(data.station.id).toBe('ev-1');
    expect(data.society.name).toBeDefined();
    expect(data.qr).toBeDefined();
    expect(data.qr.v).toBe(1);
    expect(data.qr.id).toBe(id);
    expect(String(data.qr.checksum)).toMatch(/^[0-9a-f]{8}$/);
    expect(data.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('checksum is deterministic across two calls', async () => {
    const id = await bookOne('resident1@x.com');
    const a = await send('GET', '/ev/receipt/'+id, undefined, 'resident1@x.com');
    const b = await send('GET', '/ev/receipt/'+id, undefined, 'resident1@x.com');
    const ja = await a.json() as any;
    const jb = await b.json() as any;
    expect(ja.data.qr.checksum).toBe(jb.data.qr.checksum);
  });

  it('non-owner resident cannot view another owners receipt (403)', async () => {
    const id = await bookOne('resident1@x.com');
    const r = await send('GET', '/ev/receipt/'+id, undefined, 'other@x.com');
    expect(r.status).toBe(403);
  });

  it('manager can view any owner receipt', async () => {
    const id = await bookOne('resident1@x.com');
    const r = await send('GET', '/ev/receipt/'+id, undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
  });

  it('pending booking cannot yield a receipt (400)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: { booking: {
      stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
      bufferMinutes: 5, advanceWindowDays: 7, maxActivePerFlat: 1,
      openMin: 360, closeMin: 1380, requiresApproval: true, blackoutDates: [],
    }}};
    const created = await send('POST', '/ev/bookings', {
      date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-1',
    }, 'resident1@x.com');
    const { data: cData } = await created.json() as any;
    const r = await send('GET', '/ev/receipt/'+cData.item.id, undefined, 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('confirmed or completed');
  });

  it('cancelled booking cannot yield a receipt (400)', async () => {
    const id = await bookOne('resident1@x.com');
    const cancel = await send('PATCH', '/ev/bookings/'+id, { status: 'cancelled' }, 'resident1@x.com');
    expect(cancel.status).toBe(200);
    const r = await send('GET', '/ev/receipt/'+id, undefined, 'resident1@x.com');
    expect(r.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 - editor analytics dashboard (FEATURE_TSH_EV_ADMIN_DASHBOARD).
// Spec: tsh_requirement.md sec 23.4 (Phase 4).
// ---------------------------------------------------------------------------

describe('GET /ev/admin/dashboard', () => {
  const seedTwo = async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    await send('POST', '/ev/bookings', { date: istDate(1), startMin: 9*60,  endMin: 10*60, ownerFlat: 'A-101' }, 'resident1@x.com');
    await send('POST', '/ev/bookings', { date: istDate(2), startMin: 14*60, endMin: 15*60, ownerFlat: 'B-202' }, 'mgr@x.com');
  };

  it('returns feature-disabled (503) when master flag is OFF', async () => {
    const r = await send('GET', '/ev/admin/dashboard?period=w', undefined, 'mgr@x.com');
    expect(r.status).toBe(503);
  });

  it('returns feature-disabled (503) when FEATURE_TSH_EV_ADMIN_DASHBOARD is OFF', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_ADMIN_DASHBOARD: false };
    const r = await send('GET', '/ev/admin/dashboard?period=w', undefined, 'mgr@x.com');
    expect(r.status).toBe(503);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('FEATURE_TSH_EV_ADMIN_DASHBOARD');
  });

  it('requires sign-in (401 for anonymous)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/admin/dashboard?period=w');
    expect(r.status).toBe(401);
  });

  it('resident is forbidden (403)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/admin/dashboard?period=w', undefined, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('manager gets KPIs + byDay + byHour + topFlats', async () => {
    await seedTwo();
    const r = await send('GET', '/ev/admin/dashboard?period=w', undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.period).toBe('w');
    expect(data.kpis.totalBookings).toBeGreaterThanOrEqual(2);
    expect(data.kpis.confirmedBookings).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(data.byDay)).toBe(true);
    expect(data.byDay.length).toBeGreaterThanOrEqual(7);
    expect(Array.isArray(data.byHour)).toBe(true);
    expect(data.byHour.length).toBe(24);
    expect(Array.isArray(data.topFlats)).toBe(true);
  });

  it('rejects invalid period', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/admin/dashboard?period=zzz', undefined, 'mgr@x.com');
    expect(r.status).toBe(400);
  });
});

describe('GET /ev/admin/export', () => {
  it('returns 503 when the sub-flag is off', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_ADMIN_DASHBOARD: false };
    const r = await send('GET', '/ev/admin/export?period=w&format=csv', undefined, 'mgr@x.com');
    expect(r.status).toBe(503);
  });

  it('resident is forbidden (403)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/admin/export?period=w&format=csv', undefined, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('returns CSV with header row when format=csv', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    await send('POST', '/ev/bookings', { date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-101' }, 'resident1@x.com');
    const r = await send('GET', '/ev/admin/export?period=w&format=csv', undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toContain('text/csv');
    expect(r.headers.get('content-disposition') || '').toContain('.csv');
    const text = await r.text();
    const firstLine = text.split('\n')[0];
    expect(firstLine).toContain('id,stationId,date,startTime,endTime');
    expect(text).toContain('A-101');
  });

  it('returns HTML (print-ready) when format=pdf', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    await send('POST', '/ev/bookings', { date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-101' }, 'resident1@x.com');
    const r = await send('GET', '/ev/admin/export?period=w&format=pdf', undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toContain('text/html');
    const text = await r.text();
    expect(text).toContain('EV Charging Report');
    expect(text).toContain('A-101');
  });

  it('rejects unknown format', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    const r = await send('GET', '/ev/admin/export?period=w&format=xlsx', undefined, 'mgr@x.com');
    expect(r.status).toBe(400);
  });
});
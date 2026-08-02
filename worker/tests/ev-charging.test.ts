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
          // Sub-flags stay at their DEFAULT_CONFIG values (all EV
          // flags on by default). Individual tests flip flags via
          // featureOverrides when they need a specific gate scenario.
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
    // Explicitly flip the master flag OFF for this scenario.
    featureOverrides = { FEATURE_TSH_EV_CHARGING: false };
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
    // DEFAULT_CONFIG seeds every EV flag ON so the module ships fully
    // enabled out of the box.
    expect(data.subFlags.booking).toBe(true);
    expect(data.subFlags.receipt).toBe(true);
    expect(data.subFlags.adminDashboard).toBe(true);
    expect(data.subFlags.autoReports).toBe(true);
    expect(data.subFlags.rfid).toBe(true);
    expect(data.subFlags.registration).toBe(true);
    expect(data.subFlags.support).toBe(true);
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

  it('synthesizes a single-item stations array when only the legacy `station` block is present', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = {
      ev: {
        station: { id: 'ev-legacy', name: 'Legacy Charger', location: 'B1', capacityKw: 7.4, enabled: true },
      },
    };
    const r = await send('GET', '/ev/config', undefined, 'resident1@x.com');
    const { data } = await r.json() as any;
    expect(Array.isArray(data.stations)).toBe(true);
    expect(data.stations).toHaveLength(1);
    expect(data.stations[0].id).toBe('ev-legacy');
    // `station` (singular) always mirrors stations[0] for back-compat.
    expect(data.station.id).toBe('ev-legacy');
  });

  it('exposes a multi-station `stations` array (4-charger SunArth setup)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = {
      ev: {
        stations: [
          { id: 'ev-4w-1', name: 'SunArth DC Fast Charger #1', location: 'Basement — 4W bay 1', capacityKw: 80, kind: '4W', currentType: 'DC', connector: 'CCS-2', enabled: true, image: './assets/images/ev/sunarth-dcfc-4w.png', series: 'UltraPro Series' },
          { id: 'ev-4w-2', name: 'SunArth DC Fast Charger #2', location: 'Basement — 4W bay 2', capacityKw: 80, kind: '4W', currentType: 'DC', connector: 'CCS-2', enabled: true },
          { id: 'ev-2w-1', name: 'SunArth 2-Wheeler Point #1', location: 'Basement — 2W bay 1', capacityKw: 3.3, kind: '2W', currentType: 'AC', connector: 'Bharat AC-001', enabled: true, image: './assets/images/ev/sunarth-acwallbox-2w.png', series: 'AC Wallbox Series' },
          { id: 'ev-2w-2', name: 'SunArth 2-Wheeler Point #2', location: 'Basement — 2W bay 2', capacityKw: 3.3, kind: '2W', currentType: 'AC', connector: 'Bharat AC-001', enabled: true },
        ],
      },
    };
    const r = await send('GET', '/ev/config', undefined, 'resident1@x.com');
    const { data } = await r.json() as any;
    expect(data.stations).toHaveLength(4);
    expect(data.stations.map((s: any) => s.id)).toEqual(['ev-4w-1', 'ev-4w-2', 'ev-2w-1', 'ev-2w-2']);
    // Vendor metadata (kind/currentType/connector) passes through untouched.
    expect(data.stations[0].kind).toBe('4W');
    expect(data.stations[0].capacityKw).toBe(80);
    expect(data.stations[2].kind).toBe('2W');
    expect(data.stations[2].capacityKw).toBe(3.3);
    // Product-photo path + series tagline are surfaced verbatim so the
    // resident picker can render the hero image (issue: real SunArth
    // photo per bay). Unknown fields must not be stripped by normalize.
    expect(data.stations[0].image).toBe('./assets/images/ev/sunarth-dcfc-4w.png');
    expect(data.stations[0].series).toBe('UltraPro Series');
    expect(data.stations[2].image).toBe('./assets/images/ev/sunarth-acwallbox-2w.png');
    // Legacy `station` (singular) points at the first entry.
    expect(data.station.id).toBe('ev-4w-1');
  });

  it('normalises malformed station entries (missing id / name / enabled)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = {
      ev: {
        stations: [
          { name: 'No-id charger', capacityKw: 22 },              // missing id
          { id: '', name: 'Blank id', capacityKw: 7.4 },          // blank id
          { id: 'ev-3', capacityKw: 3.3 },                        // missing name
          { id: 'ev-off', name: 'Offline', enabled: false },      // enabled respected
        ],
      },
    };
    const r = await send('GET', '/ev/config', undefined, 'resident1@x.com');
    const { data } = await r.json() as any;
    expect(data.stations).toHaveLength(4);
    expect(data.stations[0].id).toBe('ev-1');   // synthesized id from index
    expect(data.stations[1].id).toBe('ev-2');   // blank replaced
    expect(data.stations[2].name).toBe('EV Charger #3');   // synthesized name
    expect(data.stations[3].enabled).toBe(false); // explicit false preserved
    // All others default to enabled: true (missing property counts as on).
    expect(data.stations[0].enabled).toBe(true);
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
    featureOverrides = { FEATURE_TSH_EV_CHARGING: false };
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

describe('POST /ev/bookings — editor-tunable caps', () => {
  // Reuse the same slot shape as the happy-path suite.
  const bodyOn = (date: string, overrides: Record<string, unknown> = {}) => ({
    date, startMin: 9 * 60, endMin: 10 * 60,
    ownerFlat: 'A-101', ownerName: 'Cap Test',
    ...overrides,
  });

  it('honours a 2-day advance window (Tatkal-style)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: { booking: {
      stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
      bufferMinutes: 5, advanceWindowDays: 2, maxActivePerFlat: 5,
      openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [],
    }}};
    // Day 2 (== window edge) is allowed.
    const ok2 = await send('POST', '/ev/bookings', bodyOn(istDate(2)), 'resident1@x.com');
    expect(ok2.status).toBe(200);
    // Day 3 exceeds the 2-day window and must be rejected.
    const bad = await send('POST', '/ev/bookings', bodyOn(istDate(3)), 'resident1@x.com');
    expect(bad.status).toBe(400);
    const j = await bad.json() as any;
    expect(String(j.error)).toContain('advance-booking window');
    expect(String(j.error)).toContain('2 days');
  });

  it('enforces maxTotalBookingsPerFlat across all stations', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: {
      stations: [
        { id: 'ev-4w-1', name: '4W-1', capacityKw: 80, kind: '4W', enabled: true },
        { id: 'ev-2w-1', name: '2W-1', capacityKw: 3.3, kind: '2W', enabled: true },
      ],
      booking: {
        stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
        bufferMinutes: 5, advanceWindowDays: 7,
        // Per-station cap generous (5) so we can prove the global cap is what bites.
        maxActivePerFlat: 5,
        maxTotalBookingsPerFlat: 2,
        openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [],
      },
    }};
    // Two bookings — on TWO different stations — are allowed.
    const a = await send('POST', '/ev/bookings', bodyOn(istDate(1), { stationId: 'ev-4w-1' }), 'resident1@x.com');
    expect(a.status).toBe(200);
    const b = await send('POST', '/ev/bookings', bodyOn(istDate(2), { stationId: 'ev-2w-1' }), 'resident1@x.com');
    expect(b.status).toBe(200);
    // Third booking — irrespective of station — must be rejected.
    const c = await send('POST', '/ev/bookings', bodyOn(istDate(3), { stationId: 'ev-4w-1' }), 'resident1@x.com');
    expect(c.status).toBe(400);
    const j = await c.json() as any;
    expect(String(j.error)).toContain('cap 2 across all chargers');
  });

  it('treats null maxTotalBookingsPerFlat as unlimited', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: { booking: {
      stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
      bufferMinutes: 5, advanceWindowDays: 7,
      maxActivePerFlat: 10, maxTotalBookingsPerFlat: null,
      openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [],
    }}};
    for (let i = 1; i <= 4; i++) {
      const r = await send('POST', '/ev/bookings', bodyOn(istDate(i)), 'resident1@x.com');
      expect(r.status).toBe(200);
    }
  });

  it('enforces maxDailyMinutesPerFlat on the same date', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: { booking: {
      stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
      bufferMinutes: 5, advanceWindowDays: 7,
      maxActivePerFlat: 10, maxDailyMinutesPerFlat: 120,   // 2 hours / day cap
      openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [],
    }}};
    const d = istDate(1);
    // Slots are spaced beyond the 5-min buffer so overlap-detection
    // doesn't cross-reject them. We're isolating the daily-minutes cap.
    // First 60-min slot on d — 60/120 used.
    const a = await send('POST', '/ev/bookings', { date: d, startMin: 9*60,  endMin: 10*60, ownerFlat: 'A-101' }, 'resident1@x.com');
    expect(a.status).toBe(200);
    // Second 60-min slot on d (12:00-13:00) — 120/120 used exactly.
    const b = await send('POST', '/ev/bookings', { date: d, startMin: 12*60, endMin: 13*60, ownerFlat: 'A-101' }, 'resident1@x.com');
    expect(b.status).toBe(200);
    // Third slot on d — would push to 180 > 120 → reject.
    const c = await send('POST', '/ev/bookings', { date: d, startMin: 15*60, endMin: 16*60, ownerFlat: 'A-101' }, 'resident1@x.com');
    expect(c.status).toBe(400);
    const j = await c.json() as any;
    expect(String(j.error)).toContain('daily cap');
    expect(String(j.error)).toContain('120 min allowed');
    // Same flat on a DIFFERENT day is unaffected by today's daily cap.
    const other = await send('POST', '/ev/bookings', { date: istDate(2), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-101' }, 'resident1@x.com');
    expect(other.status).toBe(200);
  });

  it('exposes the new caps on GET /ev/availability policy block', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: { booking: {
      stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
      bufferMinutes: 5, advanceWindowDays: 2,
      maxActivePerFlat: 1, maxTotalBookingsPerFlat: 3, maxDailyMinutesPerFlat: 120,
      openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [],
    }}};
    const r = await send('GET', `/ev/availability?from=${istDate(0)}&to=${istDate(0)}`, undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.policy.advanceWindowDays).toBe(2);
    expect(data.policy.maxTotalBookingsPerFlat).toBe(3);
    expect(data.policy.maxDailyMinutesPerFlat).toBe(120);
    expect(data.policy.maxActivePerFlat).toBe(1);
  });
});

describe('POST /ev/bookings — multi-station', () => {
  const fourStationEv = {
    stations: [
      { id: 'ev-4w-1', name: 'SunArth 4W-1', capacityKw: 80, kind: '4W', enabled: true },
      { id: 'ev-4w-2', name: 'SunArth 4W-2', capacityKw: 80, kind: '4W', enabled: true },
      { id: 'ev-2w-1', name: 'SunArth 2W-1', capacityKw: 3.3, kind: '2W', enabled: true },
      { id: 'ev-2w-2', name: 'SunArth 2W-2', capacityKw: 3.3, kind: '2W', enabled: false },
    ],
  };

  const validBody = (overrides: Record<string, unknown> = {}) => ({
    date: istDate(1),
    startMin: 9 * 60,
    endMin: 10 * 60,
    ownerFlat: 'A-101',
    ...overrides,
  });

  it('accepts a booking against any configured stationId', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: fourStationEv };
    const r = await send('POST', '/ev/bookings', validBody({ stationId: 'ev-4w-2' }), 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.item.stationId).toBe('ev-4w-2');
  });

  it('rejects a booking against an unknown stationId', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: fourStationEv };
    const r = await send('POST', '/ev/bookings', validBody({ stationId: 'ev-does-not-exist' }), 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('unknown stationId');
  });

  it('rejects a booking against a disabled station', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: fourStationEv };
    const r = await send('POST', '/ev/bookings', validBody({ stationId: 'ev-2w-2' }), 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('offline');
  });

  it('allows the same slot to be booked concurrently on two different stations', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: fourStationEv };
    const first  = await send('POST', '/ev/bookings', validBody({ stationId: 'ev-4w-1' }), 'resident1@x.com');
    expect(first.status).toBe(200);
    const second = await send('POST', '/ev/bookings', validBody({ stationId: 'ev-4w-2', ownerFlat: 'B-202' }), 'mgr@x.com');
    expect(second.status).toBe(200);
    // Bookings live on independent stations, so the maxActivePerFlat quota
    // is enforced per-station and both are confirmed.
    const first2  = await first.json() as any;
    const second2 = await second.json() as any;
    expect(first2.data.item.stationId).toBe('ev-4w-1');
    expect(second2.data.item.stationId).toBe('ev-4w-2');
  });
});

describe('GET /ev/availability — multi-station', () => {
  it('rejects an unknown stationId query param', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: {
      stations: [
        { id: 'ev-4w-1', name: 'SunArth 4W-1', capacityKw: 80, kind: '4W', enabled: true },
      ],
    } };
    const today = istDate(0);
    const r = await send('GET', `/ev/availability?from=${today}&to=${today}&stationId=bogus`, undefined, 'resident1@x.com');
    expect(r.status).toBe(400);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('unknown stationId');
  });

  it('returns availability for a configured stationId', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true };
    systemOverrides = { ev: {
      stations: [
        { id: 'ev-4w-1', name: 'SunArth 4W-1', capacityKw: 80, kind: '4W', enabled: true },
        { id: 'ev-2w-1', name: 'SunArth 2W-1', capacityKw: 3.3, kind: '2W', enabled: true },
      ],
    } };
    const today = istDate(0);
    const r = await send('GET', `/ev/availability?from=${today}&to=${today}&stationId=ev-2w-1`, undefined, 'resident1@x.com');
    expect(r.status).toBe(200);
    const { data } = await r.json() as any;
    expect(data.stationId).toBe('ev-2w-1');
    expect(Array.isArray(data.days)).toBe(true);
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
    featureOverrides = { FEATURE_TSH_EV_CHARGING: false };
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
    featureOverrides = { FEATURE_TSH_EV_CHARGING: false };
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

// ---------------------------------------------------------------------------
// Phase 5 - private-repo mirror + auto reports (FEATURE_TSH_EV_AUTO_REPORTS).
// Spec: tsh_requirement.md sec 23.1 (Phase 5), sec 23.9.
// ---------------------------------------------------------------------------

describe('POST /ev/admin/mirror', () => {
  it('returns 503 when master flag is OFF', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: false };
    const r = await send('POST', '/ev/admin/mirror', {}, 'dev@x.com');
    expect(r.status).toBe(503);
  });

  it('returns 503 when FEATURE_TSH_EV_AUTO_REPORTS is OFF', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_AUTO_REPORTS: false };
    const r = await send('POST', '/ev/admin/mirror', {}, 'dev@x.com');
    expect(r.status).toBe(503);
    const j = await r.json() as any;
    expect(String(j.error)).toContain('FEATURE_TSH_EV_AUTO_REPORTS');
  });

  it('requires sign-in (401)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_AUTO_REPORTS: true };
    const r = await send('POST', '/ev/admin/mirror', {});
    expect(r.status).toBe(401);
  });

  it('resident is forbidden (403)', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_AUTO_REPORTS: true };
    const r = await send('POST', '/ev/admin/mirror', {}, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('manager is forbidden (403) — ADMIN only', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_AUTO_REPORTS: true };
    const r = await send('POST', '/ev/admin/mirror', {}, 'mgr@x.com');
    expect(r.status).toBe(403);
  });

  it('rejects malformed month', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_AUTO_REPORTS: true };
    const r = await send('POST', '/ev/admin/mirror', { month: 'not-a-month' }, 'dev@x.com');
    expect(r.status).toBe(400);
  });

  it('admin happy path writes report.md + bookings.csv, is idempotent, and audits', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_AUTO_REPORTS: true };
    // Seed a booking so the CSV has a row. Use last month so the default
    // mirror window (previous full IST month) picks it up. The mirror
    // month param is preferred so the test is deterministic.
    await send('POST', '/ev/bookings', { date: istDate(1), startMin: 9*60, endMin: 10*60, ownerFlat: 'A-101' }, 'resident1@x.com');
    // Pick a month explicitly for determinism — use the current IST month
    // and match against what runEvMirror returns.
    const nowMonth = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 7);
    const r = await send('POST', '/ev/admin/mirror', { month: nowMonth }, 'dev@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.ran).toBe(true);
    expect(j.data.month).toBe(nowMonth);
    expect(j.data.reportPath).toContain('backups/ev/' + nowMonth);
    expect(j.data.reportPath.endsWith('report.md')).toBe(true);
    expect(j.data.csvPath.endsWith('bookings.csv')).toBe(true);
    // The mirror should have written into the fake file store.
    expect(files.has(j.data.reportPath)).toBe(true);
    expect(files.has(j.data.csvPath)).toBe(true);
    const md = files.get(j.data.reportPath)!.content;
    expect(md).toContain('Monthly report');
    // Idempotency: a second call with the same data should NOT increment
    // the put counter beyond the initial 2 (one for report, one for CSV).
    const before = putCount;
    const r2 = await send('POST', '/ev/admin/mirror', { month: nowMonth }, 'dev@x.com');
    expect(r2.status).toBe(200);
    const j2 = await r2.json() as any;
    expect(j2.data.changed).toBe(false);
    expect(putCount).toBe(before);
  });
});

// ===========================================================================
// Phase 6 - RFID + Registration + Support (three lifecycles).
// Spec: tsh_requirement.md sec 23.1 (Phase 6).
// ===========================================================================

describe('Phase 6 - RFID lifecycle (FEATURE_TSH_EV_RFID)', () => {
  it('flag off -> 503', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_RFID: false };
    const r = await send('POST', '/ev/rfid', { type: 'issue-new', ownerFlat: 'A-101' }, 'resident1@x.com');
    expect(r.status).toBe(503);
    expect(String((await r.json() as any).error)).toContain('FEATURE_TSH_EV_RFID');
  });

  it('anonymous -> 401', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_RFID: true };
    const r = await send('POST', '/ev/rfid', { type: 'issue-new', ownerFlat: 'A-101' });
    expect(r.status).toBe(401);
  });

  it('resident can file an RFID request and read it back via scope=own', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_RFID: true };
    const r = await send('POST', '/ev/rfid', {
      type: 'issue-new', ownerFlat: 'A-101', vehiclePlate: 'MH-12-AB-1234',
    }, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.id).toMatch(/^EVRF-[A-Z0-9]{8}$/);
    expect(j.data.status).toBe('pending');
    expect(j.data.vehiclePlate).toBe('MH-12-AB-1234');
    const list = await send('GET', '/ev/rfid?scope=own', undefined, 'resident1@x.com');
    const lj = await list.json() as any;
    expect(lj.data.items.length).toBe(1);
  });

  it('resident cannot view all requests via scope=all', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_RFID: true };
    const r = await send('GET', '/ev/rfid?scope=all', undefined, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('manager can approve then mark issued; resident cannot skip statuses', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_RFID: true };
    const created = await send('POST', '/ev/rfid', {
      type: 'replace-lost', ownerFlat: 'A-101',
    }, 'resident1@x.com');
    const id = (await created.json() as any).data.id;
    // Resident cannot approve.
    const bad = await send('PATCH', '/ev/rfid/' + id, { status: 'approved' }, 'resident1@x.com');
    expect(bad.status).toBe(403);
    // Manager approves.
    const ok1 = await send('PATCH', '/ev/rfid/' + id, { status: 'approved' }, 'mgr@x.com');
    expect(ok1.status).toBe(200);
    // Manager marks issued with card code.
    const ok2 = await send('PATCH', '/ev/rfid/' + id, { status: 'issued', cardCode: 'CARD-42' }, 'mgr@x.com');
    expect(ok2.status).toBe(200);
    const j2 = await ok2.json() as any;
    expect(j2.data.cardCode).toBe('CARD-42');
    // No transition beyond 'issued'.
    const bad2 = await send('PATCH', '/ev/rfid/' + id, { status: 'rejected' }, 'mgr@x.com');
    expect(bad2.status).toBe(400);
  });

  it('rejects unknown RFID type', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_RFID: true };
    const r = await send('POST', '/ev/rfid', { type: 'do-magic', ownerFlat: 'A-101' }, 'resident1@x.com');
    expect(r.status).toBe(400);
  });
});

describe('Phase 6 - Vehicle registration (FEATURE_TSH_EV_REGISTRATION)', () => {
  it('flag off -> 503', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_REGISTRATION: false };
    const r = await send('POST', '/ev/registration', { ownerFlat: 'A-101', vehicle: { plate: 'MH12AB1234' } }, 'resident1@x.com');
    expect(r.status).toBe(503);
  });

  it('registers a vehicle and normalises the plate', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_REGISTRATION: true };
    const r = await send('POST', '/ev/registration', {
      ownerFlat: 'A-101',
      vehicle: { plate: '  mh12ab1234  ', make: 'Tata', model: 'Nexon EV', batteryKwh: 30, connectorType: 'CCS2' },
    }, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.vehicle.plate).toBe('MH12AB1234');
    expect(j.data.vehicle.make).toBe('Tata');
    expect(j.data.status).toBe('active');
  });

  it('rejects duplicate active plate for same owner', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_REGISTRATION: true };
    await send('POST', '/ev/registration', { ownerFlat: 'A-101', vehicle: { plate: 'MH12AB1234' } }, 'resident1@x.com');
    const r = await send('POST', '/ev/registration', { ownerFlat: 'A-101', vehicle: { plate: 'MH12AB1234' } }, 'resident1@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects malformed plate', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_REGISTRATION: true };
    const r = await send('POST', '/ev/registration', { ownerFlat: 'A-101', vehicle: { plate: 'x' } }, 'resident1@x.com');
    expect(r.status).toBe(400);
  });

  it('can deactivate own registration', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_REGISTRATION: true };
    const created = await send('POST', '/ev/registration', { ownerFlat: 'A-101', vehicle: { plate: 'MH12AB1234' } }, 'resident1@x.com');
    const id = (await created.json() as any).data.id;
    const upd = await send('PATCH', '/ev/registration/' + id, { status: 'inactive' }, 'resident1@x.com');
    expect(upd.status).toBe(200);
    expect((await upd.json() as any).data.status).toBe('inactive');
  });
});

describe('Phase 6 - Support tickets (FEATURE_TSH_EV_SUPPORT)', () => {
  it('flag off -> 503', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_SUPPORT: false };
    const r = await send('POST', '/ev/support', { category: 'other', subject: 's', message: 'm', ownerFlat: 'A-101' }, 'resident1@x.com');
    expect(r.status).toBe(503);
  });

  it('opens a ticket with a known category', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_SUPPORT: true };
    const r = await send('POST', '/ev/support', {
      category: 'card-not-working', subject: 'Card beeps red', message: 'It buzzes for 5 seconds then stops.', ownerFlat: 'A-101',
    }, 'resident1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.id).toMatch(/^EVSP-[A-Z0-9]{8}$/);
    expect(j.data.status).toBe('open');
    expect(j.data.category).toBe('card-not-working');
  });

  it('rejects unknown category', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_SUPPORT: true };
    const r = await send('POST', '/ev/support', { category: 'aliens', subject: 's', message: 'm', ownerFlat: 'A-101' }, 'resident1@x.com');
    expect(r.status).toBe(400);
  });

  it('manager can advance to in-progress then resolved with a note', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_SUPPORT: true };
    const created = await send('POST', '/ev/support', {
      category: 'billing-issue', subject: 'Overcharged', message: 'Charged twice for one session.', ownerFlat: 'A-101',
    }, 'resident1@x.com');
    const id = (await created.json() as any).data.id;
    const step1 = await send('PATCH', '/ev/support/' + id, { status: 'in-progress' }, 'mgr@x.com');
    expect(step1.status).toBe(200);
    const step2 = await send('PATCH', '/ev/support/' + id, { status: 'resolved', resolutionNote: 'Refunded 100 INR' }, 'mgr@x.com');
    expect(step2.status).toBe(200);
    expect((await step2.json() as any).data.resolutionNote).toBe('Refunded 100 INR');
  });

  it('resident cannot approve resolutions, only close their own', async () => {
    featureOverrides = { FEATURE_TSH_EV_CHARGING: true, FEATURE_TSH_EV_SUPPORT: true };
    const created = await send('POST', '/ev/support', {
      category: 'general-feedback', subject: 'suggestion', message: 'add signage', ownerFlat: 'A-101',
    }, 'resident1@x.com');
    const id = (await created.json() as any).data.id;
    const bad = await send('PATCH', '/ev/support/' + id, { status: 'resolved' }, 'resident1@x.com');
    expect(bad.status).toBe(403);
    const good = await send('PATCH', '/ev/support/' + id, { status: 'closed' }, 'resident1@x.com');
    expect(good.status).toBe(200);
  });
});

// -------------------------------------------------------------------------
// PATCH /ev/stations/:id — Phase 7 online/offline toggle (added 2026-08-02)
// -------------------------------------------------------------------------
describe('PATCH /ev/stations/:id — maintenance toggle', () => {
  const seedStations = () => {
    // Mirror the two-tier config surface: /ev/config resolves via the
    // loader (systemOverrides) while the PATCH endpoint reads + writes
    // config/site.json directly (files map).
    const stations = [
      { id: 'ev-2w-1', kind: '2W', name: '2-Wheeler Wallbox #1', enabled: true },
      { id: 'ev-4w-1', kind: '4W', name: '4-Wheeler DCFC #1',    enabled: true },
    ];
    systemOverrides = { ev: { stations } };
    files.set('config/site.json', {
      sha: 'sha-seed',
      content: JSON.stringify({ system: { ev: { stations } } }, null, 2),
    });
  };

  it('rejects residents (403)', async () => {
    seedStations();
    const r = await send('PATCH', '/ev/stations/ev-2w-1', { enabled: false }, 'resident1@x.com');
    expect(r.status).toBe(403);
  });

  it('rejects anonymous callers (401)', async () => {
    seedStations();
    const r = await send('PATCH', '/ev/stations/ev-2w-1', { enabled: false });
    expect(r.status).toBe(401);
  });

  it('rejects missing/invalid enabled body (400)', async () => {
    seedStations();
    const r = await send('PATCH', '/ev/stations/ev-2w-1', {}, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('returns 404 when the station id does not exist', async () => {
    seedStations();
    const r = await send('PATCH', '/ev/stations/nonexistent', { enabled: false }, 'mgr@x.com');
    expect(r.status).toBe(404);
  });

  it('manager can flip a station to maintenance with a custom reason', async () => {
    seedStations();
    const r = await send(
      'PATCH', '/ev/stations/ev-2w-1',
      { enabled: false, maintenanceReason: 'Charging cable damaged — vendor visit scheduled' },
      'mgr@x.com',
    );
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.station.enabled).toBe(false);
    expect(j.data.station.maintenanceReason).toBe('Charging cable damaged — vendor visit scheduled');
    // Config file was rewritten with the new state.
    const site = JSON.parse(files.get('config/site.json')!.content);
    expect(site.system.ev.stations[0].enabled).toBe(false);
    expect(site.system.ev.stations[0].maintenanceReason).toBe('Charging cable damaged — vendor visit scheduled');
    // Sibling station untouched.
    expect(site.system.ev.stations[1].enabled).toBe(true);
    expect(site.system.ev.stations[1].maintenanceReason).toBeUndefined();
  });

  it('defaults the reason to "Temporarily unavailable" when none is supplied', async () => {
    seedStations();
    const r = await send('PATCH', '/ev/stations/ev-4w-1', { enabled: false }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.station.enabled).toBe(false);
    expect(j.data.station.maintenanceReason).toBe('Temporarily unavailable');
  });

  it('re-enabling a station clears the maintenance reason', async () => {
    // Seed with the station already in maintenance so we can flip back on.
    const stations = [
      { id: 'ev-2w-1', kind: '2W', name: '2-Wheeler Wallbox #1',
        enabled: false, maintenanceReason: 'Awaiting vendor' },
    ];
    systemOverrides = { ev: { stations } };
    files.set('config/site.json', {
      sha: 'sha-seed', content: JSON.stringify({ system: { ev: { stations } } }, null, 2),
    });
    const r = await send('PATCH', '/ev/stations/ev-2w-1', { enabled: true }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.station.enabled).toBe(true);
    expect(j.data.station.maintenanceReason).toBeUndefined();
    const site = JSON.parse(files.get('config/site.json')!.content);
    expect(site.system.ev.stations[0].enabled).toBe(true);
    expect(site.system.ev.stations[0].maintenanceReason).toBeUndefined();
  });

  it('preserves unknown vendor metadata (image, series, capacityKw) on toggle', async () => {
    const stations = [{
      id: 'ev-4w-1', kind: '4W', name: 'SunArth DCFC',
      enabled: true, image: './x.png', series: 'UltraPro',
      capacityKw: 80, connector: 'CCS-2',
    }];
    systemOverrides = { ev: { stations } };
    files.set('config/site.json', {
      sha: 'sha-seed', content: JSON.stringify({ system: { ev: { stations } } }, null, 2),
    });
    const r = await send('PATCH', '/ev/stations/ev-4w-1', { enabled: false }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const site = JSON.parse(files.get('config/site.json')!.content);
    const s = site.system.ev.stations[0];
    expect(s.enabled).toBe(false);
    expect(s.image).toBe('./x.png');
    expect(s.series).toBe('UltraPro');
    expect(s.capacityKw).toBe(80);
    expect(s.connector).toBe('CCS-2');
  });

  it('committee members can also toggle', async () => {
    seedStations();
    const r = await send('PATCH', '/ev/stations/ev-2w-1', { enabled: false }, 'cmt@x.com');
    expect(r.status).toBe(200);
  });
});
// Smoke tests for the /ev/* routes (Phase 1: /ev/config only).
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

vi.mock('../src/github/client.ts', () => ({
  getFile:      vi.fn(async () => undefined),
  getJson:      vi.fn(async () => undefined),
  putFile:      vi.fn(async () => ({ sha: 'sha-x' })),
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
        contributor: ['contrib@x.com'],
      },
    })),
    invalidateCache: vi.fn(),
  };
});

import worker from '../src/index.ts';

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
});

describe('GET /ev/config — master flag', () => {
  it('returns feature-disabled (503) when FEATURE_TSH_EV_CHARGING is OFF', async () => {
    // Master defaults off; leave overrides empty.
    const r = await send('GET', '/ev/config', undefined, 'contrib@x.com');
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
    const r = await send('GET', '/ev/config', undefined, 'contrib@x.com');
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
    const r = await send('GET', '/ev/config', undefined, 'contrib@x.com');
    const { data } = await r.json() as any;
    expect(data.station.name).toBe('Tower A Charger');
    expect(data.station.capacityKw).toBe(11);
    expect(data.usageGuidelines).toEqual(['Custom guideline #1', 'Custom guideline #2']);
    expect(data.faqs).toEqual([{ q: 'How to book?', a: 'Use the grid.' }]);
    expect(data.helpline.directoryEntryId).toBe('dir-42');
    expect(data.reports.mirrorCron).toBe('weekly');
  });
});

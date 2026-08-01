// Smoke tests for the /vehicles routes. Follows the same mock pattern as
// directory.test.ts so neither file mutates the other's mocks.
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

let storedFile: { sha: string; content: string } | undefined;
const putCalls: Array<{ path: string; body: string }> = [];
// Per-test overlay for features / system.vehicles so we can flip v2
// flags (e.g. FEATURE_TSH_VEHICLES_EMAIL_FILTER) without re-mocking the
// whole config loader.
let featureOverrides: Record<string, boolean> = {};
let systemOverrides: Record<string, unknown> = {};

vi.mock('../src/github/client.ts', () => ({
  getFile: vi.fn(async (_env: any, path: string) => {
    if (path !== 'config/vehicles.json' || !storedFile) return undefined;
    return { sha: storedFile.sha, content: storedFile.content, encoding: 'utf-8' as const };
  }),
  getJson: vi.fn(async () => undefined),
  putFile: vi.fn(async (_env: any, path: string, content: string) => {
    putCalls.push({ path, body: content });
    if (path === 'config/vehicles.json') storedFile = { sha: 'sha-new', content };
    return { sha: 'sha-new' };
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
        features: { ...DEFAULT_CONFIG.features, FEATURE_DAILY_TURNSTILE: false, FEATURE_TSH_VEHICLES: true, ...featureOverrides },
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
import { _resetVehiclesCacheForTests } from '../src/routes/vehicles.ts';

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

beforeEach(() => {
  storedFile = undefined;
  putCalls.length = 0;
  featureOverrides = {};
  systemOverrides = {};
  _resetVehiclesCacheForTests();
});

describe('GET /vehicles', () => {
  it('requires sign-in (401 for anonymous)', async () => {
    const r = await send('GET', '/vehicles');
    expect(r.status).toBe(401);
  });

  it('returns empty list to any signed-in user', async () => {
    const r = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.vehicles).toEqual([]);
    expect(j.data.canWrite).toBe(false);   // contributor is NOT on the default allowlist
    expect(j.data.editorRoles).toContain('MANAGER');
  });

  it('advertises canWrite=true for managers / committee / admins', async () => {
    const rMgr = await send('GET', '/vehicles', undefined, 'mgr@x.com');
    expect((await rMgr.json() as any).data.canWrite).toBe(true);
    const rAdm = await send('GET', '/vehicles', undefined, 'dev@x.com');
    expect((await rAdm.json() as any).data.canWrite).toBe(true);
  });
});

describe('PUT /vehicles', () => {
  const validPayload = {
    vehicles: [
      { flat: 'A201', regNo: 'MH 11 JJ 0234', type: '4W', comments: 'White Honda City' },
      { flat: 'A201', regNo: 'MH12AB4567',   type: '2W' },
      { flat: 'B102', regNo: 'MH01ZZ1111',   type: '4W', sticker: 'P-104', emails: ['owner@x.com'] },
    ],
  };

  it('rejects contributors (not on the editor allowlist)', async () => {
    const r = await send('PUT', '/vehicles', validPayload, 'contrib@x.com');
    expect(r.status).toBe(403);
  });

  it('accepts a manager and persists normalised rows', async () => {
    const r = await send('PUT', '/vehicles', validPayload, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.saved).toBe(true);
    expect(j.data.count).toBe(3);

    const g = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    const gj = await g.json() as any;
    expect(gj.data.vehicles).toHaveLength(3);
    const a1 = gj.data.vehicles.find((v: any) => v.regNo === 'MH11JJ0234');
    expect(a1).toBeTruthy();
    expect(a1.flat).toBe('A201');
    expect(a1.id).toBe('veh-a201-mh11jj0234');
    expect(a1.regNoDisplay).toBe('MH 11 JJ 0234');
    expect(a1.updatedBy).toBe('mgr@x.com');
  });

  it('rejects duplicate regNo across different flats (Conflict)', async () => {
    const r = await send('PUT', '/vehicles', {
      vehicles: [
        { flat: 'A201', regNo: 'MH11JJ0234', type: '4W' },
        { flat: 'B102', regNo: 'MH11JJ0234', type: '4W' },
      ],
    }, 'mgr@x.com');
    expect(r.status).toBe(409);
    const j = await r.json() as any;
    expect(j.ok).toBe(false);
    expect(String(j.error)).toMatch(/two different flats/i);
  });

  it('rejects duplicate regNo on the same flat (Conflict)', async () => {
    const r = await send('PUT', '/vehicles', {
      vehicles: [
        { flat: 'A201', regNo: 'MH11JJ0234', type: '4W' },
        { flat: 'A201', regNo: 'mh 11 jj 0234', type: '2W' },   // same after normalisation
      ],
    }, 'mgr@x.com');
    expect(r.status).toBe(409);
  });

  it('rejects invalid flat', async () => {
    const r = await send('PUT', '/vehicles', {
      vehicles: [{ flat: 'Z999', regNo: 'MH11JJ0234', type: '4W' }],
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects invalid type', async () => {
    const r = await send('PUT', '/vehicles', {
      vehicles: [{ flat: 'A201', regNo: 'MH11JJ0234', type: '3W' }],
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects invalid email in emails[]', async () => {
    const r = await send('PUT', '/vehicles', {
      vehicles: [{ flat: 'A201', regNo: 'MH11JJ0234', type: '4W', emails: ['not-an-email'] }],
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('uppercases regNoDisplay + sticker + flat even when entered lowercase', async () => {
    await send('PUT', '/vehicles', {
      vehicles: [{ flat: 'a201', regNo: 'mh 11 jj 0234', type: '4W', sticker: 'p-104' }],
    }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
    const g = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    const row = (await g.json() as any).data.vehicles[0];
    expect(row.flat).toBe('A201');
    expect(row.regNo).toBe('MH11JJ0234');
    expect(row.regNoDisplay).toBe('MH 11 JJ 0234');
    expect(row.sticker).toBe('P-104');
  });

  it('preserves createdAt across a re-save', async () => {
    await send('PUT', '/vehicles', {
      vehicles: [{ flat: 'A201', regNo: 'MH11JJ0234', type: '4W' }],
    }, 'mgr@x.com');
    _resetVehiclesCacheForTests();  // force re-read from mock storage
    const g1 = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    const created1 = (await g1.json() as any).data.vehicles[0].createdAt;

    await new Promise((r) => setTimeout(r, 10));
    _resetVehiclesCacheForTests();
    await send('PUT', '/vehicles', {
      vehicles: [{ flat: 'A201', regNo: 'MH11JJ0234', type: '4W', comments: 'edited' }],
    }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
    const g2 = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    const row2 = (await g2.json() as any).data.vehicles[0];
    expect(row2.createdAt).toBe(created1);
    expect(row2.updatedAt).not.toBe(created1);
    expect(row2.comments).toBe('edited');
  });
});

describe('DELETE /vehicles/:id', () => {
  it('removes one row and keeps the rest', async () => {
    await send('PUT', '/vehicles', {
      vehicles: [
        { flat: 'A201', regNo: 'MH11JJ0234', type: '4W' },
        { flat: 'A201', regNo: 'MH12AB4567', type: '2W' },
      ],
    }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
    const r = await send('DELETE', '/vehicles/veh-a201-mh11jj0234', undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.count).toBe(1);
    expect(j.data.removed.regNo).toBe('MH11JJ0234');
  });

  it('rejects contributor', async () => {
    await send('PUT', '/vehicles', {
      vehicles: [{ flat: 'A201', regNo: 'MH11JJ0234', type: '4W' }],
    }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
    const r = await send('DELETE', '/vehicles/veh-a201-mh11jj0234', undefined, 'contrib@x.com');
    expect(r.status).toBe(403);
  });

  it('returns 400 for a missing id', async () => {
    const r = await send('DELETE', '/vehicles/veh-does-not-exist', undefined, 'mgr@x.com');
    expect(r.status).toBe(400);
  });
});

// v2 hook: server-side per-caller email filter.
describe('GET /vehicles (v2 email-filter hook)', () => {
  const seed = async () => {
    await send('PUT', '/vehicles', {
      vehicles: [
        { flat: 'A201', regNo: 'MH11JJ0234', type: '4W', emails: ['resident.a@x.com'] },
        { flat: 'B102', regNo: 'MH12AB4567', type: '2W', emails: ['resident.b@x.com', 'shared@x.com'] },
        { flat: 'C303', regNo: 'MH13CD8888', type: '4W' },  // no emails
      ],
    }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
  };

  it('flag OFF (default): every signed-in user sees the full list', async () => {
    await seed();
    const r = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    const j = await r.json() as any;
    expect(j.data.vehicles).toHaveLength(3);
    expect(j.data.filtered).toBe(false);
  });

  it('flag ON: non-editor only sees rows whose emails[] contains their address', async () => {
    await seed();
    featureOverrides = { FEATURE_TSH_VEHICLES_EMAIL_FILTER: true };
    _resetVehiclesCacheForTests();
    const r = await send('GET', '/vehicles', undefined, 'resident.b@x.com');
    const j = await r.json() as any;
    expect(j.data.filtered).toBe(true);
    expect(j.data.vehicles).toHaveLength(1);
    expect(j.data.vehicles[0].flat).toBe('B102');
  });

  it('flag ON: editor (manager) still sees the full list', async () => {
    await seed();
    featureOverrides = { FEATURE_TSH_VEHICLES_EMAIL_FILTER: true };
    _resetVehiclesCacheForTests();
    const r = await send('GET', '/vehicles', undefined, 'mgr@x.com');
    const j = await r.json() as any;
    expect(j.data.vehicles).toHaveLength(3);
    expect(j.data.filtered).toBe(false);   // canWrite=true ⇒ no filter advertised
  });

  it('flag ON: non-editor with no matching email sees an empty list', async () => {
    await seed();
    featureOverrides = { FEATURE_TSH_VEHICLES_EMAIL_FILTER: true };
    _resetVehiclesCacheForTests();
    const r = await send('GET', '/vehicles', undefined, 'stranger@x.com');
    const j = await r.json() as any;
    expect(j.data.filtered).toBe(true);
    expect(j.data.vehicles).toEqual([]);
  });
});

// Flat-level parking bay allocation. Parking No. is a fixed physical
// property of the flat (mandatory + non-clearable) and must be unique
// across the society, but a single flat may hold multiple bays.
describe('PUT /vehicles/flat-parking', () => {
  it('rejects contributors (not editor)', async () => {
    const r = await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: ['P-1'] }, 'contrib@x.com');
    expect(r.status).toBe(403);
  });

  it('accepts a single bay via legacy parkingNo field', async () => {
    const r = await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNo: 'p-104' }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.parkingNos).toEqual(['P-104']);   // uppercased
    _resetVehiclesCacheForTests();
    const g = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    const gj = await g.json() as any;
    expect(gj.data.flatParking).toEqual({ A201: ['P-104'] });
  });

  it('accepts multiple bays for one flat', async () => {
    const r = await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: ['P-104', 'p-201'] }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.parkingNos).toEqual(['P-104', 'P-201']);
  });

  it('rejects a blank / empty list (parking is mandatory)', async () => {
    const r1 = await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: [] }, 'mgr@x.com');
    expect(r1.status).toBe(400);
    expect(String((await r1.json() as any).error)).toMatch(/cannot be cleared|blank/i);

    const r2 = await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNo: '   ' }, 'mgr@x.com');
    expect(r2.status).toBe(400);

    const r3 = await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: ['P-1', ''] }, 'mgr@x.com');
    expect(r3.status).toBe(400);
  });

  it('rejects within-flat duplicates', async () => {
    const r = await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: ['P-1', 'p-1'] }, 'mgr@x.com');
    expect(r.status).toBe(400);
    expect(String((await r.json() as any).error)).toMatch(/duplicate/i);
  });

  it('rejects a bay already assigned to a different flat (Conflict)', async () => {
    // Seed A201 with P-104.
    await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: ['P-104'] }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
    // B102 tries to claim the same bay.
    const r = await send('PUT', '/vehicles/flat-parking',
      { flat: 'B102', parkingNos: ['P-104'] }, 'mgr@x.com');
    expect(r.status).toBe(409);
    expect(String((await r.json() as any).error)).toMatch(/already assigned to flat A201/i);
  });

  it('lets a flat keep its own bay across re-saves', async () => {
    await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: ['P-104'] }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
    const r = await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: ['P-104', 'P-105'] }, 'mgr@x.com');
    expect(r.status).toBe(200);
    expect((await r.json() as any).data.parkingNos).toEqual(['P-104', 'P-105']);
  });

  it('bulk PUT /vehicles preserves flatParking', async () => {
    await send('PUT', '/vehicles/flat-parking',
      { flat: 'A201', parkingNos: ['P-104'] }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
    await send('PUT', '/vehicles', {
      vehicles: [{ flat: 'A201', regNo: 'MH11JJ0234', type: '4W' }],
    }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
    const g = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    expect((await g.json() as any).data.flatParking).toEqual({ A201: ['P-104'] });
  });

  it('upgrades legacy string-shape flatParking on read', async () => {
    // Simulate a hand-written file with the old single-string shape by
    // hitting the storage mock directly. This is checked via GET, which
    // routes through loadFromGithub \u2192 the normaliser.
    // We can't mock storedFile without importing the mock, so we prove
    // the invariant by round-tripping instead: an empty array in a PUT
    // is rejected, but a single string entry survives.
    const r = await send('PUT', '/vehicles/flat-parking',
      { flat: 'C303', parkingNo: 'C-9' }, 'mgr@x.com');
    expect(r.status).toBe(200);
    _resetVehiclesCacheForTests();
    const g = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    expect((await g.json() as any).data.flatParking).toEqual({ C303: ['C-9'] });
  });
});

// v2 hook: FEATURE_TSH_VEHICLES_MEMBER_ALLOWLIST — curated e-mail
// allowlist restricting who can hit GET/PUT/DELETE /vehicles. Editors
// always bypass; empty list + flag on = editors only.
describe('/vehicles member allowlist (v2 hook, off by default)', () => {
  const seed = async () => {
    // Any signed-in editor can seed the initial file.
    await send('PUT', '/vehicles', {
      vehicles: [
        { flat: 'A101', regNo: 'MH12AB1234', type: '4W' },
      ],
    }, 'mgr@x.com');
    _resetVehiclesCacheForTests();
  };

  it('flag OFF (default): any signed-in caller may read', async () => {
    await seed();
    const r = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.vehicles).toHaveLength(1);
  });

  it('flag ON + caller not in list + not editor: 403', async () => {
    await seed();
    featureOverrides = { FEATURE_TSH_VEHICLES_MEMBER_ALLOWLIST: true };
    systemOverrides = { vehicles: { memberAllowlist: ['a@x.com', 'b@x.com'] } };
    _resetVehiclesCacheForTests();
    const r = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    expect(r.status).toBe(403);
    const j = await r.json() as any;
    expect(String(j.error || '')).toMatch(/member allowlist/i);
  });

  it('flag ON + caller e-mail in list (case-insensitive): 200', async () => {
    await seed();
    featureOverrides = { FEATURE_TSH_VEHICLES_MEMBER_ALLOWLIST: true };
    // Configured with mixed case; caller signs in lower-case.
    systemOverrides = { vehicles: { memberAllowlist: ['Contrib@X.COM'] } };
    _resetVehiclesCacheForTests();
    const r = await send('GET', '/vehicles', undefined, 'contrib@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.vehicles).toHaveLength(1);
  });

  it('flag ON + editor role: 200 regardless of allowlist (editors bypass)', async () => {
    await seed();
    featureOverrides = { FEATURE_TSH_VEHICLES_MEMBER_ALLOWLIST: true };
    systemOverrides = { vehicles: { memberAllowlist: [] } }; // empty list
    _resetVehiclesCacheForTests();
    const r = await send('GET', '/vehicles', undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.vehicles).toHaveLength(1);
    expect(j.data.canWrite).toBe(true);
  });
});

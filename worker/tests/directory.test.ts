// Smoke tests for the new /directory endpoints. Reuses the GitHub +
// JWT mocks pattern from routes.smoke.test.ts (kept independent so
// neither file mutates the other's mocks).
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

vi.mock('../src/github/client.ts', () => ({
  getFile: vi.fn(async (_env: any, path: string) => {
    if (path !== 'config/directory.json' || !storedFile) return undefined;
    return { sha: storedFile.sha, content: storedFile.content, encoding: 'utf-8' as const };
  }),
  getJson: vi.fn(async () => undefined),
  putFile: vi.fn(async (_env: any, path: string, content: string) => {
    putCalls.push({ path, body: content });
    if (path === 'config/directory.json') storedFile = { sha: 'sha-new', content };
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
      config: { ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features, FEATURE_DAILY_TURNSTILE: false } },
      access: {
        managers:    ['mgr@x.com'],
        committee:   ['cmt@x.com'],
        admins:      ['dev@x.com'],
        treasurer:   [],
        chairman:    [],
        secretary:   [],
        contributor: [],
      },
    })),
    invalidateCache: vi.fn(),
  };
});

import worker from '../src/index.ts';
import { _resetDirectoryCacheForTests } from '../src/routes/directory.ts';

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
  if (identity) headers['X-Test-Identity'] = identity;
  if (identity) headers['Authorization'] = `Bearer fake-jwt-for-${identity}`;
  return worker.fetch(
    new Request(`https://w.x${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }),
    env as any,
  );
};

beforeEach(() => {
  storedFile = undefined;
  putCalls.length = 0;
  _resetDirectoryCacheForTests();
});

describe('GET /directory', () => {
  it('returns empty defaults when no directory file exists', async () => {
    const r = await send('GET', '/directory');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.vendors).toEqual([]);
    expect(j.data.contacts).toEqual([]);
    expect(j.data.resources).toEqual([]);
    expect(j.data.vendorCategories).toEqual([]);
  });

  it('returns stored directory after a save', async () => {
    storedFile = {
      sha: 'sha-1',
      content: JSON.stringify({
        version: 1,
        vendorCategories: ['Electrician'],
        vendors: [{ id: 'vnd-1', name: 'Alpha Elec', category: 'Electrician', phone: '9999999999', createdAt: 'x', updatedAt: 'x' }],
        contacts: [], resources: [],
      }),
    };
    const r = await send('GET', '/directory');
    const j = await r.json() as any;
    expect(j.data.vendors).toHaveLength(1);
    expect(j.data.vendors[0].name).toBe('Alpha Elec');
  });
});

describe('PUT /directory — RBAC', () => {
  const body = { directory: { version: 1, vendorCategories: ['Plumber'], vendors: [{ name: 'Beta Plumbing', phone: '8888888888' }], contacts: [], resources: [] } };

  it('rejects anonymous', async () => {
    const r = await send('PUT', '/directory', body);
    expect(r.status).toBe(401);
  });

  it('rejects unknown identity (PUBLIC role)', async () => {
    const r = await send('PUT', '/directory', body, 'stranger@x.com');
    expect(r.status).toBe(403);
  });

  it('accepts manager', async () => {
    const r = await send('PUT', '/directory', body, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.saved).toBe(true);
    expect(j.data.counts.vendors).toBe(1);
    expect(j.data.counts.vendorCategories).toBe(1);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.path).toBe('config/directory.json');
  });

  it('accepts committee', async () => {
    const r = await send('PUT', '/directory', body, 'cmt@x.com');
    expect(r.status).toBe(200);
  });

  it('accepts admin', async () => {
    const r = await send('PUT', '/directory', body, 'dev@x.com');
    expect(r.status).toBe(200);
  });
});

describe('PUT /directory — validation', () => {
  it('assigns ids and timestamps to new vendor entries', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1,
        vendorCategories: [],
        vendors:   [{ name: 'Test vendor' }],
        contacts:  [{ name: 'Test contact', role: 'Security' }],
        resources: [{ title: 'Bye-laws', url: 'https://example.org/bylaws.pdf' }],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    expect(putCalls).toHaveLength(1);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.vendors[0].id).toMatch(/^vnd-[0-9a-f]{16}$/);
    expect(saved.contacts[0].id).toMatch(/^ctc-[0-9a-f]{16}$/);
    expect(saved.resources[0].id).toMatch(/^res-[0-9a-f]{16}$/);
    expect(saved.vendors[0].createdAt).toMatch(/T/);
    expect(saved.vendors[0].updatedAt).toMatch(/T/);
  });

  it('rejects vendor without a name', async () => {
    const r = await send('PUT', '/directory', {
      directory: { version: 1, vendorCategories: [], vendors: [{ phone: '9999999999' }], contacts: [], resources: [] },
    }, 'dev@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects oversized field', async () => {
    const r = await send('PUT', '/directory', {
      directory: { version: 1, vendorCategories: [], vendors: [{ name: 'x'.repeat(200) }], contacts: [], resources: [] },
    }, 'dev@x.com');
    expect(r.status).toBe(400);
  });

  it('deduplicates vendor categories case-insensitively', async () => {
    const r = await send('PUT', '/directory', {
      directory: { version: 1, vendorCategories: ['Plumber', 'plumber', 'Electrician'], vendors: [], contacts: [], resources: [] },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.vendorCategories).toEqual(['Plumber', 'Electrician']);
  });
});

describe('PUT /directory — multi-phone schema', () => {
  it('accepts a phones array and mirrors first into legacy phone field', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], vendors: [],
        contacts: [{ name: 'Front gate', phones: ['9111111111', '9222222222'] }],
        resources: [],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.contacts[0].phones).toEqual(['9111111111', '9222222222']);
    expect(saved.contacts[0].phone).toBe('9111111111');
  });

  it('migrates a legacy single phone into a phones array', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], vendors: [],
        contacts: [{ name: 'Manager', phone: '9333333333' }],
        resources: [],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.contacts[0].phones).toEqual(['9333333333']);
    expect(saved.contacts[0].phone).toBe('9333333333');
  });

  it('rejects more than 5 phones', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], vendors: [],
        contacts: [{ name: 'Bot', phones: ['1','2','3','4','5','6'] }],
        resources: [],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects a phones entry over 30 chars', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], vendors: [],
        contacts: [{ name: 'Bot', phones: ['9'.repeat(31)] }],
        resources: [],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(400);
  });

  it('dedupes identical phone entries within one record', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], vendors: [],
        contacts: [{ name: 'Twin', phones: ['9111111111', '9111111111', '9222222222'] }],
        resources: [],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.contacts[0].phones).toEqual(['9111111111', '9222222222']);
  });
});


describe('PUT /directory � services', () => {
  it('round-trips a service entry with all fields and stamps an svc- id', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], serviceCategories: ['Cook', 'House Help'],
        vendors: [], contacts: [], resources: [],
        services: [{
          name: 'Sunita',
          category: 'House Help',
          phones: ['9000011111'],
          priceRange: '?2,500 / month',
          comment: 'Comes from 9-11 daily. Speaks Hindi + English.',
        }],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.counts.services).toBe(1);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.services[0].id).toMatch(/^svc-[0-9a-f]{16}$/);
    expect(saved.services[0].name).toBe('Sunita');
    expect(saved.services[0].category).toBe('House Help');
    expect(saved.services[0].phones).toEqual(['9000011111']);
    expect(saved.services[0].priceRange).toBe('?2,500 / month');
    expect(saved.services[0].comment).toContain('Hindi');
    expect(saved.services[0].verified).toBeUndefined();
  });

  it('stamps verifiedBy/verifiedAt when verified=true and no prior verifier', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], serviceCategories: ['Cook'],
        vendors: [], contacts: [], resources: [],
        services: [{ name: 'Rakesh', category: 'Cook', verified: true }],
      },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.services[0].verified).toBe(true);
    expect(saved.services[0].verifiedBy).toBe('mgr@x.com');
    expect(saved.services[0].verifiedAt).toMatch(/T/);
  });

  it('preserves original verifier when verified=true is re-saved', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], serviceCategories: ['Cook'],
        vendors: [], contacts: [], resources: [],
        services: [{
          name: 'Anita', category: 'Cook',
          verified: true,
          verifiedBy: 'original-manager@x.com',
          verifiedAt: '2026-06-10T08:00:00.000Z',
        }],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.services[0].verifiedBy).toBe('original-manager@x.com');
    expect(saved.services[0].verifiedAt).toBe('2026-06-10T08:00:00.000Z');
  });

  it('drops verifiedBy/At when verified=false', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], serviceCategories: ['Cook'],
        vendors: [], contacts: [], resources: [],
        services: [{
          name: 'Unverified', verified: false,
          verifiedBy: 'mgr@x.com', verifiedAt: '2026-06-10T08:00:00.000Z',
        }],
      },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.services[0].verified).toBe(false);
    expect(saved.services[0].verifiedBy).toBeUndefined();
    expect(saved.services[0].verifiedAt).toBeUndefined();
  });

  it('dedupes serviceCategories case-insensitively', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [],
        serviceCategories: ['Cook', 'cook', 'House Help', 'COOK'],
        vendors: [], contacts: [], resources: [], services: [],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.serviceCategories).toEqual(['Cook', 'House Help']);
  });

  it('rejects services missing a name', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], serviceCategories: [],
        vendors: [], contacts: [], resources: [],
        services: [{ category: 'Cook', phones: ['9000000000'] }],
      },
    }, 'dev@x.com');
    expect(r.status).toBe(400);
  });
});


describe('PUT /directory pinToHome', () => {
  it('persists pinToHome=true on emergency contacts and echoes it back on GET', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], serviceCategories: [],
        vendors: [], contacts: [], resources: [], services: [],
        emergency: [{
          name: 'Amol Kharwadkar',
          role: 'Society Manager',
          phones: ['9272330487'],
          notes: 'On Society Payroll',
          pinToHome: true,
        }],
      },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    _resetDirectoryCacheForTests();
    const g = await send('GET', '/directory');
    const gj = await g.json() as any;
    expect(gj.data.emergency).toHaveLength(1);
    expect(gj.data.emergency[0].pinToHome).toBe(true);
    expect(gj.data.emergency[0].role).toBe('Society Manager');
  });

  it('omits pinToHome when the field is missing or false', async () => {
    const r = await send('PUT', '/directory', {
      directory: {
        version: 1, vendorCategories: [], serviceCategories: [],
        vendors: [], contacts: [], resources: [], services: [],
        emergency: [
          { name: 'Security Desk', role: 'Security', phones: ['9000000000'], pinToHome: false },
          { name: 'Backup Guard', role: 'Security', phones: ['9000000001'] },
        ],
      },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    _resetDirectoryCacheForTests();
    const g = await send('GET', '/directory');
    const gj = await g.json() as any;
    expect(gj.data.emergency[0].pinToHome).toBeUndefined();
    expect(gj.data.emergency[1].pinToHome).toBeUndefined();
  });
});

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
        managers:   ['mgr@x.com'],
        committee:  ['cmt@x.com'],
        developers: ['dev@x.com'],
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

  it('accepts developer', async () => {
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

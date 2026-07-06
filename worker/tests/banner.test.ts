// Smoke tests for /banner endpoints. Same mocking pattern as
// directory.test.ts.
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
    if (path !== 'config/banner.json' || !storedFile) return undefined;
    return { sha: storedFile.sha, content: storedFile.content, encoding: 'utf-8' as const };
  }),
  getJson: vi.fn(async () => undefined),
  putFile: vi.fn(async (_env: any, path: string, content: string) => {
    putCalls.push({ path, body: content });
    if (path === 'config/banner.json') storedFile = { sha: 'sha-new', content };
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
        admins: ['dev@x.com'],
      },
    })),
    invalidateCache: vi.fn(),
  };
});

import worker from '../src/index.ts';
import { _resetBannerCacheForTests } from '../src/routes/banner.ts';

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
  _resetBannerCacheForTests();
});

describe('GET /banner', () => {
  it('returns empty when no banner file exists', async () => {
    const r = await send('GET', '/banner');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.items).toEqual([]);
  });
});

describe('PUT /banner — RBAC', () => {
  const body = { banner: { version: 1, items: [{ text: 'Maintenance shutdown 9-11 AM' }] } };

  it('rejects anonymous', async () => {
    const r = await send('PUT', '/banner', body);
    expect(r.status).toBe(401);
  });

  it('rejects unknown identity', async () => {
    const r = await send('PUT', '/banner', body, 'stranger@x.com');
    expect(r.status).toBe(403);
  });

  it('accepts manager', async () => {
    const r = await send('PUT', '/banner', body, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.saved).toBe(true);
    expect(j.data.count).toBe(1);
  });

  it('accepts committee', async () => {
    const r = await send('PUT', '/banner', body, 'cmt@x.com');
    expect(r.status).toBe(200);
  });

  it('accepts admin', async () => {
    const r = await send('PUT', '/banner', body, 'dev@x.com');
    expect(r.status).toBe(200);
  });
});

describe('PUT /banner — validation', () => {
  it('assigns id, createdAt, createdBy and defaults severity to info', async () => {
    const r = await send('PUT', '/banner', {
      banner: { version: 1, items: [{ text: 'Hello' }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.items[0].id).toMatch(/^bnr-[0-9a-f]{16}$/);
    expect(saved.items[0].createdBy).toBe('mgr@x.com');
    expect(saved.items[0].severity).toBe('info');
    expect(saved.items[0].createdAt).toMatch(/T/);
  });

  it('accepts warn/alert severity verbatim', async () => {
    const r = await send('PUT', '/banner', {
      banner: { version: 1, items: [{ text: 'Power cut', severity: 'alert' }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.items[0].severity).toBe('alert');
  });

  it('coerces unknown severity to info', async () => {
    const r = await send('PUT', '/banner', {
      banner: { version: 1, items: [{ text: 'X', severity: 'rainbow' }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.items[0].severity).toBe('info');
  });

  it('rejects expiresAt that is not a valid date', async () => {
    const r = await send('PUT', '/banner', {
      banner: { version: 1, items: [{ text: 'X', expiresAt: 'next-tuesday-ish' }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects more than 20 items', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ text: `Item ${i}` }));
    const r = await send('PUT', '/banner', { banner: { version: 1, items } }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects empty text', async () => {
    const r = await send('PUT', '/banner', {
      banner: { version: 1, items: [{ text: '' }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });
});

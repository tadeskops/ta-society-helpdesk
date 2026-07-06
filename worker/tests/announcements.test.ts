// Smoke tests for /announcements endpoints.
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
    if (path !== 'config/announcements.json' || !storedFile) return undefined;
    return { sha: storedFile.sha, content: storedFile.content, encoding: 'utf-8' as const };
  }),
  getJson: vi.fn(async () => undefined),
  putFile: vi.fn(async (_env: any, path: string, content: string) => {
    putCalls.push({ path, body: content });
    if (path === 'config/announcements.json') storedFile = { sha: 'sha-new', content };
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
      // Force the announcements flag ON for the suite (default is off).
      config: { ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features, FEATURE_DAILY_TURNSTILE: false, FEATURE_DAILY_ANNOUNCEMENTS: true } },
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
import { _resetAnnouncementsCacheForTests } from '../src/routes/announcements.ts';

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
  _resetAnnouncementsCacheForTests();
});

describe('GET /announcements', () => {
  it('returns empty when no file exists', async () => {
    const r = await send('GET', '/announcements');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.items).toEqual([]);
  });
});

describe('PUT /announcements — RBAC + validation', () => {
  const body = { announcements: { version: 1, items: [{ title: 'Pool reopens', body: 'From Friday 10 AM after maintenance.' }] } };

  it('rejects anonymous', async () => {
    const r = await send('PUT', '/announcements', body);
    expect(r.status).toBe(401);
  });

  it('rejects unknown identity', async () => {
    const r = await send('PUT', '/announcements', body, 'stranger@x.com');
    expect(r.status).toBe(403);
  });

  it('accepts manager and assigns id + createdBy', async () => {
    const r = await send('PUT', '/announcements', body, 'mgr@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.items[0].id).toMatch(/^ann-[0-9a-f]{16}$/);
    expect(saved.items[0].createdBy).toBe('mgr@x.com');
  });

  it('rejects missing title', async () => {
    const r = await send('PUT', '/announcements', {
      announcements: { version: 1, items: [{ body: 'lonely body' }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects body over 4000 chars', async () => {
    const r = await send('PUT', '/announcements', {
      announcements: { version: 1, items: [{ title: 'X', body: 'x'.repeat(4001) }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects more than 50 items', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ title: `t${i}`, body: 'b' }));
    const r = await send('PUT', '/announcements', { announcements: { version: 1, items } }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('preserves pinned=true', async () => {
    const r = await send('PUT', '/announcements', {
      announcements: { version: 1, items: [{ title: 'A', body: 'b', pinned: true }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.items[0].pinned).toBe(true);
  });
});

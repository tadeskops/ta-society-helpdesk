// Smoke tests for /polls + voting.
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

// In-memory file store keyed by path so polls + votes can coexist.
const store = new Map<string, { sha: string; content: string }>();
const putCalls: Array<{ path: string; body: string }> = [];

vi.mock('../src/github/client.ts', () => ({
  getFile: vi.fn(async (_env: any, path: string) => {
    const f = store.get(path);
    if (!f) return undefined;
    return { sha: f.sha, content: f.content, encoding: 'utf-8' as const };
  }),
  getJson: vi.fn(async () => undefined),
  putFile: vi.fn(async (_env: any, path: string, content: string) => {
    putCalls.push({ path, body: content });
    store.set(path, { sha: `sha-${putCalls.length}`, content });
    return { sha: `sha-${putCalls.length}` };
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
      // Force POLLS flag on for the suite.
      config: { ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features, FEATURE_DAILY_TURNSTILE: false, FEATURE_DAILY_POLLS: true } },
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
import { _resetPollsCacheForTests } from '../src/routes/polls.ts';

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

const seedPoll = (poll: any) => {
  store.set('config/polls.json', { sha: 'sha-seed', content: JSON.stringify({ version: 1, items: [poll] }) });
};

beforeEach(() => {
  store.clear();
  putCalls.length = 0;
  _resetPollsCacheForTests();
});

describe('GET /polls', () => {
  it('returns empty when no polls file', async () => {
    const r = await send('GET', '/polls');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.items).toEqual([]);
  });

  it('returns polls with totals=0 and myVote=null for anonymous', async () => {
    seedPoll({ id: 'pol-1', question: 'Pool reopen day?', options: [{ id: 'mon', label: 'Mon' }, { id: 'fri', label: 'Fri' }], createdAt: 'x', createdBy: 'mgr@x.com' });
    const r = await send('GET', '/polls');
    const j = await r.json() as any;
    expect(j.data.items[0].open).toBe(true);
    expect(j.data.items[0].totals).toEqual([{ optionId: 'mon', count: 0 }, { optionId: 'fri', count: 0 }]);
    expect(j.data.items[0].myVote).toBeNull();
  });
});

describe('PUT /polls — RBAC + validation', () => {
  const body = { polls: { version: 1, items: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] } };

  it('rejects anonymous', async () => {
    const r = await send('PUT', '/polls', body);
    expect(r.status).toBe(401);
  });

  it('rejects unknown identity', async () => {
    const r = await send('PUT', '/polls', body, 'stranger@x.com');
    expect(r.status).toBe(403);
  });

  it('accepts manager and assigns ids', async () => {
    const r = await send('PUT', '/polls', body, 'mgr@x.com');
    expect(r.status).toBe(200);
    const saved = JSON.parse(putCalls[0]!.body);
    expect(saved.items[0].id).toMatch(/^pol-[0-9a-f]{16}$/);
    expect(saved.items[0].options[0].id).toMatch(/^opt-[0-9a-f]{16}$/);
  });

  it('rejects poll with fewer than 2 options', async () => {
    const r = await send('PUT', '/polls', {
      polls: { version: 1, items: [{ question: 'Q?', options: [{ label: 'A' }] }] },
    }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });

  it('rejects poll with > 10 options', async () => {
    const opts = Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` }));
    const r = await send('PUT', '/polls', { polls: { version: 1, items: [{ question: 'Q?', options: opts }] } }, 'mgr@x.com');
    expect(r.status).toBe(400);
  });
});

describe('POST /polls/:id/vote', () => {
  beforeEach(() => {
    seedPoll({ id: 'pol-vote', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], createdAt: 'x', createdBy: 'mgr@x.com' });
  });

  it('rejects anonymous', async () => {
    const r = await send('POST', '/polls/pol-vote/vote', { optionId: 'a' });
    expect(r.status).toBe(401);
  });

  it('rejects bad poll id', async () => {
    const r = await send('POST', '/polls/nope/vote', { optionId: 'a' }, 'dev@x.com');
    expect(r.status).toBe(404);
  });

  it('rejects unknown optionId', async () => {
    const r = await send('POST', '/polls/pol-vote/vote', { optionId: 'z' }, 'dev@x.com');
    expect(r.status).toBe(400);
  });

  it('records a vote and tally reflects it', async () => {
    const r = await send('POST', '/polls/pol-vote/vote', { optionId: 'a', voterAlias: 'Alex', voterFlat: 'A-101' }, 'res1@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.myVote).toBe('a');
    expect(j.data.totals).toEqual([{ optionId: 'a', count: 1 }, { optionId: 'b', count: 0 }]);
    // Voter record saved with optional alias + flat.
    const votesFile = putCalls.find((p) => p.path === 'config/poll-votes.json');
    expect(votesFile).toBeTruthy();
    const saved = JSON.parse(votesFile!.body);
    expect(saved.votes).toHaveLength(1);
    expect(saved.votes[0].voterEmail).toBe('res1@x.com');
    expect(saved.votes[0].voterAlias).toBe('Alex');
    expect(saved.votes[0].voterFlat).toBe('A-101');
  });

  it('replaces an earlier vote from the same email (one vote per voter per poll)', async () => {
    await send('POST', '/polls/pol-vote/vote', { optionId: 'a' }, 'res1@x.com');
    const r2 = await send('POST', '/polls/pol-vote/vote', { optionId: 'b' }, 'res1@x.com');
    expect(r2.status).toBe(200);
    const j = await r2.json() as any;
    expect(j.data.totals).toEqual([{ optionId: 'a', count: 0 }, { optionId: 'b', count: 1 }]);
  });

  it('refuses voting on a closed poll', async () => {
    seedPoll({ id: 'pol-vote', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], closed: true, createdAt: 'x', createdBy: 'mgr@x.com' });
    const r = await send('POST', '/polls/pol-vote/vote', { optionId: 'a' }, 'res1@x.com');
    expect(r.status).toBe(400);
  });
});

describe('GET /polls/:id/votes', () => {
  beforeEach(() => {
    seedPoll({ id: 'pol-v', question: 'Q?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], createdAt: 'x', createdBy: 'mgr@x.com' });
  });

  it('rejects anonymous', async () => {
    const r = await send('GET', '/polls/pol-v/votes');
    expect(r.status).toBe(401);
  });

  it('rejects regular signed-in user (PUBLIC role)', async () => {
    const r = await send('GET', '/polls/pol-v/votes', undefined, 'stranger@x.com');
    expect(r.status).toBe(403);
  });

  it('returns voter records to manager+', async () => {
    await send('POST', '/polls/pol-v/vote', { optionId: 'a', voterFlat: 'B-202' }, 'res1@x.com');
    const r = await send('GET', '/polls/pol-v/votes', undefined, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.count).toBe(1);
    expect(j.data.voters[0].voterEmail).toBe('res1@x.com');
    expect(j.data.voters[0].voterFlat).toBe('B-202');
  });
});

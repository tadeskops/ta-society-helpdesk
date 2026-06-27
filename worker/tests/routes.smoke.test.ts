// End-to-end smoke test for the Worker fetch dispatch. Mocks the JWT
// verifier and the GitHub client so no network is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (hoisted) ------------------------------------------------------

vi.mock('../src/auth/jwt.ts', () => {
  // Identity is selected by a magic header X-Test-Identity: <email>|<roles>
  return {
    verifyGoogleJwt: vi.fn(async (_env: any, req: Request) => {
      const h = req.headers.get('X-Test-Identity');
      if (!h) return undefined;
      const [email] = h.split('|');
      return { email: email!.toLowerCase(), emailVerified: true, sub: 'test-sub' };
    }),
    requireIdentity: vi.fn(),
  };
});

const ghCalls: any[] = [];
const issuesByNum: Record<number, any> = {};
let nextIssueNum = 1;

vi.mock('../src/github/client.ts', () => {
  const createIssue = vi.fn(async (_env: any, params: any) => {
    const num = nextIssueNum++;
    const issue = {
      number: num, title: params.title, body: params.body,
      labels: params.labels.map((n: string) => ({ name: n })),
      state: 'open', locked: false,
      html_url: `https://github.com/x/y/issues/${num}`,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    issuesByNum[num] = issue;
    ghCalls.push({ fn: 'createIssue', params });
    return issue;
  });
  const updateIssue = vi.fn(async (_env: any, num: number, patch: any) => {
    const issue = issuesByNum[num];
    if (patch.title) issue.title = patch.title;
    if (patch.body) issue.body = patch.body;
    if (patch.labels) issue.labels = patch.labels.map((n: string) => ({ name: n }));
    if (patch.state) issue.state = patch.state;
    issue.updated_at = new Date().toISOString();
    ghCalls.push({ fn: 'updateIssue', num, patch });
    return issue;
  });
  const listIssues = vi.fn(async () => Object.values(issuesByNum));
  const getIssue = vi.fn(async (_env: any, num: number) => issuesByNum[num]);
  const lockIssue = vi.fn(async () => undefined);
  const commentOnIssue = vi.fn(async (_env: any, num: number, body: string) => {
    ghCalls.push({ fn: 'commentOnIssue', num, body });
  });
  const putBinaryB64 = vi.fn(async (_env: any, path: string) => {
    ghCalls.push({ fn: 'putBinaryB64', path });
    return { sha: 'sha-' + path };
  });
  return {
    getFile: vi.fn(async () => undefined),
    getJson: vi.fn(async () => undefined),
    putFile: vi.fn(async () => ({ sha: 'sha' })),
    appendToFile: vi.fn(async () => undefined),
    putBinaryB64,
    createIssue, listIssues, getIssue, updateIssue, lockIssue, commentOnIssue,
  };
});

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

// ---- Imports under test ---------------------------------------------------

import worker from '../src/index.ts';
import { _resetThrottleForTests } from '../src/routes/issues.ts';

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
  ghCalls.length = 0;
  for (const k of Object.keys(issuesByNum)) delete issuesByNum[Number(k)];
  nextIssueNum = 1;
  _resetThrottleForTests();
});

// ---- Tests ----------------------------------------------------------------

describe('healthz / preflight', () => {
  it('GET / returns ok', async () => {
    const r = await send('GET', '/');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.name).toBe('tsh-worker');
  });
  it('OPTIONS returns CORS preflight with allowed origin echoed', async () => {
    const r = await send('OPTIONS', '/issues');
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8080');
  });
});

describe('GET /config (anonymous)', () => {
  it('returns the merged config', async () => {
    const r = await send('GET', '/config');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.features.FEATURE_DAILY_TRACK).toBe(true);
  });
});

describe('GET /whoami', () => {
  it('UNKNOWN for anonymous', async () => {
    const r = await send('GET', '/whoami');
    const j = await r.json() as any;
    expect(j.data.primary).toBe('UNKNOWN');
    expect(j.data.email).toBeNull();
  });
  it('DEVELOPER for dev@x.com', async () => {
    const r = await send('GET', '/whoami', undefined, 'dev@x.com');
    const j = await r.json() as any;
    expect(j.data.primary).toBe('DEVELOPER');
    expect(j.data.email).toBe('dev@x.com');
  });
});

describe('POST /issues — full create flow', () => {
  it('creates an issue with DLY-padded title and daily labels', async () => {
    const r = await send('POST', '/issues', {
      tower: 'A', category: 'Lift', subCategory: 'Doors not closing',
      location: 'Lobby G', description: 'Doors keep sticking',
    });
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.data.id).toBe('DLY-00001');
    const created = ghCalls.find((c) => c.fn === 'createIssue');
    expect(created.params.labels).toContain('daily');
    expect(created.params.labels).toContain('tower:A');
    expect(created.params.labels).toContain('cat:lift');
    const titlePatch = ghCalls.find((c) => c.fn === 'updateIssue' && c.patch.title);
    expect(titlePatch.patch.title).toBe('DLY-00001 · Lift · A');
  });

  it('rejects an unknown tower', async () => {
    const r = await send('POST', '/issues', {
      tower: 'T99', category: 'Lift', subCategory: 'Other',
      location: 'x', description: 'detailed enough text',
    });
    expect(r.status).toBe(400);
  });
});

describe('lifecycle PATCH', () => {
  it('rejects forbidden transition', async () => {
    await send('POST', '/issues', {
      tower: 'A', category: 'Water', subCategory: 'Leak',
      location: 'Pump', description: 'leak in basement',
    });
    const r = await send('PATCH', '/issues/DLY-00001', { to: 'resolved' }, 'mgr@x.com');
    expect(r.status).toBe(403);
    const j = await r.json() as any;
    expect(j.error).toMatch(/Forbidden transition/);
  });

  it('allows new -> assigned and posts an audit comment', async () => {
    await send('POST', '/issues', {
      tower: 'A', category: 'Water', subCategory: 'Leak',
      location: 'Pump', description: 'leak in basement',
    });
    const r = await send('PATCH', '/issues/DLY-00001',
      { to: 'assigned', severity: 'high', notes: 'Vendor: Alpha' }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.from).toBe('new');
    expect(j.data.to).toBe('assigned');
    const comment = ghCalls.find((c) => c.fn === 'commentOnIssue');
    expect(comment.body).toContain('**Status change**');
    expect(comment.body).toContain('new → assigned');
  });
});

describe('soft-delete (committee+)', () => {
  it('manager cannot delete', async () => {
    await send('POST', '/issues', {
      tower: 'A', category: 'Lift', subCategory: 'Stuck',
      location: 'lift 1', description: 'lift stuck on G',
    });
    const r = await send('POST', '/issues/DLY-00001/delete', { reason: 'spam' }, 'mgr@x.com');
    expect(r.status).toBe(403);
  });
  it('committee can delete; subsequent public read returns 404', async () => {
    await send('POST', '/issues', {
      tower: 'A', category: 'Lift', subCategory: 'Stuck',
      location: 'lift 1', description: 'lift stuck on G',
    });
    const del = await send('POST', '/issues/DLY-00001/delete', { reason: 'duplicate' }, 'cmt@x.com');
    expect(del.status).toBe(200);
    const pub = await send('GET', '/issues/DLY-00001/public');
    expect(pub.status).toBe(404);
  });
});

describe('GET /issues/public', () => {
  it('omits reporter PII', async () => {
    await send('POST', '/issues', {
      tower: 'A', category: 'Cleaning', subCategory: 'Other',
      location: 'Block A', description: 'Garbage piling up',
      reporterName: 'Asha', reporterFlat: 'B-204', reporterPhone: '+919876543210',
    });
    const r = await send('GET', '/issues/public');
    const body = await r.text();
    expect(body).not.toContain('Asha');
    expect(body).not.toContain('B-204');
    expect(body).not.toContain('9876543210');
  });
});

describe('RBAC denials', () => {
  it('PUT /config requires DEVELOPER', async () => {
    const cfg = { version: 1, features: { FEATURE_DAILY_TRACK: true }, tunables: {}, lists: { towers: [], categories: [], subCategories: {} }, system: {} };
    const r = await send('PUT', '/config', { config: cfg }, 'mgr@x.com');
    expect(r.status).toBe(403);
  });
  it('PUT /access-lists/developers rejects empty list', async () => {
    const r = await send('PUT', '/access-lists/developers', { emails: [] }, 'dev@x.com');
    expect(r.status).toBe(409);
  });
  it('PUT /access-lists/developers rejects self-removal', async () => {
    const r = await send('PUT', '/access-lists/developers', { emails: ['other@x.com'] }, 'dev@x.com');
    expect(r.status).toBe(409);
  });
});

describe('GET /metrics/visit (anonymous)', () => {
  it('returns zero when no data file exists', async () => {
    const { _resetMetricsCacheForTests } = await import('../src/routes/metrics.ts');
    _resetMetricsCacheForTests();
    const r = await send('GET', '/metrics/visit');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.total).toBe(0);
  });
});


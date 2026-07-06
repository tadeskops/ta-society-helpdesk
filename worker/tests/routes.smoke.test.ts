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
        admins: ['dev@x.com'],
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
  it('ADMIN for dev@x.com', async () => {
    const r = await send('GET', '/whoami', undefined, 'dev@x.com');
    const j = await r.json() as any;
    expect(j.data.primary).toBe('ADMIN');
    expect(j.data.email).toBe('dev@x.com');
  });
});

describe('POST /issues — full create flow', () => {
  it('creates an issue with a TKT-prefixed title and daily labels', async () => {
    const r = await send('POST', '/issues', {
      tower: 'A', category: 'Lift', subCategory: 'Doors not closing',
      location: 'Lobby G', description: 'Doors keep sticking',
    });
    expect(r.status).toBe(201);
    const j = await r.json() as any;
    expect(j.data.id).toMatch(/^TKT-\d{10}(?:-\d+)?$/);
    const created = ghCalls.find((c) => c.fn === 'createIssue');
    expect(created.params.labels).toContain('daily');
    expect(created.params.labels).toContain('tower:A');
    expect(created.params.labels).toContain('cat:lift');
    const titlePatch = ghCalls.find((c) => c.fn === 'updateIssue' && c.patch.title);
    expect(titlePatch.patch.title).toMatch(/^TKT-\d{10}(?:-\d+)? · Lift · A$/);
    // The patch should also persist the tkt:<id> label on the issue.
    expect(titlePatch.patch.labels.some((n: string) => n.startsWith('tkt:TKT-'))).toBe(true);
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

  it('accepts the hyphenated wire value on PATCH to `in-progress` (regression: no underscore alias)', async () => {
    // The frontend must send `in-progress` (hyphen); a stale `in_progress`
    // (underscore) is rejected by the validator. This test protects the
    // full new -> assigned -> in-progress chain from silently regressing
    // to a broken tab in the dashboard.
    await send('POST', '/issues', {
      tower: 'A', category: 'Water', subCategory: 'Leak',
      location: 'Pump', description: 'wire compat guard',
    });
    const step1 = await send('PATCH', '/issues/DLY-00001',
      { to: 'assigned', severity: 'medium' }, 'mgr@x.com');
    expect(step1.status).toBe(200);
    const step2 = await send('PATCH', '/issues/DLY-00001',
      { to: 'in-progress' }, 'mgr@x.com');
    expect(step2.status).toBe(200);
    const j2 = await step2.json() as any;
    expect(j2.data.from).toBe('assigned');
    expect(j2.data.to).toBe('in-progress');

    // And the underscore variant must be rejected so we notice quickly if
    // anyone re-introduces the mismatch.
    const bad = await send('PATCH', '/issues/DLY-00001',
      { to: 'in_progress' }, 'mgr@x.com');
    expect(bad.status).toBe(400);
  });
});

describe('soft-delete (manager+)', () => {
  it('manager archive with reason succeeds (spec §6.5)', async () => {
    await send('POST', '/issues', {
      tower: 'A', category: 'Lift', subCategory: 'Stuck',
      location: 'lift 1', description: 'lift stuck on G',
    });
    const r = await send('POST', '/issues/DLY-00001/delete', { reason: '[archive] retention' }, 'mgr@x.com');
    expect(r.status).toBe(200);
  });
  it('manager archive without a reason is rejected 400', async () => {
    await send('POST', '/issues', {
      tower: 'A', category: 'Lift', subCategory: 'Stuck',
      location: 'lift 1', description: 'lift stuck on G',
    });
    const r = await send('POST', '/issues/DLY-00001/delete', {}, 'mgr@x.com');
    expect(r.status).toBe(400);
    const r2 = await send('POST', '/issues/DLY-00001/delete', { reason: '   ' }, 'mgr@x.com');
    expect(r2.status).toBe(400);
  });
  it('committee can delete without a reason; subsequent public read returns 404', async () => {
    await send('POST', '/issues', {
      tower: 'A', category: 'Lift', subCategory: 'Stuck',
      location: 'lift 1', description: 'lift stuck on G',
    });
    const del = await send('POST', '/issues/DLY-00001/delete', {}, 'cmt@x.com');
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
  it('PUT /config requires ADMIN', async () => {
    const cfg = { version: 1, features: { FEATURE_DAILY_TRACK: true }, tunables: {}, lists: { towers: [], categories: [], subCategories: {} }, system: {} };
    const r = await send('PUT', '/config', { config: cfg }, 'mgr@x.com');
    expect(r.status).toBe(403);
  });
  it('PUT /access-lists/admins rejects empty list', async () => {
    const r = await send('PUT', '/access-lists/admins', { emails: [] }, 'dev@x.com');
    expect(r.status).toBe(409);
  });
  it('PUT /access-lists/admins rejects self-removal', async () => {
    const r = await send('PUT', '/access-lists/admins', { emails: ['other@x.com'] }, 'dev@x.com');
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

describe('POST /reports/backup (signed-in)', () => {
  it('writes only the dated copy for a manager (no canonical clobber)', async () => {
    // Managers still get an audit-trail dated PDF, but must not overwrite
    // the always-latest download link — that's reserved for full-scope
    // committee/admin exports and the weekly cron.
    const r = await send('POST', '/reports/backup', {
      source: 'unit-test',
      snapshot: { sample: true },
      pdfB64: 'aGk=',
      updateCanonical: true, // ignored: manager is below the required tier
    }, 'mgr@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.ok).toBe(true);
    expect(j.data.latestPath).toBeUndefined();
    expect(j.data.monthlyPath).toBeUndefined();
    const pdfWrites = ghCalls.filter((c) => c.fn === 'putBinaryB64');
    const paths = pdfWrites.map((c) => c.path);
    expect(paths.some((p) => /^backups\/\d{4}-\d{2}-\d{2}\/\d{4}-unit-test\.pdf$/.test(p))).toBe(true);
    expect(paths.some((p) => p === 'backups/TSH_Report.pdf')).toBe(false);
    expect(paths.some((p) => /^backups\/TSH_Report_\d{4}\.pdf$/.test(p))).toBe(false);
  });

  it('committee with updateCanonical=true refreshes the always-latest and monthly aliases', async () => {
    const r = await send('POST', '/reports/backup', {
      source: 'manage',
      snapshot: { sample: true },
      pdfB64: 'aGk=',
      updateCanonical: true,
    }, 'cmt@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.latestPath).toBe('backups/TSH_Report.pdf');
    expect(j.data.monthlyPath).toMatch(/^backups\/TSH_Report_\d{4}\.pdf$/);
    const paths = ghCalls.filter((c) => c.fn === 'putBinaryB64').map((c) => c.path);
    expect(paths.some((p) => p === 'backups/TSH_Report.pdf')).toBe(true);
    expect(paths.some((p) => /^backups\/TSH_Report_\d{4}\.pdf$/.test(p))).toBe(true);
    expect(paths.some((p) => /^backups\/\d{4}-\d{2}-\d{2}\/\d{4}-manage\.pdf$/.test(p))).toBe(true);
  });

  it('committee without updateCanonical does not touch the canonical aliases', async () => {
    const r = await send('POST', '/reports/backup', {
      source: 'manage',
      snapshot: { sample: true },
      pdfB64: 'aGk=',
    }, 'cmt@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.latestPath).toBeUndefined();
    expect(j.data.monthlyPath).toBeUndefined();
    const paths = ghCalls.filter((c) => c.fn === 'putBinaryB64').map((c) => c.path);
    expect(paths.some((p) => p === 'backups/TSH_Report.pdf')).toBe(false);
  });

  it('omits the latest/monthly aliases when no pdfB64 is supplied', async () => {
    const r = await send('POST', '/reports/backup', {
      source: 'unit-test',
      snapshot: { sample: true },
      updateCanonical: true,
    }, 'cmt@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.latestPath).toBeUndefined();
    expect(j.data.monthlyPath).toBeUndefined();
    const pdfWrites = ghCalls.filter((c) => c.fn === 'putBinaryB64');
    expect(pdfWrites.length).toBe(0);
  });
});

describe('auto-assign sweep', () => {
  // The sweep is what enforces the "minimize the steps" requirement — a
  // ticket sitting in `new` for more than DAILY_AUTO_ASSIGN_HOURS (4 by
  // default) is auto-promoted to `assigned` so it never stalls.

  it('promotes `new` tickets older than the cutoff and posts an audit comment', async () => {
    const { runAutoAssignSweep, AUTO_ASSIGN_ACTOR } = await import('../src/routes/issues.ts');
    const { DEFAULT_CONFIG } = await import('../src/config/defaults.ts');

    // Create a fresh ticket, then rewind its created_at so the sweep sees
    // it as stale (5h old vs the 4h default cutoff).
    await send('POST', '/issues', {
      tower: 'A', category: 'Water', subCategory: 'Leak',
      location: 'Pump', description: 'leak needing manager attention',
    });
    const created = Object.values(issuesByNum)[0] as any;
    const now = Date.now();
    created.created_at = new Date(now - 5 * 3_600_000).toISOString();

    // Clear the calls made by the create flow so we only inspect what the
    // sweep itself does to the ticket.
    ghCalls.length = 0;

    const cfg = { ...DEFAULT_CONFIG };
    const result = await runAutoAssignSweep(
      env as any, cfg, ['mgr@x.com'], now,
    );

    expect(result.swept.length).toBe(1);
    expect(result.cutoffHours).toBe(4);
    expect(result.swept[0]!.id).toMatch(/^(?:DLY|TKT)-\d+$/);

    // Status label flipped from `new` to `assigned`.
    const updated = ghCalls.find((c) => c.fn === 'updateIssue');
    expect(updated).toBeDefined();
    expect(updated!.patch.labels).toContain('assigned');
    expect(updated!.patch.labels).not.toContain('new');

    // Audit comment attributed to system@auto-assign.
    const comment = ghCalls.find((c) => c.fn === 'commentOnIssue');
    expect(comment).toBeDefined();
    expect(comment!.body).toContain(AUTO_ASSIGN_ACTOR);
    expect(comment!.body).toContain('new → assigned');
    expect(comment!.body).toContain('auto-assigned after 4h');
    expect(comment!.body).toContain('mgr@x.com');
  });

  it('leaves fresh `new` tickets alone', async () => {
    const { runAutoAssignSweep } = await import('../src/routes/issues.ts');
    const { DEFAULT_CONFIG } = await import('../src/config/defaults.ts');

    await send('POST', '/issues', {
      tower: 'A', category: 'Water', subCategory: 'Leak',
      location: 'Pump', description: 'just filed, still within grace',
    });
    // Clear the create-flow calls so the assertion is scoped to the sweep.
    ghCalls.length = 0;
    // No rewind — the ticket was created moments ago, well under 4h.
    const result = await runAutoAssignSweep(
      env as any, { ...DEFAULT_CONFIG }, ['mgr@x.com'], Date.now(),
    );

    expect(result.swept.length).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(ghCalls.some((c) => c.fn === 'updateIssue')).toBe(false);
    expect(ghCalls.some((c) => c.fn === 'commentOnIssue')).toBe(false);
  });

  it('honours the DAILY_AUTO_ACK_HOURS legacy alias when the new key is absent', async () => {
    const { runAutoAssignSweep } = await import('../src/routes/issues.ts');
    const { DEFAULT_CONFIG } = await import('../src/config/defaults.ts');

    await send('POST', '/issues', {
      tower: 'A', category: 'Water', subCategory: 'Leak',
      location: 'Pump', description: 'legacy alias respected',
    });
    const created = Object.values(issuesByNum)[0] as any;
    const now = Date.now();
    // 25h old — beyond both the new default (4h) and the legacy 24h.
    created.created_at = new Date(now - 25 * 3_600_000).toISOString();

    // Simulate a not-yet-migrated site.json that still has the old key.
    const cfg: any = {
      ...DEFAULT_CONFIG,
      tunables: { ...DEFAULT_CONFIG.tunables },
    };
    delete cfg.tunables.DAILY_AUTO_ASSIGN_HOURS;
    cfg.tunables.DAILY_AUTO_ACK_HOURS = 12;

    const result = await runAutoAssignSweep(env as any, cfg, ['mgr@x.com'], now);
    expect(result.cutoffHours).toBe(12);
    expect(result.swept.length).toBe(1);
  });
});


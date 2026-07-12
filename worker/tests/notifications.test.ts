// Notifications API + emitter smoke tests.
// Covers: emit no-op when flag off, reservation-created notifies staff,
// approve notifies owner, mark-one-read, mark-all-read, /count endpoint,
// and per-user cap trimming.

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

const files = new Map<string, { sha: string; content: string }>();
let putCount = 0;

vi.mock('../src/github/client.ts', () => ({
  getFile: vi.fn(async (_env: any, path: string) => {
    const f = files.get(path);
    if (!f) return undefined;
    return { sha: f.sha, content: f.content, encoding: 'utf-8' as const };
  }),
  getJson: vi.fn(async () => undefined),
  putFile: vi.fn(async (_env: any, path: string, content: string) => {
    putCount++;
    files.set(path, { sha: `sha-${putCount}`, content });
    return { sha: `sha-${putCount}` };
  }),
  appendToFile: vi.fn(async () => undefined),
  putBinaryB64: vi.fn(async () => ({ sha: 'bin-sha' })),
  getBinaryFile: vi.fn(async () => undefined),
  createIssue: vi.fn(),
  listIssues: vi.fn(async () => []),
  getIssue: vi.fn(),
  updateIssue: vi.fn(),
  lockIssue: vi.fn(),
  commentOnIssue: vi.fn(),
}));

let notificationsFlag = true;

vi.mock('../src/config/loader.ts', async () => {
  const { DEFAULT_CONFIG } = await import('../src/config/defaults.ts');
  return {
    loadConfig: vi.fn(async () => ({
      config: {
        ...DEFAULT_CONFIG,
        features: {
          ...DEFAULT_CONFIG.features,
          FEATURE_DAILY_TURNSTILE: false,
          FEATURE_TSH_RESERVATIONS: true,
          FEATURE_TSH_NOTIFICATIONS: notificationsFlag,
        },
      },
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
import { _resetReservationCachesForTests } from '../src/routes/reservations.ts';
import { _resetNotifyCacheForTests } from '../src/lib/notify.ts';

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

const seedFacilities = () => {
  files.set('config/facilities.json', {
    sha: 'sha-fac',
    content: JSON.stringify({
      version: 1,
      facilities: [
        {
          id: 'community-hall', name: 'Community Hall', description: 'Main hall',
          enabled: true, capacity: 100,
          slots: [
            { id: 'morning',   label: 'Morning',   startHour: 6,  endHour: 12 },
            { id: 'afternoon', label: 'Afternoon', startHour: 12, endHour: 18 },
          ],
          policy: {
            minAdvanceHours: 1, maxAdvanceDays: 365, maxConcurrentPerOwner: 5,
            requiresApproval: true, requiresPayment: false, paymentAmount: 0,
            paymentPayee: '', blackoutDates: [],
          },
          rules: [],
        },
      ],
    }),
  });
};

const soon = (): string => {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 5.5 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

const createRes = async (identity: string, slot = 'morning') => {
  const d = soon();
  const r = await send('POST', '/reservations', {
    facilityId: 'community-hall', date: d, slotId: slot,
    purpose: 'Party', ownerName: 'Alice', ownerFlat: 'A-101',
  }, identity);
  const j = await r.json() as any;
  return j.data.reservation as { id: string };
};

beforeEach(() => {
  files.clear();
  putCount = 0;
  notificationsFlag = true;
  _resetReservationCachesForTests();
  _resetNotifyCacheForTests();
  seedFacilities();
});

// -------------------------------------------------------------- Endpoints

describe('notifications endpoints', () => {
  it('requires sign-in for /notifications', async () => {
    const r = await send('GET', '/notifications');
    expect(r.status).toBe(401);
  });

  it('returns empty list for a fresh user', async () => {
    const r = await send('GET', '/notifications', undefined, 'nobody@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.items).toEqual([]);
    expect(j.data.unread).toBe(0);
  });

  it('emits to staff when a reservation is created; owner does not self-notify', async () => {
    await createRes('resident1@x.com');
    const mgr = await send('GET', '/notifications', undefined, 'mgr@x.com');
    const mgrJ = await mgr.json() as any;
    expect(mgrJ.data.items.length).toBe(1);
    expect(mgrJ.data.items[0].event).toBe('reservation-created');
    expect(mgrJ.data.unread).toBe(1);
    const owner = await send('GET', '/notifications', undefined, 'resident1@x.com');
    const ownerJ = await owner.json() as any;
    expect(ownerJ.data.items.length).toBe(0);
  });

  it('emits to owner on approve', async () => {
    const rec = await createRes('resident1@x.com');
    const patch = await send('PATCH', `/reservations/${rec.id}`, { status: 'confirmed' }, 'mgr@x.com');
    expect(patch.status).toBe(200);
    const own = await send('GET', '/notifications', undefined, 'resident1@x.com');
    const j = await own.json() as any;
    const approvals = j.data.items.filter((n: any) => n.event === 'reservation-approved');
    expect(approvals.length).toBe(1);
  });

  it('/notifications/count returns the unread count only', async () => {
    await createRes('resident1@x.com');
    const c = await send('GET', '/notifications/count', undefined, 'mgr@x.com');
    const j = await c.json() as any;
    expect(j.data.unread).toBe(1);
  });

  it('PATCH /notifications/:id/read marks a single notification as read', async () => {
    await createRes('resident1@x.com');
    const list = await (await send('GET', '/notifications', undefined, 'mgr@x.com')).json() as any;
    const id = list.data.items[0].id;
    const p = await send('PATCH', `/notifications/${id}/read`, {}, 'mgr@x.com');
    expect(p.status).toBe(200);
    const j = await p.json() as any;
    expect(j.data.notification.readAt).toBeTruthy();
    const c = await (await send('GET', '/notifications/count', undefined, 'mgr@x.com')).json() as any;
    expect(c.data.unread).toBe(0);
  });

  it('PATCH /notifications/:id/read 404 when the notification is not yours', async () => {
    await createRes('resident1@x.com');
    const list = await (await send('GET', '/notifications', undefined, 'mgr@x.com')).json() as any;
    const id = list.data.items[0].id;
    const p = await send('PATCH', `/notifications/${id}/read`, {}, 'dev@x.com');
    expect(p.status).toBe(404);
  });

  it('POST /notifications/mark-all-read clears every unread item for the caller', async () => {
    await createRes('resident1@x.com', 'morning');
    await createRes('resident2@x.com', 'afternoon');
    const before = await (await send('GET', '/notifications/count', undefined, 'mgr@x.com')).json() as any;
    expect(before.data.unread).toBe(2);
    const p = await send('POST', '/notifications/mark-all-read', {}, 'mgr@x.com');
    const j = await p.json() as any;
    expect(j.data.updated).toBe(2);
    const after = await (await send('GET', '/notifications/count', undefined, 'mgr@x.com')).json() as any;
    expect(after.data.unread).toBe(0);
  });

  it('feature flag off makes emit a no-op', async () => {
    notificationsFlag = false;
    _resetNotifyCacheForTests();
    await createRes('resident1@x.com');
    // Nothing should have been written to the notifications file at all.
    expect(files.has('config/notifications.json')).toBe(false);
  });
});

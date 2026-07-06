// Phase 3 — Google Calendar mirror smoke tests.
// Covers: no-op when flag off, no-op when facility has no calendarId,
// queues when creds are missing, calls gcalCreate/gcalDelete via mocked
// fetch, admin-only status + retry endpoints, drain drops after
// CALENDAR_RETRY_MAX attempts.

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

let calendarFlag = true;
let facilityCalendarId: string | undefined = 'cal-abc@group.calendar.google.com';

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
          FEATURE_TSH_RESERVATIONS_CALENDAR: calendarFlag,
        },
      },
      access: {
        managers:  ['mgr@x.com'],
        committee: ['cmt@x.com'],
        admins:    ['dev@x.com'],
      },
    })),
    invalidateCache: vi.fn(),
  };
});

import worker from '../src/index.ts';
import { _resetReservationCachesForTests } from '../src/routes/reservations.ts';
import { _resetNotifyCacheForTests } from '../src/lib/notify.ts';
import {
  _resetCalendarCacheForTests,
  _resetCalendarTokenForTests,
} from '../src/lib/google-calendar.ts';

// ---- fetch mock ---------------------------------------------------------

type FetchCall = { url: string; init?: RequestInit };
const fetchCalls: FetchCall[] = [];
let fetchImpl: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

const origFetch = globalThis.fetch;
beforeEach(() => {
  fetchCalls.length = 0;
  fetchImpl = null;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    fetchCalls.push({ url, init });
    if (fetchImpl) return fetchImpl(url, init);
    // Default: everything succeeds.
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/events') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'evt-123' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/events/') && (init?.method === 'DELETE' || init?.method === 'PATCH')) {
      return new Response('', { status: 204 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
});

const envBase = {
  GH_OWNER: 'tadeskops',
  GH_REPO: 'ta-society-helpdesk',
  GH_BRANCH: 'main',
  GOOGLE_OAUTH_CLIENT_ID: 'test-client-id',
  TURNSTILE_SITE_KEY: 'test',
  ALLOWED_ORIGINS: 'http://localhost:8080',
  LOG_LEVEL: 'error',
  GITHUB_TOKEN: 'fake',
};

const envWithCreds = {
  ...envBase,
  GOOGLE_CAL_CLIENT_ID: 'gcid',
  GOOGLE_CAL_CLIENT_SECRET: 'gcsec',
  GOOGLE_CAL_REFRESH_TOKEN: 'gcrt',
};

const send = (method: string, path: string, body?: any, identity?: string, env: any = envWithCreds) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Origin': 'http://localhost:8080' };
  if (identity) {
    headers['X-Test-Identity'] = identity;
    headers['Authorization'] = `Bearer fake-jwt-for-${identity}`;
  }
  return worker.fetch(
    new Request(`https://w.x${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }),
    env,
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
          ...(facilityCalendarId ? { calendarId: facilityCalendarId } : {}),
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

const createAndConfirm = async (env: any = envWithCreds, slot = 'morning') => {
  const d = soon();
  const c = await send('POST', '/reservations', {
    facilityId: 'community-hall', date: d, slotId: slot,
    purpose: 'Party', ownerName: 'Alice', ownerFlat: 'A-101',
  }, 'resident1@x.com', env);
  const j = await c.json() as any;
  const id = j.data.reservation.id;
  const p = await send('PATCH', `/reservations/${id}`, { status: 'confirmed' }, 'mgr@x.com', env);
  return { id, patch: p };
};

beforeEach(() => {
  files.clear();
  putCount = 0;
  calendarFlag = true;
  facilityCalendarId = 'cal-abc@group.calendar.google.com';
  _resetReservationCachesForTests();
  _resetNotifyCacheForTests();
  _resetCalendarCacheForTests();
  _resetCalendarTokenForTests();
  seedFacilities();
});

describe('google-calendar mirror', () => {
  it('is a no-op when the flag is off', async () => {
    calendarFlag = false;
    _resetReservationCachesForTests();
    await createAndConfirm();
    const gcalHits = fetchCalls.filter((c) => c.url.includes('googleapis.com'));
    expect(gcalHits.length).toBe(0);
    expect(files.has('config/calendar-queue.json')).toBe(false);
  });

  it('is a no-op when the facility has no calendarId', async () => {
    facilityCalendarId = undefined;
    seedFacilities();
    _resetReservationCachesForTests();
    await createAndConfirm();
    const gcalHits = fetchCalls.filter((c) => c.url.includes('googleapis.com'));
    expect(gcalHits.length).toBe(0);
  });

  it('queues the op when creds are missing', async () => {
    await createAndConfirm(envBase);   // no OAuth secrets
    const gcalHits = fetchCalls.filter((c) => c.url.includes('googleapis.com'));
    expect(gcalHits.length).toBe(0);
    const q = files.get('config/calendar-queue.json');
    expect(q).toBeDefined();
    const parsed = JSON.parse(q!.content);
    expect(parsed.items.length).toBe(1);
    expect(parsed.items[0].op).toBe('create');
  });

  it('creates a Google Calendar event on confirm and stores the id', async () => {
    const { id } = await createAndConfirm();
    const gcalCreate = fetchCalls.filter((c) => c.url.includes('googleapis.com') && c.url.endsWith('/events'));
    expect(gcalCreate.length).toBe(1);
    // Reservation record now carries the event id.
    const rs = JSON.parse(files.get('config/reservations.json')!.content);
    const rec = rs.items.find((x: any) => x.id === id);
    expect(rec.calendarEventId).toBe('evt-123');
  });

  it('deletes the mirrored event on cancel', async () => {
    const { id } = await createAndConfirm();
    fetchCalls.length = 0;
    const cancel = await send('PATCH', `/reservations/${id}`, { status: 'cancelled' }, 'mgr@x.com');
    expect(cancel.status).toBe(200);
    const dels = fetchCalls.filter((c) => c.init?.method === 'DELETE' && c.url.includes('/events/'));
    expect(dels.length).toBe(1);
  });

  it('queues on Google 5xx failure and keeps the reservation confirmed', async () => {
    fetchImpl = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        return new Response('oops', { status: 500 });
      }
      return new Response('', { status: 404 });
    };
    const { id, patch } = await createAndConfirm();
    expect(patch.status).toBe(200);         // reservation still confirmed
    const rs = JSON.parse(files.get('config/reservations.json')!.content);
    const rec = rs.items.find((x: any) => x.id === id);
    expect(rec.status).toBe('confirmed');
    expect(rec.calendarEventId).toBeUndefined();
    const q = JSON.parse(files.get('config/calendar-queue.json')!.content);
    expect(q.items.length).toBe(1);
    expect(q.items[0].lastError).toMatch(/gcal create/);
  });
});

describe('/admin/calendar-status & /admin/calendar-retry', () => {
  it('requires ADMIN', async () => {
    const r = await send('GET', '/admin/calendar-status', undefined, 'mgr@x.com');
    expect(r.status).toBe(403);
  });

  it('returns status metadata for admins', async () => {
    const r = await send('GET', '/admin/calendar-status', undefined, 'dev@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.enabled).toBe(true);
    expect(j.data.haveCreds).toBe(true);
    expect(j.data.queueDepth).toBe(0);
  });

  it('drains a queued op successfully on retry', async () => {
    // First: queue an op by failing.
    fetchImpl = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      if (init?.method === 'POST' && url.includes('/events')) return new Response('nope', { status: 500 });
      return new Response('', { status: 204 });
    };
    await createAndConfirm();
    expect(JSON.parse(files.get('config/calendar-queue.json')!.content).items.length).toBe(1);
    // Now: retry with success.
    fetchImpl = async (url, init) => {
      if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
      if (init?.method === 'POST' && url.includes('/events')) return new Response(JSON.stringify({ id: 'evt-new' }), { status: 200 });
      return new Response('', { status: 204 });
    };
    _resetCalendarCacheForTests();
    const r = await send('POST', '/admin/calendar-retry', {}, 'dev@x.com');
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.data.attempted).toBe(1);
    expect(j.data.ok).toBe(1);
    expect(JSON.parse(files.get('config/calendar-queue.json')!.content).items.length).toBe(0);
  });
});

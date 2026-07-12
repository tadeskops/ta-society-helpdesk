// Migration-compat: config/admins.json is the canonical source, but the
// loader must still hydrate access.admins from the legacy
// config/developers.json file and the legacy BOOTSTRAP_DEVELOPERS env var
// so a mid-migration deploy never locks admins out.
//
// The loader also merges the code-hardcoded developer admin(s) from
// worker/src/auth/hardcoded.ts — they are always present in
// access.admins regardless of what config/admins.json contains, so
// every assertion below uses `toContain` (order-agnostic) rather than
// `toEqual` and additionally checks the hardcoded admin is included.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HARDCODED_ADMINS } from '../src/auth/hardcoded.ts';

const hardcoded = HARDCODED_ADMINS[0]!;

const getJsonMock = vi.fn();

vi.mock('../src/github/client.ts', () => ({
  getJson: (...args: unknown[]) => getJsonMock(...args),
}));

// Fresh dynamic import per test so the module-level cache is reset.
const loadFresh = async () => {
  vi.resetModules();
  return (await import('../src/config/loader.ts')).loadConfig;
};

const baseEnv = {
  GH_OWNER: 'x', GH_REPO: 'y', GH_BRANCH: 'main',
  GOOGLE_OAUTH_CLIENT_ID: '', TURNSTILE_SITE_KEY: '',
  ALLOWED_ORIGINS: '', LOG_LEVEL: 'error' as const,
  GITHUB_TOKEN: 'fake',
};

beforeEach(() => {
  getJsonMock.mockReset();
});

describe('loader access-list resolution', () => {
  it('prefers config/admins.json when present', async () => {
    getJsonMock.mockImplementation((_env: unknown, path: string) => {
      if (path === 'config/site.json')       return Promise.resolve(undefined);
      if (path === 'config/managers.json')   return Promise.resolve([]);
      if (path === 'config/committee.json')  return Promise.resolve([]);
      if (path === 'config/admins.json')     return Promise.resolve(['new@x.com']);
      if (path === 'config/developers.json') return Promise.resolve(['old@x.com']);
      return Promise.resolve(undefined);
    });
    const loadConfig = await loadFresh();
    const { access } = await loadConfig(baseEnv as any);
    expect(access.admins).toContain('new@x.com');
    expect(access.admins).toContain(hardcoded);
    expect(access.admins).not.toContain('old@x.com');
  });

  it('falls back to legacy config/developers.json when admins.json is missing', async () => {
    getJsonMock.mockImplementation((_env: unknown, path: string) => {
      if (path === 'config/site.json')       return Promise.resolve(undefined);
      if (path === 'config/managers.json')   return Promise.resolve([]);
      if (path === 'config/committee.json')  return Promise.resolve([]);
      if (path === 'config/admins.json')     return Promise.reject(new Error('404'));
      if (path === 'config/developers.json') return Promise.resolve(['legacy@x.com']);
      return Promise.resolve(undefined);
    });
    const loadConfig = await loadFresh();
    const { access } = await loadConfig(baseEnv as any);
    expect(access.admins).toContain('legacy@x.com');
    expect(access.admins).toContain(hardcoded);
  });

  it('bootstraps from BOOTSTRAP_ADMINS when no file exists', async () => {
    getJsonMock.mockImplementation((_env: unknown, path: string) => {
      if (path === 'config/site.json')       return Promise.resolve(undefined);
      if (path === 'config/managers.json')   return Promise.resolve([]);
      if (path === 'config/committee.json')  return Promise.resolve([]);
      return Promise.reject(new Error('404'));
    });
    const loadConfig = await loadFresh();
    const { access } = await loadConfig({ ...baseEnv, BOOTSTRAP_ADMINS: 'boot@x.com' } as any);
    expect(access.admins).toContain('boot@x.com');
    expect(access.admins).toContain(hardcoded);
  });

  it('falls back to legacy BOOTSTRAP_DEVELOPERS when BOOTSTRAP_ADMINS is unset', async () => {
    getJsonMock.mockImplementation((_env: unknown, path: string) => {
      if (path === 'config/site.json')       return Promise.resolve(undefined);
      if (path === 'config/managers.json')   return Promise.resolve([]);
      if (path === 'config/committee.json')  return Promise.resolve([]);
      return Promise.reject(new Error('404'));
    });
    const loadConfig = await loadFresh();
    const { access } = await loadConfig({ ...baseEnv, BOOTSTRAP_DEVELOPERS: 'legacyboot@x.com' } as any);
    expect(access.admins).toContain('legacyboot@x.com');
    expect(access.admins).toContain(hardcoded);
  });

  it('merges hardcoded developer admin even when every source is empty', async () => {
    getJsonMock.mockImplementation((_env: unknown, path: string) => {
      if (path === 'config/site.json')       return Promise.resolve(undefined);
      if (path === 'config/managers.json')   return Promise.resolve([]);
      if (path === 'config/committee.json')  return Promise.resolve([]);
      if (path === 'config/admins.json')     return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const loadConfig = await loadFresh();
    const { access } = await loadConfig(baseEnv as any);
    expect(access.admins).toContain(hardcoded);
    expect(access.admins).toHaveLength(HARDCODED_ADMINS.length);
  });
});

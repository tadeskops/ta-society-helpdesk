// Migration-compat: config/admins.json is the canonical source, but the
// loader must still hydrate access.admins from the legacy
// config/developers.json file and the legacy BOOTSTRAP_DEVELOPERS env var
// so a mid-migration deploy never locks admins out.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    expect(access.admins).toEqual(['new@x.com']);
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
    expect(access.admins).toEqual(['legacy@x.com']);
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
    expect(access.admins).toEqual(['boot@x.com']);
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
    expect(access.admins).toEqual(['legacyboot@x.com']);
  });
});

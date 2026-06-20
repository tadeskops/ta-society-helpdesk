// Loads + caches config/site.json and the three allow-lists from
// GitHub. Cache TTL: tunables.CONFIG_CACHE_SECONDS (default 60 s).
// Spec: tsh_requirement.md §3.2, §9.

import type { Env } from '../env.ts';
import { getJson } from '../github/client.ts';
import { DEFAULT_CONFIG, type SiteConfig, tunable } from './defaults.ts';
import { log } from '../lib/log.ts';

export type { SiteConfig };

export interface AccessLists {
  managers: string[];
  committee: string[];
  developers: string[];
}

interface Cache {
  config: SiteConfig;
  access: AccessLists;
  expiresAt: number;
}

let cache: Cache | undefined;

const normaliseEmails = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string').map((s) => s.trim().toLowerCase()).filter(Boolean);
};

const deepMerge = <T>(base: T, override: Partial<T> | undefined): T => {
  if (!override) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge((out[k] ?? {}) as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
};

const loadFromGithub = async (env: Env): Promise<{ config: SiteConfig; access: AccessLists }> => {
  const [siteRaw, mgrRaw, comRaw, devRaw] = await Promise.all([
    getJson<Partial<SiteConfig>>(env, 'config/site.json').catch(() => undefined),
    getJson<unknown>(env, 'config/managers.json').catch(() => []),
    getJson<unknown>(env, 'config/committee.json').catch(() => []),
    getJson<unknown>(env, 'config/developers.json').catch(() => undefined),
  ]);

  const config = deepMerge(DEFAULT_CONFIG, siteRaw);

  const devs = devRaw === undefined
    ? normaliseEmails((env.BOOTSTRAP_DEVELOPERS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    : normaliseEmails(devRaw);

  const access: AccessLists = {
    managers:   normaliseEmails(mgrRaw),
    committee:  normaliseEmails(comRaw),
    developers: devs,
  };

  return { config, access };
};

export const loadConfig = async (env: Env): Promise<{ config: SiteConfig; access: AccessLists }> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return { config: cache.config, access: cache.access };
  }
  try {
    const fresh = await loadFromGithub(env);
    const ttl = tunable(fresh.config, 'CONFIG_CACHE_SECONDS', 60) * 1000;
    cache = { ...fresh, expiresAt: now + ttl };
    return fresh;
  } catch (e) {
    log.error(env, 'config_load_failed', { err: String(e) });
    if (cache) return { config: cache.config, access: cache.access };
    return {
      config: DEFAULT_CONFIG,
      access: { managers: [], committee: [], developers: [] },
    };
  }
};

export const invalidateCache = (): void => {
  cache = undefined;
};

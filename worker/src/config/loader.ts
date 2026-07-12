// Loads + caches config/site.json and the three allow-lists from
// GitHub. Cache TTL: tunables.CONFIG_CACHE_SECONDS (default 60 s).
// Spec: tsh_requirement.md §3.2, §9.

import type { Env } from '../env.ts';
import { getJson } from '../github/client.ts';
import { DEFAULT_CONFIG, type SiteConfig, tunable } from './defaults.ts';
import { log } from '../lib/log.ts';
import { mergeHardcodedAdmins } from '../auth/hardcoded.ts';

export type { SiteConfig };

export interface AccessLists {
  managers: string[];
  committee: string[];
  admins: string[];
  // Strict-hierarchy tiers between COMMITTEE and MANAGER, and above
  // COMMITTEE. See worker/src/auth/roles.ts for the 8-tier chain:
  // ADMIN > CHAIRMAN > SECRETARY > TREASURER > COMMITTEE >
  //   CONTRIBUTOR > MANAGER > RESIDENT.
  // While all three of chairman/secretary/treasurer are empty the
  // grandfather clause in roles.ts keeps the legacy Committee+Admin
  // gate on the treasury ledger.
  treasurer: string[];
  chairman: string[];
  secretary: string[];
  contributor: string[];
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

// Basic RFC-lite email shape: <local>@<label>.<tld≥2>. Catches obvious
// typos (missing @, no dot, no TLD) but doesn't reject weird-but-valid
// TLDs. Used only for surfacing warnings, never for filtering.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Common TLD suffixes we recognise. If an email's TLD isn't on this list
// we log a warn — that's how we'd have caught ".coam" vs ".com".
const KNOWN_TLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'co', 'io', 'ai',
  'app', 'dev', 'me', 'in', 'us', 'uk', 'ca', 'au', 'de', 'fr', 'jp',
  'info', 'biz', 'name', 'pro',
]);

const warnSuspiciousEmails = (env: Env, list: string, emails: string[]): void => {
  for (const e of emails) {
    if (!EMAIL_RE.test(e)) {
      log.warn(env, 'config_access_email_malformed', { list, email: e });
      continue;
    }
    const tld = e.split('.').pop() ?? '';
    if (!KNOWN_TLDS.has(tld)) {
      log.warn(env, 'config_access_email_suspicious_tld', { list, email: e, tld });
    }
  }
};

// Per-file loader that returns the parsed value, or `undefined` if the
// file is truly missing (404). Any other failure — network error, JSON
// parse error, upstream 5xx — is logged and treated as `undefined` so a
// single bad file never silently blanks an allow-list without a trace.
const loadOptional = async <T>(env: Env, path: string): Promise<T | undefined> => {
  try {
    return await getJson<T>(env, path);
  } catch (e) {
    log.warn(env, 'config_file_load_failed', { path, err: String(e) });
    return undefined;
  }
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
  const [siteRaw, mgrRaw, comRaw, adminRaw, devLegacyRaw, treasurerRaw, chairmanRaw, secretaryRaw, contributorRaw] = await Promise.all([
    loadOptional<Partial<SiteConfig>>(env, 'config/site.json'),
    loadOptional<unknown>(env, 'config/managers.json'),
    loadOptional<unknown>(env, 'config/committee.json'),
    loadOptional<unknown>(env, 'config/admins.json'),
    loadOptional<unknown>(env, 'config/developers.json'),
    loadOptional<unknown>(env, 'config/treasurer.json'),
    loadOptional<unknown>(env, 'config/chairman.json'),
    loadOptional<unknown>(env, 'config/secretary.json'),
    loadOptional<unknown>(env, 'config/contributor.json'),
  ]);

  const config = deepMerge(DEFAULT_CONFIG, siteRaw);

  // Prefer new config/admins.json; fall back to legacy config/developers.json
  // for one migration cycle. Bootstrap env vars fall back the same way.
  const rawAdmins = adminRaw ?? devLegacyRaw;
  const fileAdmins = rawAdmins === undefined
    ? normaliseEmails((env.BOOTSTRAP_ADMINS ?? env.BOOTSTRAP_DEVELOPERS ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    : normaliseEmails(rawAdmins);
  // Merge hardcoded developer admin(s) — see worker/src/auth/hardcoded.ts.
  // These are invisible in the Settings UI (stripped by GET /access-lists)
  // but every RBAC check sees them as normal admins.
  const admins = mergeHardcodedAdmins(fileAdmins);

  const access: AccessLists = {
    managers:    normaliseEmails(mgrRaw),
    committee:   normaliseEmails(comRaw),
    admins,
    treasurer:   normaliseEmails(treasurerRaw),
    chairman:    normaliseEmails(chairmanRaw),
    secretary:   normaliseEmails(secretaryRaw),
    contributor: normaliseEmails(contributorRaw),
  };

  warnSuspiciousEmails(env, 'managers',    access.managers);
  warnSuspiciousEmails(env, 'committee',   access.committee);
  warnSuspiciousEmails(env, 'admins',      access.admins);
  warnSuspiciousEmails(env, 'treasurer',   access.treasurer);
  warnSuspiciousEmails(env, 'chairman',    access.chairman);
  warnSuspiciousEmails(env, 'secretary',   access.secretary);
  warnSuspiciousEmails(env, 'contributor', access.contributor);

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
      access: { managers: [], committee: [], admins: [], treasurer: [], chairman: [], secretary: [], contributor: [] },
    };
  }
};

export const invalidateCache = (): void => {
  cache = undefined;
};

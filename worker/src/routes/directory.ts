// Society directory (vendors, community contacts, resources).
// GET  /directory          — anonymous-safe; gated by FEATURE_DAILY_DIRECTORY.
// PUT  /directory          — DEVELOPER/COMMITTEE/MANAGER may write the full
//                            directory file at once (small payload, no need
//                            for per-row endpoints in v1).
// PUT  /directory/categories — same roles; updates vendorCategories only.
//
// Storage: config/directory.json in the issues repo. Cached in-Worker for
// DIRECTORY_CACHE_SECONDS (default 120 s) so the hot read path stays fast
// even if the file grows to hundreds of vendors.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { parseJson, str, optStr, isObj } from '../lib/validate.ts';
import { BadRequest } from '../lib/errors.ts';
import { getFile, putFile } from '../github/client.ts';
import { writeAudit } from '../lib/audit.ts';
import { tunable } from '../config/defaults.ts';

const DIR_PATH = 'config/directory.json';

interface DirEntry {
  id: string;
  name: string;
  category?: string;
  phone?: string;
  address?: string;
  role?: string;
  url?: string;
  description?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface Directory {
  version: number;
  vendorCategories: string[];
  vendors: DirEntry[];
  contacts: DirEntry[];
  resources: DirEntry[];
}

const EMPTY_DIRECTORY: Directory = {
  version: 1,
  vendorCategories: [],
  vendors: [],
  contacts: [],
  resources: [],
};

interface Cache { value: Directory; sha?: string; expiresAt: number; }
let cache: Cache | undefined;

const invalidate = (): void => { cache = undefined; };

/** Test-only: clear the in-module directory cache between tests. */
export const _resetDirectoryCacheForTests = (): void => { cache = undefined; };

const loadFromGithub = async (env: Ctx['env']): Promise<{ value: Directory; sha?: string }> => {
  const f = await getFile(env, DIR_PATH);
  if (!f) return { value: structuredClone(EMPTY_DIRECTORY) };
  try {
    const parsed = JSON.parse(f.content) as Partial<Directory>;
    return {
      value: {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        vendorCategories: Array.isArray(parsed.vendorCategories) ? parsed.vendorCategories.filter((x): x is string => typeof x === 'string') : [],
        vendors:   Array.isArray(parsed.vendors)   ? (parsed.vendors   as DirEntry[]) : [],
        contacts:  Array.isArray(parsed.contacts)  ? (parsed.contacts  as DirEntry[]) : [],
        resources: Array.isArray(parsed.resources) ? (parsed.resources as DirEntry[]) : [],
      },
      sha: f.sha,
    };
  } catch {
    return { value: structuredClone(EMPTY_DIRECTORY), sha: f.sha };
  }
};

const loadDirectory = async (ctx: Ctx): Promise<Directory> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const fresh = await loadFromGithub(ctx.env);
  const ttl = tunable(ctx.config, 'DIRECTORY_CACHE_SECONDS', 120) * 1000;
  cache = { value: fresh.value, sha: fresh.sha, expiresAt: now + ttl };
  return fresh.value;
};

const sanitiseEntry = (raw: unknown, kind: 'vendor' | 'contact' | 'resource'): DirEntry => {
  if (!isObj(raw)) throw new BadRequest(`${kind} entry must be an object`);
  const name = kind === 'resource'
    ? str(raw['title'] ?? raw['name'], `${kind}.title`, { min: 1, max: 120 })
    : str(raw['name'], `${kind}.name`, { min: 1, max: 120 });
  const out: DirEntry = {
    id: typeof raw['id'] === 'string' && raw['id'] ? raw['id'] : cryptoRandomId(kind),
    name,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const cat = optStr(raw['category'], `${kind}.category`, { max: 60 });
  if (cat) out.category = cat;
  const phone = optStr(raw['phone'], `${kind}.phone`, { max: 30 });
  if (phone) out.phone = phone;
  const address = optStr(raw['address'], `${kind}.address`, { max: 240 });
  if (address) out.address = address;
  const role = optStr(raw['role'], `${kind}.role`, { max: 80 });
  if (role) out.role = role;
  const url = optStr(raw['url'], `${kind}.url`, { max: 500 });
  if (url) out.url = url;
  const description = optStr(raw['description'], `${kind}.description`, { max: 500 });
  if (description) out.description = description;
  const notes = optStr(raw['notes'], `${kind}.notes`, { max: 500 });
  if (notes) out.notes = notes;
  return out;
};

const cryptoRandomId = (prefix: string): string => {
  // Web Crypto is available in the Workers runtime.
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const hex = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
  const tag = prefix === 'vendor' ? 'vnd' : prefix === 'contact' ? 'ctc' : 'res';
  return `${tag}-${hex}`;
};

const validateCategories = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) throw new BadRequest('vendorCategories must be an array');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') throw new BadRequest('category must be a string');
    const s = v.trim();
    if (!s) continue;
    if (s.length > 60) throw new BadRequest(`category too long: ${s}`);
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
};

export const mountDirectory = (r: Router): void => {
  // ---- GET /directory ----
  r.get('/directory', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: ['FEATURE_DAILY_DIRECTORY'] });
    const dir = await loadDirectory(ctx);
    return ok(ctx.env, ctx.req, dir);
  });

  // ---- PUT /directory ----
  r.put('/directory', async (ctx: Ctx) => {
    ensureAllowed(ctx, {
      flags: ['FEATURE_DAILY_DIRECTORY'],
      roles: ['MANAGER', 'COMMITTEE', 'DEVELOPER'],
      requireIdentity: true,
    });
    const body = await parseJson<Record<string, unknown>>(ctx.req);
    const incoming = (body['directory'] ?? body) as Record<string, unknown>;
    if (!isObj(incoming)) throw new BadRequest('directory must be an object');

    const next: Directory = {
      version: typeof incoming['version'] === 'number' ? (incoming['version'] as number) : 1,
      vendorCategories: validateCategories(incoming['vendorCategories'] ?? []),
      vendors:   Array.isArray(incoming['vendors'])   ? (incoming['vendors'] as unknown[]).map((e) => sanitiseEntry(e, 'vendor'))   : [],
      contacts:  Array.isArray(incoming['contacts'])  ? (incoming['contacts'] as unknown[]).map((e) => sanitiseEntry(e, 'contact'))  : [],
      resources: Array.isArray(incoming['resources']) ? (incoming['resources'] as unknown[]).map((e) => sanitiseEntry(e, 'resource')) : [],
    };

    const actor = ctx.identity!.email;
    const existing = await getFile(ctx.env, DIR_PATH);
    const serialised = JSON.stringify(next, null, 2) + '\n';
    await putFile(
      ctx.env,
      DIR_PATH,
      serialised,
      `directory: update by ${actor}`,
      actor,
      existing?.sha,
    );
    await writeAudit(ctx.env, {
      actor,
      action: 'directory:put',
      target: DIR_PATH,
      detail: `vendors=${next.vendors.length} contacts=${next.contacts.length} resources=${next.resources.length}`,
    });
    invalidate();
    return ok(ctx.env, ctx.req, { saved: true, counts: {
      vendors: next.vendors.length,
      contacts: next.contacts.length,
      resources: next.resources.length,
      vendorCategories: next.vendorCategories.length,
    }});
  });
};

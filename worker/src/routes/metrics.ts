// Visitor counter. Public read + public increment.
//
//   GET  /metrics/visit  -> { total, updatedAt }
//   POST /metrics/visit  -> { total, updatedAt }   (atomic +1)
//
// Storage: data/visitors.json in the configured GH repo/branch. The
// frontend (footer) gates the POST with a localStorage marker so each
// browser increments at most once per UTC day; we additionally cache
// reads for 60 s in-isolate to avoid hammering GitHub on busy pages.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { getFile, putFile } from '../github/client.ts';

const VISITORS_PATH = 'data/visitors.json';

interface Visitors { total: number; updatedAt: string; }

const EMPTY: Visitors = { total: 0, updatedAt: '' };

interface Cache { value: Visitors; sha?: string; expiresAt: number; }
let cache: Cache | undefined;
const READ_TTL_MS = 60_000;

export const _resetMetricsCacheForTests = (): void => { cache = undefined; };

const load = async (env: Ctx['env']): Promise<{ value: Visitors; sha?: string }> => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return { value: cache.value, sha: cache.sha };
  const f = await getFile(env, VISITORS_PATH);
  if (!f) {
    cache = { value: structuredClone(EMPTY), expiresAt: now + READ_TTL_MS };
    return { value: cache.value };
  }
  let parsed: Partial<Visitors> = {};
  try { parsed = JSON.parse(f.content) as Partial<Visitors>; } catch { /* fall through */ }
  const value: Visitors = {
    total: typeof parsed.total === 'number' && Number.isFinite(parsed.total) ? parsed.total : 0,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
  };
  cache = { value, sha: f.sha, expiresAt: now + READ_TTL_MS };
  return { value, sha: f.sha };
};

export const mountMetrics = (r: Router): void => {
  r.get('/metrics/visit', async (ctx: Ctx) => {
    const { value } = await load(ctx.env);
    return ok(ctx.env, ctx.req, value);
  });

  r.post('/metrics/visit', async (ctx: Ctx) => {
    // Best-effort atomic increment with one retry on sha conflict.
    for (let attempt = 0; attempt < 2; attempt++) {
      const f = await getFile(ctx.env, VISITORS_PATH);
      const current: Visitors = f
        ? (() => {
            try {
              const p = JSON.parse(f.content) as Partial<Visitors>;
              return {
                total: typeof p.total === 'number' && Number.isFinite(p.total) ? p.total : 0,
                updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
              };
            } catch { return { total: 0, updatedAt: '' }; }
          })()
        : { total: 0, updatedAt: '' };
      const next: Visitors = { total: current.total + 1, updatedAt: new Date().toISOString() };
      try {
        await putFile(
          ctx.env,
          VISITORS_PATH,
          JSON.stringify(next, null, 2) + '\n',
          `chore(metrics): visit #${next.total}`,
          'tsh-worker@users.noreply.github.com',
          f?.sha,
        );
        cache = { value: next, expiresAt: Date.now() + READ_TTL_MS };
        return ok(ctx.env, ctx.req, next);
      } catch (e) {
        if (attempt === 1) throw e;
        // small backoff before refetch
        await new Promise((r) => setTimeout(r, 80));
      }
    }
    // Unreachable
    return ok(ctx.env, ctx.req, EMPTY);
  });
};

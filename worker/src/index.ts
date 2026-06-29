// TSH Worker entrypoint. Spec: tsh_requirement.md §4.
// Flow per request: parse URL -> CORS preflight -> verify JWT (optional)
// -> load config + access lists -> resolve role -> dispatch.

import type { Env } from './env.ts';
import type { Ctx } from './lib/ctx.ts';
import { err, ok, preflight } from './lib/envelope.ts';
import { HttpError } from './lib/errors.ts';
import { log } from './lib/log.ts';
import { verifyGoogleJwt } from './auth/jwt.ts';
import { resolveRoles } from './auth/roles.ts';
import { loadConfig } from './config/loader.ts';
import { buildRouter } from './routes/index.ts';
import { scheduledBackup, archiveMonthly } from './routes/backup.ts';

const router = buildRouter();

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return preflight(env, req);

    if (url.pathname === '/' || url.pathname === '/healthz') {
      return ok(env, req, { ok: true, name: 'tsh-worker', version: '0.1.0' });
    }

    try {
      const identityRaw = await verifyGoogleJwt(env, req).catch((e: unknown) => {
        // Anonymous-allowed paths get undefined; explicit bad token still throws.
        if (e instanceof HttpError && e.status === 401) {
          const hasAuth = !!req.headers.get('Authorization');
          if (hasAuth) throw e;
          return undefined;
        }
        throw e;
      });

      const { config, access } = await loadConfig(env);
      const roles = resolveRoles(access, identityRaw?.email ?? null);

      const ctx: Ctx = {
        env, req, url,
        ...(identityRaw ? { identity: identityRaw } : {}),
        roles, config, access,
        ip: req.headers.get('CF-Connecting-IP') ?? '',
      };

      const matched = router.match(req.method, url.pathname);
      if (!matched) return err(env, req, `Not found: ${req.method} ${url.pathname}`, 404);

      return await matched.handler(ctx, matched.params);
    } catch (e) {
      if (e instanceof HttpError) {
        log.warn(env, 'request_rejected', { status: e.status, msg: e.message, path: url.pathname });
        return err(env, req, e.message, e.status);
      }
      log.error(env, 'unhandled_error', { err: String((e as Error).stack ?? e), path: url.pathname });
      return err(env, req, 'Internal error', 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await scheduledBackup(env, event.scheduledTime);
          log.info(env, 'cron_backup_result', result);
        } catch (e) {
          log.error(env, 'cron_backup_failed', { err: String((e as Error).stack ?? e) });
        }
        try {
          const archived = await archiveMonthly(env, event.scheduledTime);
          log.info(env, 'cron_archive_result', archived);
        } catch (e) {
          log.error(env, 'cron_archive_failed', { err: String((e as Error).stack ?? e) });
        }
      })(),
    );
  },
};

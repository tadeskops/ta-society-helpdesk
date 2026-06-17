// Structured logger. Filters by env.LOG_LEVEL. Worker logs surface in
// `wrangler tail` and the Cloudflare dashboard.

import type { Env } from '../env.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const shouldLog = (env: Env, level: Level): boolean =>
  ORDER[level] >= ORDER[env.LOG_LEVEL ?? 'info'];

const emit = (env: Env, level: Level, msg: string, extra?: Record<string, unknown>): void => {
  if (!shouldLog(env, level)) return;
  const line = { t: new Date().toISOString(), level, msg, ...(extra ?? {}) };
  // Console.* maps to Cloudflare logs. Never log secrets / JWTs.
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
};

export const log = {
  debug: (env: Env, msg: string, extra?: Record<string, unknown>) => emit(env, 'debug', msg, extra),
  info:  (env: Env, msg: string, extra?: Record<string, unknown>) => emit(env, 'info',  msg, extra),
  warn:  (env: Env, msg: string, extra?: Record<string, unknown>) => emit(env, 'warn',  msg, extra),
  error: (env: Env, msg: string, extra?: Record<string, unknown>) => emit(env, 'error', msg, extra),
};

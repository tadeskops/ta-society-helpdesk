// Response envelope helpers. Spec: tsh_requirement.md §5.1.
// Every response is { ok: boolean, data?: any, error?: string }.

import type { Env } from '../env.ts';

export interface OkBody<T> {
  ok: true;
  data: T;
}

export interface ErrBody {
  ok: false;
  error: string;
}

export type Envelope<T> = OkBody<T> | ErrBody;

const baseHeaders = (env: Env, req: Request): HeadersInit => {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim());
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] ?? '*';
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
};

export const ok = <T>(env: Env, req: Request, data: T, status = 200): Response =>
  new Response(JSON.stringify({ ok: true, data } satisfies OkBody<T>), {
    status,
    headers: baseHeaders(env, req),
  });

export const err = (env: Env, req: Request, message: string, status = 400): Response =>
  new Response(JSON.stringify({ ok: false, error: message } satisfies ErrBody), {
    status,
    headers: baseHeaders(env, req),
  });

export const preflight = (env: Env, req: Request): Response => {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim());
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] ?? '*';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Turnstile-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  });
};

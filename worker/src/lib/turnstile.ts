// Cloudflare Turnstile verification. Spec: tsh_requirement.md §17.3.
// Called from POST /issues only when FEATURE_DAILY_TURNSTILE is on.

import type { Env } from '../env.ts';
import { BadRequest, FeatureDisabled } from './errors.ts';
import { log } from './log.ts';

const ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const verifyTurnstile = async (env: Env, token: string | undefined, ip: string): Promise<void> => {
  if (!env.TURNSTILE_SECRET) {
    // Flag claims to be on but the secret is not configured.
    throw new FeatureDisabled('FEATURE_DAILY_TURNSTILE (no secret configured)');
  }
  if (!token) throw new BadRequest('Missing Turnstile token');

  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  if (ip) form.set('remoteip', ip);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', body: form });
  } catch (e) {
    log.error(env, 'turnstile_fetch_failed', { err: String(e) });
    throw new BadRequest('Turnstile verification failed (network)');
  }

  if (!res.ok) {
    log.warn(env, 'turnstile_http_error', { status: res.status });
    throw new BadRequest('Turnstile verification failed');
  }

  const body = (await res.json()) as { success: boolean; 'error-codes'?: string[] };
  if (!body.success) {
    log.warn(env, 'turnstile_rejected', { codes: body['error-codes'] });
    throw new BadRequest('Turnstile rejected the submission');
  }
};

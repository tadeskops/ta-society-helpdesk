// Google ID-token (JWT) verification against Google's JWKS.
// Spec: tsh_requirement.md §3.1.
//
// Caches the JWKS for 1 hour (Google rotates keys infrequently).
// On verify failure -> Unauthorized; on missing token -> caller decides
// (anonymous-allowed routes pass undefined).

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../env.ts';
import { Unauthorized } from '../lib/errors.ts';

const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
const getJwks = () => {
  if (!jwks) {
    jwks = createRemoteJWKSet(JWKS_URL, {
      cacheMaxAge: 60 * 60 * 1000,   // 1 h
      cooldownDuration: 30 * 1000,
    });
  }
  return jwks;
};

export interface Identity {
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  sub: string;
}

const bearer = (req: Request): string | undefined => {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : undefined;
};

export const verifyGoogleJwt = async (env: Env, req: Request): Promise<Identity | undefined> => {
  const token = bearer(req);
  if (!token) return undefined;

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getJwks(), {
      issuer: ISSUERS,
      audience: env.GOOGLE_OAUTH_CLIENT_ID,
    });
    payload = verified.payload;
  } catch (e) {
    throw new Unauthorized(`JWT verify failed: ${String((e as Error).message ?? e)}`);
  }

  const email = typeof payload['email'] === 'string' ? (payload['email'] as string).toLowerCase() : undefined;
  if (!email) throw new Unauthorized('JWT has no email claim');

  const name = typeof payload['name'] === 'string' ? (payload['name'] as string) : undefined;
  const picture = typeof payload['picture'] === 'string' ? (payload['picture'] as string) : undefined;

  return {
    email,
    emailVerified: payload['email_verified'] === true,
    sub: String(payload.sub ?? ''),
    ...(name !== undefined ? { name } : {}),
    ...(picture !== undefined ? { picture } : {}),
  };
};

export const requireIdentity = async (env: Env, req: Request): Promise<Identity> => {
  const id = await verifyGoogleJwt(env, req);
  if (!id) throw new Unauthorized();
  if (!id.emailVerified) throw new Unauthorized('Google email not verified');
  return id;
};

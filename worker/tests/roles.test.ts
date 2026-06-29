import { describe, it, expect } from 'vitest';
import { resolveRoles, hasAny, isAtLeast } from '../src/auth/roles.ts';
import { ensureAllowed } from '../src/middleware/rbac.ts';
import { Forbidden, FeatureDisabled, Unauthorized } from '../src/lib/errors.ts';
import { DEFAULT_CONFIG } from '../src/config/defaults.ts';
import type { Ctx } from '../src/lib/ctx.ts';

const access = {
  managers:   ['mgr@x.com'],
  committee:  ['cmt@x.com', 'mgr@x.com'], // committee also on managers — additive
  developers: ['dev@x.com'],
};

describe('resolveRoles', () => {
  it('returns UNKNOWN for anonymous', () => {
    const r = resolveRoles(access, null);
    expect(r.primary).toBe('UNKNOWN');
    expect(r.all).toEqual(['UNKNOWN']);
    expect(r.email).toBeNull();
  });
  it('returns the highest precedence as primary', () => {
    expect(resolveRoles(access, 'dev@x.com').primary).toBe('DEVELOPER');
    expect(resolveRoles(access, 'cmt@x.com').primary).toBe('COMMITTEE');
    expect(resolveRoles(access, 'mgr@x.com').primary).toBe('COMMITTEE'); // additive
  });
  it('RESIDENT for signed-in emails not on any privileged list', () => {
    const r = resolveRoles(access, 'random@x.com');
    expect(r.primary).toBe('RESIDENT');
    expect(r.all).toContain('RESIDENT');
  });
  it('every signed-in user is at minimum a Resident (additive)', () => {
    const dev = resolveRoles(access, 'dev@x.com');
    expect(dev.all).toContain('RESIDENT');
  });
  it('is case-insensitive', () => {
    expect(resolveRoles(access, 'DEV@X.COM').primary).toBe('DEVELOPER');
  });
});

describe('hasAny / isAtLeast', () => {
  const dev = resolveRoles(access, 'dev@x.com');
  const mgr = resolveRoles(access, 'mgr@x.com'); // also committee
  const anon = resolveRoles(access, null);
  const res = resolveRoles(access, 'random@x.com');
  it('hasAny matches any element of the role set', () => {
    expect(hasAny(dev, 'DEVELOPER')).toBe(true);
    expect(hasAny(mgr, 'COMMITTEE', 'MANAGER')).toBe(true);
    expect(hasAny(anon, 'DEVELOPER', 'MANAGER')).toBe(false);
    expect(hasAny(res, 'RESIDENT')).toBe(true);
  });
  it('isAtLeast walks the precedence chain', () => {
    expect(isAtLeast(dev, 'MANAGER')).toBe(true);
    expect(isAtLeast(mgr, 'DEVELOPER')).toBe(false);
    expect(isAtLeast(anon, 'UNKNOWN')).toBe(true);
    expect(isAtLeast(anon, 'RESIDENT')).toBe(false);
    expect(isAtLeast(res, 'RESIDENT')).toBe(true);
    expect(isAtLeast(res, 'MANAGER')).toBe(false);
  });
});

const mkCtx = (email: string | null, opts: { config?: any; identity?: any } = {}): Ctx => ({
  env: {} as any,
  req: new Request('https://x/'),
  url: new URL('https://x/'),
  roles: resolveRoles(access, email),
  config: opts.config ?? DEFAULT_CONFIG,
  access,
  ip: '127.0.0.1',
  ...(opts.identity ? { identity: opts.identity } : {}),
});

describe('ensureAllowed', () => {
  it('passes when no constraints', () => {
    expect(() => ensureAllowed(mkCtx(null), {})).not.toThrow();
  });
  it('throws Unauthorized when identity required + missing', () => {
    expect(() => ensureAllowed(mkCtx(null), { requireIdentity: true })).toThrow(Unauthorized);
  });
  it('throws Forbidden on role mismatch', () => {
    const ctx = mkCtx('mgr@x.com', { identity: { email: 'mgr@x.com', emailVerified: true, sub: '1' } });
    expect(() => ensureAllowed(ctx, { roles: ['DEVELOPER'], requireIdentity: true })).toThrow(Forbidden);
  });
  it('throws FeatureDisabled when flag is off', () => {
    const cfg = { ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features, FEATURE_DAILY_TRACK: false } };
    expect(() => ensureAllowed(mkCtx(null, { config: cfg }), { flags: ['FEATURE_DAILY_TRACK'] }))
      .toThrow(FeatureDisabled);
  });
  it('passes when role + flag + identity all check out', () => {
    const ctx = mkCtx('dev@x.com', { identity: { email: 'dev@x.com', emailVerified: true, sub: '1' } });
    expect(() => ensureAllowed(ctx, {
      roles: ['DEVELOPER'], flags: ['FEATURE_DAILY_TRACK'], requireIdentity: true,
    })).not.toThrow();
  });
});

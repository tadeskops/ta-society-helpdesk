import { describe, it, expect } from 'vitest';
import {
  resolveRoles, hasAny, isAtLeast,
  canViewTreasuryLedger, canActOnTreasuryLedger, isTreasuryGrandfatherActive,
} from '../src/auth/roles.ts';
import { ensureAllowed } from '../src/middleware/rbac.ts';
import { Forbidden, FeatureDisabled, Unauthorized } from '../src/lib/errors.ts';
import { DEFAULT_CONFIG } from '../src/config/defaults.ts';
import type { Ctx } from '../src/lib/ctx.ts';

const access = {
  managers:   ['mgr@x.com'],
  committee:  ['cmt@x.com', 'mgr@x.com'], // committee also on managers — additive
  admins: ['dev@x.com'],
  treasurer: [] as string[],
  chairman:  [] as string[],
  secretary: [] as string[],
};

describe('resolveRoles', () => {
  it('returns UNKNOWN for anonymous', () => {
    const r = resolveRoles(access, null);
    expect(r.primary).toBe('UNKNOWN');
    expect(r.all).toEqual(['UNKNOWN']);
    expect(r.email).toBeNull();
  });
  it('returns the highest precedence as primary', () => {
    expect(resolveRoles(access, 'dev@x.com').primary).toBe('ADMIN');
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
    expect(resolveRoles(access, 'DEV@X.COM').primary).toBe('ADMIN');
  });
});

describe('hasAny / isAtLeast', () => {
  const dev = resolveRoles(access, 'dev@x.com');
  const mgr = resolveRoles(access, 'mgr@x.com'); // also committee
  const anon = resolveRoles(access, null);
  const res = resolveRoles(access, 'random@x.com');
  it('hasAny matches any element of the role set', () => {
    expect(hasAny(dev, 'ADMIN')).toBe(true);
    expect(hasAny(mgr, 'COMMITTEE', 'MANAGER')).toBe(true);
    expect(hasAny(anon, 'ADMIN', 'MANAGER')).toBe(false);
    expect(hasAny(res, 'RESIDENT')).toBe(true);
  });
  it('isAtLeast walks the precedence chain', () => {
    expect(isAtLeast(dev, 'MANAGER')).toBe(true);
    expect(isAtLeast(mgr, 'ADMIN')).toBe(false);
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
    expect(() => ensureAllowed(ctx, { roles: ['ADMIN'], requireIdentity: true })).toThrow(Forbidden);
  });
  it('throws FeatureDisabled when flag is off', () => {
    const cfg = { ...DEFAULT_CONFIG, features: { ...DEFAULT_CONFIG.features, FEATURE_DAILY_TRACK: false } };
    expect(() => ensureAllowed(mkCtx(null, { config: cfg }), { flags: ['FEATURE_DAILY_TRACK'] }))
      .toThrow(FeatureDisabled);
  });
  it('passes when role + flag + identity all check out', () => {
    const ctx = mkCtx('dev@x.com', { identity: { email: 'dev@x.com', emailVerified: true, sub: '1' } });
    expect(() => ensureAllowed(ctx, {
      roles: ['ADMIN'], flags: ['FEATURE_DAILY_TRACK'], requireIdentity: true,
    })).not.toThrow();
  });
});

// ------------------------------------------------------------ treasury tags

describe('additive treasury tags (TREASURER / CHAIRMAN / SECRETARY)', () => {
  it('appends TREASURER/CHAIRMAN/SECRETARY to roles.all without changing primary', () => {
    const tagged = {
      ...access,
      treasurer: ['cmt@x.com'],
      chairman:  ['cmt@x.com'],
      secretary: ['random@x.com'],
    };
    const cmt = resolveRoles(tagged, 'cmt@x.com');
    // Primary stays COMMITTEE (highest precedence), tags appear in `all`.
    expect(cmt.primary).toBe('COMMITTEE');
    expect(cmt.all).toContain('TREASURER');
    expect(cmt.all).toContain('CHAIRMAN');
    expect(cmt.all).not.toContain('SECRETARY');

    const rand = resolveRoles(tagged, 'random@x.com');
    expect(rand.primary).toBe('RESIDENT'); // secretary is NOT in precedence
    expect(rand.all).toContain('SECRETARY');
  });

  it('resolveRoles matches new tag lists case-insensitively', () => {
    const tagged = { ...access, treasurer: ['Foo@X.COM'] };
    const foo = resolveRoles(tagged, 'FOO@x.COM');
    expect(foo.all).toContain('TREASURER');
  });

  it('isAtLeast ignores additive tags (must use hasAny)', () => {
    const tagged = { ...access, treasurer: ['t@x.com'] };
    const t = resolveRoles(tagged, 't@x.com');
    // Treasurer isn't in the precedence chain — user is just RESIDENT+TREASURER
    expect(isAtLeast(t, 'MANAGER')).toBe(false);
    expect(hasAny(t, 'TREASURER')).toBe(true);
  });
});

describe('isTreasuryGrandfatherActive', () => {
  it('true when all three lists empty', () => {
    expect(isTreasuryGrandfatherActive(access)).toBe(true);
  });
  it('false as soon as ANY of the three is seeded', () => {
    expect(isTreasuryGrandfatherActive({ ...access, treasurer: ['x@x.com'] })).toBe(false);
    expect(isTreasuryGrandfatherActive({ ...access, chairman:  ['x@x.com'] })).toBe(false);
    expect(isTreasuryGrandfatherActive({ ...access, secretary: ['x@x.com'] })).toBe(false);
  });
});

describe('canViewTreasuryLedger', () => {
  const cfgOff = DEFAULT_CONFIG;
  const cfgSecOn = {
    ...DEFAULT_CONFIG,
    features: { ...DEFAULT_CONFIG.features, FEATURE_TREASURY_SECRETARY_ACCESS: true },
  };

  it('ADMIN always allowed', () => {
    const dev = resolveRoles(access, 'dev@x.com');
    expect(canViewTreasuryLedger(dev, access, cfgOff)).toBe(true);
    // ADMIN unaffected by grandfather off/on
    const seeded = { ...access, treasurer: ['t@x.com'] };
    expect(canViewTreasuryLedger(dev, seeded, cfgOff)).toBe(true);
  });

  it('CHAIRMAN/TREASURER always allowed regardless of secretary flag', () => {
    const seeded = { ...access, treasurer: ['tre@x.com'], chairman: ['chr@x.com'] };
    expect(canViewTreasuryLedger(resolveRoles(seeded, 'tre@x.com'), seeded, cfgOff)).toBe(true);
    expect(canViewTreasuryLedger(resolveRoles(seeded, 'chr@x.com'), seeded, cfgOff)).toBe(true);
  });

  it('SECRETARY denied when flag OFF, allowed when flag ON', () => {
    const seeded = { ...access, secretary: ['sec@x.com'], treasurer: ['tre@x.com'] };
    const sec = resolveRoles(seeded, 'sec@x.com');
    expect(canViewTreasuryLedger(sec, seeded, cfgOff)).toBe(false);
    expect(canViewTreasuryLedger(sec, seeded, cfgSecOn)).toBe(true);
  });

  it('grandfather: plain COMMITTEE allowed while all three lists empty', () => {
    const cmt = resolveRoles(access, 'cmt@x.com');
    expect(canViewTreasuryLedger(cmt, access, cfgOff)).toBe(true);
  });

  it('grandfather: plain COMMITTEE DENIED once any list is seeded', () => {
    const seeded = { ...access, treasurer: ['tre@x.com'] };
    const cmt = resolveRoles(seeded, 'cmt@x.com'); // still just COMMITTEE
    expect(canViewTreasuryLedger(cmt, seeded, cfgOff)).toBe(false);
  });

  it('MANAGER (non-committee) is NEVER covered by grandfather', () => {
    const mgrOnly = { ...access, managers: ['just-mgr@x.com'], committee: [] };
    const m = resolveRoles(mgrOnly, 'just-mgr@x.com');
    // Grandfather covers COMMITTEE+ADMIN, not MANAGER.
    expect(canViewTreasuryLedger(m, mgrOnly, cfgOff)).toBe(false);
  });

  it('RESIDENT / anonymous always denied', () => {
    expect(canViewTreasuryLedger(resolveRoles(access, 'random@x.com'), access, cfgOff)).toBe(false);
    expect(canViewTreasuryLedger(resolveRoles(access, null), access, cfgOff)).toBe(false);
  });
});

describe('canActOnTreasuryLedger', () => {
  it('ADMIN/CHAIRMAN/TREASURER always allowed', () => {
    const seeded = { ...access, treasurer: ['tre@x.com'], chairman: ['chr@x.com'] };
    expect(canActOnTreasuryLedger(resolveRoles(access, 'dev@x.com'), access)).toBe(true);
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'tre@x.com'), seeded)).toBe(true);
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'chr@x.com'), seeded)).toBe(true);
  });

  it('SECRETARY is NEVER allowed to act (view-only, even with flag on)', () => {
    const seeded = { ...access, secretary: ['sec@x.com'], treasurer: ['tre@x.com'] };
    const sec = resolveRoles(seeded, 'sec@x.com');
    expect(canActOnTreasuryLedger(sec, seeded)).toBe(false);
  });

  it('grandfather: COMMITTEE can act until any list is seeded', () => {
    const cmt = resolveRoles(access, 'cmt@x.com');
    expect(canActOnTreasuryLedger(cmt, access)).toBe(true);
    const seeded = { ...access, treasurer: ['tre@x.com'] };
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'cmt@x.com'), seeded)).toBe(false);
  });
});

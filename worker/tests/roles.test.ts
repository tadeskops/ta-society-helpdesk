import { describe, it, expect } from 'vitest';
import {
  resolveRoles, hasAny, isAtLeast,
  canViewTreasuryLedger, canActOnTreasuryLedger, isTreasuryGrandfatherActive,
  canEditAccessList, canToggleFeatureFlag, rankOf,
} from '../src/auth/roles.ts';
import { ensureAllowed } from '../src/middleware/rbac.ts';
import { Forbidden, FeatureDisabled, Unauthorized } from '../src/lib/errors.ts';
import { DEFAULT_CONFIG } from '../src/config/defaults.ts';
import type { Ctx } from '../src/lib/ctx.ts';

const access = {
  managers:    ['mgr@x.com'],
  committee:   ['cmt@x.com', 'mgr@x.com'], // committee also on managers — additive
  admins:      ['dev@x.com'],
  treasurer:   [] as string[],
  chairman:    [] as string[],
  secretary:   [] as string[],
  contributor: [] as string[],
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

describe('hasAny / isAtLeast (strict 8-tier hierarchy)', () => {
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
  it('isAtLeast walks the 8-tier precedence chain', () => {
    expect(isAtLeast(dev, 'MANAGER')).toBe(true);
    expect(isAtLeast(dev, 'CHAIRMAN')).toBe(true);   // ADMIN > CHAIRMAN
    expect(isAtLeast(mgr, 'ADMIN')).toBe(false);
    expect(isAtLeast(mgr, 'COMMITTEE')).toBe(true);
    expect(isAtLeast(mgr, 'TREASURER')).toBe(false); // COMMITTEE < TREASURER
    expect(isAtLeast(anon, 'UNKNOWN')).toBe(true);
    expect(isAtLeast(anon, 'RESIDENT')).toBe(false);
    expect(isAtLeast(res, 'RESIDENT')).toBe(true);
    expect(isAtLeast(res, 'MANAGER')).toBe(false);
  });
  it('ADMIN inherits every capability below (strict linear chain)', () => {
    expect(isAtLeast(dev, 'ADMIN')).toBe(true);
    expect(isAtLeast(dev, 'CHAIRMAN')).toBe(true);
    expect(isAtLeast(dev, 'SECRETARY')).toBe(true);
    expect(isAtLeast(dev, 'TREASURER')).toBe(true);
    expect(isAtLeast(dev, 'COMMITTEE')).toBe(true);
    expect(isAtLeast(dev, 'CONTRIBUTOR')).toBe(true);
    expect(isAtLeast(dev, 'MANAGER')).toBe(true);
    expect(isAtLeast(dev, 'RESIDENT')).toBe(true);
  });
});

const mkCtx = (email: string | null, opts: { config?: any; identity?: any; access?: any } = {}): Ctx => ({
  env: {} as any,
  req: new Request('https://x/'),
  url: new URL('https://x/'),
  roles: resolveRoles(opts.access ?? access, email),
  config: opts.config ?? DEFAULT_CONFIG,
  access: opts.access ?? access,
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

// ------------------------------------------------------------ hierarchy tags

describe('strict 8-tier hierarchy — CHAIRMAN/SECRETARY/TREASURER as first-class tiers', () => {
  it('primary becomes CHAIRMAN/SECRETARY/TREASURER when the email is on that list only', () => {
    const seeded = {
      ...access,
      chairman:  ['chr@x.com'],
      secretary: ['sec@x.com'],
      treasurer: ['tre@x.com'],
    };
    expect(resolveRoles(seeded, 'chr@x.com').primary).toBe('CHAIRMAN');
    expect(resolveRoles(seeded, 'sec@x.com').primary).toBe('SECRETARY');
    expect(resolveRoles(seeded, 'tre@x.com').primary).toBe('TREASURER');
  });
  it('CHAIRMAN outranks SECRETARY outranks TREASURER outranks COMMITTEE', () => {
    expect(rankOf('CHAIRMAN')).toBeLessThan(rankOf('SECRETARY'));
    expect(rankOf('SECRETARY')).toBeLessThan(rankOf('TREASURER'));
    expect(rankOf('TREASURER')).toBeLessThan(rankOf('COMMITTEE'));
    expect(rankOf('COMMITTEE')).toBeLessThan(rankOf('CONTRIBUTOR'));
    expect(rankOf('CONTRIBUTOR')).toBeLessThan(rankOf('MANAGER'));
    expect(rankOf('MANAGER')).toBeLessThan(rankOf('RESIDENT'));
  });
  it('CONTRIBUTOR sits strictly between COMMITTEE and MANAGER', () => {
    const seeded = { ...access, contributor: ['con@x.com'] };
    const con = resolveRoles(seeded, 'con@x.com');
    expect(con.primary).toBe('CONTRIBUTOR');
    expect(isAtLeast(con, 'MANAGER')).toBe(true);
    expect(isAtLeast(con, 'COMMITTEE')).toBe(false);
  });
  it('resolveRoles matches new tier lists case-insensitively', () => {
    const seeded = { ...access, treasurer: ['Foo@X.COM'] };
    const foo = resolveRoles(seeded, 'FOO@x.COM');
    expect(foo.all).toContain('TREASURER');
    expect(foo.primary).toBe('TREASURER');
  });
});

describe('isTreasuryGrandfatherActive', () => {
  it('true when chairman/secretary/treasurer all empty', () => {
    expect(isTreasuryGrandfatherActive(access)).toBe(true);
  });
  it('false as soon as ANY of the three is seeded', () => {
    expect(isTreasuryGrandfatherActive({ ...access, treasurer: ['x@x.com'] })).toBe(false);
    expect(isTreasuryGrandfatherActive({ ...access, chairman:  ['x@x.com'] })).toBe(false);
    expect(isTreasuryGrandfatherActive({ ...access, secretary: ['x@x.com'] })).toBe(false);
  });
});

describe('canViewTreasuryLedger (post-hierarchy: inherits via isAtLeast TREASURER)', () => {
  const cfgOff = DEFAULT_CONFIG;

  it('ADMIN always allowed', () => {
    const dev = resolveRoles(access, 'dev@x.com');
    expect(canViewTreasuryLedger(dev, access, cfgOff)).toBe(true);
    const seeded = { ...access, treasurer: ['t@x.com'] };
    expect(canViewTreasuryLedger(dev, seeded, cfgOff)).toBe(true);
  });

  it('CHAIRMAN / SECRETARY / TREASURER always allowed (strict-hierarchy inheritance)', () => {
    const seeded = {
      ...access,
      chairman:  ['chr@x.com'],
      secretary: ['sec@x.com'],
      treasurer: ['tre@x.com'],
    };
    expect(canViewTreasuryLedger(resolveRoles(seeded, 'chr@x.com'), seeded, cfgOff)).toBe(true);
    expect(canViewTreasuryLedger(resolveRoles(seeded, 'sec@x.com'), seeded, cfgOff)).toBe(true);
    expect(canViewTreasuryLedger(resolveRoles(seeded, 'tre@x.com'), seeded, cfgOff)).toBe(true);
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
    expect(canViewTreasuryLedger(m, mgrOnly, cfgOff)).toBe(false);
  });

  it('CONTRIBUTOR is denied (below COMMITTEE in the chain)', () => {
    const seeded = { ...access, contributor: ['con@x.com'] };
    const con = resolveRoles(seeded, 'con@x.com');
    expect(canViewTreasuryLedger(con, seeded, cfgOff)).toBe(false);
  });

  it('RESIDENT / anonymous always denied', () => {
    expect(canViewTreasuryLedger(resolveRoles(access, 'random@x.com'), access, cfgOff)).toBe(false);
    expect(canViewTreasuryLedger(resolveRoles(access, null), access, cfgOff)).toBe(false);
  });
});

describe('canActOnTreasuryLedger', () => {
  it('ADMIN / CHAIRMAN / SECRETARY / TREASURER all allowed under strict hierarchy', () => {
    const seeded = {
      ...access,
      chairman:  ['chr@x.com'],
      secretary: ['sec@x.com'],
      treasurer: ['tre@x.com'],
    };
    expect(canActOnTreasuryLedger(resolveRoles(access, 'dev@x.com'), access)).toBe(true);
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'chr@x.com'), seeded)).toBe(true);
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'sec@x.com'), seeded)).toBe(true);
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'tre@x.com'), seeded)).toBe(true);
  });

  it('grandfather: COMMITTEE can act until any list is seeded', () => {
    const cmt = resolveRoles(access, 'cmt@x.com');
    expect(canActOnTreasuryLedger(cmt, access)).toBe(true);
    const seeded = { ...access, treasurer: ['tre@x.com'] };
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'cmt@x.com'), seeded)).toBe(false);
  });

  it('CONTRIBUTOR / MANAGER / RESIDENT never act via this helper', () => {
    const seeded = { ...access, contributor: ['con@x.com'], treasurer: ['tre@x.com'] };
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'con@x.com'), seeded)).toBe(false);
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'mgr@x.com'), seeded)).toBe(false);
    expect(canActOnTreasuryLedger(resolveRoles(seeded, 'random@x.com'), seeded)).toBe(false);
  });
});

describe('canEditAccessList (delegated editing rule)', () => {
  const seeded = {
    ...access,
    chairman:    ['chr@x.com'],
    secretary:   ['sec@x.com'],
    treasurer:   ['tre@x.com'],
    contributor: ['con@x.com'],
  };
  const admin      = resolveRoles(seeded, 'dev@x.com');
  const chairman   = resolveRoles(seeded, 'chr@x.com');
  const secretary  = resolveRoles(seeded, 'sec@x.com');
  const treasurer  = resolveRoles(seeded, 'tre@x.com');
  const committee  = resolveRoles(seeded, 'cmt@x.com');
  const contributor = resolveRoles(seeded, 'con@x.com');
  const manager    = resolveRoles(seeded, 'mgr@x.com'); // also on committee → primary=COMMITTEE
  const resident   = resolveRoles(seeded, 'random@x.com');

  it('ADMIN may edit every list including admins', () => {
    for (const r of ['admins','chairman','secretary','treasurer','committee','contributor','managers'] as const) {
      expect(canEditAccessList(admin, r)).toBe(true);
    }
  });
  it('CHAIRMAN may edit secretary/treasurer/committee/contributor/managers but NOT admins or self', () => {
    expect(canEditAccessList(chairman, 'admins')).toBe(false);
    expect(canEditAccessList(chairman, 'chairman')).toBe(false);
    expect(canEditAccessList(chairman, 'secretary')).toBe(true);
    expect(canEditAccessList(chairman, 'treasurer')).toBe(true);
    expect(canEditAccessList(chairman, 'committee')).toBe(true);
    expect(canEditAccessList(chairman, 'contributor')).toBe(true);
    expect(canEditAccessList(chairman, 'managers')).toBe(true);
  });
  it('SECRETARY may edit treasurer/committee/contributor/managers only', () => {
    expect(canEditAccessList(secretary, 'chairman')).toBe(false);
    expect(canEditAccessList(secretary, 'secretary')).toBe(false);
    expect(canEditAccessList(secretary, 'treasurer')).toBe(true);
    expect(canEditAccessList(secretary, 'committee')).toBe(true);
    expect(canEditAccessList(secretary, 'contributor')).toBe(true);
    expect(canEditAccessList(secretary, 'managers')).toBe(true);
  });
  it('TREASURER may edit committee/contributor/managers only', () => {
    expect(canEditAccessList(treasurer, 'secretary')).toBe(false);
    expect(canEditAccessList(treasurer, 'treasurer')).toBe(false);
    expect(canEditAccessList(treasurer, 'committee')).toBe(true);
    expect(canEditAccessList(treasurer, 'contributor')).toBe(true);
    expect(canEditAccessList(treasurer, 'managers')).toBe(true);
  });
  it('COMMITTEE may edit contributor/managers only', () => {
    expect(canEditAccessList(committee, 'treasurer')).toBe(false);
    expect(canEditAccessList(committee, 'committee')).toBe(false);
    expect(canEditAccessList(committee, 'contributor')).toBe(true);
    expect(canEditAccessList(committee, 'managers')).toBe(true);
  });
  it('CONTRIBUTOR may edit managers only', () => {
    expect(canEditAccessList(contributor, 'committee')).toBe(false);
    expect(canEditAccessList(contributor, 'contributor')).toBe(false);
    expect(canEditAccessList(contributor, 'managers')).toBe(true);
  });
  it('MANAGER / RESIDENT may edit nothing', () => {
    // manager fixture is actually promoted to COMMITTEE via additive
    // list membership above; test the pure MANAGER case explicitly.
    const mgrOnly = { ...seeded, committee: ['cmt@x.com'], managers: ['pure-mgr@x.com'] };
    const pureMgr = resolveRoles(mgrOnly, 'pure-mgr@x.com');
    for (const r of ['admins','chairman','secretary','treasurer','committee','contributor','managers'] as const) {
      expect(canEditAccessList(pureMgr, r)).toBe(false);
      expect(canEditAccessList(resident, r)).toBe(false);
    }
    // manager fixture's real primary is COMMITTEE (multi-list membership),
    // so it CAN edit contributor + managers — assert that separately:
    expect(manager.primary).toBe('COMMITTEE');
    expect(canEditAccessList(manager, 'managers')).toBe(true);
  });
});

describe('canToggleFeatureFlag (delegated flag toggle)', () => {
  const cfgAdminOnly = DEFAULT_CONFIG;
  const cfgDelegated = {
    ...DEFAULT_CONFIG,
    system: {
      ...DEFAULT_CONFIG.system,
      flagDelegation: {
        FEATURE_TREASURY_MANAGER_APPROVE: 'CHAIRMAN',
        FEATURE_DAILY_COST_FIELD:          'COMMITTEE',
      },
    },
  };
  const seeded = { ...access, chairman: ['chr@x.com'], secretary: ['sec@x.com'] };

  it('ADMIN may toggle every flag regardless of delegation', () => {
    const admin = resolveRoles(seeded, 'dev@x.com');
    expect(canToggleFeatureFlag(admin, 'FEATURE_DAILY_TRACK', cfgAdminOnly)).toBe(true);
    expect(canToggleFeatureFlag(admin, 'FEATURE_TREASURY_MANAGER_APPROVE', cfgDelegated)).toBe(true);
  });
  it('non-admin cannot toggle when no delegation configured', () => {
    const chr = resolveRoles(seeded, 'chr@x.com');
    expect(canToggleFeatureFlag(chr, 'FEATURE_DAILY_TRACK', cfgAdminOnly)).toBe(false);
  });
  it('CHAIRMAN may toggle a flag delegated to CHAIRMAN', () => {
    const chr = resolveRoles(seeded, 'chr@x.com');
    expect(canToggleFeatureFlag(chr, 'FEATURE_TREASURY_MANAGER_APPROVE', cfgDelegated)).toBe(true);
  });
  it('SECRETARY (below CHAIRMAN) may NOT toggle a flag delegated to CHAIRMAN', () => {
    const sec = resolveRoles(seeded, 'sec@x.com');
    expect(canToggleFeatureFlag(sec, 'FEATURE_TREASURY_MANAGER_APPROVE', cfgDelegated)).toBe(false);
  });
  it('CHAIRMAN inherits COMMITTEE-delegated flags (higher tier)', () => {
    const chr = resolveRoles(seeded, 'chr@x.com');
    expect(canToggleFeatureFlag(chr, 'FEATURE_DAILY_COST_FIELD', cfgDelegated)).toBe(true);
  });
  it('MANAGER cannot toggle a COMMITTEE-delegated flag (lower tier)', () => {
    const mgr = resolveRoles({ ...seeded, managers: ['pure-mgr@x.com'], committee: [] }, 'pure-mgr@x.com');
    expect(canToggleFeatureFlag(mgr, 'FEATURE_DAILY_COST_FIELD', cfgDelegated)).toBe(false);
  });
});

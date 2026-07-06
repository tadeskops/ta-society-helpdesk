// Unit tests for the seed-content filter used across
// announcements / banner / polls / events GET endpoints.
import { describe, it, expect } from 'vitest';
import { filterSeed, isSeedItem, SEED_AUTHOR } from '../src/lib/seed.ts';
import { DEFAULT_CONFIG } from '../src/config/defaults.ts';

const cfgWithFlag = (on: boolean) => ({
  ...DEFAULT_CONFIG,
  features: { ...DEFAULT_CONFIG.features, FEATURE_DAILY_SHOW_DEMO_ISSUES: on },
});

describe('lib/seed', () => {
  it('isSeedItem tags system@seed authors', () => {
    expect(isSeedItem({ createdBy: SEED_AUTHOR })).toBe(true);
    expect(isSeedItem({ createdBy: 'mgr@x.com' })).toBe(false);
    expect(isSeedItem(undefined)).toBe(false);
  });

  it('filterSeed strips seed items when flag is off (default)', () => {
    const items = [
      { id: 'a', createdBy: 'mgr@x.com', title: 'real' },
      { id: 'b', createdBy: SEED_AUTHOR, title: 'seed' },
      { id: 'c', createdBy: 'cmt@x.com', title: 'real2' },
    ];
    const out = filterSeed(items, cfgWithFlag(false));
    expect(out.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('filterSeed keeps seed items when FEATURE_DAILY_SHOW_DEMO_ISSUES is on', () => {
    const items = [
      { id: 'a', createdBy: 'mgr@x.com' },
      { id: 'b', createdBy: SEED_AUTHOR },
    ];
    const out = filterSeed(items, cfgWithFlag(true));
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('FEATURE_DAILY_SHOW_DEMO_ISSUES default is false (fail-closed)', () => {
    expect(DEFAULT_CONFIG.features['FEATURE_DAILY_SHOW_DEMO_ISSUES']).toBe(false);
  });
});

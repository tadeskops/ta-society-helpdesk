// Seed/demo content filter. Items authored by "system@seed" are
// sample-data placeholders shipped in the initial config; they're hidden
// from residents unless FEATURE_DAILY_SHOW_DEMO_ISSUES is turned on
// (same flag that gates seed:demo issues on the public board — reusing
// one switch keeps ops simple).

import type { SiteConfig } from '../config/defaults.ts';
import { isFeatureOn } from '../config/defaults.ts';

export const SEED_AUTHOR = 'system@seed';

export const isSeedItem = (it: { createdBy?: string } | undefined | null): boolean =>
  !!it && it.createdBy === SEED_AUTHOR;

export const filterSeed = <T extends { createdBy?: string }>(items: T[], cfg: SiteConfig): T[] => {
  if (isFeatureOn(cfg, 'FEATURE_DAILY_SHOW_DEMO_ISSUES')) return items;
  return items.filter((it) => !isSeedItem(it));
};

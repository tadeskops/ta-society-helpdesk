// EV Charging Services — resident-facing routes (Phase 1: /ev/config).
// -----------------------------------------------------------------------------
// Master feature flag: FEATURE_TSH_EV_CHARGING. Every /ev/* endpoint is
// gated by it. Sub-features (booking, receipt, admin dashboard, mirror,
// rfid, registration, support) have their own FEATURE_TSH_EV_* flag and
// are added in subsequent phases (see tsh_requirement.md §23).
//
// GET /ev/config — signed-in only (any authenticated society user). Returns
// the ev block from site.json (merged with defaults) plus a subFlags map
// so the client can render each sub-panel without a second /config round-trip.
//
// Storage: no persistent state in Phase 1. Phase 2 adds config/ev-bookings.json.
//
// Spec: tsh_requirement.md §23.

import type { Router } from '../lib/router.ts';
import type { Ctx } from '../lib/ctx.ts';
import { ok } from '../lib/envelope.ts';
import { ensureAllowed } from '../middleware/rbac.ts';
import { isFeatureOn } from '../config/defaults.ts';

// Master flag — every /ev/* handler passes it via ensureAllowed({ flags }).
export const FEATURE = 'FEATURE_TSH_EV_CHARGING';

// Sub-feature flags — exported so tests and the settings page can reference
// them without magic strings. Each one gates its own set of routes / UI
// blocks; see tsh_requirement.md §23.1 for the ship queue.
export const FEATURE_BOOKING          = 'FEATURE_TSH_EV_BOOKING';
export const FEATURE_RECEIPT          = 'FEATURE_TSH_EV_RECEIPT';
export const FEATURE_ADMIN_DASHBOARD  = 'FEATURE_TSH_EV_ADMIN_DASHBOARD';
export const FEATURE_AUTO_REPORTS     = 'FEATURE_TSH_EV_AUTO_REPORTS';
export const FEATURE_RFID             = 'FEATURE_TSH_EV_RFID';
export const FEATURE_REGISTRATION     = 'FEATURE_TSH_EV_REGISTRATION';
export const FEATURE_SUPPORT          = 'FEATURE_TSH_EV_SUPPORT';

// Shallow-merge a site.json override onto a defaults record. Preserves
// primitive types where the override supplies a value of the right type;
// falls back to the default otherwise. Kept local to this file — the
// merge is deliberately shallow so admins can drop a partial block into
// site.json without having to re-declare every leaf.
const mergeShallow = <T extends Record<string, unknown>>(
  defaults: T,
  override: unknown,
): T => {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return defaults;
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    // Only substitute when types match (or both are objects — deep-merge
    // is handled one level up by the caller for nested blocks).
    const dv = (defaults as Record<string, unknown>)[k];
    if (typeof dv === typeof v) out[k] = v;
    else if (dv === undefined) out[k] = v;
  }
  return out as T;
};

// Compute the effective ev block by merging site.json → system.ev onto
// the baked-in defaults. Sub-blocks (station, booking, provider, etc.)
// are shallow-merged individually so an admin can override just one
// leaf without dropping the whole sibling set.
const resolveEvConfig = (ctx: Ctx): {
  station: Record<string, unknown>;
  booking: Record<string, unknown>;
  usageGuidelines: string[];
  provider: Record<string, unknown>;
  faqs: Array<{ q: string; a: string }>;
  helpline: Record<string, unknown>;
  reports: Record<string, unknown>;
} => {
  const sysEv = (ctx.config.system as Record<string, unknown>).ev as Record<string, unknown> | undefined;
  const defaults = ((ctx.config.system as Record<string, unknown>).ev ?? {}) as Record<string, unknown>;
  const src = (sysEv ?? {}) as Record<string, unknown>;
  // Both defaults and src refer to the same block because config/loader.ts
  // shallow-merges site.json onto DEFAULT_CONFIG at load time. We still
  // pull leaf-level guarantees so a malformed override does not undefine
  // a required field. Keep the resolver defensive.
  const stationDefaults = { id: 'ev-1', name: 'EV Charger #1', location: 'Basement 1', capacityKw: 7.4, enabled: true };
  const bookingDefaults = {
    stepMinutes: 30, minDurationMinutes: 30, maxDurationMinutes: 180,
    bufferMinutes: 5, advanceWindowDays: 7, maxActivePerFlat: 1,
    openMin: 360, closeMin: 1380, requiresApproval: false, blackoutDates: [] as string[],
  };
  const providerDefaults = { name: '', androidUrl: '', iosUrl: '', website: '', email: '', tollFree: '' };
  const helplineDefaults = { directoryEntryId: '' };
  const reportsDefaults  = { template: '', mirrorCron: 'monthly' as const };
  const station  = mergeShallow(stationDefaults,  (src['station']  ?? defaults['station']));
  const booking  = mergeShallow(bookingDefaults,  (src['booking']  ?? defaults['booking']));
  const provider = mergeShallow(providerDefaults, (src['provider'] ?? defaults['provider']));
  const helpline = mergeShallow(helplineDefaults, (src['helpline'] ?? defaults['helpline']));
  const reports  = mergeShallow(reportsDefaults,  (src['reports']  ?? defaults['reports']));
  const rawGuides = (src['usageGuidelines'] ?? defaults['usageGuidelines']);
  const usageGuidelines = Array.isArray(rawGuides)
    ? rawGuides.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  const rawFaqs = (src['faqs'] ?? defaults['faqs']);
  const faqs = Array.isArray(rawFaqs)
    ? rawFaqs
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({ q: String(r['q'] ?? ''), a: String(r['a'] ?? '') }))
        .filter((r) => r.q && r.a)
    : [];
  return { station, booking, usageGuidelines, provider, faqs, helpline, reports };
};

// ---- Routes -----------------------------------------------------------------
export const mountEvCharging = (r: Router): void => {
  // GET /ev/config — signed-in only. Returns the ev block plus a
  // subFlags map so the client can render / hide each sub-panel in
  // one round-trip.
  r.get('/ev/config', async (ctx: Ctx) => {
    ensureAllowed(ctx, { flags: [FEATURE], requireIdentity: true });
    const ev = resolveEvConfig(ctx);
    const subFlags = {
      booking:         isFeatureOn(ctx.config, FEATURE_BOOKING),
      receipt:         isFeatureOn(ctx.config, FEATURE_RECEIPT),
      adminDashboard:  isFeatureOn(ctx.config, FEATURE_ADMIN_DASHBOARD),
      autoReports:     isFeatureOn(ctx.config, FEATURE_AUTO_REPORTS),
      rfid:            isFeatureOn(ctx.config, FEATURE_RFID),
      registration:    isFeatureOn(ctx.config, FEATURE_REGISTRATION),
      support:         isFeatureOn(ctx.config, FEATURE_SUPPORT),
    };
    return ok(ctx.env, ctx.req, {
      station:         ev.station,
      booking:         ev.booking,
      usageGuidelines: ev.usageGuidelines,
      provider:        ev.provider,
      faqs:            ev.faqs,
      helpline:        ev.helpline,
      reports: {
        // Never leak the report template body to residents in Phase 1;
        // only the cadence label is safe to publish. Phase 4 exposes the
        // template via a MANAGER+-gated endpoint.
        mirrorCron: ev.reports['mirrorCron'] ?? 'monthly',
      },
      subFlags,
    });
  });
};

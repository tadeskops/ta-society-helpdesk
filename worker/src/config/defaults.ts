// Default config baked into the Worker. Used when config/site.json is
// missing or malformed. CONFIG file values always override these.
// Spec: tsh_requirement.md §9.

export interface SiteConfig {
  version: number;
  features: Record<string, boolean>;
  // Tunables are mostly numeric knobs (cache TTLs, sizes, quorums) but a
  // few are string templates (e.g. TREASURY_RECEIPT_PATH). The `tunable()`
  // helper below narrows via typeof at call sites.
  tunables: Record<string, number | string>;
  lists: {
    towers: string[];
    categories: string[];
    subCategories: Record<string, string[]>;
    /** Optional treasury categories. Absent = fall back to DEFAULT_CONFIG. */
    treasuryCategories?: string[];
  };
  system: {
    issuesRepo: string;
    backupBranch: string;
    workerUrl: string;
    handoverPortalUrl: string;
    photoStorage: 'in-repo' | 'r2';
    turnstileSiteKey: string;
    logoUrl?: string;
    logoNameUrl?: string;
    weeklyReportUrl?: string;
    fullReportUrl?: string;
    reportBackupFreq?: 'weekly' | 'daily' | '3x-daily';
    backupEnabled?: boolean;
    /** HH:MM (24h, IST). Cron emits one snapshot per matched slot per day. */
    backupTimes?: string[];
    /** Days to retain backups under /backups (informational; cleanup is manual today). */
    backupRetentionDays?: number;
    /**
     * Feature-flag delegation map. Keys are FEATURE_* names, values are
     * the MINIMUM role (in the 8-tier hierarchy) permitted to toggle
     * that flag via `PATCH /features/:flag`. ADMIN may always toggle
     * every flag through PUT /config. Omit / empty = admin-only.
     *
     * Example: `{ "FEATURE_TREASURY_MANAGER_APPROVE": "CHAIRMAN" }` grants
     * chairman-and-above (chairman, admin) the right to flip that flag
     * without touching the full site.json.
     */
    flagDelegation?: Record<string, string>;
    /**
     * Vehicle Registry (FEATURE_TSH_VEHICLES) settings.
     *
     * `editorRoles` is the set-membership allowlist for full add/edit/
     * delete on config/vehicles.json. If absent / empty, the route falls
     * back to ['ADMIN','CHAIRMAN','SECRETARY','TREASURER','COMMITTEE',
     * 'MANAGER'].
     *
     * The remaining keys are RESERVED for v2 features (all gated by
     * their own FEATURE_* flag — default off — so present-day behaviour
     * is unchanged):
     *   • stickerRoles  — narrow PATCH /vehicles/:id/sticker path.
     *                     Meant for a future SECURITY_GUARD role that
     *                     may only update the sticker (and read the
     *                     flat) without touching the full record. Any
     *                     role name is valid here; admin adds
     *                     'SECURITY_GUARD' once that role exists in the
     *                     auth chain. Default = editorRoles.
     *   • bulkEmailRoles — POST /vehicles/emails/import. Manager-and-
     *                     above by default. Parses a pasted / uploaded
     *                     block of text (up to `maxBulkEmails` addresses)
     *                     and returns the extracted list for the admin
     *                     to attach to flats / vehicles.
     *   • residentAddRoles — POST /vehicles/mine. Path for residents to
     *                     self-register their own vehicle. Off until an
     *                     id-validation flow exists; when on, it also
     *                     honours `residentAddRequiresIdCheck` and
     *                     writes with `pending=true` when the caller has
     *                     not been verified.
     *   • residentAddRequiresIdCheck — fail-closed gate. When true (default),
     *                     resident self-add is rejected unless the caller's
     *                     identity has been validated against a flat.
     *   • maxBulkEmails — soft cap for the bulk import parser. Default 300.
     */
    vehicles?: {
      editorRoles?: string[];
      stickerRoles?: string[];
      bulkEmailRoles?: string[];
      residentAddRoles?: string[];
      residentAddRequiresIdCheck?: boolean;
      maxBulkEmails?: number;
    };
  };
  ui?: {
    defaultTheme?: 'dark' | 'light' | 'medium';
    defaultFontScale?: 'md' | 'lg' | 'xl';
    /**
     * Whether the compact header icons (Export, Download Latest, Sign in/out)
     * expand to show their text label.
     * - 'auto'   (default): labels visible at >=1100px, icons-only below
     * - 'never'           : always icon-only (good for tight headers / tenant brand pages)
     * - 'always'          : always show labels (good for kiosk / large-screen installs)
     * Mobile (<700px) is always icon-only regardless of this setting so the
     * userbox doesn't crowd the nav row.
     */
    headerIconExpand?: 'auto' | 'never' | 'always';
  };
}

export const DEFAULT_CONFIG: SiteConfig = {
  version: 1,
  features: {
    FEATURE_DAILY_TRACK:                  true,
    FEATURE_DAILY_ANONYMOUS_SUBMIT:       true,
    FEATURE_DAILY_PHOTO_UPLOAD:           true,
    FEATURE_DAILY_WHATSAPP_SHARE:         true,
    FEATURE_DAILY_COST_FIELD:             false,
    FEATURE_DAILY_PUBLIC_RESOLVED:        true,
    FEATURE_DAILY_PUBLIC_REJECTED:        false,
    FEATURE_DAILY_PUBLIC_PHOTOS:          true,
    FEATURE_DAILY_PUBLIC_PDF:             true,
    FEATURE_DAILY_AUDIT_LOG_UI:           true,
    FEATURE_DAILY_TURNSTILE:              true,
    FEATURE_DAILY_AUTOSAVE_DRAFT:         true,
    FEATURE_DAILY_REJECTED_FILTER:        true,
    FEATURE_DAILY_COMMITTEE_PHOTO:        false,
    FEATURE_DAILY_SEVERITY:               false,
    FEATURE_DAILY_SLA:                    false,
    FEATURE_DAILY_WEEKLY_REPORT:          false,
    FEATURE_DAILY_PUBLIC_BOARD:           true,
    FEATURE_DAILY_MANAGER_DASHBOARD:      true,
    FEATURE_DAILY_COMMITTEE_DASHBOARD:    true,
    FEATURE_DAILY_KPI_DASHBOARD:          true,
    FEATURE_DAILY_COMMITTEE_VIEW:         true,
    // Fail-closed: seeded/demo content (issues + system@seed items) stays
    // hidden unless a site explicitly turns this on. Prevents sample data
    // from leaking to residents when site.json is missing / malformed.
    FEATURE_DAILY_SHOW_DEMO_ISSUES:       false,
    FEATURE_DAILY_DIRECTORY:              true,
    FEATURE_DAILY_DIRECTORY_SERVICES:     true,
    FEATURE_DAILY_BANNER:                 true,
    FEATURE_DAILY_ANNOUNCEMENTS:          true,
    FEATURE_DAILY_POLLS:                  true,
    FEATURE_DAILY_EVENTS:                 true,
    FEATURE_DAILY_FLOATING_PALETTE:       true,
    FEATURE_DAILY_VISITOR_COUNTER:        true,
    FEATURE_DAILY_USER_ROLE_BADGE:        true,
    FEATURE_DAILY_EXPORT_PDF:             true,
    FEATURE_BOOKINGS_REPORT:              true,
    FEATURE_TSH_RESERVATIONS:             true,
    FEATURE_TSH_NOTIFICATIONS:            true,
    FEATURE_TSH_RESERVATIONS_CALENDAR:    false,
    // Treasury &amp; Reimbursements (§ treasury-requirements.md).
    // Master switch and per-capability toggles so committees can grant
    // the manager more or less without redeploying.
    FEATURE_TREASURY:                        true,
    FEATURE_TREASURY_MANAGER_APPROVE:        false,
    FEATURE_TREASURY_MANAGER_PAY:            false,
    FEATURE_TREASURY_MANAGER_RECORD_EXPENSE: true,
    FEATURE_TREASURY_RESIDENT_RAISE:         true,
    // Vehicle Registry (§Vehicle Registry). Signed-in residents can search
    // any vehicle by regNo to find the flat; add/edit/delete is gated by
    // system.vehicles.editorRoles (default: MANAGER, COMMITTEE, TREASURER,
    // SECRETARY, CHAIRMAN, ADMIN).
    FEATURE_TSH_VEHICLES:                    true,
    // Vehicle Registry v2 hooks (design-in, wire-later).
    // All default OFF — flipping them on in site.json activates the
    // corresponding narrow path without any code change.
    //  • EMAIL_FILTER: server-side per-caller filter — non-editors only
    //    see rows whose emails[] contains their signed-in email.
    //  • STICKER_PATCH: PATCH /vehicles/:id/sticker for a security-guard
    //    style role that may only touch the sticker field.
    //  • BULK_EMAILS: POST /vehicles/emails/import to accept a pasted /
    //    uploaded block of up to ~300 addresses; parser extracts and
    //    returns them for admin attachment.
    //  • RESIDENT_ADD: POST /vehicles/mine — resident self-registration.
    //    Gated by residentAddRequiresIdCheck (default true = fail closed).
    FEATURE_TSH_VEHICLES_EMAIL_FILTER:        false,
    FEATURE_TSH_VEHICLES_STICKER_PATCH:       false,
    FEATURE_TSH_VEHICLES_BULK_EMAILS:         false,
    FEATURE_TSH_VEHICLES_RESIDENT_ADD:        false,
    // DEPRECATED (2026-07-12): under the new strict 8-tier hierarchy
    // SECRETARY sits ABOVE TREASURER in the precedence chain and
    // inherits treasury view naturally, so this flag is a no-op. It is
    // retained in defaults for backward compatibility with existing
    // site.json files that reference it and will be removed once all
    // tenants have migrated. Do NOT rely on it in new code.
    FEATURE_TREASURY_SECRETARY_ACCESS:       false,
  },
  tunables: {
    // Auto-assign sweep: a `new` ticket older than this many hours is
    // promoted to `assigned` on the next scheduled tick. Default 4h.
    // (Legacy alias `DAILY_AUTO_ACK_HOURS` is still read by `tunable()` for
    // back-compat with existing config/site.json — see loader.ts.)
    DAILY_AUTO_ASSIGN_HOURS:    4,
    DAILY_ARCHIVE_AFTER_DAYS:   90,
    DAILY_PHOTO_MAX_PER_ISSUE:  6,
    DAILY_PHOTO_MAX_BYTES:      5242880,
    DAILY_PHOTO_MAX_DIM:        1600,
    DAILY_PHOTO_JPEG_QUALITY:   0.85,
    DAILY_RATE_LIMIT_SECONDS:   20,
    DAILY_DAILY_LIMIT:          20,
    DAILY_DESC_MIN:             5,
    DAILY_DESC_MAX:             2000,
    DAILY_LOCATION_MAX:         120,
    CONFIG_CACHE_SECONDS:       60,
    WHOAMI_CACHE_SECONDS:       5,
    DIRECTORY_CACHE_SECONDS:    120,
    BANNER_CACHE_SECONDS:       60,
    ANNOUNCEMENTS_CACHE_SECONDS: 60,
    EVENTS_CACHE_SECONDS:       60,
    POLLS_CACHE_SECONDS:        60,
    POLLS_VOTES_CACHE_SECONDS:  30,
    DAILY_NOTICE_TTL_DAYS:      7,
    RESERVATIONS_CACHE_SECONDS: 60,
    RESERVATION_PROOF_MAX_BYTES: 5_242_880,   // 5 MB per file
    RESERVATION_MAX_PROOFS:      5,           // per reservation
    NOTIFICATIONS_CACHE_SECONDS: 30,
    NOTIFICATIONS_MAX_ITEMS:     2000,
    NOTIFICATIONS_PER_USER_CAP:  200,
    CALENDAR_RETRY_MAX:          5,
    CALENDAR_QUEUE_CACHE_SECONDS: 60,
    // Treasury tunables. `TREASURY_APPROVAL_QUORUM` may be 1 (single
    // committee approval) or 2 (two committee approvals before Paid can
    // be clicked). Everything else is size / TTL.
    TREASURY_CACHE_SECONDS:      60,
    TREASURY_MAX_FILE_BYTES:     5_242_880,   // 5 MB per file
    TREASURY_MAX_FILES_PER_ITEM: 5,           // proofs OR payment slips
    TREASURY_ARCHIVE_AFTER_DAYS: 120,
    TREASURY_APPROVAL_QUORUM:    1,
    // Path template for receipt/proof binaries written into the treasury
    // private repo. Placeholders: {yearMonth} (UTC YYYY-MM), {kind}
    // ('proof' | 'payment' | 'receipt'), {id} (RMB-* or EXP-*), {seq}
    // (2-digit index within the batch), {name} (sanitised original filename).
    TREASURY_RECEIPT_PATH:       'treasury/receipts/{yearMonth}/{kind}/{id}/{seq}-{name}',
    // Vehicle Registry cache TTL. Small file (< 40 KB even for 500 rows)
    // so 120 s is plenty for search-heavy read workloads.
    VEHICLES_CACHE_SECONDS:      120,
  },
  lists: {
    towers:     ['A', 'B', 'C', 'Common Area'],
    categories: [
      'Lift',
      'Water',
      'Electricity',
      'Plumbing',
      'Cleaning',
      'Security',
      'Garden',
      'Pest Control',
      'Parking',
      'Waste Management',
      'Intercom',
      'Building & Civil',
      'Clubhouse',
      'Swimming Pool',
      'Gym',
      'CCTV',
      'Fire Safety',
      'Noise / Nuisance',
      'Vendor / Service',
      'Other',
    ],
    subCategories: {
      'Lift':             ['Stuck', 'Doors not closing', 'Buttons faulty', 'Display faulty', 'Noise', 'Slow / Erratic', 'Floor levelling', 'Power outage', 'Other'],
      'Water':            ['No supply', 'Low pressure', 'Leak', 'Discolouration', 'Quality / Taste', 'Hot water', 'Tank overflow', 'Other'],
      'Electricity':      ['Common-area outage', 'Flat outage', 'Lights flickering', 'Damaged fixture', 'Bulb replacement', 'Tripping / MCB', 'Inverter / UPS', 'Wiring exposed', 'Other'],
      'Plumbing':         ['Leak', 'Blockage', 'Tap / faucet', 'Drainage', 'Sewage', 'Geyser', 'Other'],
      'Cleaning':         ['Common area', 'Lift', 'Staircase', 'Garbage', 'Spillage', 'Pet waste', 'Other'],
      'Security':         ['Gate', 'Intercom', 'Visitor management', 'Patrolling', 'Theft / Damage', 'Suspicious activity', 'Other'],
      'Garden':           ['Watering', 'Pruning', 'Damaged planter', 'Tree fall risk', 'Pest in plants', 'Lawn', 'Other'],
      'Pest Control':     ['Cockroach', 'Rodent', 'Mosquito', 'Bees / Wasp', 'Termite', 'Bird nest', 'Snake', 'Other'],
      'Parking':          ['Unauthorised vehicle', 'Damage to vehicle', 'Lighting', 'Signage', 'Barrier / Boom faulty', 'EV charging', 'Other'],
      'Waste Management': ['Missed pickup', 'Overflow', 'Segregation', 'Smell', 'Bin damaged', 'Other'],
      'Intercom':         ['Not working', 'Line noise', 'Wrong number', 'Display faulty', 'Other'],
      'Building & Civil': ['Wall crack', 'Seepage', 'Paint peeling', 'Damaged tile', 'Door / Window', 'Lift lobby', 'Roof / Terrace', 'Other'],
      'Clubhouse':        ['Booking issue', 'Equipment', 'Hygiene', 'Lighting', 'AC', 'Other'],
      'Swimming Pool':    ['Water quality', 'Filter', 'Heating', 'Hygiene', 'Lifeguard', 'Equipment', 'Other'],
      'Gym':              ['Equipment broken', 'Hygiene', 'AC', 'Lighting', 'Music', 'Other'],
      'CCTV':             ['Camera offline', 'Footage request', 'Angle / position', 'Recording fault', 'Other'],
      'Fire Safety':      ['Extinguisher', 'Hose / Pipe', 'Alarm', 'Smoke detector', 'Sprinkler', 'Emergency exit', 'Other'],
      'Noise / Nuisance': ['Loud music', 'Construction noise', 'Pet noise', 'Party', 'Other'],
      'Vendor / Service': ['Delivery issue', 'Service quality', 'Billing', 'Schedule', 'Other'],
      'Other':            ['Other'],
    },
    // Treasury categories — surfaced in the reimbursement + expense forms
    // on docs/treasury.html. Editable from settings.html (admin only).
    treasuryCategories: [
      'Repairs',
      'Plumbing',
      'Electrical',
      'Housekeeping',
      'Security',
      'Water',
      'Utilities',
      'Lift AMC',
      'Fire / Safety AMC',
      'DG / STP AMC',
      'Garden',
      'Pest Control',
      'Office / Admin',
      'Festivals',
      'Events',
      'Insurance',
      'Legal / Audit',
      'Statutory / Tax',
      'Miscellaneous',
    ],
  },
  system: {
    issuesRepo:        'tadeskops/ta-society-helpdesk',
    backupBranch:      'main',
    workerUrl:         'https://tsh-worker.tadeskops.workers.dev',
    handoverPortalUrl: 'https://script.google.com/macros/s/REPLACE_ME/exec',
    photoStorage:      'in-repo',
    turnstileSiteKey:  'REPLACE_ME',
    logoUrl:           '',
    logoNameUrl:       '',
    weeklyReportUrl:   '',
    fullReportUrl:     '',
    reportBackupFreq:  '3x-daily',
    backupEnabled:     true,
    backupTimes:       ['08:00', '14:00', '20:00'],
    backupRetentionDays: 90,
    // Vehicle Registry — role allowlist for add/edit/delete on
    // config/vehicles.json. Set-membership check (not hierarchy) so an
    // admin can precisely include MANAGER (below CONTRIBUTOR in the
    // strict chain) while excluding CONTRIBUTOR and RESIDENT.
    //
    // The remaining keys are RESERVED hooks for the v2 features listed
    // above under FEATURE_TSH_VEHICLES_*. They default sensibly so that
    // when an admin flips the matching feature flag on, the endpoint
    // gains the right allowlist without a second Settings edit.
    vehicles: {
      editorRoles:                ['ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE', 'MANAGER'],
      // Includes 'SECURITY_GUARD' as a future-facing hint — even though
      // the role does not yet exist in the auth chain, the set-membership
      // check treats it as inert until an admin adds it to a caller's
      // access list. Manager and above already have full edit, so their
      // presence here is redundant-but-harmless.
      stickerRoles:               ['ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE', 'MANAGER', 'SECURITY_GUARD'],
      bulkEmailRoles:             ['ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE', 'MANAGER'],
      // Empty by default. When FEATURE_TSH_VEHICLES_RESIDENT_ADD is
      // enabled, admin adds 'RESIDENT' here (plus any editor roles that
      // should also be able to self-add on someone's behalf).
      residentAddRoles:           [],
      residentAddRequiresIdCheck: true,
      maxBulkEmails:              300,
    },
  },
  ui: {
    defaultTheme:     'light',
    defaultFontScale: 'md',
    headerIconExpand: 'never',
  },
};

export const isFeatureOn = (cfg: SiteConfig, key: string): boolean =>
  cfg.features[key] === true;

// Back-compat aliases. Old config/site.json files may still carry a
// deprecated key; we transparently read the alias when the new key is
// missing. Add new pairs here rather than sprinkling fallbacks around
// the codebase.
const TUNABLE_ALIASES: Record<string, string> = {
  DAILY_AUTO_ASSIGN_HOURS: 'DAILY_AUTO_ACK_HOURS',
};

export const tunable = (cfg: SiteConfig, key: string, fallback: number): number => {
  const v = cfg.tunables[key];
  if (typeof v === 'number') return v;
  const alias = TUNABLE_ALIASES[key];
  if (alias) {
    const av = cfg.tunables[alias];
    if (typeof av === 'number') return av;
  }
  return fallback;
};

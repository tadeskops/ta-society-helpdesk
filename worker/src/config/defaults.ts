// Default config baked into the Worker. Used when config/site.json is
// missing or malformed. CONFIG file values always override these.
// Spec: tsh_requirement.md §9.

export interface SiteConfig {
  version: number;
  features: Record<string, boolean>;
  tunables: Record<string, number>;
  lists: {
    towers: string[];
    categories: string[];
    subCategories: Record<string, string[]>;
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

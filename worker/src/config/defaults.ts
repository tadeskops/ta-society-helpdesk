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
  };
}

export const DEFAULT_CONFIG: SiteConfig = {
  version: 1,
  features: {
    FEATURE_DAILY_TRACK:            true,
    FEATURE_DAILY_ANONYMOUS_SUBMIT: true,
    FEATURE_DAILY_PHOTO_UPLOAD:     true,
    FEATURE_DAILY_WHATSAPP_SHARE:   true,
    FEATURE_DAILY_COST_FIELD:       false,
    FEATURE_DAILY_PUBLIC_RESOLVED:  true,
    FEATURE_DAILY_PUBLIC_REJECTED:  false,
    FEATURE_DAILY_PUBLIC_PHOTOS:    true,
    FEATURE_DAILY_PUBLIC_PDF:       true,
    FEATURE_DAILY_AUDIT_LOG_UI:     true,
    FEATURE_DAILY_TURNSTILE:        true,
  },
  tunables: {
    DAILY_AUTO_ACK_HOURS:       24,
    DAILY_ARCHIVE_AFTER_DAYS:   90,
    DAILY_PHOTO_MAX_PER_ISSUE:  6,
    DAILY_PHOTO_MAX_BYTES:      5242880,
    CONFIG_CACHE_SECONDS:       60,
    WHOAMI_CACHE_SECONDS:       5,
  },
  lists: {
    towers:     ['T1', 'T2', 'T3', 'T4'],
    categories: ['Lift', 'Water', 'Lights', 'Cleaning', 'Security', 'Other'],
    subCategories: {
      Lift:     ['Stuck', 'Doors not closing', 'Buttons faulty', 'Other'],
      Water:    ['No supply', 'Low pressure', 'Leak', 'Quality', 'Other'],
      Lights:   ['Common area dark', 'Flickering', 'Damaged fixture', 'Other'],
      Cleaning: ['Common area', 'Lift', 'Staircase', 'Garbage', 'Other'],
      Security: ['Gate', 'CCTV', 'Intercom', 'Visitor management', 'Other'],
      Other:    ['Other'],
    },
  },
  system: {
    issuesRepo:        'tadeskops/ta-society-helpdesk',
    backupBranch:      'main',
    workerUrl:         'https://tsh-worker.tadeskops.workers.dev',
    handoverPortalUrl: 'https://script.google.com/macros/s/REPLACE_ME/exec',
    photoStorage:      'in-repo',
    turnstileSiteKey:  'REPLACE_ME',
  },
};

export const isFeatureOn = (cfg: SiteConfig, key: string): boolean =>
  cfg.features[key] === true;

export const tunable = (cfg: SiteConfig, key: string, fallback: number): number => {
  const v = cfg.tunables[key];
  return typeof v === 'number' ? v : fallback;
};

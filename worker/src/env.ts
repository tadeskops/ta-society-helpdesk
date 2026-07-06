// Worker environment bindings. Mirror of wrangler.toml [vars] + secrets.
// Spec: tsh_requirement.md §10.

export interface Env {
  // Public vars (wrangler.toml [vars])
  GH_OWNER: string;
  GH_REPO: string;
  GH_BRANCH: string;
  /** Booking-receipts archive repo. Falls back to GH_OWNER when unset. */
  GH_RECEIPTS_OWNER?: string;
  /** Receipts repo name (default: "tsh-booking-receipts"). Empty disables archive. */
  GH_RECEIPTS_REPO?: string;
  GH_RECEIPTS_BRANCH?: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  TURNSTILE_SITE_KEY: string;
  ALLOWED_ORIGINS: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  // Secrets (wrangler secret put)
  GITHUB_TOKEN: string;
  /** Optional: separate PAT for the receipts repo. Falls back to GITHUB_TOKEN. */
  GITHUB_RECEIPTS_TOKEN?: string;
  BOOTSTRAP_ADMINS?: string;
  /** Legacy alias for BOOTSTRAP_ADMINS. Read as fallback during migration. */
  BOOTSTRAP_DEVELOPERS?: string;
  TURNSTILE_SECRET?: string;

  // Phase 3 (Google Calendar mirror) — all optional. Missing = mirror
  // silently queues operations and no external call is made.
  GOOGLE_CAL_CLIENT_ID?: string;
  GOOGLE_CAL_CLIENT_SECRET?: string;
  GOOGLE_CAL_REFRESH_TOKEN?: string;
}

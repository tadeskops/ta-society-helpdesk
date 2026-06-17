// Worker environment bindings. Mirror of wrangler.toml [vars] + secrets.
// Spec: tsh_requirement.md §10.

export interface Env {
  // Public vars (wrangler.toml [vars])
  GH_OWNER: string;
  GH_REPO: string;
  GH_BRANCH: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  TURNSTILE_SITE_KEY: string;
  ALLOWED_ORIGINS: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';

  // Secrets (wrangler secret put)
  GITHUB_TOKEN: string;
  BOOTSTRAP_DEVELOPERS?: string;
  TURNSTILE_SECRET?: string;
}

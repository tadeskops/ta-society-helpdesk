# ta-society-helpdesk

Day-to-day society issue tracker for the residential society.
Anonymous-friendly intake, manager triage, vendor/maintenance fix,
resolution. **Free GitHub-only stack.**

- Spec / source of truth: [tsh_requirement.md](./tsh_requirement.md)
- Sibling repo (handover track, Google stack):
  https://github.com/tadeskops/ta-issue-manager

## Stack at a glance

| Layer | Service | Plan |
|---|---|---|
| Static UI | GitHub Pages (`docs/`) | Free |
| Backend  | Cloudflare Worker (`worker/`) | Free |
| Database | GitHub Issues (this repo) | Free |
| Auth     | Google Identity Services (any Gmail) | Free |
| Anti-spam | Cloudflare Turnstile | Free |
| CI/CD    | GitHub Actions | Free |

No Google Sheet, no Apps Script, no Google Form, no Drive. Residents
do not need a GitHub account.

## Repo layout

```
.
├── docs/                  GitHub Pages root (static UI)
├── worker/                Cloudflare Worker source (TypeScript)
├── config/                Runtime config — edited from settings.html
├── photos/                Per-ticket photo folders (DLY-<n>/...)
├── backups/               Scheduled PDF reports
├── .github/workflows/     CI/CD
├── tsh_requirement.md     Spec — single source of truth
└── README.md              You are here
```

## Setup runbook (one-time, in order)

| # | When | Action |
|---|---|---|
| 1 | Fresh deploy | Create a Google OAuth Web Client ID; add `https://tadeskops.github.io` + `http://localhost:8080` as authorised origins. |
| 2 | Fresh deploy | Create a Cloudflare account; install Wrangler (`npm i -g wrangler`); `wrangler login`. |
| 3 | Fresh deploy | Create a fine-scoped GitHub PAT for this repo with `issues:write` + `contents:write` only. |
| 4 | Fresh deploy | (Optional) Create a Cloudflare Turnstile widget; copy site key + secret. Skip if shipping with `FEATURE_DAILY_TURNSTILE` off. |
| 5 | Fresh deploy | `cd worker && npm install`. Replace `GOOGLE_OAUTH_CLIENT_ID` + `TURNSTILE_SITE_KEY` in `wrangler.toml`. |
| 6 | Fresh deploy | Set Worker secrets: `wrangler secret put GITHUB_TOKEN`; `wrangler secret put BOOTSTRAP_ADMINS` (your email; legacy alias `BOOTSTRAP_DEVELOPERS` still honored); `wrangler secret put TURNSTILE_SECRET` if used. |
| 7 | Fresh deploy | `cd worker && npm run deploy`. Update `config/site.json` → `system.workerUrl` + `system.turnstileSiteKey`. |
| 8 | Fresh deploy | Push to `main`. Pages serves from `docs/`; workflows fire. |
| 9 | Fresh deploy | First admin signs in at `https://tadeskops.github.io/ta-society-helpdesk/settings.html`. Worker bootstraps via `BOOTSTRAP_ADMINS`. Add canonical `config/admins.json` from Settings → Access lists, then **remove** the `BOOTSTRAP_ADMINS` secret. |
| 10 | Fresh deploy | Admin adds manager + committee emails from Settings → Access lists. |
| 11 | Fresh deploy | Admin reviews feature flags + system bindings on Settings. |
| 12 | Fresh deploy | On the handover repo, set `DAILY_TRACK_URL` → this site's URL. |
| — | Anytime | Operators triage from manager / committee dashboards. |
| — | Anytime | Bulk-archive runs on cron + on demand from committee dashboard. |

## Local development

```powershell
# Worker
cd worker
npm install
# worker/.dev.vars (gitignored):
#   GITHUB_TOKEN=...
#   BOOTSTRAP_ADMINS=you@example.com
#   TURNSTILE_SECRET=1x0000000000000000000000000000000AA  # Turnstile test always-pass
npm run dev   # http://localhost:8787

# Static site (separate terminal)
cd docs
npx http-server -p 8080
```

## Repo policy

This repo follows [.github/copilot-instructions.md](.github/copilot-instructions.md):

- Every commit + push as `tadeskops <ta.deskops@gmail.com>` (local-scope).
- Every UI affordance is feature-flag gated and toggleable from Settings;
  no redeploy needed.
- Mobile-first responsive across phone / tablet / desktop.
- Cross-repo references to the handover track are link-only.
- Intermediate scratch lives under `temp/` (gitignored).

# Prompt: Prepare an App for TA Society Helpdesk (Daily Track)

> Copy everything below the horizontal rule into your AI assistant / hand it to
> your engineering team as a single brief. It is self-contained: no other doc is
> required to produce a first-cut app design, wireframes, data model, or working
> prototype for the **TA Society Helpdesk** (daily track only).
>
> This project is `tadeskops/ta-society-helpdesk`. There is a sibling handover
> track in a separate repo; it is deliberately out of scope here — the only
> connection is a single hyperlink on the landing page.

---

## Role

You are a senior product engineer + designer. Prepare an **app** (mobile-first
responsive web app / PWA — no native store submission on day one) for a
residential apartment society ("Tower Apartments") to run its day-to-day
issue helpdesk: residents report common-area problems (lift, water, lights,
cleaning, security), the society manager triages and assigns to a vendor, and
the ticket is resolved and audited.

Deliver:

1. Product summary (1 page).
2. User personas + role matrix.
3. Information architecture / navigation map.
4. Screen-by-screen wireframes (low-fi is fine) for every role surface.
5. Data model + API surface.
6. Auth, roles, and permissions model.
7. Non-functional requirements (security, cost, hosting, offline, i18n, a11y).
8. Phased delivery plan (MVP → v1 → v2), with a clear "smallest thing that
   makes residents happy on day one".
9. Open questions you would not decide on your own.

If any requirement below is ambiguous, list it in the "open questions" section
rather than silently guessing.

---

## Context

The society needs a fast, free, mobile-first way for any resident in the lift
lobby with a phone to report a broken lift in under 30 seconds, and for the
society manager to triage, assign, resolve, and audit that ticket without
switching tools. High volume, fast turnaround, anonymous-friendly intake,
vendor/maintenance owns the fix.

Today's stack (reference — you can propose changes, but justify cost impact):

- Static UI on **GitHub Pages** (`docs/`).
- Backend = a single **Cloudflare Worker** (~80 lines of TS). Free tier.
- Database = **GitHub Issues** in the same repo. One issue per ticket. Status
  encoded as labels.
- Auth = **Google Identity Services (GIS)** — any Gmail. Worker verifies the
  Google ID token (JWT) on every request.
- Anti-spam = **Cloudflare Turnstile** (feature-flag gated).
- CI/CD = **GitHub Actions** for Pages deploy, Worker deploy, and a scheduled
  PDF report every ~8 hours (`backups/*.pdf`).
- Explicitly **not** used: Google Sheets, Apps Script, Google Forms, Google
  Drive, Firebase, Supabase, Twilio, WhatsApp Business API, any DB server,
  any container/VM.

Design principle: **one page per role surface.** Routes never branch on role
inside a single HTML — the wrong-role redirect happens in the page's
`ensureAuthorized()` step before any data is rendered.

Every UI affordance is **feature-flag gated** and every flag/list/tunable is
editable from the in-app settings page. No hardcoded switches that require a
redeploy.

---

## Product goals (in priority order)

1. **Zero-friction reporting.** Resident on a phone, lobby wifi, no app
   installed, must file a lift-stuck ticket in under 30 seconds.
2. **One front door.** A single landing page routes to intake, public board,
   or ticket lookup. Sign-in optional for reporting, mandatory for privileged
   actions.
3. **Fair audit trail.** Every state change is timestamped and attributed to a
   verified identity. Nothing important is deletable in a way that erases
   history — "delete" means soft-delete (lock + tombstone) with an audit line.
4. **Role-appropriate views.** Resident → own ticket + public board. Manager →
   triage queue. Committee → everything + redact / soft-delete / audit tools.
   Admin → settings.
5. **Free to run.** Target $0/mo at ~50 issues/month. Any paid dependency
   must be flagged and justified.
6. **Continuity with existing data.** Must be able to import historical daily
   issues (existing GitHub Issues in `tadeskops/ta-society-helpdesk`) without
   losing the audit trail.

---

## Users & roles

Four roles. Capabilities are additive — an email on multiple lists gets the
union. Landing-page badge precedence: `ADMIN > COMMITTEE > MANAGER > RESIDENT`.

| Role | Identifier | Can do |
|---|---|---|
| **Resident** | Anonymous Google sign-in (any Gmail). Anonymous submit also allowed via feature flag. | Submit a daily issue; look up own ticket by id; read the public board (PII redacted). Cannot call any privileged action. |
| **Society Manager** | Email in `config/managers.json` (allow-list). | Assign vendor + severity, mark in-progress, resolve, reject, reopen. Add photos. Receives auto-assigned tickets after `DAILY_AUTO_ASSIGN_HOURS`. Cannot delete, cannot edit historical fields, cannot change settings. |
| **Technical Committee** | Email in `config/committee.json`. | Everything Manager can + edit/redact issue body, overwrite resolution notes, soft-delete (lock + tombstone), bulk archive, view audit log. Read-only on settings. |
| **Admin** | Email in `config/admins.json` (legacy: `config/developers.json`). | Everything Committee can + edit `config/site.json` (feature flags, visibility, lists), manage all three allow-lists from the settings page, edit system bindings (repo, branch, Worker URL, photo-storage strategy). |

Hard constraints:

- No client-typed "email + role" login form. Ever.
- Identity comes only from a verified Google ID token (JWT). The server ignores
  any `email` / `role` / `actor` field in the request body.
- Allow-lists live in editable JSON files in the repo; every change is a
  commit (free audit history).
- **One-admin-minimum guard.** It must be impossible to save an empty
  admin list.
- The admin list is **bootstrapped from a server secret** (`BOOTSTRAP_ADMINS`, legacy alias `BOOTSTRAP_DEVELOPERS`)
  only when the file is missing. After the file exists, the file is canonical
  and the secret can be removed.

---

## Feature set (by module)

For each module below, name the primary user, the trigger, the happy path,
and the failure/edge cases you would handle.

### A. Landing page

- Header: logo, portal name, "Track: Daily" pill, Sign-in button (top right).
- Primary card: "Report a daily issue" with a plain-English 2-line description
  and a `Report now →` CTA.
- Secondary card: link to the handover portal (URL from `config/site.json →
  system.handoverPortalUrl`). Link-only, no code coupling.
- Secondary row: `Look up ticket by id` input + `View public board` +
  `View latest PDF report`.

### B. Resident intake (`daily-report.html`)

- Single-screen mobile-first card.
- Required fields: tower (dropdown from config), location (free text),
  category (dropdown from config), sub-category (cascade from category),
  description.
- Optional identity fields: reporter name, flat, phone (normalised),
  notify-on-WhatsApp toggle.
- Photo upload (feature-flag gated): up to `DAILY_PHOTO_MAX_PER_ISSUE`
  files, each ≤ `DAILY_PHOTO_MAX_BYTES`.
- Anti-spam: Cloudflare Turnstile widget (feature-flag gated).
- Google one-tap sign-in in the header.
- Submit → redirect to `daily-confirm.html?id=DLY-<n>`.

### C. Confirmation (`daily-confirm.html`)

- Big ticket id (`DLY-<5-digit>`) with copy button.
- WhatsApp share deep link (`wa.me/?text=…`) — feature-flag gated.
- "What happens next" three-step explainer.
- `[Report another]` and `[View status]` buttons.

### D. Manager dashboard (`manager-dashboard.html`)

- **Tabs are generated from `config.lifecycle.states`** — never hardcoded.
  With default config the tabs are: `New` · `Assigned` · `In Progress` ·
  `Resolved (today)` · `Rejected` · `All`.
- **Row actions are generated from `config.lifecycle.transitions`** for the
  current state — never hardcoded. With default config, the visible actions per
  state are:
  - `new` → Assign (vendor + severity) · Reject
  - `assigned` → Mark in progress · Resolve · Reject
  - `in-progress` → Resolve · Reject
  - `resolved` → Reopen
  - `rejected` → Reopen
- Quick filters: tower / category / severity / age.
- **Auto-assign:** a scheduled sweep promotes every `new` ticket older than
  `DAILY_AUTO_ASSIGN_HOURS` (default **4**) to `assigned`. Target = the
  Society Manager role (round-robin across `config/managers.json`, or the
  single manager if only one exists). Severity defaults to `medium`; vendor
  stays blank and shows as `— (auto-assigned, needs vendor)` in the row.
  Auto-transitions write an audit comment with `by: system@auto-assign`.
- Detail modal: full body, photos, audit trail, action buttons.

### E. Committee dashboard (`committee-dashboard.html`)

- Visually identical layout to the manager dashboard (same chrome, same
  config-driven tabs and actions).
- Adds in the detail-modal overflow menu: edit/redact body, overwrite
  resolution notes, soft-delete, bulk archive, **override auto-assign target**.
- Adds an audit-log viewer tab.

### F. Public board (`public-board.html`)

- Read-only. Anonymous access allowed.
- Filter pill: `All / New / In Progress / Resolved`. Search by ticket id.
- **PII redaction is mandatory** on every row before it leaves the server:
  strip `reporterName`, `reporterEmail`, `reporterFlat`, `reporterPhone`;
  regex-scrub phone-number-shaped substrings from `description` and `location`;
  hide internal manager comments; only show `resolutionNotes` when status is
  `resolved`.

### G. Settings (`settings.html`)

- **Admin write. Committee read-only.** Every input `disabled` in the
  read-only view; server would reject the `PUT` anyway.
- Sections:
  - **Access lists** — three editable email arrays (admin / committee /
    manager). One-admin-minimum guard.
  - **Feature flags** — every toggle listed in "Configuration" below.
  - **Visibility** — public board: show photos / show severity / expose PDF export.
  - **Lists** — towers, categories, sub-categories (nested by category).
  - **Lifecycle** — editable list of states (`id`, `label`, `color`, `terminal`,
    `publiclyVisible`) and transitions (`from`, `to`, `action`, `minRole`,
    `requires: []`). Admin can add a mid-workflow state (e.g.
    `waiting-parts`, `vendor-scheduled`) here without a redeploy. Validation:
    (a) the state graph must remain connected from `new` to at least one
    terminal state; (b) no orphan states; (c) `new`, `resolved`, `rejected`,
    `deleted` are reserved ids that cannot be removed.
  - **System** — `issuesRepo`, `backupBranch`, `workerUrl`, `photoStorage`
    strategy. Hidden from committee read-only view.
  - **Audit log** — last N entries from `config/audit.log` (read-only).
- Save → `PUT /config` (and/or `PUT /access-lists/:role`) → server commits the
  change to the repo. All pages re-fetch `/config` on next load (60s cache).

### H. Reports

- Scheduled GitHub Action generates two PDFs every ~8 hours (cadence configurable):
  - `backups/TSH_Report.pdf` — anonymised (PII stripped).
  - `backups/TSH_Full_Report.pdf` — full content.
- Manual dispatch trigger available.

### I. Notifications (design, don't overbuild)

- WhatsApp: **deep-link only** (`wa.me/?text=…`). No Twilio, no Business API.
- Email: transactional only, server-sent. No newsletters.
- In-app toasts for the current session.

---

## Data model

### One daily issue = one GitHub Issue

**Title:** `DLY-<padded-id> · <category> · <tower>`
Example: `DLY-00142 · Lift · T2`. `<padded-id>` is the GitHub Issue number
zero-padded to 5 digits. No separate counter.

**Body (Markdown, section-headed so it is parseable):**

```
### Reported
- Date: 2026-06-17T08:42:00+05:30
- Tower: T2
- Location: Lift lobby, ground floor
- Category: Lift
- Sub-category: Doors not closing

### Reporter
- Name: <optional>
- Flat: <optional>
- Phone: <optional, normalised>
- Notify on WhatsApp: yes / no

### Description
<free text>

### Photos
- ![](https://raw.githubusercontent.com/.../photos/DLY-00142/01.jpg)

### Resolution (set on RESOLVED)
- By: <manager-email>
- Date: <ISO>
- Notes: <free text>
- Cost: <number, optional>
```

**Labels (status is the source of truth):**

| Family | Values | Notes |
|---|---|---|
| Status | one of `config.lifecycle.states[].id` — defaults: `new`, `assigned`, `in-progress`, `resolved`, `rejected`, `deleted` | Exactly one at any time. Adding a state in Settings creates a new label on next write. |
| Tower | `tower:T1`, `tower:T2`, … | One. |
| Category | `cat:lift`, `cat:water`, `cat:lights`, `cat:cleaning`, `cat:security`, … | One; matches `config/site.json`. |
| Severity | `sev:critical`, `sev:high`, `sev:medium`, `sev:low` | Set on assign; defaults to `sev:medium` on auto-assign. |
| System | `daily` | Always present. |

**Audit comments:** every status transition posts a comment shaped:

```
**Status change**
- From: assigned → in-progress
- By: <actor-email>
- At: <ISO>
- Notes: <optional free text>
```

Append-only. Never edited. The full lifecycle is reconstructable from comments alone.

**Soft-delete (committee+):** apply `deleted` label; lock the issue; replace
body with `[REDACTED — deleted by <email> at <ISO>]`; strip from all read
endpoints; append a line to `config/audit.log`. Hard delete is never done via API.

### Lifecycle (default, minimized — configurable in Settings)

The default flow is deliberately short: **new → assigned → in-progress →
resolved**, plus `rejected` and `deleted` sinks. `new → assigned` fires
automatically after `DAILY_AUTO_ASSIGN_HOURS` (default 4) if no manager
acted; a manager can also drive it manually before then.

Allowed transitions with default config:

| From | To | Action | Roles | Trigger |
|---|---|---|---|---|
| `new` | `assigned` | assign vendor + severity | Manager+ | manual |
| `new` | `assigned` | auto-assign to Society Manager | system | cron after `DAILY_AUTO_ASSIGN_HOURS` |
| `new` | `rejected` | reject | Manager+ | manual |
| `assigned` | `in-progress` | mark in progress | Manager+ | manual |
| `assigned` | `resolved` | resolve directly | Manager+ | manual |
| `assigned` | `rejected` | reject | Manager+ | manual |
| `in-progress` | `resolved` | resolve | Manager+ | manual |
| `in-progress` | `rejected` | reject | Manager+ | manual |
| `resolved` | `in-progress` | reopen | Manager+ | manual |
| `rejected` | `new` | reopen | Manager+ | manual |
| any → `deleted` | soft-delete | Committee+ | manual |

Any transition not listed in `config.lifecycle.transitions` is rejected
server-side with `Forbidden transition: <from> → <to>`.

**Configurable states — Settings-driven, no redeploy.** A admin can add
intermediate states (e.g. `triaging`, `waiting-parts`, `vendor-scheduled`)
from `settings.html`. The dashboard tabs and per-row action buttons rebuild
from the config on the next `/config` fetch. Schema:

```jsonc
"lifecycle": {
  "states": [
    { "id": "new",         "label": "New",         "color": "#0ea5e9", "terminal": false, "publiclyVisible": true },
    { "id": "assigned",    "label": "Assigned",    "color": "#f59e0b", "terminal": false, "publiclyVisible": true },
    { "id": "in-progress", "label": "In progress", "color": "#8b5cf6", "terminal": false, "publiclyVisible": true },
    { "id": "resolved",    "label": "Resolved",    "color": "#10b981", "terminal": true,  "publiclyVisible": true },
    { "id": "rejected",    "label": "Rejected",    "color": "#64748b", "terminal": true,  "publiclyVisible": false },
    { "id": "deleted",     "label": "Deleted",     "color": "#000000", "terminal": true,  "publiclyVisible": false }
  ],
  "transitions": [
    { "from": "new",         "to": "assigned",    "action": "Assign",         "minRole": "MANAGER", "requires": ["vendor","severity"] },
    { "from": "new",         "to": "rejected",    "action": "Reject",         "minRole": "MANAGER" },
    { "from": "assigned",    "to": "in-progress", "action": "Mark in progress","minRole": "MANAGER" },
    { "from": "assigned",    "to": "resolved",    "action": "Resolve",        "minRole": "MANAGER", "requires": ["notes"] },
    { "from": "assigned",    "to": "rejected",    "action": "Reject",         "minRole": "MANAGER" },
    { "from": "in-progress", "to": "resolved",    "action": "Resolve",        "minRole": "MANAGER", "requires": ["notes"] },
    { "from": "in-progress", "to": "rejected",    "action": "Reject",         "minRole": "MANAGER" },
    { "from": "resolved",    "to": "in-progress", "action": "Reopen",         "minRole": "MANAGER" },
    { "from": "rejected",    "to": "new",         "action": "Reopen",         "minRole": "MANAGER" },
    { "from": "*",           "to": "deleted",     "action": "Delete",         "minRole": "COMMITTEE" }
  ],
  "autoTransitions": [
    {
      "from": "new",
      "to": "assigned",
      "afterHours": 4,
      "assignTo": { "role": "MANAGER", "strategy": "round-robin" },
      "defaults": { "severity": "medium", "vendor": null },
      "actor": "system@auto-assign"
    }
  ]
}
```

Reserved ids that cannot be removed: `new`, `resolved`, `rejected`, `deleted`.
Everything else is admin-editable. `requires` lets the UI grey out an
action until the ticket has the needed fields (e.g. `Resolve` needs `notes`).

`POST /issues/bulk-archive` does not change status; it sweeps `resolved` /
`rejected` issues older than `DAILY_ARCHIVE_AFTER_DAYS` and soft-deletes them.

---

## API surface (single Cloudflare Worker, all paths)

Envelope for every response: `{ ok: boolean, data?: any, error?: string }`.
HTTP: 2xx ok; 401 missing/invalid JWT; 403 role denied; 4xx validation;
5xx server.

| Method + Path | Auth | Roles | Purpose |
|---|---|---|---|
| `POST /issues` | JWT (or anonymous if flag on) | All | Create a daily issue. Server validates schema, verifies Turnstile if enabled, creates the GitHub Issue with labels. |
| `GET /issues` | JWT | Manager, Committee, Admin | List for dashboards. Server-side filter by status/tower/category. |
| `GET /issues/public` | None | All | Public board read; PII scrubbed. |
| `GET /issues/:id/public` | None | All | Confirmation-page lookup by ticket id. PII redacted. |
| `PATCH /issues/:id` | JWT | Manager, Committee, Admin | Status transitions. Posts an audit comment on every change. |
| `POST /issues/:id/photos` | JWT | Manager, Committee, Admin | Attach photos to an existing issue. |
| `POST /issues/:id/redact` | JWT | Committee, Admin | Edit issue body to remove PII / fix typos. Edit + audit comment. |
| `POST /issues/:id/delete` | JWT | Committee, Admin | Soft-delete. |
| `POST /issues/bulk-archive` | JWT | Committee, Admin | Manual retention sweep. |
| `POST /issues/auto-assign-sweep` | JWT (cron token) or Admin | system, Admin | Promote `new` tickets older than `DAILY_AUTO_ASSIGN_HOURS` to `assigned` per `config.lifecycle.autoTransitions`. Also exposed via a scheduled trigger (Cloudflare Cron / GitHub Action) so it runs every 15 minutes without a manual call. |
| `GET /config` | None | All | Returns `site.json` (features + tunables + lists + lifecycle + system). Called by every page on load. Cached 60s. |
| `PUT /config` | JWT | Admin | Overwrite `config/site.json`. Server commits with an audit-log line. |
| `GET /access-lists` | JWT | Committee (read), Admin (read) | Returns all three allow-lists. |
| `PUT /access-lists/:role` | JWT | Admin | Overwrite one allow-list. Enforces one-admin-minimum. |
| `GET /audit` | JWT | Committee, Admin | Recent entries from `config/audit.log`. |
| `GET /whoami` | JWT | All | `{ email, roles[] }` for the verified caller. |

---

## Configuration (`config/site.json`) — defaults

```jsonc
{
  "version": 1,
  "features": {
    "FEATURE_DAILY_TRACK":            true,
    "FEATURE_DAILY_ANONYMOUS_SUBMIT": true,
    "FEATURE_DAILY_PHOTO_UPLOAD":     true,
    "FEATURE_DAILY_WHATSAPP_SHARE":   true,
    "FEATURE_DAILY_COST_FIELD":       false,
    "FEATURE_DAILY_PUBLIC_RESOLVED":  true,
    "FEATURE_DAILY_PUBLIC_REJECTED":  false,
    "FEATURE_DAILY_PUBLIC_PHOTOS":    true,
    "FEATURE_DAILY_PUBLIC_PDF":       true,
    "FEATURE_DAILY_AUDIT_LOG_UI":     true,
    "FEATURE_DAILY_TURNSTILE":        true
  },
  "tunables": {
    "DAILY_AUTO_ASSIGN_HOURS":    4,
    "DAILY_ARCHIVE_AFTER_DAYS":  90,
    "DAILY_PHOTO_MAX_PER_ISSUE":  6,
    "DAILY_PHOTO_MAX_BYTES": 5242880
  },
  "lists": {
    "towers":       ["T1","T2","T3","T4"],
    "categories":   ["Lift","Water","Lights","Cleaning","Security","Other"],
    "subCategories": { "Lift": ["Stuck","Doors not closing","Buttons faulty","Other"] }
  },
  "lifecycle": {
    "states":          [ /* see Data model → Lifecycle */ ],
    "transitions":     [ /* see Data model → Lifecycle */ ],
    "autoTransitions": [ /* see Data model → Lifecycle */ ]
  },
  "system": {
    "issuesRepo":         "tadeskops/ta-society-helpdesk",
    "backupBranch":       "main",
    "workerUrl":          "https://daily-worker.tadeskops.workers.dev",
    "handoverPortalUrl":  "https://tadeskops.github.io/ta-issue-manager/",
    "photoStorage":       "in-repo"
  }
}
```

Baked-in defaults live in the Worker as `DEFAULT_CONFIG`. When the file is
missing or malformed the Worker returns defaults. Config values always override.

---

## Server secrets

| Name | Purpose |
|---|---|
| `GITHUB_TOKEN` | Fine-scoped PAT — `issues:write`, `contents:write` on this repo only. Rotatable. Never logged, never returned. |
| `GOOGLE_OAUTH_CLIENT_ID` | Verifies JWT `aud`. |
| `BOOTSTRAP_ADMINS` | Comma-separated emails; read **only** when `config/admins.json` is missing. Removed after bootstrap. Legacy alias `BOOTSTRAP_DEVELOPERS` still honored during migration. |
| `TURNSTILE_SECRET` | Verifies the Turnstile token on `POST /issues`. Used only when `FEATURE_DAILY_TURNSTILE` is on. |
| `TURNSTILE_SITE_KEY` | Public-safe; returned by `GET /config` so the intake page can render the widget. |

Nothing sensitive is ever shipped to the browser.

---

## Security requirements (must-hold, non-negotiable)

- Identity comes only from the Google ID token (JWT), verified server-side.
- Every privileged action goes through the server-side role allow-list.
- Client payloads MUST NOT contain `email` / `role` / `actor`. Server ignores
  them if present.
- Allow-lists are JSON files in the repo; every change is a commit.
- **No PII in `localStorage` / `sessionStorage` / query strings.** JWT lives
  only in the in-memory variable for the current tab.
- GitHub PAT lives only in server secrets; never shipped to the browser.
- Public read endpoints scrub PII before returning.
- Soft-delete only. Hard-delete requires a manual out-of-band action on github.com.
- Rate-limit `POST /issues` from anonymous callers (Turnstile + IP-based).
- No "allow all as ADMIN" testing bypass in production.
- No client-typed email/role login form.

---

## Non-functional requirements

- **Mobile-first responsive.** Three breakpoints (phone / tablet / desktop),
  mandatory on every page. Phone is the primary target.
- **Modern minimal aesthetic.** Reuse the existing brand tokens (logo,
  palette, font stack, radius/shadow scale). No decorative imagery, no
  skeuomorphism, no animation beyond simple state transitions.
- **Plain-English copy** on every resident-facing surface. No jargon.
- **Offline-tolerant intake.** A resident on flaky lobby wifi must be able
  to draft an issue, retry on send, and not lose the payload.
- **Accessible.** WCAG 2.1 AA. Keyboard-navigable dashboards. Colour is
  never the only signal (status badges also have icons + text).
- **Multi-language ready** (English + one regional language toggle). Content
  strings pulled from a single dictionary.
- **Cost target:** $0/mo. Any paid dependency must be flagged and justified.
- **Every UI affordance is feature-flag gated and toggleable from Settings —
  no redeploy needed to hide/show a control.**
- **No CONFIG-only knobs.** Every flag, list, and tunable surfaced anywhere
  in the app is editable from `settings.html`.

---

## Integrations

- Google Identity Services (GIS) — any Gmail.
- Cloudflare Turnstile — optional; feature-flag gated.
- GitHub REST + GraphQL — the only "database" writer.
- WhatsApp — deep-link only.
- **Explicitly not used:** Google Sheets, Apps Script, Google Forms, Google
  Drive, Firebase, Supabase, Twilio, WhatsApp Business API, any DB server,
  any container/VM host.

---

## Explicitly out of scope

- Payments, billing, maintenance-fee collection.
- Visitor management, gate-pass, parking allocation.
- Community chat / forum / marketplace.
- Push notifications requiring a paid gateway.
- Native app submission (iOS App Store / Play Store) on day one. PWA is fine.
- The sibling **handover track** in `tadeskops/ta-issue-manager`. The only
  connection is a hyperlink on the landing page — no shared code, assets,
  builds, secrets, schemas, or workflows.

---

## Phased delivery — what you must propose

1. **MVP (2–3 weeks).** Landing + resident intake + confirmation + public
   board + manager dashboard (minimum viable columns and actions). Google
   Sign-In. One tower to start. Turnstile off.
2. **v1 (4–6 weeks).** Add committee dashboard, settings page, soft-delete,
   audit log, PDF export, Turnstile, photo upload. Roll out to all towers.
3. **v2 (later).** PWA install prompt. Regional-language toggle. Offline
   draft queue. Optional swap of photo storage to Cloudflare R2.

For each phase, list: scope, out-of-scope, success metric, and the single
biggest risk.

---

## Deliverables checklist

Return your response as one document with these sections, in this order:

1. Product summary.
2. Personas + role matrix.
3. Information architecture (sitemap + navigation).
4. Screen-by-screen wireframes (ASCII, mermaid, or described layout).
5. Data model (types + lifecycle diagram).
6. API surface (method + path + auth + roles + purpose).
7. Auth & security summary.
8. Non-functional requirements checklist.
9. Phased delivery plan.
10. Open questions.

Keep copy plain-English on every resident-facing surface. Reuse the existing
brand tokens — do not invent a new identity. When in doubt, choose the option
that gets a broken lift reported faster.

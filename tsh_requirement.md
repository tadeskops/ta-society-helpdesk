# Issue Addressal Portal (IRP) — Requirements

> Lightweight, serverless issue-management workflow for the residential society.
> Two parallel tracks: a **Handover track** (Google-stack, already in production) and a **Daily track** (GitHub-stack, new). They share a visual identity but use independent toolchains so neither can break the other.

---

## At a glance — what tools does this use, and for what?

The portal is split into two tracks. Each track uses a different set of tools. **The existing handover track is not changing** — everything it uses today keeps working as-is. The new daily track is a separate piece hosted on GitHub.

### Plain-English answer to common questions

| Question | Answer |
|---|---|
| Does the **daily track** need a Google Sheet? | **No.** Daily issues are stored as GitHub Issues. |
| Does the daily track need Google Apps Script? | **No.** It's a plain static website on GitHub Pages plus one tiny helper service (Cloudflare Worker, ~80 lines). |
| Does the daily track need a Google Form? | **No.** Residents fill in a form on the static website itself. |
| Does the daily track need Google Drive? | **No.** Photos are uploaded straight into the GitHub Issue. |
| Does a resident need a GitHub account? | **No.** They sign in with their existing Gmail (Google Sign-In). |
| Does a resident need to install anything? | **No.** It's a regular webpage — opens in any phone or laptop browser. |
| Does the existing handover track change? | **No.** It keeps using Google Form + Sheet + Apps Script + Drive exactly as today. The only edit is one extra link on the landing page that points to the daily-track website. |
| Where do the PDF status reports live? | **GitHub** — same as today (handover) and same place (daily). One folder, two PDFs. |

### Tool map — Handover track (existing, unchanged)

| Tool / Service | What it does (plain words) | Required? |
|---|---|---|
| **Google Form** | The page where residents fill in a snag (handover defect) | Yes |
| **Google Sheet** | The database — every snag ticket is one row | Yes |
| **Google Apps Script** | The "server" behind the dashboards — handles approvals, routes pages, runs the API | Yes |
| **Google Drive** | Stores all the photos residents upload | Yes |
| **Google Sign-In** | How committee + builder log in to their dashboards | Yes |
| **GitHub (this repo)** | Stores the source code + the weekly PDF report + an XLSX backup of the Sheet | Yes (output mirror only) |

### Tool map — Daily track (new)

| Tool / Service | What it does (plain words) | Required? |
|---|---|---|
| **GitHub Issues** (new repo, e.g. `ta-society-daily`) | The database — every reported daily issue is one GitHub Issue. Status is stored as labels (`new`, `assigned`, `resolved`, etc.) | Yes |
| **GitHub Pages** | Hosts the resident form + manager dashboard as a normal website at `https://<you>.github.io/ta-society-daily/` | Yes |
| **GitHub Actions** | Runs the scheduled PDF report (same pattern as today's handover weekly report) | Yes |
| **Cloudflare Worker** (free tier) | A small safety-net service (~80 lines) that holds the GitHub access token. The browser never sees the token; it talks to the Worker, the Worker talks to GitHub. | Yes |
| **Google Sign-In (GIS)** | How residents and managers prove who they are. Any Gmail account works; no GitHub account needed. The Worker checks the Google identity token before it does anything. | Yes |
| Google Sheet | Not used | — |
| Google Form | Not used | — |
| Google Apps Script | Not used | — |
| Google Drive | Not used (photos go into the GitHub Issue itself) | — |

### Why this split?

1. **Zero risk to what works.** The existing portal keeps running on the existing stack — same Sheet, same Apps Script, same Form. Nothing to migrate.
2. **No new accounts for residents.** They already have Gmail; that's enough to sign in. No GitHub account, no app install.
3. **Free across the board.** GitHub Pages + Issues + Actions + Cloudflare Workers are all free for this volume.
4. **One look and feel.** The daily-track website reuses the same logo, colours, fonts, and layouts as the existing portal. A small teal "Track: Daily" pill in the header is the only visible signal that you've crossed over.
5. **Strong separation.** Handover data (PII-heavy, multi-week warranty workflow) stays in Google. Daily data (lighter, faster turnaround) lives in GitHub. Neither system can corrupt the other.

> **Status of this document.** §1–§19 below describe the **current production state** (handover track only — Google stack). §20 currently describes an earlier draft of the daily track that assumed the same Google stack; **it will be rewritten** to match the GitHub-backed design summarised above once the open design questions (repo visibility, manager-list location, photo storage strategy) are confirmed.

---

## 1. System Overview

The portal hosts **two parallel issue tracks** in a single web app — see §20 for the daily-track design and the rationale for separation.

| Aspect | Value |
|---|---|
| Purpose (Handover track) | Track resident-reported handover/snag issues from intake → committee approval → builder execution → closure |
| Purpose (Daily track) | Track day-to-day society issues (lift, water, lights, cleaning, security, etc.) from anonymous resident report → manager triage → vendor/maintenance fix → resolution. See §20. |
| Hosting | Single Apps Script web app (HtmlService) |
| Storage | One bound Google Sheet (handover tabs + `DAILY_ISSUES` + `DAILY_ARCHIVES` + `CONFIG`) |
| Identity | Google account sign-in (`Session.getActiveUser()`) for committee/builder/manager; **anonymous** allowed for daily-track intake and for the public submitted-issues view |
| Authorization | Role lookup against the `CONFIG` sheet |
| Cost | Free (Google Sheets + Apps Script quotas only) |
| External services | None — no Firebase, no OAuth Client ID, no GitHub Pages |

---

## 2. Roles

| Role | How identified | Capabilities |
|---|---|---|
| Resident (Handover) | Submits Google Form (no sign-in to portal) | Submit handover issues only |
| Resident (Daily) | Anonymous visitor of the public deployment (no sign-in required) | Submit daily issues via `daily-report.html` and read the public submitted-issues view. **Cannot** call any committee/builder/manager action. See §20. |
| Technical Committee | Google email listed in `CONFIG.COMMITTEE_EMAILS` | Approve/reject pending, view all handover dashboards, close/reopen, delete, full read. **Manager-track read-only** by default; can be granted manager rights by also listing the email in `CONFIG.MANAGER_EMAILS`. |
| Builder | Google email matching `CONFIG.BUILDER_EMAIL` | Read assigned handover issues, update builder status / comment / vendor, close/reopen. **No daily-track access** unless also a manager. |
| Society Manager | Google email listed in `CONFIG.MANAGER_EMAILS` | Triage / assign / update / resolve / reject / reopen daily issues; read the manager dashboard (§20). **No handover-track write access** unless also a committee member. |
| Unknown (signed-in) | Any signed-in Google user not in CONFIG | Denied for dashboards; allowed to read the public submitted-issues view and submit a daily issue. |
| Unknown (anonymous) | Visitor without a Google session, hitting the public deployment | Allowed to submit a daily issue and read the public submitted-issues view; everything else denied. |

> Committee, builder, and manager email lists are runtime-editable via the `CONFIG` sheet.
> No code changes required to onboard or remove a member.
> An email may appear in **multiple** role lists — `getUserRole(email)` returns the highest-privilege role (`COMMITTEE > MANAGER > BUILDER > UNKNOWN`), and per-action allow-lists are evaluated additively (a committee+manager email gets the union of capabilities).

---

## 3. Authentication & Authorization (Google Auth — MANDATORY)

### 3.1 Authentication
- Web app deployed with `executeAs: USER_ACCESSING`, `access: ANYONE` (any Google account).
- Google forces sign-in before any request reaches the script.
- Server reads identity via `Session.getActiveUser().getEmail()` — **must not** be supplied by the client.
- Browser must never send `userEmail` in a payload; if present, it is ignored.

### 3.2 Authorization
- `getUserRole(email)` (see [config.gs](config.gs)) resolves `COMMITTEE | BUILDER | UNKNOWN`.
- Per-action allow-list enforced server-side in `isActionAllowed_(action, role)` (see [Router.gs](Router.gs)).
- `UNKNOWN` is denied on every action and is shown an access-denied landing page.

### 3.3 Sign-out
- No programmatic sign-out for an Apps Script web app session.
- Logout button triggers `API.signOut()` which redirects through Google's account-chooser.

### 3.4 What is forbidden
- Client-typed email + role form (removed).
- `sessionStorage` for identity (removed).
- "Allow all as COMMITTEE" fallback in `validateUserAccess` (removed).
- Trusting `payload.userEmail` in `doPost` (removed).

---

## 4. Architecture

```
┌────────────┐    1. GET /exec     ┌────────────────────────────┐
│  Browser   │ ──────────────────▶ │ Apps Script Web App (Router.gs)
│            │                     │   doGet(e)                 │
│            │ ◀────HTML page──── │   - Session.getActiveUser()│
│            │                     │   - getUserRole(email)     │
│            │                     │   - serve role-specific UI │
│            │                     └────────────┬───────────────┘
│            │  2. google.script.run.api_call(action, payload)  │
│            │ ───────────────────────────────▶│
│            │                                  │ api_call()
│            │                                  │ - Session-trusted email
│            │                                  │ - isActionAllowed_
│            │                                  │ - dispatch to handler in
│            │                                  │   apps-script.gs
│            │ ◀──────────JSON result──────────┘
└────────────┘
        │
        │  Legacy / local-dev only: fetch(API.ENDPOINT) → doPost(e)
        │     (still gated by Session-trusted email)
```

### 4.1 File map

| File | Role |
|---|---|
| [appsscript.json](appsscript.json) | Manifest — web app deploy config + OAuth scopes |
| [Router.gs](Router.gs) | `doGet`, role-based routing, `api_call`, `api_whoAmI`, allow-list |
| [config.gs](config.gs) | CONFIG-sheet reader, `getUserRole()`, cache, `setupConfigSheet()` |
| [apps-script.gs](apps-script.gs) | Business logic, sheet handlers, hardened `doPost` |
| [assets/js/api.js](assets/js/api.js) | Transport shim: `google.script.run` in prod, `fetch` for local dev |
| [index.html](index.html) | Landing / access-denied / "Switch account" |
| [committee-dashboard.html](committee-dashboard.html) | Committee queue + active issues |
| [builder-dashboard.html](builder-dashboard.html) | Builder task list + status updates |
| [dashboard.html](dashboard.html) | Admin analytics (committee only) |
| [submitted-issues.html](src/pages/submitted-issues.html) | Read-only view of `PENDING_REVIEW` enriched with downstream LIVE / CLOSED status (severity hidden by default — controlled by `FEATURE_SHOW_SEVERITY_ON_SUBMITTED`) |
| [DEPLOYMENT_AUTH.md](DEPLOYMENT_AUTH.md) | Deploy steps for the auth model |

---

## 5. Google Sheet Schema (11 tabs)

| # | Tab | Purpose |
|---|---|---|
| 1 | `Form Responses 1` | Raw form intake (auto-populated by Google Forms) — handover track only |
| 2 | `PENDING_REVIEW` | Handover issues **currently** awaiting committee approval. Rows leave this sheet on approve/reject (strict move). |
| 3 | `LIVE_ISSUES` | Approved, active handover issues (builder updates here). Rows leave on close. |
| 4 | `BUILDER_VIEW` | Spreadsheet-side formula view of `LIVE_ISSUES` for the builder — no code reader |
| 5 | `ARCHIVES_ISSUES` | **Rejected** handover issues (moved here from `PENDING_REVIEW` on reject). Read-only from the app. |
| 6 | `CLOSED_ISSUES` | Resolved handover issues. Layout = `LIVE_COL` + 4 closure columns `[reason, closedDate, closedBy, resolutionDays]`. |
| 7 | `CATEGORY_MASTER` | Dropdown values (shared by both tracks; daily-track filters via the `track` column — see §20.4) |
| 8 | `DASHBOARD` | Formula-only metric tab |
| 9 | `CONFIG` | Runtime config: identity, assets, feature flags, tunables |
| 10 | `DAILY_ISSUES` | **Daily track** — single tab covering the full daily-issue lifecycle. Rows are **updated in place** (`STATUS` column); they do not migrate between sheets. Layout = `DAILY_COL` (see §20.4). Rows leave only on archive (move to `DAILY_ARCHIVES`). |
| 11 | `DAILY_ARCHIVES` | **Daily track** — rejected / spam / duplicate / fully resolved issues older than the retention window (`DAILY_ARCHIVE_AFTER_DAYS`). Read-only from the app. Same layout as `DAILY_ISSUES`. |

`SHEET_ID` is hardcoded in [src/Main.gs](src/Main.gs#L4); all sheet names live in the `SHEETS` constant. Daily-track sheets are gated by `FEATURE_DAILY_TRACK` (default OFF) — when the flag is off the sheets may be absent without breaking any handover code path.

### 5.1 CONFIG tab layout

| Key | Value | Notes |
|---|---|---|
| `COMMITTEE_EMAILS` | `a@x.com, b@x.com` | Comma- or newline-separated |
| `BUILDER_EMAIL` | `builder@x.com` | Single email |
| `MANAGER_EMAILS` | `manager@x.com, ops@x.com` | Comma- or newline-separated. Empty by default. Required for the daily-track manager dashboard. See §20.2. |
| `LOGO_URL` | `https://drive.google.com/uc?id=…` | Optional — falls back to bundled asset |
| `ATTACHMENT_FOLDER_ID` | `1AbC…xyz` | Drive folder ID for **all** in-portal photo uploads (handover submit + committee "attach later" + **daily-track** quick-report). **Auto-populated on first upload** by `resolveAttachmentFolder_({ autoSetup: true })` — walks the canonical path under My Drive and persists the result. Operators can pre-seed it via `setupAttachmentFolder` (see §13.1) or override it with a different folder id manually. The daily track shares the same folder; photos are scoped per-ticket via the `TICKET_ID` (`DLY-NNNNN`) sub-folder convention. |

Feature flags and numeric tunables are stored as additional rows; their canonical defaults live in `DEFAULT_FEATURES` / `DEFAULT_TUNABLES` (`src/Config.gs`). Cached 5 min in `CacheService`; `clearConfigCache()` forces refresh.

**Daily-track flags & tunables** (canonical list in §20.7):

| Key | Default | Effect |
|---|---|---|
| `FEATURE_DAILY_TRACK` | `"false"` | Master switch. When `"false"`, daily-track sheets/APIs/pages are inert and the landing page hides the "Daily Issue" card. |
| `FEATURE_DAILY_ANONYMOUS_SUBMIT` | `"true"` | When `"false"`, daily-track intake requires a Google sign-in. Default ON to keep the resident barrier near zero. |
| `FEATURE_DAILY_PHOTO_UPLOAD` | `"true"` | Daily-track photo uploader kill-switch (independent of `FEATURE_PHOTO_UPLOAD` so handover photos can stay on while daily uploads are paused). |
| `DAILY_AUTO_ACK_HOURS` | `24` | Manager must acknowledge a `NEW` issue within this many hours; overdue rows are flagged red on the manager dashboard. |
| `DAILY_ARCHIVE_AFTER_DAYS` | `90` | `RESOLVED` / `REJECTED` rows older than this are eligible for `archiveDailyIssues` (see §20.5). |
| `DAILY_NOTIFICATION_WHATSAPP` | `"false"` | Reserved — when set, manager-side resolution emits a WhatsApp click-to-chat link for residents who opted in. No outbound API call is made by Apps Script (see §20.6). |

---

## 6. Web App URL Routes (`doGet` parameters)

| URL | Behaviour |
|---|---|
| `/exec` | Role-based landing — committee → committee dashboard, manager → manager dashboard, builder → builder dashboard, unknown → **landing-page split** (handover vs daily entry — see §20.1). When `FEATURE_DAILY_TRACK` is off, the landing falls back to the legacy denied page. |
| `/exec?page=committee` | Force committee dashboard (committee only) |
| `/exec?page=builder` | Force builder dashboard (builder or committee) |
| `/exec?page=admin` | Admin analytics (committee only) |
| `/exec?page=submitted` | Read-only submitted-issues table — unified view of both tracks gated by track-toggle pill (committee, manager, builder, **and anonymous** — see §20.1.E) |
| `/exec?page=manager` | Force manager dashboard (manager or committee). Requires `FEATURE_DAILY_TRACK`. |
| `/exec?page=daily` | Public daily-issue quick-report card (see §20.1.B). **Anonymous-allowed** when `FEATURE_DAILY_TRACK` + `FEATURE_DAILY_ANONYMOUS_SUBMIT` are both on; otherwise requires a Google sign-in. |
| `/exec?page=daily-confirm&id=DLY-00142` | Post-submit confirmation card with tracking ID + share-via-WhatsApp link (see §20.1.C). Anonymous-allowed regardless of session. |

Unauthorized requests for a page never reach the HTML — `Router.gs` substitutes the denied page. Daily-track URLs return the denied page when `FEATURE_DAILY_TRACK` is off (route remains registered so links don't 404).

---

## 7. Server API Surface (`google.script.run.api_call`)

All requests pass through `api_call(action, payload)` in [Router.gs](Router.gs).
`isActionAllowed_(action, role)` is the single source of truth for capabilities.

**Handover-track actions:**

| Action | Committee | Builder | Resident |
|---|:---:|:---:|:---:|
| `getFormResponses` | ✅ | ✅ | — |
| `getIssuesWithStatus` | ✅ | ✅ | ✅ |
| `getSubmittedIssues` | ✅ | ✅ | ✅ |
| `getPendingIssues` | ✅ | — | — |
| `approveIssue` (payload: `{ticketId, severity}`) | ✅ | — | — |
| `rejectIssue` | ✅ | — | — |
| `getLiveIssues` | ✅ | ✅ | — |
| `getClosedIssues` | ✅ | ✅ | — |
| `updateBuilderStatus` | ✅ | ✅ | — |
| `closeIssue` | ✅ | ✅ | — |
| `reopenIssue` | ✅ | ✅ | — |
| `deleteIssue` | ✅ | — | — |
| `generateTicketId` | ✅ | — | — |
| `approveIssueWithTicketId` _(deprecated shim → `approveIssue`)_ | ✅ | — | — |
| `getDashboardMetrics` | ✅ | ✅ | — |
| `syncFormResponses` | ✅ | — | — |
| `submitIssue` | ✅ | ✅ | ✅ |
| `addPhotosToIssue` (payload: `{ticketId, sheet, photos:[{name,mime,b64}]}`) | ✅ | — | — |
| `getReportPhotoB64` (payload: `{fileId, maxW}`) | ✅ | ✅ | ✅ |
| `commitFullReportPdf` (payload: `{b64, source}`) | ✅ | ✅ | — |
| `getCategoryMaster` | ✅ | ✅ | ✅ |
| `getClientConfig` | ✅ | ✅ | ✅ |
| `validateUserAccess` | ✅ | ✅ | ✅ |

**Daily-track actions** (all gated by `FEATURE_DAILY_TRACK`; full design in §20):

| Action | Committee | Manager | Builder | Anon / Resident (Daily) |
|---|:---:|:---:|:---:|:---:|
| `submitDailyIssue` (payload: `{tower, location, category, subCategory, description, photos[], reporterName?, reporterFlat?, reporterPhone?, notifyOptIn?}`) | ✅ | ✅ | ✅ | ✅ (when `FEATURE_DAILY_ANONYMOUS_SUBMIT`) |
| `getDailyIssues` (payload: `{filter: 'NEW' \| 'TRIAGING' \| 'ASSIGNED' \| 'IN_PROGRESS' \| 'RESOLVED' \| 'ALL'}`) | ✅ | ✅ | — | — |
| `getDailyIssuesPublic` (payload: `{ticketId?}`) | ✅ | ✅ | ✅ | ✅ (read-only, PII redacted — used by submitted-issues view + post-submit confirmation lookup) |
| `updateDailyStatus` (payload: `{ticketId, status, comment?, vendor?, severity?}`) | ✅ | ✅ | — | — |
| `assignDailyIssue` (payload: `{ticketId, vendor, severity}`) | ✅ | ✅ | — | — |
| `resolveDailyIssue` (payload: `{ticketId, resolutionNotes, costEstimate?}`) | ✅ | ✅ | — | — |
| `rejectDailyIssue` (payload: `{ticketId, reason}`) | ✅ | ✅ | — | — |
| `reopenDailyIssue` (payload: `{ticketId, reason}`) | ✅ | ✅ | — | — |
| `addPhotosToDailyIssue` (payload: `{ticketId, photos[]}`) | ✅ | ✅ | — | — |
| `archiveDailyIssues` (no payload — runs the retention sweep) | ✅ | ✅ | — | — |
| `getDailyMetrics` (manager-dashboard KPIs) | ✅ | ✅ | — | — |
| `getReportPhotoB64` (re-used as-is — same handler, daily ticket folders auto-resolve) | ✅ | ✅ | ✅ | ✅ |

`getDailyIssuesPublic` is the **PII-redacted** sibling of `getDailyIssues` — it scrubs `REPORTER_NAME`, `REPORTER_PHONE`, and any free-text `DESCRIPTION` content matching a phone-number regex before returning rows. Anonymous callers receive only `{ticketId, tower, category, subCategory, status, severity, reportedDate, resolvedDate?, photoLinks[]}`. The unified submitted-issues view (§20.1.E) calls this for the daily track and `getSubmittedIssues` for the handover track in parallel; results are merged client-side.

`addPhotosToIssue` lets the committee attach photos to an existing issue that was submitted without any (e.g. bulk Form imports). `sheet` must be one of `PENDING_REVIEW`, `LIVE_ISSUES`, or `CLOSED_ISSUES`. New URLs are appended (comma-separated) to the row's existing `PHOTO` column. Gated by **two** flags — both must be true: `FEATURE_COMMITTEE_PHOTO_ATTACH` (master switch for this feature, **default OFF**) and `FEATURE_PHOTO_UPLOAD` (global photo kill-switch). The committee dashboard also hides the **Upload Photo** button client-side when `FEATURE_COMMITTEE_PHOTO_ATTACH` is false.

`getReportPhotoB64` is the photo-fetch helper for the **Export Report** PDF wizard. It takes a Drive file id (or any drive URL containing one) and an optional max-width hint, fetches the JPEG bytes server-side via `UrlFetchApp` (avoids browser CORS issues that prevent jsPDF from embedding Drive thumbnails), and returns `{ mimeType, b64, sourceId }`. Gated by **two** flags — both must be true: `FEATURE_PDF_REPORT` (master switch for the report wizard, **default OFF**) and `FEATURE_PHOTO_UPLOAD` (global photo kill-switch). Available to all roles **including anonymous visitors** (role UNKNOWN) so the Export Report wizard on the public `submitted-issues.html` page can embed photo thumbnails — the underlying Drive attachment folder is already shared "Anyone with the link – Viewer" via `makeAttachmentFolderPublic`, so this exposes nothing that wasn't already publicly viewable via the issue-card thumbnails.

`commitFullReportPdf` accepts the wizard-rendered PDF bytes and overwrites `backups/TA_IAP_Full_Report.pdf`. Allowed for COMMITTEE + BUILDER unconditionally. **Conditionally allowed for anonymous (role UNKNOWN) when `FEATURE_PUBLIC_FULL_REPORT` is on** — this lets the public submitted-issues Export Report write the same canonical file as the dashboards, so a single source of truth backs the **View Full Report** pill across all five pages. Self-defended by `FEATURE_WEEKLY_REPORT_BACKUP` (master kill-switch), 30 MB size cap, and `%PDF` magic-byte check inside the handler itself.

Response envelope: `{ success: boolean, data: any, error: string|null }`
(some legacy actions return `{ success, responses, count, error }` — the
client shim normalises both).

`api_whoAmI()` is a separate endpoint that returns `{ email, role }` for the
signed-in user (used by `API.whoAmI()` on page load).

---

## 8. Issue Lifecycle (state machine)

### 8.0 Handover track

Strict-move semantics: every state transition is `appendRow(target); deleteRow(source)`.
No in-place state flips. A ticket lives on exactly one sheet at a time.

```
Form intake (severity BLANK)
  → PENDING_REVIEW
        ├─▶ approveIssue   → LIVE_ISSUES   (severity set, SLA computed)
        └─▶ rejectIssue    → ARCHIVES_ISSUES (audit, read-only)

LIVE_ISSUES (builder updates STATUS column in place):
  ASSIGNED → IN_PROGRESS → WORK_COMPLETED
        └─▶ closeIssue   → CLOSED_ISSUES

CLOSED_ISSUES:
  └─▶ reopenIssue    → LIVE_ISSUES (status = IN_PROGRESS)
```

### 8.0.1 Daily track (in-place semantics — distinct from handover)

Daily-track tickets do **not** move between sheets during their normal lifecycle. They live in `DAILY_ISSUES` and the `STATUS` column is updated in place. Only `archiveDailyIssues` (retention sweep) moves rows out — to `DAILY_ARCHIVES`. This deliberately differs from the handover track because daily volume is higher, the status changes are more granular, and a single tab simplifies the manager dashboard read path.

```
submitDailyIssue (anonymous or signed-in)
  → DAILY_ISSUES (STATUS = NEW)
        │
        ├─▶ updateDailyStatus(TRIAGING)   — manager acknowledged
        │
        ├─▶ assignDailyIssue              → STATUS = ASSIGNED (vendor + severity set)
        │       │
        │       ├─▶ updateDailyStatus(IN_PROGRESS)
        │       │
        │       ├─▶ resolveDailyIssue     → STATUS = RESOLVED (resolution notes)
        │       │       └─▶ reopenDailyIssue → STATUS = IN_PROGRESS
        │       │
        │       └─▶ rejectDailyIssue      → STATUS = REJECTED (reason)
        │
        └─▶ rejectDailyIssue              → STATUS = REJECTED (spam/duplicate before triage)

Retention sweep (manual or scheduled):
  archiveDailyIssues
    └─▶ rows where (STATUS in {RESOLVED, REJECTED}) AND age > DAILY_ARCHIVE_AFTER_DAYS
        → DAILY_ARCHIVES (strict move; same shape)
```

Full state-machine semantics, columns, and per-state allowed transitions are in §20.5.

> Severity & SLA are set **on approval**, not on intake. `approveIssue`
> requires `{ ticketId, severity }`; the server validates severity and
> computes `slaDate = calculateSLADate(severity, reportedDate)` before
> writing to `LIVE_ISSUES`.

### 8.1 Per-page data sources

Every page must fetch from **every** lifecycle sheet it surfaces — do not
infer counts from `getDashboardMetrics` alone.

| Page | Fetches | Renders |
|---|---|---|
| `committee-dashboard.html` | `getPendingIssues` (PENDING + ARCHIVES) + `getLiveIssues('ALL')` + `getClosedIssues` + `getDashboardMetrics` | Pending tab (filter: Pending/Rejected/All), Active tab, Closed tab |
| `builder-dashboard.html` | `getLiveIssues('BUILDER')` + `getClosedIssues` | Merged into single table; "Work Completed" filter covers both builder-marked and committee-closed |
| `admin-dashboard.html` | `getDashboardMetrics` + `getLiveIssues('ALL')` | KPIs + charts + aging/SLA tables |
| `submitted-issues.html` | `getSubmittedIssues` (unions PENDING + LIVE + optional ARCHIVES) | Single table with Status filter; archives gated by `SUBMITTED_INCLUDE_REJECTED` |
| `submit-issue.html` | `getClientConfig` + `getCategoryMaster` | Intake form |

> **Photo array shape (canonical).** Every reader emits the photo URLs as
> `i.issue.photoLinks` (array of normalized Drive thumbnail URLs).
> `getSubmittedIssues` additionally retains a root-level `attachments`
> array for the legacy submitted-issues detail-modal renderer; new
> consumers must read `i.issue.photoLinks`. The PDF Export wizard
> (`partials/pdf-report.html` `COLUMN_CATALOG.photos.read`) reads only
> the canonical field — root-only `attachments` will produce empty Photo
> cells.

---

## 9. Ticket IDs

- Generated by `generateTicketID()` at **intake** (Form trigger + in-portal submit).
- Format: `TKT-00001`, `TKT-00002`, … (5-digit, zero-padded).
- **Source of truth:** a `TICKET_COUNTER` value in
  `PropertiesService.getScriptProperties()`. Each call lifts the counter
  to `max(counter, scannedMax) + 1` and writes it back atomically
  inside a `LockService.getScriptLock()` critical section, so two
  concurrent intakes can never mint the same id and a manual sheet
  edit (paste, row-delete, re-import) can never collide either.
- `scannedMax` is computed across `PENDING_REVIEW` (the primary intake
  sheet — every new ticket lands here first), `LIVE_ISSUES`, and
  `CLOSED_ISSUES`, recognising both `TKT-` and legacy `TA-` prefixes.
- The ticket id **does not change** on approval. `approveIssueWithTicketId`
  is a deprecated shim retained for any legacy clients — it ignores
  `newTicketId` and delegates to `approveIssue`.

### 9.1 Recovery functions

When the spreadsheet drifts (duplicate ids, missing pending rows, etc.)
operators run these from the Apps Script editor — both take a full XLSX
backup to GitHub before any write:

- `renumberAllTicketIds()` (`src/Recovery.gs`) — rewrites `TICKET_ID`
  across `PENDING_REVIEW` + `LIVE_ISSUES` + `CLOSED_ISSUES` +
  `ARCHIVES_ISSUES` as a single monotonic `TKT-NNNNN` series sorted by
  `DATE_REPORTED` ascending. Resets `TICKET_COUNTER` to the new max.
  Drive folder names are **not** renamed; existing photos still resolve
  because they reference the folder by Drive id, not name.
- `recoverPendingFromForm()` (`src/Recovery.gs`) — wipes
  `PENDING_REVIEW` data rows and re-imports every row from
  `Form Responses 1` whose `{timestamp,resident,flat}` signature is not
  already present in `LIVE_ISSUES` or `CLOSED_ISSUES` (so already-
  promoted tickets are not duplicated). Drops the cached
  `TICKET_COUNTER` so new pending ids are minted from the surviving
  live/closed max via `generateTicketID()`.
- `dedupeTicketIds()` (`src/Recovery.gs`) — surgical fix for the
  "external paste introduced duplicate ids" scenario (e.g. an assessment
  CSV import seeded three rows with the same legacy `TA-0001`). Scans
  all four issue sheets, keeps the row with the earliest
  `DATE_REPORTED` for each id (tiebreak: sheet order in
  `RECOVERY_TICKET_SHEETS`, then row index), and assigns a fresh
  `TKT-NNNNN` id (via `generateTicketID()`) to every other occurrence.
  Non-duplicated rows are never touched, so existing photo folders and
  external references survive intact.
- `normalizeLegacyTicketIds()` (`src/Recovery.gs`) — companion to
  `dedupeTicketIds()` for the "external paste introduced bad-shape ids"
  scenario, **including singletons** (e.g. one-off `TA-0001` audit row
  pasted from an assessment dump). Scans all four issue sheets and
  reissues a fresh `TKT-NNNNN` id (via `generateTicketID()`) for every
  row whose id does not match `^TKT-\d{5}$`. Use after any direct
  paste of legacy / audit data into the sheets — `dedupeTicketIds`
  alone will not catch a unique `TA-0001` because there's nothing to
  deduplicate against.

---

## 10. SLA Rules

| Severity | Days |
|---|---|
| Critical | 1 |
| High | 3 |
| Medium | 7 |
| Low | 15 |

Auto-calculated on approval (`calculateSLADate`). Dashboard surfaces breaches.

---

## 11. Google Form Fields (7)

Resident Name · Flat Number · Category · Sub-Category · Tower · Exact Location/Comment · Upload Photos/Video.

> Severity is **not** a form question. It is assigned by the Technical Committee
> on approval (see §8). The `Severity` column is retained in `Form Responses 1`
> and `PENDING_REVIEW` for historical rows and remains blank for new intake.
>
> Email and Phone are not collected by the form. Resident identity in the
> in-portal submit path comes from `Session.getActiveUser().getEmail()`.

`onFormSubmit` trigger writes a new `PENDING_APPROVAL` row.

---

## 12. Apps Script Triggers

| Trigger | Schedule | Purpose |
|---|---|---|
| `onFormSubmit` | On form submit | Create ticket in `PENDING_REVIEW` |
| `clearConfigCache` *(optional)* | Hourly | Pick up CONFIG edits without manual run |
| `weeklyBackupJob` *(optional)* | `REPORT_BACKUP_FREQUENCY` (default `"3x-daily"`) — every 8 hours by default; once per day at ~02:00 IST when `"daily"`; Mondays only at ~02:00 when `"weekly"` | XLSX snapshot of the spreadsheet committed to `backups/ta-issue-manager.xlsx`. Installed by `installWeeklyBackupTrigger` once `GITHUB_TOKEN` is set. Re-run the installer after editing the tunable so the trigger is recreated with the new cadence. |
| `weeklyReportJob` *(optional, gated by `FEATURE_WEEKLY_REPORT_BACKUP`)* | `REPORT_BACKUP_FREQUENCY` (default `"3x-daily"`) — every 8 hours by default; once per day at ~03:00 IST when `"daily"` (one hour after the daily sheet backup so it picks up that day's snapshot); Mondays only at ~03:00 when `"weekly"` | Builds two PDF status reports server-side and commits both to GitHub: `backups/TA_IAP_Report.pdf` (anonymised — pending+active only, resident name and flat number redacted to `—`) and `backups/TA_IAP_Full_Report.pdf` (full content — pending+active+closed+rejected, photos embedded inline). Installed by `installWeeklyReportTrigger`. The full-report file is also overwritten on demand whenever a committee/builder clicks **Export Report** on a dashboard (the wizard streams the rendered PDF — including photos — back to the server via `commitFullReportPdf`); the scheduled trigger is the fallback when nobody exported in the last interval. Re-run `installWeeklyReportTrigger` after editing `REPORT_BACKUP_FREQUENCY`. See §19.14. |

---

## 13. Deployment (mandatory settings)

| Setting | Value |
|---|---|
| Manifest | [appsscript.json](appsscript.json) (`USER_ACCESSING`, `ANYONE`) |
| Required scopes | `spreadsheets`, `userinfo.email`, `script.container.ui`, `script.send_mail`, `drive` (read + write for uploads) |
| Deploy as | Web app, *Execute as: User accessing the web app*, *Who has access: Anyone with a Google account* (secure deployment) plus a sibling public deployment (`USER_DEPLOYING` / `ANYONE_ANONYMOUS`) for intake — see §19.8 |

### 13.1 Apps Script setup runbook (one-time, in order)

All functions live in `src/Config.gs`. Run from the Apps Script editor → function dropdown → Run. All are idempotent.

| # | When | Function | What it does |
|---|---|---|---|
| 1 | Fresh deploy, or after pulling new `DEFAULT_FEATURES` / `DEFAULT_TUNABLES` | `setupConfigSheet` | Seeds the `CONFIG` tab. Preserves existing operator values; appends only missing keys with defaults. |
| 2 | **Fresh deploy, or after re-binding to a different spreadsheet / form** — without this, form submissions land in `Form Responses 1` but **never become tickets** | `installFormSubmitTrigger` (`src/Main.gs`) | Idempotent. Removes any prior `onFormSubmit` triggers on this script project and creates a fresh spreadsheet-form-submit trigger so each new Google Form response runs `onFormSubmit(e)` → `createPendingIssue_()` → row appended to `PENDING_REVIEW` with a fresh `TKT-NNNNN` id. Returns `{success, message, data:{removed, triggerId}}`. |
| — | _Diagnostic_ — confirm form / weekly / report triggers are wired up | `listProjectTriggers` (`src/Main.gs`) | Read-only. Lists every trigger on the script project (`handler`, `type`, `triggerSource`, `sourceId`, `uniqueId`). If `onFormSubmit` is missing, run `installFormSubmitTrigger`. |
| — | _Optional_ — pre-seed `ATTACHMENT_FOLDER_ID` without waiting for the first upload | `setupAttachmentFolder` | Walks `My Drive / TA_HANDOVER / ISSUE_UPLOADS / TA Issue Reporting Portal / Upload Photos/Video` (tolerating ` (File responses)` suffix), persists the folder id in CONFIG, and forces public-view on the folder. **Not required** — `uploadSubmissionPhotos_` calls the same resolver lazily on first upload via `resolveAttachmentFolder_({ autoSetup: true, makePublic: true })`. |
| — | _Optional_ — bulk-publish files already inside the attachment folder (Form-uploaded, etc.) | `makeAttachmentFolderPublic` | Walks every file in the folder and re-applies *Anyone with link → Viewer*. New uploads after this build are made public automatically by `trySharePublic_` in the upload path. Falls back to `ANYONE` if domain policy blocks link sharing. |
| — | Anytime, to verify | `whereDoUploadsGo` | Read-only. Prints the configured folder's full path + URL. Does not change anything. |
| — | After editing CONFIG by hand | `clearConfigCache` | Forces the next call to re-read CONFIG (5-min cache otherwise). |

Full operator steps in [DEPLOYMENT_AUTH.md](DEPLOYMENT_AUTH.md) and the **Apps Script setup runbook** table in `README.md`.

---

## 14. Security Requirements

- ✅ Identity comes only from `Session.getActiveUser().getEmail()`.
- ✅ All actions pass through `api_call` → role-based allow-list.
- ✅ Client payloads MUST NOT contain `userEmail`; backend MUST ignore it.
- ✅ Committee/builder emails managed via CONFIG sheet (no code change to add/remove).
- ✅ No PII in `sessionStorage`, `localStorage`, or query strings.
- ✅ "Switch account" available on every page (`API.signOut()`).
- ✅ Defaults in [config.gs](config.gs) are FALLBACK ONLY (used if CONFIG sheet missing).
- ❌ No client-typed email/role login form.
- ❌ No "allow all as COMMITTEE" testing bypass in production.

---

## 15. Frontend Requirements

- Single-page-per-role design. Pages are loaded as Apps Script HTML files.
- All API calls go through the `API` shim in [assets/js/api.js](assets/js/api.js).
- `window.IRP_USER = { email, role }` is populated on page load via `API.whoAmI()`.
- Every dashboard runs an `ensureAuthorized()` IIFE before loading data and
  redirects to the landing page if the role is wrong.
- Tailwind via CDN, Font Awesome via CDN, Chart.js via CDN. No build step.
- Mobile breakpoints: 375px (iPhone SE), 360px (Android), 768px (iPad).
- Page weight target: < 200 KB compressed per page.

---

## 16. Non-Goals / Out of Scope

- Password-based authentication.
- Workspace-domain restriction (achievable later by changing deploy access setting; not required now).
- Mobile native apps.
- Multi-building / multi-tenant support.
- Real-time push (auto-refresh polling is sufficient).

---

## 17. Rollback Plan

Re-deploy with **Execute as: Me** + **Access: Anyone**, restore the
"BYPASS AUTHENTICATION" block in `validateUserAccess`, and the legacy client
flow still works. CONFIG sheet is backward-compatible.

---

## 18. Acceptance Criteria

1. Opening `/exec` while signed in as a committee member loads the committee dashboard with no email/role prompt.
2. Opening `/exec` while signed in as the builder loads the builder dashboard.
3. Opening `/exec` while signed in as an unauthorized Google account shows the access-denied landing with the verified email and a "Switch account" button.
4. A builder who manipulates DevTools to call `API.call('approveIssue', …)` receives `Forbidden for role BUILDER: approveIssue`.
5. Removing an email from `CONFIG.COMMITTEE_EMAILS` and running `clearConfigCache` revokes that user's access within seconds.
6. No `sessionStorage`/`localStorage` key contains an email after any flow.
7. `doPost` ignores any `userEmail` field in the request body and uses `Session.getActiveUser().getEmail()`.

---

## 19. Critical Issues & Lessons Learned

This section records bugs whose root cause was non-obvious. Re-read before
touching the affected area.

### 19.1 `google.script.run` silently returns `null` on Invalid Date

**Symptom:** `api_call('getX')` resolves to `null` on the client even though
the server function returns a populated `{success, data, error}` object.
No error, no console log, no stack trace.

**Root cause:** Apps Script cannot serialize `new Date(NaN)` across the
`google.script.run` bridge. If **any** field in the response is an Invalid
Date, the *entire* response is dropped and the success handler receives
`null`. Invalid Dates are produced when reading empty date-formatted Sheet
cells with `getValues()`.

**Rule:** Every value returned to the client must pass through the helpers
in `src/Main.gs`:
- `safeStr_(v)` — coerce to string, blank for null/undefined.
- `safeDateIso_(v)` — ISO string, or `""` if invalid/empty.

Applies to **all** server functions that read from sheets:
`getPendingIssues`, `getLiveIssues`, `getClosedIssues`,
`getSubmittedIssues`, `getFormResponses`, `getIssuesWithStatus`, etc.

### 19.2 Strict-move semantics for sheet-based state transitions

**Symptom:** Committee "Pending Only" filter showed approved tickets.
Rows appeared on multiple tabs at once.

**Root cause:** `approveIssue` was flipping a `STATE=APPROVED` column in
place on `PENDING_REVIEW` and **also** appending to `LIVE_ISSUES`. The
same ticket existed on two sheets.

**Rule:** Every transition is `appendRow(target); deleteRow(source)` —
in that order, inside one function. Never leave a logical state flag on
the source row. A ticket lives on exactly one sheet at a time.

Applies to: `approveIssue`, `rejectIssue`, `closeIssue`, `reopenIssue`,
`deleteIssue`.

### 19.3 Never silently swap in mock data on API failure

**Symptom:** Dashboard "worked" with plausible-looking content while the
real backend was broken (permission denied, null response, etc.).
Real failures went undetected for days.

**Rule:** On API failure, render empty state + a visible toast carrying
the real error message. Mock data is for local development only and must
never be used as a runtime fallback. If permissions are the likely cause,
append a hint ("your Google account may not have access…").

Reference implementation: `committee-dashboard.html → loadData()` catch
block.

### 19.4 Per-page data audit — fetch from every relevant lifecycle sheet

**Symptom:** Committee "Closed" tab was permanently empty. Builder
"Work Completed" filter only showed builder-marked rows, not committee-closed
tickets.

**Root cause:** Pages were sourcing counts from `getDashboardMetrics`
(which has aggregates but not row data) instead of fetching the actual
sheet via `getClosedIssues`.

**Rule:** When a page surfaces rows from a lifecycle state, it must call
the dedicated getter for that sheet. See §8.1 for the per-page matrix.
When adding a new state or sheet, update that matrix and audit every page.

### 19.5 Sheet column layouts diverge per tab — don't share a single map

`PENDING_REVIEW` uses `PENDING_COL` (width `PENDING_WIDTH = 17`).
`LIVE_ISSUES` and `CLOSED_ISSUES` use `LIVE_COL` (width `LIVE_WIDTH = 20`).
`ARCHIVES_ISSUES` reuses `PENDING_COL`.
`CLOSED_ISSUES` extends `LIVE_COL` with 4 trailing columns:
`[reason, closedDate, closedBy, resolutionDays]` at indices
`LIVE_WIDTH .. LIVE_WIDTH+3`.

Functions that union rows across sheets (e.g. `getSubmittedIssues`) must
use a per-sheet mapper — do not index `row[]` with a single shared map.

### 19.6 `submitIssue` writes blank severity

Severity is assigned by the committee on approval, not by the resident.
`submitIssue` and the form trigger both force `severity = ""` regardless
of any client-supplied value. The submit form has no severity field.

### 19.7 Tunables that gate visibility

| Tunable (CONFIG sheet) | Default | Effect |
|---|---|---|
| `SUBMITTED_INCLUDE_REJECTED` | `"false"` | When `"true"`, `getSubmittedIssues` also unions `ARCHIVES_ISSUES`. Read-only submitted view hides rejected rows by default. |
| `FEATURE_SHOW_SEVERITY_ON_SUBMITTED` | `"false"` | When `"true"`, severity column is visible on the submitted-issues page. |
| `FEATURE_OPEN_SHEET_LINK` | `"false"` | When `"true"`, the public submitted-issues page renders the **Open in Sheets** pill (linking to the underlying spreadsheet) on the title row. Default OFF — opt-in. The button is server-rendered, so when off it is absent from the HTML entirely (no client-side gate to bypass). |
| `FEATURE_COMMITTEE_PHOTO_ATTACH` | `"false"` | When `"true"`, committee detail view shows an **Upload Photo** button on issues without photos and the `addPhotosToIssue` API accepts writes. Default OFF — opt-in via the CONFIG sheet. |
| `FEATURE_PDF_REPORT` | `"true"` | When `"true"` (the default), every list view (Committee / Builder / Submitted read-only) shows an **Export Report** button that opens a PDF wizard (sources, columns, embedded photos) and the `getReportPhotoB64` API accepts requests. Each view scopes its own column menu (Committee = full 17 incl. `photos`; Builder drops committee-only fields; Submitted read-only shows Ticket ID + Title + form-entry fields + Status + `photos` only) — the column catalog and per-view defaults live in `src/partials/pdf-report.html` and each page's `openExportReport()`. The first page opens with a compact title header (portal + title band + single meta line of generated/by/source-counts/filters) and the first section's list begins immediately below — no full cover page. Photos are embedded **only inline in the Photos column** (thumbnail grid sized by `INLINE_THUMB`); there is no separate end-of-section gallery. The wizard's "Include photos" master switch gates inline rendering and, when off, also drops the Photos column from the table. Default ON — turn off in the CONFIG sheet to hide the wizard. |
| `FEATURE_WEEKLY_REPORT_BACKUP` | `"true"` | When `"true"` (the default), two PDF status reports are committed to GitHub by the weekly cron (see §19.14): **(a)** `backups/TA_IAP_Report.pdf` — anonymised, pending+active only, resident name and flat number redacted to `—` (no login-page button — the anonymised file is retained for legacy/external mirrors only); **(b)** `backups/TA_IAP_Full_Report.pdf` — full content including closed+rejected rows, names, flats, descriptions, and **photos embedded inline** (server-side fallback now fetches Drive thumbnails authenticated via `UrlFetchApp` + script OAuth and embeds them via `Body.appendImage`, capped at 4 photos per issue / 60 per report; the dashboard-wizard `commitFullReportPdf` path still wins when used). All five pages (login, submitted, committee, builder, admin) expose this via a small **View Full Report** pill that resolves to `FULL_REPORT_PUBLIC_URL` (auto-derived from `BACKUP_REPO` + `BACKUP_BRANCH` when the tunable is empty, so the pill works out-of-the-box). The pill renders **whenever the URL resolves** and is independent of `FEATURE_WEEKLY_REPORT_BACKUP` — the flag now only gates the *write* paths (cron job, wizard auto-commit). The cron and `commitFullReportPdf` API still require the `GITHUB_TOKEN` script property and a configured `BACKUP_REPO`. Default ON — turn off in the CONFIG sheet to disable the cron + wizard auto-commit (the View Full Report pill keeps working as long as a previously committed PDF exists at the URL). |
| `FEATURE_PUBLIC_FULL_REPORT` | `"true"` | When `"true"` (the default), the public `submitted-issues.html` Export Report behaves the same as the committee/builder Export: **(a)** `getSubmittedIssues` unions `CLOSED_ISSUES` (alongside pending + live + the existing `SUBMITTED_INCLUDE_REJECTED` gate on rejected), so the wizard's PDF covers the full ticket lifecycle; and **(b)** anonymous visitors are allowed to call `commitFullReportPdf`, overwriting `backups/TA_IAP_Full_Report.pdf` — same canonical file the dashboards push to, so the **View Full Report** pill on every page always points at the freshest content regardless of which view ran the export. Requires `FEATURE_PDF_REPORT` + `FEATURE_WEEKLY_REPORT_BACKUP`. The commit handler retains its own defences (`%PDF` magic check, 30 MB size cap, `GITHUB_TOKEN` + `BACKUP_REPO` required). Flip OFF in CONFIG if anonymous abuse appears — that instantly reverts to the prior behaviour (public view excludes closed tickets and cannot write to GitHub) without a redeploy. |
| `WEEKLY_REPORT_PUBLIC_URL` | `""` | Raw URL where `TA_IAP_Report.pdf` (the anonymised public copy) lands. Recommended: `https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Report.pdf`. **When empty, the server auto-derives this URL from `BACKUP_REPO` + `BACKUP_BRANCH`** unconditionally (no longer gated by `FEATURE_WEEKLY_REPORT_BACKUP`), so the URL is always served via `getClientConfig`. The login page no longer renders an anonymised pill (replaced by **View Full Report**); operators can still mirror the anonymised file externally if needed. |
| `FULL_REPORT_PUBLIC_URL` | `""` | Raw URL where `TA_IAP_Full_Report.pdf` (the full report including names, flats, closed/rejected rows, **and embedded photos**) lands. Recommended: `https://raw.githubusercontent.com/tadeskops/ta-issue-manager/main/backups/TA_IAP_Full_Report.pdf`. **When empty, the server auto-derives this URL from `BACKUP_REPO` + `BACKUP_BRANCH`** unconditionally so the **View Full Report** pill on every page works out-of-the-box. **Privacy note:** the full file contains residents' names and flat numbers — keep the backup repo private, or override this tunable to point at an authenticated mirror, before sharing widely. |
| `REPORT_BACKUP_FREQUENCY` | `"3x-daily"` | Cadence for **both** scheduled trigger jobs that commit to the GitHub mirror — the XLSX sheet backup (`weeklyBackupJob`, ~02:00 anchor) and the PDF report job (`weeklyReportJob`, ~03:00 anchor). Accepted values: **`"3x-daily"` (default)** installs `.everyHours(8)` so each job fires roughly **3 times per 24 h** — chosen so the canonical `backups/TA_IAP_Full_Report.pdf` and `backups/ta-issue-manager.xlsx` stay fresh enough for an end-of-shift snapshot model without crossing the Apps Script daily-trigger quota; Apps Script `.everyHours()` cannot be pinned to a specific wall-clock hour, so the actual fire times depend on when the trigger was installed. `"daily"` falls back to once per day at the legacy ~02:00 / ~03:00 slot via `.everyDays(1).atHour(...)`. `"weekly"` reverts to the historic Mondays-only schedule. Any other value (typo, blank, common spelling variants like `"3x"` or `"thrice-daily"` are tolerated; everything else) is treated as `"3x-daily"`. Apps Script time-based triggers are independent objects — **editing this tunable does not move an already-installed trigger.** Re-run `installWeeklyBackupTrigger` and `installWeeklyReportTrigger` from the Apps Script editor after changing the value so each installer wipes its prior trigger and recreates it with the new cadence. The function names retain the `weekly` prefix for backward compatibility; only the schedule changes. |
| `FEATURE_SLA` | `"false"` | When `"true"`, every list view (Committee / Builder / Admin) shows SLA breach KPI cards, the **SLA Days** column, the **SLA Breached** filter option, the **SLA Status / Due Date / Days Remaining** detail-modal block, and the PDF wizard exposes `slaDue` + `breached` columns. The `getLiveIssues` API still returns a `sla:{}` sub-object (with placeholder `dueDate:""`, `breached:false`, `daysRemaining:null` when off), and `getDashboardMetrics.slaBreaches` is forced to `0` when off so existing clients don't NPE. SLA due-date is still **computed and written** to `LIVE_ISSUES.SLA_DATE` at `approveIssue` time regardless of the flag, so flipping it on later "just works". The approve-modal severity labels also drop the `(SLA X day)` suffix and the helper note `SLA due date is computed…` when off. Default OFF — opt-in via the CONFIG sheet. |

Defaults live in `DEFAULT_TUNABLES` (`src/Config.gs`); CONFIG sheet values
override.

### 19.8 Two deployments — public vs secure

The app is published as two web-app deployments and CI keeps both in sync
via `clasp 3.3.0`:

| Deployment | `executeAs` | `access` | Purpose |
|---|---|---|---|
| Public  | `USER_DEPLOYING` | `ANYONE_ANONYMOUS` | Landing + intake form (no Google sign-in) |
| Secure  | `USER_ACCESSING` | `ANYONE` | All authenticated dashboards |

`signOut()` and "Back to Login" redirect to `PUBLIC_WEBAPP_URL`. Do not
merge these into a single deployment — the public one must not require
Google sign-in.

### 19.9 Status enum — only what the server actually writes

UI dropdowns, badge maps and fallback labels must list **only** the states
the server writes. Inventing extra states (e.g. `NEW`) causes filters to
show empty results and confuses users.

Canonical status set (single source of truth):

| Status | Set by | Lives on |
|---|---|---|
| `PENDING_APPROVAL` | form intake / `onFormSubmit` | `PENDING_REVIEW` |
| `REJECTED` | `rejectIssue` | `ARCHIVES_ISSUES` |
| `ASSIGNED` | `approveIssue` | `LIVE_ISSUES` |
| `IN_PROGRESS` | builder update | `LIVE_ISSUES` |
| `WORK_COMPLETED` | builder update | `LIVE_ISSUES` |
| `REOPENED` | `reopenIssue` | `LIVE_ISSUES` |
| `CLOSED` | `closeIssue` | `CLOSED_ISSUES` |

When adding a new state, update **every** page's filter dropdown,
`getStatusBadge()`, `getStatusIcon()`, and any `status || 'FALLBACK'`
default. When removing a state, sweep the codebase first
(`grep -rE "['\"]STATE['\"]" src/`).

### 19.10 `.gs` files have no local JS parser — `clasp push` is the syntax check

**Symptom:** Local edits to `src/Main.gs` looked fine in VS Code, all
"No errors found", but CI failed with:
`Syntax error: SyntaxError: Illegal return statement line: NNNN file: src/Main.gs`

**Root cause:** Apps Script `.gs` files are not parsed by any local
tool — VS Code's JS language service does not load them by default, so
orphan `return` statements, missing function headers and unbalanced
braces only surface when the V8 runtime parses them server-side after
`clasp push`. In this incident an earlier refactor stripped the
`function reopenIssue(...) {` header and left its body as top-level code.

**Rule:** After any edit that touches function boundaries in a `.gs`
file, run a quick brace/return audit before committing:

```powershell
node -e "const s=require('fs').readFileSync('src/Main.gs','utf8');let d=0;s.split('\n').forEach((l,i)=>{const o=(l.match(/{/g)||[]).length,c=(l.match(/}/g)||[]).length;d+=o-c;if(/^\s*return\b/.test(l)&&d===0)console.log('TOP-LEVEL RETURN at',i+1)});console.log('depth='+d)"
```

`depth` must end at `0`, and there must be no top-level returns.

### 19.11 CI: never let `bash -e` swallow command output

**Symptom:** Workflow step showed only `Process completed with exit code 1`,
no diagnostic from the failing command.

**Root cause:** `OUTPUT=$(cmd 2>&1); echo "$OUTPUT"` under `bash -e`
aborts the script on the assignment line the moment `cmd` exits non-zero,
so `echo` never runs and the captured stderr is lost.

**Rule:** Wrap any capture-then-inspect pattern in `set +e … set -e`:

```bash
set +e
OUTPUT=$(clasp push -f 2>&1)
EC=$?
set -e
echo "$OUTPUT"
echo "exit code: $EC"
[ $EC -ne 0 ] && { echo "::error::cmd failed"; exit $EC; }
```

### 19.12 `clasp 3.x` `.claspignore` uses strict gitignore semantics

**Symptom:** `clasp push -f` reported `Pushed 0 files` and CI failed.

**Root cause:** clasp 3.x switched its ignore parser to strict gitignore
rules: *"It is not possible to re-include a file if a parent directory of
that file is excluded."* The legacy whitelist pattern

```
**
!appsscript.json
!src/**
```

excludes the `src/` directory itself, so `!src/**` has no effect — and
older clasp versions silently tolerated this.

**Rule:** Use root-anchored ignores so parent dirs are never excluded:

```
/*
/.*

!/appsscript.json
!/src
```

`/*` only matches top-level non-hidden entries; `/.*` covers root-level
dotfiles (`.github`, `.gitignore`, `.claspignore`). The `src/` directory
is then never excluded, so its full contents are walked and pushed.

### 19.13 Drive `/file/d/<id>/view` URLs do **not** render in `<img>` tags

**Symptom:** Photos uploaded via the Google Form (or older portal
submissions) showed as broken images in the web app, even though clicking
the link in a new tab worked.

**Root cause:** `DriveApp.File.getUrl()` returns the **HTML viewer** URL
(`https://drive.google.com/file/d/<id>/view?...`). The browser fetches an
entire Drive HTML page, not the image bytes, so `<img src=...>` fails.
Additionally, the legacy `?export=view` endpoint sometimes triggers a
redirect chain that the Apps Script iframe blocks.

**Rule:** Every photo URL returned to the client must be normalized via
`driveImageUrl_(url)` in `src/Main.gs`, which rewrites any Drive URL
(`/file/d/<id>/view`, `?id=<id>`, `/open?id=<id>`, `/uc?...`) to the
thumbnail endpoint:

```
https://drive.google.com/thumbnail?id=<ID>&sz=w2000
```

This endpoint streams JPEG bytes, honors *Anyone with the link* sharing,
and works inside `<img>`. `splitPhotoLinks_` applies the normalization
automatically for **every** reader (`getPendingIssues`, `getLiveIssues`,
`getClosedIssues`, `getFormResponses`, etc.), so callers never need to
convert URLs themselves.

**Companion rule:** Files in the attachment folder must be publicly
viewable for any web-app visitor (the public deployment serves anonymous
users — see §19.8). `uploadSubmissionPhotos_` forces
`ANYONE_WITH_LINK → VIEW` on every new upload (falling back to `ANYONE`
and logging on policy block). For legacy / Form-uploaded files, run
`makeAttachmentFolderPublic` once (§13.1) to retroactively open up the
entire folder.

### 19.14 Weekly PDF status report — dual-file model

**Goal.** Operators want a static PDF snapshot of the issue queue
checked into the GitHub mirror so it survives Sheet edits, accidental
deletions, and Apps Script outages, and is linked from **every** page
(login, submitted, committee, builder, admin) via a small **View Full
Report** pill. The cron itself is gated by `FEATURE_WEEKLY_REPORT_BACKUP`
(default **on** as of v2026.06) and ships **two** files at the same `BACKUP_REPO`:

| File path (in repo) | Default scope | Content | Surfaced where |
|---|---|---|---|
| `backups/TA_IAP_Report.pdf` | Pending + Active only | Per-issue table (Ticket / Date / Tower / Category / Severity / Status / Description). **Resident name and flat number are redacted to `—`.** No photos. | Retained for legacy/external mirrors only — no UI surface (the login page now points at the full report, see below). |
| `backups/TA_IAP_Full_Report.pdf` | Pending + Active + Closed + Rejected | Per-issue table including resident name, full Tower / Flat, descriptions, **and inline photos** (server-side cron now fetches Drive thumbnails authenticated via `UrlFetchApp` + script OAuth and embeds them via `Body.appendImage`, capped at 4 photos per issue / 60 per report; the wizard-pushed copy is even richer). | **All five pages** (login, submitted, committee, builder, admin) via a small **View Full Report** pill that resolves to `FULL_REPORT_PUBLIC_URL` (auto-derived from `BACKUP_REPO` + `BACKUP_BRANCH` when the tunable is empty). The pill is **independent of `FEATURE_WEEKLY_REPORT_BACKUP`** — it renders whenever the URL resolves so the link keeps working even after the cron is paused. |

**Two write paths converge on the same files.**

1. **Wizard auto-commit (full file only).** Whenever a committee or
   builder clicks **Export Report** on a signed-in dashboard, the
   existing client-side wizard renders the PDF as today (jsPDF +
   `jspdf-autotable`, optional photos), then — fire-and-forget — base64-
   encodes the bytes and calls `commitFullReportPdf(b64, source)` on the
   server. The server validates the `%PDF` magic bytes, enforces a 30 MB
   size cap, and upserts the file via the existing
   `backup_putToGit_` helper. Failures never block the user's local
   download / preview. Committee + builder pages always opt into this
   hook by setting `window.IRP_AUTO_COMMIT_FULL_REPORT = true` after
   `getClientConfig` succeeds. **The public `submitted-issues.html`
   page also opts in when `FEATURE_PUBLIC_FULL_REPORT` is on** — under
   that flag the server's `getSubmittedIssues` also returns CLOSED
   tickets (matching the committee/builder data scope) so the
   wizard's PDF is complete enough to overwrite the canonical file.
   The login page never opts in. As a defence in depth, the router
   allows `commitFullReportPdf` for anonymous callers **only when
   `FEATURE_PUBLIC_FULL_REPORT` is on** — flipping the flag off in
   CONFIG instantly revokes anonymous write access without redeploy.

2. **Scheduled server fallback (both files).** A time-based trigger
   `weeklyReportJob` runs on a schedule controlled by
   `REPORT_BACKUP_FREQUENCY` and rebuilds **both** files using
   `DocumentApp` server-side. **Default `"3x-daily"` installs
   `.everyHours(8)`** so each scheduled run refreshes the canonical
   `backups/TA_IAP_Full_Report.pdf` (and the anonymised companion)
   roughly three times every 24 h — a quiet shift never goes longer
   than ~8 h without a fresh snapshot, and the **View Full Report**
   pill on every page picks up the latest content automatically.
   `"daily"` reverts to once per day at ~03:00 IST (one hour after the
   daily sheet backup so it picks up that day's snapshot); `"weekly"`
   keeps the legacy Mondays-only schedule. The companion
   `weeklyBackupJob` (XLSX snapshot, ~02:00 anchor) reads the same
   tunable so the sheet backup and PDF report stay aligned. The
   anonymised file always overwrites; the full file overwrites too,
   so a quiet interval (no manual export) still refreshes the
   snapshot. `DocumentApp` cannot reliably embed Drive photos at
   scale, so the server-built copy of `TA_IAP_Full_Report.pdf` is
   text-only — the wizard-pushed copy (when available) is the richer
   one. **Editing `REPORT_BACKUP_FREQUENCY` does not move an
   already-installed trigger** — re-run both `installWeeklyBackupTrigger`
   and `installWeeklyReportTrigger` after changing the value so each
   installer wipes its prior trigger and recreates it with the new
   cadence. The function names retain the `weekly` prefix for backward
   compatibility; only the schedule changes.

**Implementation pointers.** All logic lives in
[`src/WeeklyReport.gs`](../src/WeeklyReport.gs):

- `weeklyReport_props_()` reads `GITHUB_TOKEN` / `BACKUP_REPO` /
  `BACKUP_BRANCH` from script properties (reusing
  `backup_props_()` from `src/Backup.gs`) plus `WEEKLY_REPORT_DIR`
  (default `backups`), `WEEKLY_REPORT_FILE` (default
  `TA_IAP_Report.pdf`), `WEEKLY_FULL_REPORT_FILE` (default
  `TA_IAP_Full_Report.pdf`).
- `weeklyReport_renderPdfBlob_(rows, stats, variant)` — `variant ∈
  { "ANONYMISED", "FULL" }`. Different per-issue table headers; no
  photos in either server build.
- `generateWeeklyReportPdf(reason)` and `generateFullReportPdf(reason)`
  are also exposed as standalone runnable functions for one-off
  rebuilds (operator runbook in `README.md`).
- `commitFullReportPdf(b64, source)` accepts the wizard's bytes;
  rejects anything where the first three decoded bytes don't match the
  `%PDF` signature (37 80 68 70) or where the payload exceeds 30 MB.

**Privacy stance.** The login-page link must remain safe to expose to
any anonymous visitor of the issue tracker. Resident names and flat
numbers are PII; descriptions, tower, category, status, and severity are
considered acceptable in aggregate (and the operator can still leave
`WEEKLY_REPORT_PUBLIC_URL` empty if the residents disagree — the file
is then committed but not surfaced anywhere). The full report, by
contrast, is gated on its own URL tunable AND distributed only via
authorised channels — the operator should keep the GitHub repo private
**or** treat the file as authenticated-only.

---

## 20. Daily Issue Reporting Track

### 20.0 Why a parallel track (and not a flag on existing sheets)

The handover track exists to drive **construction defects through a
committee → builder warranty workflow**. Every assumption baked into
`PENDING_REVIEW` / `LIVE_ISSUES` / `CLOSED_ISSUES` reflects that
contract: a committee gate before any work, a single named builder, a
multi-week SLA, a strict-move pipeline, and the requirement that the
PDF status report capture the warranty audit trail.

Society day-to-day issues (lift broken, water tanker delayed, lights
out in stairwell, security guard absent, common-area cleaning missed)
are a **different problem class**:

- High volume, short-lived. Most are resolved within hours, not weeks.
- No committee gate. The society manager is the dispatcher.
- Many vendors, not one. Plumber today, electrician tomorrow.
- Anonymous-friendly. A resident in the lift lobby reaching for their
  phone should not have to log into a Google account.
- Different audit needs. Resolution notes + cost > builder/SLA matrix.

Forcing both classes through the same sheets and the same approval flow
would either compromise the handover audit trail (turning the committee
gate into a rubber stamp) or insert needless friction into daily issue
reporting (forcing a sign-in and an approval step). The parallel track
keeps both contracts intact and reuses every shared mechanism — auth,
photo upload pipeline, PDF wizard, CONFIG, role table — so the cost of
addition is bounded.

### 20.1 UI design — page-by-page

#### A. Landing page (`index.html`) — split entry

Anonymous visitors and signed-in users without a privileged role both
land on a single split card. Signed-in privileged users (committee,
manager, builder) skip this and go straight to their dashboard.

```
┌─────────────────────────────────────────────────────────────┐
│  [logo]  Tower Apartments — Issue Portal      [Sign in ▸]  │
├─────────────────────────────────────────────────────────────┤
│   What do you want to report?                               │
│                                                             │
│   ┌──────────────────────────┐  ┌──────────────────────────┐│
│   │  🔧  DAILY ISSUE         │  │  🏗  HANDOVER SNAG       ││
│   │  Lift, water, lights,    │  │  Construction defects,   ││
│   │  cleaning, security…     │  │  builder warranty work   ││
│   │  No sign-in needed       │  │  Goes to TA Committee    ││
│   │  Resolved by manager     │  │  → Builder lifecycle     ││
│   │  [ Report now → ]        │  │  [ Report now → ]        ││
│   └──────────────────────────┘  └──────────────────────────┘│
│   ─── Already reported? ───                                 │
│   [ View all submitted issues ]    [ View Full Report ]    │
└─────────────────────────────────────────────────────────────┘
```

The "Daily Issue" card is hidden when `FEATURE_DAILY_TRACK` is off; the
landing then collapses to the legacy single-CTA layout. The "View Full
Report" pill remains independent of the daily track (gated by
`FULL_REPORT_PUBLIC_URL` resolution as today \u2014 see §19.14).

#### B. Daily quick-report (`src/pages/daily-report.html`)

Single-screen mobile-first card. **Identity fields are optional**.

```
┌──────────────────────────────────────┐
│  ← Back     Report a Daily Issue     │
├──────────────────────────────────────┤
│  Where?                              │
│  [ Tower ▾ ]  [ Flat / Common ▾ ]    │
│                                      │
│  What's the problem?                 │
│  [ Category ▾  e.g. Lift / Water ]   │
│  [ Sub-category ▾ ]                  │
│                                      │
│  Tell us more (optional)             │
│  ┌────────────────────────────────┐  │
│  └────────────────────────────────┘  │
│                                      │
│  Add photos (optional)               │
│  [ 📷 Take photo ] [ 📁 Choose ]     │
│  ┌────┐ ┌────┐                       │
│  │    │ │    │   (thumbnails)        │
│  └────┘ └────┘                       │
│                                      │
│  Your name & flat (optional)         │
│  [ Name      ] [ Flat # ]            │
│  WhatsApp/phone (optional)           │
│  [ +91 ____________ ]                │
│  ☐ Notify me on WhatsApp when fixed  │
│                                      │
│  [        Submit issue        ]      │
│                                      │
│  No login required. Tracking ID will │
│  be shown after you submit.          │
└──────────────────────────────────────┘
```

Design constraints:

- Single column, tap targets ≥48px.
- Tower / Category / Sub-Category dropdowns are pre-fetched once via
  `getClientConfig` + `getCategoryMaster` (with `track=daily` filter on
  the latter — see §20.4).
- Photo uploader reuses the **exact same** `uploadSubmissionPhotos_`
  pipeline as the handover submit page (Drive folder, public-share,
  `splitPhotoLinks_` normalisation). The only difference is the per-
  ticket sub-folder name (`DLY-NNNNN` instead of `TKT-NNNNN`).
- `FEATURE_AUTOSAVE_DRAFT` carries over — partial entries survive a tab
  close. Drafts are namespaced (`localStorage` key
  `irp.draft.daily.v1`) so they don't collide with handover drafts.
- The page never imports the heavy committee/builder dashboard JS —
  the bundle target is < 80 KB compressed (lower than the 200 KB
  general page budget) so it loads fast on a phone in a stairwell.

#### C. Confirmation screen (`/exec?page=daily-confirm&id=DLY-00142`)

```
┌──────────────────────────────────────┐
│  ✓ Reported                          │
│                                      │
│  Tracking ID:  DLY-00142             │
│  [ Copy ID ]   [ Share via WhatsApp ]│
│                                      │
│  What happens next                   │
│  ① Manager reviews (usually < 24 h)  │
│  ② Assigned to maintenance/vendor    │
│  ③ You'll see the status update on   │
│     the public submitted-issues page │
│                                      │
│  [ Report another ]  [ View status ] │
└──────────────────────────────────────┘
```

The "Share via WhatsApp" button uses a `wa.me/?text=…` deep link only
— no outbound API call from Apps Script. The confirmation page is
crawlable by ticket id (anonymous-allowed) so a resident can re-open
the link from their WhatsApp history and see the current status —
served via `getDailyIssuesPublic({ticketId})` (PII-redacted shape).

#### D. Manager dashboard (`src/pages/manager-dashboard.html`) — new

Visually modeled on `committee-dashboard.html` so a returning operator
recognises it immediately. Differences:

- **Header pill** says "Daily Issues" in a different accent colour
  (teal) so the track is unambiguous at a glance.
- **Tabs** map to daily statuses, not handover lifecycle:
  `New (12)` · `Triaging (4)` · `Assigned (8)` · `In Progress (5)` ·
  `Resolved (3 today)` · `Rejected` · `All`.
- **Row actions**: Acknowledge · Assign vendor + severity · Mark in
  progress · Resolve (with notes + optional cost) · Reject (with
  reason) · Reopen (from Resolved/Rejected).
- **Quick filters**: Tower, Category, Severity, Age. Rows where
  `now − reportedDate > DAILY_AUTO_ACK_HOURS` and `STATUS = NEW` are
  flagged red.
- **No SLA matrix popup**. Daily issues use the same severity scale
  (Critical/High/Medium/Low) but the dashboard surfaces a single
  "overdue" badge rather than the full handover SLA section.
- **Detail modal** includes resolution-notes timeline, vendor history,
  and the same photo gallery component used by the committee detail
  modal.

The manager dashboard is **the only new HTML page** added for this
track beyond the resident-facing pages above. No new framework, no
new component library — Tailwind/FA/Chart.js as today.

#### E. Public submitted-issues view (`src/pages/submitted-issues.html`) — unified

The existing page becomes the single public read-only board for both
tracks, with a track toggle pill at the top:

```
[ All ]  [ Daily (live) ]  [ Handover (live) ]    Status ▾   Tower ▾   Search 🔍
```

- "All" = both tracks merged, sorted by reported date desc.
- "Daily (live)" = `getDailyIssuesPublic` only; `STATUS != ARCHIVED`.
- "Handover (live)" = current `getSubmittedIssues` behaviour.
- The Export Report wizard gains a "Source" toggle (Daily / Handover /
  Both). The handover branch is unchanged. The daily branch reads from
  `getDailyIssuesPublic` and renders a column subset (Ticket ID, Date,
  Tower, Category, Sub-Cat, Status, Severity, Photos) — **PII columns
  are absent from the catalog**, not just hidden.

Anonymous-allowed exactly as today.

### 20.2 Authentication & Authorization deltas

- A new role `MANAGER` is added to `getUserRole(email)`. Resolution
  order: `COMMITTEE > MANAGER > BUILDER > UNKNOWN`. An email listed
  in both `COMMITTEE_EMAILS` and `MANAGER_EMAILS` resolves to
  `COMMITTEE` but is treated as having manager capabilities by the
  per-action allow-list (additive grant).
- `isActionAllowed_` gains the daily-track entries listed in §7. All
  daily write actions reject `UNKNOWN` regardless of
  `FEATURE_DAILY_ANONYMOUS_SUBMIT` — only `submitDailyIssue` and the
  read endpoints (`getDailyIssuesPublic`, `getReportPhotoB64`) are
  anonymous-allowed.
- The public deployment (`USER_DEPLOYING` / `ANYONE_ANONYMOUS`, see
  §19.8) is the entry point for anonymous daily-track intake. The
  signed-in deployment (`USER_ACCESSING` / `ANYONE`) is what
  managers/committee/builders use. Both deployments share the same
  script project, so a single `clasp push` ships both.
- Server identity rules from §3 are unchanged: `Session.getActiveUser`
  is still the only trusted source. Anonymous calls observe an empty
  email — handlers must branch on `if (!email)` instead of trusting any
  client-supplied identity. The optional `reporterName` /
  `reporterFlat` / `reporterPhone` fields in `submitDailyIssue` are
  **content fields**, not identity fields, and are stored verbatim
  (after a phone-number normalisation) without any authorization
  bearing.

### 20.3 File map additions

| File | Role |
|---|---|
| `src/pages/daily-report.html` | Anonymous-allowed quick-report card (§20.1.B) |
| `src/pages/daily-confirm.html` | Post-submit confirmation (§20.1.C) |
| `src/pages/manager-dashboard.html` | Manager triage dashboard (§20.1.D) |
| `src/Daily.gs` | All daily-track server logic — sheet readers/writers, `submitDailyIssue`, status mutators, archive sweep, metrics. Self-contained module; depends only on `Config.gs` helpers, `Main.gs` photo helpers, and the `safeStr_` / `safeDateIso_` serialisation helpers. |

`Router.gs` gains daily-track route entries in `PAGE_MAP` and the
`api_call` switch. `Config.gs` gains the daily-track flags/tunables
listed in §5.1 and §20.7. No other existing file changes shape.

### 20.4 `DAILY_ISSUES` sheet schema

`DAILY_COL` (single-tab layout — same shape on `DAILY_ARCHIVES`):

| # | Column | Notes |
|---|---|---|
| 0 | `TICKET_ID` | `DLY-NNNNN` (5-digit, zero-padded). Counter is `DAILY_TICKET_COUNTER` in `ScriptProperties` — separate from handover `TICKET_COUNTER` so the two series cannot collide. |
| 1 | `REPORTED_DATE` | ISO timestamp. Set server-side from `new Date()`; never trust the client. |
| 2 | `REPORTER_EMAIL` | `Session.getActiveUser().getEmail()` if signed in, blank otherwise. PII — never returned by `getDailyIssuesPublic`. |
| 3 | `REPORTER_NAME` | Optional free text from the form. PII — redacted in public reads. |
| 4 | `REPORTER_FLAT` | Optional. PII — redacted in public reads. |
| 5 | `REPORTER_PHONE` | Optional, normalised to `+CC NNNNN…`. PII — redacted in public reads. |
| 6 | `NOTIFY_OPT_IN` | `"true"` / `"false"`. When true, manager dashboard surfaces a click-to-WhatsApp link on resolution. |
| 7 | `TOWER` | Required. |
| 8 | `LOCATION` | Required. Free text — flat number, common-area location, etc. Phone-number regex scrubbed by `getDailyIssuesPublic`. |
| 9 | `CATEGORY` | Required. Sourced from `CATEGORY_MASTER` rows where `track = "daily"`. |
| 10 | `SUB_CATEGORY` | Optional. |
| 11 | `DESCRIPTION` | Optional free text. Phone-number regex scrubbed by `getDailyIssuesPublic`. |
| 12 | `PHOTO` | Comma-separated normalised Drive thumbnail URLs (same shape as handover `PHOTO`, normalised by `splitPhotoLinks_`). |
| 13 | `STATUS` | One of `NEW \| TRIAGING \| ASSIGNED \| IN_PROGRESS \| RESOLVED \| REJECTED`. |
| 14 | `SEVERITY` | Manager-set on assign. Same scale as handover (Critical/High/Medium/Low) but **no SLA-date column** — the manager dashboard uses `DAILY_AUTO_ACK_HOURS` for the overdue badge instead. |
| 15 | `VENDOR` | Free text — vendor name + contact. |
| 16 | `ASSIGNED_TO_EMAIL` | Manager email that took ownership. |
| 17 | `LAST_UPDATE_DATE` | ISO. Updated by every status mutation. |
| 18 | `LAST_UPDATE_BY_EMAIL` | The actor's session email. |
| 19 | `RESOLUTION_NOTES` | Free text from `resolveDailyIssue`. |
| 20 | `RESOLUTION_DATE` | ISO. Set on resolve, cleared on reopen. |
| 21 | `COST_ESTIMATE` | Optional numeric (society currency). Drives the manager-dashboard cost KPI. |
| 22 | `REJECT_REASON` | Free text from `rejectDailyIssue`. |
| 23 | `REOPEN_HISTORY` | JSON array of `{date, by, reason}` — append on every reopen. Read-only from the app. |

`DAILY_WIDTH = 24`. Every reader emits `i.issue.photoLinks` (canonical
shape — see §8.1) and every column is coerced through `safeStr_` /
`safeDateIso_` before returning to the client (per §19.1).

`CATEGORY_MASTER` gains a 4th column `track` (values `handover` /
`daily` / `both`). `getCategoryMaster({track:'daily'})` filters on
that column. Existing rows default to `handover` so the handover form
behaviour is unchanged. (When the column is absent — i.e. legacy
sheet — the reader treats every row as `both` for backwards
compatibility.)

### 20.5 Daily lifecycle — allowed transitions

| From | To | Action | Who |
|---|---|---|---|
| `NEW` | `TRIAGING` | `updateDailyStatus({status:'TRIAGING'})` | manager / committee |
| `NEW` | `REJECTED` | `rejectDailyIssue` | manager / committee |
| `NEW` | `ASSIGNED` | `assignDailyIssue` (skips TRIAGING — explicit) | manager / committee |
| `TRIAGING` | `ASSIGNED` | `assignDailyIssue` | manager / committee |
| `TRIAGING` | `REJECTED` | `rejectDailyIssue` | manager / committee |
| `ASSIGNED` | `IN_PROGRESS` | `updateDailyStatus({status:'IN_PROGRESS'})` | manager / committee |
| `IN_PROGRESS` | `RESOLVED` | `resolveDailyIssue` | manager / committee |
| `ASSIGNED` | `RESOLVED` | `resolveDailyIssue` (manager confirmed fixed without an explicit IN_PROGRESS step) | manager / committee |
| `RESOLVED` | `IN_PROGRESS` | `reopenDailyIssue` (appends to `REOPEN_HISTORY`) | manager / committee |
| `REJECTED` | `NEW` | `reopenDailyIssue` (appends to `REOPEN_HISTORY`) | manager / committee |

Any other transition is rejected by the server with
`Forbidden transition: <from> → <to>`.

`archiveDailyIssues` is a separate idempotent sweep (not a transition):
it strict-moves every row where `STATUS ∈ {RESOLVED, REJECTED}` and
`now - LAST_UPDATE_DATE > DAILY_ARCHIVE_AFTER_DAYS` into
`DAILY_ARCHIVES` and deletes the source row. Manual via the editor;
optionally schedulable via `installDailyArchiveTrigger` (cadence
shares `REPORT_BACKUP_FREQUENCY` for simplicity).

### 20.6 Notifications

The portal does **not** make outbound API calls (no Twilio, no WhatsApp
Business API). Instead:

- The confirmation card and the public submitted-issues row both
  render `wa.me` deep links so the resident can share their tracking
  ID into the society WhatsApp group with one tap.
- When `notifyOptIn` is set on a ticket and the manager clicks
  **Resolve**, the manager dashboard renders a click-to-chat link in
  the success toast (`https://wa.me/<phone>?text=Issue%20DLY-NNNNN…`).
  The manager taps it on their phone; nothing is sent server-side.

This keeps the daily track inside Apps Script's free quota budget and
avoids any new credentials or vendor onboarding.

### 20.7 Feature flags & tunables (canonical)

Listed in §5.1 with their defaults. Behaviours summarised:

| Flag / Tunable | Default | Effect |
|---|---|---|
| `FEATURE_DAILY_TRACK` | `false` | Master kill-switch. Off = daily-track sheets/APIs/pages are inert; landing page hides the daily card; handover behaviour is byte-for-byte unchanged. |
| `FEATURE_DAILY_ANONYMOUS_SUBMIT` | `true` | Off = `submitDailyIssue` rejects callers without a Google session. Use only if abuse appears. |
| `FEATURE_DAILY_PHOTO_UPLOAD` | `true` | Off = daily intake form hides the photo uploader and `submitDailyIssue` ignores any `photos[]` payload. Independent of `FEATURE_PHOTO_UPLOAD` so handover photos can stay on. |
| `DAILY_AUTO_ACK_HOURS` | `24` | Manager dashboard "overdue" threshold for `STATUS = NEW`. |
| `DAILY_ARCHIVE_AFTER_DAYS` | `90` | Retention cut-off used by `archiveDailyIssues`. |
| `DAILY_NOTIFICATION_WHATSAPP` | `false` | Reserved — when true, manager-side resolution toast renders the click-to-chat link (§20.6). |

### 20.8 Performance budget

The daily track is **additive** to the existing read/write paths.
Upper bounds and cache strategy:

- Public submitted-issues view: one extra `getDailyIssuesPublic` call
  in parallel with `getSubmittedIssues`. Cached client-side for 30 s
  (same TTL as the existing handover read).
- Manager dashboard: same shape as the committee dashboard — three
  reads (`getDailyIssues({filter:'ALL'})`, `getDailyMetrics`, plus
  `getCategoryMaster` once at boot) executed in parallel via the
  existing `API.batch` shim. Target end-to-end load < 1.2 s on a
  cold cache (matches the committee dashboard).
- Existing dashboards (`committee`, `builder`, `admin`, handover
  `submit-issue`): **zero new calls**. The flag-gated landing page
  detects daily-track availability via `getClientConfig` (already
  fetched today) so no new round-trip is added.
- Page bundles: `daily-report.html` < 80 KB compressed (sub-budget
  versus the 200 KB general target). `manager-dashboard.html` reuses
  the committee bundle and stays inside 200 KB.
- Apps Script invocation budget: each daily ticket adds at most one
  sheet write + one Drive write per photo. Worst-case daily volume
  (estimated 30/day) sits well inside the 6-min/exec and per-day
  quota envelopes.

### 20.9 Setup runbook (one-time, after the first deploy that ships §20)

| # | When | Function | What it does |
|---|---|---|---|
| 1 | First deploy with `FEATURE_DAILY_TRACK=true` | `setupConfigSheet` | Already runs — picks up the new keys (idempotent, preserves existing values). |
| 2 | First deploy | `installDailyTrackSheets` (`src/Daily.gs`) | Creates `DAILY_ISSUES` and `DAILY_ARCHIVES` if missing; ensures `CATEGORY_MASTER` has the `track` column; seeds a starter set of daily categories. Idempotent. |
| 3 | First deploy / after editing `MANAGER_EMAILS` | `clearConfigCache` | Picks up the new manager list within seconds. |
| 4 | _Optional_ — schedule the retention sweep | `installDailyArchiveTrigger` (`src/Daily.gs`) | Idempotent. Schedules `archiveDailyIssues` on the same cadence as `REPORT_BACKUP_FREQUENCY` (default `3x-daily`). Re-run after editing the cadence tunable. |
| — | Diagnostic | `listProjectTriggers` | Already exists. Should now also list `archiveDailyIssues` if step 4 was run. |

### 20.10 Acceptance criteria (in addition to §18)

1. With `FEATURE_DAILY_TRACK=false`: the landing page renders exactly
   as before §20 was merged; no new API actions are advertised in
   `getClientConfig`; handover-track flows pass every existing
   acceptance test from §18 unchanged.
2. With `FEATURE_DAILY_TRACK=true` and an anonymous browser session:
   the landing page shows both cards; clicking "Daily Issue" opens
   `daily-report.html`; submission produces a `DLY-NNNNN` id and the
   confirmation card.
3. An anonymous attacker who calls `API.call('updateDailyStatus', …)`
   from DevTools receives `Forbidden for role UNKNOWN: updateDailyStatus`.
4. A manager email listed in `CONFIG.MANAGER_EMAILS` lands on
   `manager-dashboard.html` at `/exec`; a builder-only email still
   lands on the builder dashboard; a committee email still lands on
   the committee dashboard (highest-privilege wins).
5. `getDailyIssuesPublic` never returns `REPORTER_NAME`,
   `REPORTER_EMAIL`, `REPORTER_FLAT`, or `REPORTER_PHONE` regardless
   of caller role; `getDailyIssues` returns them only to manager /
   committee.
6. The committee dashboard, builder dashboard, admin dashboard,
   handover submit page, and handover submitted view make the same
   number of API calls and load the same bundle size after §20 is
   merged as before — no regression in handover-track performance.
7. Disabling `FEATURE_DAILY_TRACK` after daily tickets exist: the
   sheets remain intact (no destructive action), public pages stop
   rendering daily rows, manager dashboard returns the access-denied
   page, but the data is preserved for re-enable.


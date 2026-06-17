# Repository instructions for AI coding agents

These rules apply to **every** task in this repository (issue triage,
feature work, refactors, bug fixes, doc edits, anything). They are
binding — do not skip them because the user did not restate them in the
current request.

## 0. Repository scope & two-repo workspace boundary

This workspace contains **two sibling repos** under `C:\CR7\TAMC\IRP_Repo\`:

| Folder | Repo | Spec file | Stack |
|---|---|---|---|
| `ta-society-helpdesk/` (this repo) | `github.com/tadeskops/ta-society-helpdesk` | `tsh_requirement.md` | Daily track — GitHub Pages + Issues + Cloudflare Worker |
| `ta-issue-manager/` (sibling) | `github.com/tadeskops/ta-issue-manager` | `requirement.md` | Handover track — Google Apps Script + Sheet + Form + Drive |

**Hard boundary rules — do not cross them:**

1. **Edits scope to one repo per turn.** When the user's request touches
   files inside this repo (`ta-society-helpdesk/...`), all edits, commits,
   and pushes happen here. When the request touches files inside
   `ta-issue-manager/`, switch to that repo's working directory and
   follow **its** `.github/copilot-instructions.md`. **Never make the
   same change in both repos in one push** unless the user explicitly
   asks for a coordinated change.

2. **Spec file = `tsh_requirement.md` for this repo only.** Updates to
   daily-track behavior (roles, GitHub Issue schema, Worker API,
   feature flags, settings page, etc.) go into `tsh_requirement.md`
   here. The handover-track spec (`requirement.md`) lives in the
   sibling repo and is **out of scope** for changes made here. Do not
   edit `requirement.md` from this repo's working tree even if a stale
   copy is present.

3. **Push target for this repo.** Every `git push` from this repo goes
   to `origin` = `github.com/tadeskops/ta-society-helpdesk` only.
   Verify with `git remote get-url origin` before any push (per §3.3).

4. **Cross-repo references are link-only.** When this site needs to
   link back to the handover portal (or vice-versa), use a plain
   `<a href="…">` configured via the daily-track config file
   (`config/site.json` → `handoverPortalUrl` — see `tsh_requirement.md`).
   Do not import code, copy assets verbatim, or share build steps
   across the two repos.

5. **If the user asks an ambiguous question** that could apply to
   either repo, infer scope from the working directory of the file the
   user attached (or last edited). When uncertain, ask once before
   making changes.

6. **Commit AND push identity is non-negotiable for BOTH repos.** Every
   commit AND every push from either `ta-society-helpdesk` or
   `ta-issue-manager` must originate from the `tadeskops` GitHub
   account (`ta.deskops@gmail.com`). Before **any** `git commit` or
   `git push`, run the identity check in §3.3 — if `user.name` /
   `user.email` do not match, abort and tell the user. Never bypass,
   never silently reconfigure global git identity to satisfy it, and
   never commit or push with a different account "just this once".
   The fix is **always** local-scope:
   `git -C <repo-path> config user.name tadeskops` and
   `git -C <repo-path> config user.email ta.deskops@gmail.com`,
   never `git config --global`.

## 1. `tsh_requirement.md` is the spec — keep it in sync

`tsh_requirement.md` at the repo root is the **single source of truth**
for this project's behavior, roles, GitHub Issue label/schema
conventions, Cloudflare Worker API actions, config keys, and feature
flags. Any code change that affects observable behavior MUST be
reflected in `tsh_requirement.md` in the same change.

### When you MUST update `tsh_requirement.md`

Update it whenever a change touches any of the following:

- **Roles or capabilities** — a role gains/loses an action, a new role
  is added (resident / manager / committee / developer), the role-
  resolution precedence changes, or the allow-list source-of-truth
  files (`config/managers.json`, `config/committee.json`,
  `config/developers.json`) change shape.
- **Worker API actions** — a new endpoint is added to the Cloudflare
  Worker (`POST /issues`, `GET /issues`, `PATCH /issues/:id`, etc.),
  an action is renamed/removed, its allow-list changes, its payload
  shape changes, or its JWT-verification rules change.
- **GitHub Issue conventions** — a new label is introduced (status,
  category, severity, tower, etc.), the body-section markers change,
  the photo-attachment scheme changes, the audit-comment format
  changes, or the soft-delete convention changes (lock + tombstone
  body).
- **Config keys** — a new key in `config/site.json`, a new
  flag in the feature-flag list, or a new tunable consumed by the
  static pages or the Worker.
- **Pages / routing** — a page is added/removed from the static site,
  a feature flag starts/stops gating a page, the URL contract for the
  manager dashboard / settings page / public board changes.
- **External integrations** — Cloudflare Worker secrets added/renamed,
  GitHub PAT scopes changed, GitHub Pages or Actions workflow
  contract changed, photo-storage strategy moved (in-repo ↔ R2).
- **Setup runbook** — a new bootstrap step (issue-template seeding,
  initial committer of `config/*.json`, Worker secret rotation, etc.)
  appears. It must be added to the setup section in `tsh_requirement.md`
  and to the **setup runbook** in `README.md`.

### When you do NOT need to update `tsh_requirement.md`

- Pure refactors with zero observable change.
- Cosmetic changes (whitespace, comment clarification, typo fixes in
  source comments).
- Local-dev / preview tooling that doesn't ship to GitHub Pages or
  the Worker.

### How to update

1. Read the existing `tsh_requirement.md` section that is affected.
2. Edit **in place** — preserve heading numbering and the tabular style.
   Do not append "changelog" entries; the file is a spec, not a log.
3. If the change is substantial (new role, new endpoint set, new
   config family), add a new numbered subsection in the appropriate
   top-level section rather than overloading an existing bullet.
4. Cross-check that the README runbook is also up-to-date if a new
   step needs to be run by an operator (or by GitHub Actions).

### How to verify before finishing the task

Before reporting a task as complete, mentally walk through this
checklist:

- [ ] Did this change touch a Worker endpoint, an issue label
      convention, a `config/*.json` schema, a page route, a feature
      flag, or a setup step?
- [ ] If yes → is `tsh_requirement.md` updated in the same commit?
- [ ] If a new operator-run step exists → is the **README runbook
      table** updated too?

If any answer is "no", finish the doc update before closing out.

## 2. Other standing rules

- **Do not create stray markdown files** to document changes — keep
  history in commit messages / PR descriptions. The only docs that
  ship with the repo are `README.md`, `tsh_requirement.md`, and the
  files under `.github/`. Anything else under `docs/` (the GitHub
  Pages site root) belongs to the live web app, not to documentation
  — discuss with the user before adding documentation files outside
  these locations.
- **Honor existing patterns.** Issue creation goes through the
  Worker's `POST /issues` endpoint, never via direct GitHub API calls
  from the static page. Auth flows always verify the Google JWT
  server-side (Worker-side); the browser-side check is render-gate
  only. Photo URLs are always returned by the Worker after
  GitHub-side normalization.
- **Server-trust user identity.** Email comes from the verified
  Google ID token (JWT), never from a client-supplied payload field.
  The Worker is the only component that may convert a JWT into an
  authoritative email + role tuple.
- **Never ship the GitHub PAT to the browser.** The PAT lives in
  Cloudflare Worker secrets only. Any code path that requires the PAT
  must run on the Worker.

## 2.1 Significant new features must be feature-flag gated

Any change that adds a **significant new feature** must ship behind a
`FEATURE_*` flag in `config/site.json`, enforced on both Worker and
static page, and the agent must explicitly justify the chosen default
in the PR/commit body.

### How to decide if a change qualifies

A change qualifies as "significant" — and therefore needs a flag —
if **any** of the following is true:

- It adds a new Worker endpoint or extends an existing one with a new
  payload shape.
- It adds a new UI affordance the user can interact with (a new
  button, panel, page, modal, drag-drop zone, file picker, etc.).
- It writes to GitHub Issues, the daily-track config files, or the
  photo store in a code path that did not previously write there.
- It changes a role's capabilities (resident/manager/committee/
  developer gains a new action).
- It is opinionated enough that an operator might reasonably want to
  turn it off without a redeploy (regulatory, scope, cost, perf, or
  "we don't want this group to see it yet" reasons).

A change does **not** need a flag if it is purely:

- A bug fix that restores documented behavior.
- A refactor with zero observable change.
- Cosmetic (whitespace, copy edits, log message tweaks).
- A schema migration / setup helper that an operator runs explicitly.
- A change to local-dev / preview tooling.

### Default-state policy

When a flag is added, the agent must choose a default and **state the
reason** in the commit message:

| Default the flag to… | …when |
|---|---|
| `false` (off, opt-in) | The feature is new, write-capable, role-scoped, irreversible (writes to GitHub Issues / config / sends notifications), or the user hasn't asked for it to be enabled by default. **This is the safe default.** |
| `true` (on) | The user has explicitly asked for it on by default, OR the feature is purely additive read-only UX with negligible blast radius (e.g. a new sort option on an existing list), AND turning it off would leave the page in a broken state. |

**Default to `false` when in doubt.** A flag that ships off can be
turned on by editing `config/site.json` from the settings page (or
directly in the repo); a flag that ships on and breaks something
requires a Worker / Pages redeploy to fix.

### Implementation requirements

1. Add the flag to `config/site.json` (and to `DEFAULT_CONFIG` in the
   Worker) with a one-line comment describing what it gates.
2. Worker-side: every endpoint that participates in the feature must
   read the flag from the cached config and return a clear error when
   it's off (`"<Feature> is disabled. Toggle FEATURE_X in
   config/site.json."`). Do not rely on the page gate alone — the API
   can be called by any caller with a valid JWT.
3. Page-side: the relevant page must read the flag from the
   `/config` response and:
   - hide / not render the affordance when the flag is false;
   - re-check the flag inside the action handler as a defensive guard
     against stale renders.
4. `tsh_requirement.md` updates: add a row to the feature-flags
   section with the default value and effect; if the feature exposes
   a new Worker endpoint, note both the role allow-list AND the gating
   flag(s) in the API table.
5. If two flags both gate the action (e.g. a master switch + a
   global kill-switch), say so explicitly in `tsh_requirement.md` —
   both must be true for the action to run.

### How to verify before finishing the task

- [ ] Did this change add a new Worker endpoint, a new visible UI
      affordance, or a new external write path?
- [ ] If yes → is there a `FEATURE_*` row in `config/site.json`?
- [ ] Is the flag enforced on both Worker and page (render gate +
      handler re-check)?
- [ ] Is the default explicitly justified in the commit body?
- [ ] Is `tsh_requirement.md` updated with the new flag row?

If any answer is "no", finish the gating before closing out.

## 3. Source-control & push policy

These rules apply to **every** git operation the agent runs in this
repo. They are non-negotiable.

### 3.1 `ref/`, `node_modules/`, `.dev.vars` — local-only, never push

The repo-root `ref/` folder (if present) holds working reference
material — sample exports, scratch notes, screenshots. It is listed in
[`.gitignore`](../.gitignore) and **must never** be committed or pushed.
The same applies to `node_modules/`, Wrangler's `.dev.vars`,
`.wrangler/`, and any local `.env*` files.

- Do not `git add ref/`, `git add -f ref/`, or run `git add .` from
  inside `ref/`.
- Do not commit Cloudflare Worker secrets, GitHub PATs, or any
  Google OAuth client secrets — these belong only in Cloudflare Worker
  encrypted env vars.
- If a file under `ref/` is genuinely needed in the deployed app, copy
  it into `docs/assets/` (or another tracked folder) and reference the
  copy.

### 3.2 Always list changes and ask before pushing

The agent must **not** run any push command on its own initiative.
Before any of the following, stop and present the user with a
confirmation prompt that lists every change:

- `git push` (any remote, any branch)
- `git push --force` / `--force-with-lease` (in addition, call out the
  destructive nature explicitly)
- `wrangler deploy` (deploys the Cloudflare Worker)
- `gh workflow run` / any GitHub Actions trigger that pushes to a
  remote or deploys to Pages
- Direct edits to GitHub via the API (creating issues, labels,
  branches, releases) when those changes alter live state

#### Confirmation template

Use exactly this shape — adapt the bullets to the actual diff:

```
Ready to push. Please confirm.

Target:      <github / cloudflare-worker / both>
Remote:      origin (https://github.com/tadeskops/ta-society-helpdesk.git)
Branch:      <e.g. main>
Git account: tadeskops <ta.deskops@gmail.com>   ← must be tadeskops

Files changed (vs origin/<branch>):
  M docs/index.html              — landing split card
  M docs/manager-dashboard.html  — triage actions
  M worker/src/index.ts          — added PATCH /issues/:id
  M tsh_requirement.md           — §20.x, §21
  M README.md                    — setup runbook

Commit message (proposed):
  feat(daily): manager triage actions + Worker PATCH endpoint

Proceed? (yes / no / edit)
```

The user must answer **yes** (or equivalent like "push it") before the
agent runs the push. "no" / silence / a question = do not push.

If the user gives a blanket "push everything you do" instruction at any
point, the agent still lists the changes once per push but may skip the
explicit yes/no prompt for that session only.

### 3.3 Pushes must use the `tadeskops` git account

Every push to GitHub from this repo must originate from the `tadeskops`
account (`ta.deskops@gmail.com`). Before any `git push`:

1. Run a pre-push identity check:

   ```powershell
   git config user.name      # must be exactly: tadeskops
   git config user.email     # must be exactly: ta.deskops@gmail.com
   git remote get-url origin # must be: https://github.com/tadeskops/ta-society-helpdesk.git
   ```

2. If any of those three values does not match, **abort the push** and
   tell the user which value is wrong and how to fix it (`git config
   user.name tadeskops`, etc.). Do not "fix it silently" — the user
   may have other repos that should keep a different identity.

3. **Wrong-repo guard.** If `git remote get-url origin` returns a
   `ta-issue-manager` URL, abort immediately — you are in the sibling
   handover repo by mistake. See §0.

4. Never reconfigure `user.name`, `user.email`, the remote URL, or
   credentials without explicit user instruction in the same turn.

### 3.4 Cloudflare Worker (`wrangler`) deploys — same rules

`wrangler deploy` ships the Worker live — there is no PR review buffer.
Follow §3.2 for confirmation, and additionally:

- Verify the working tree is clean of debug logs / hard-coded test
  emails before prompting the user.
- Mention which Worker environment will be affected (production /
  preview / staging — see `wrangler.toml`).
- After a successful deploy, list any Worker secrets or
  `config/*.json` files that must be re-checked
  (`config/managers.json`, `config/site.json`, `GITHUB_TOKEN`,
  `GOOGLE_OAUTH_CLIENT_ID` — see README runbook).

### 3.5 GitHub Pages deploys — same rules

GitHub Pages publishes from the `main` branch (or a configured
deployment branch) on every push. Treat any push that touches `docs/`
as a live deploy:

- Confirm the path-to-publish in the confirmation block.
- Mention if the change affects the public site URL or only the
  authenticated dashboards.
- After a successful push, verify the Pages workflow ran green
  (`gh run list --workflow deploy-pages.yml --limit 1`) before
  declaring the task done.

## 4. Intermediate scratch space (`temp/`) and per-turn context loading

Long implementations often need scratch context that should survive
between turns but never ship to GitHub Pages or the Worker — design
notes, in-progress payload sketches, half-resolved open questions,
intermediate config drafts, captured tool outputs that will inform a
later step.

### 4.1 Always use `temp/` for intermediate context

- Write all such intermediate scratch under the repo-root `temp/`
  folder. Create it on first use; it is gitignored and **must never**
  be committed or pushed (see `.gitignore`).
- One file per topic; use short kebab-case names
  (`temp/worker-api-draft.md`, `temp/role-matrix.md`,
  `temp/photo-upload-flow.md`). Append to existing files when the
  topic continues; do not spawn duplicates.
- Keep entries terse — bullet points, tables, JSON snippets — not
  prose. The point is to recall context cheaply, not to write a book.
- When an intermediate decision graduates into a real change, fold it
  into `tsh_requirement.md` (or the relevant code) and **delete the
  matching `temp/` file** in the same turn. Stale scratch files are
  worse than no scratch files.
- Do not put secrets, JWTs, GitHub PATs, or real resident PII in
  `temp/`. The folder is local-only but still on the developer's
  workstation; treat it as untrusted.

### 4.2 Per-turn context loading (token-efficient)

At the start of every turn, before producing any plan or making any
change, the agent must consider — in this order:

1. **`tsh_requirement.md`** — the spec is the source of truth. If the
   relevant section is already in attached context, do not re-read it;
   if it is not, read only the section(s) the current request touches
   (use the file's heading numbering, not a full read).
2. **`temp/`** — list the directory; read only files whose name is
   relevant to the current request. Do not bulk-read every file.
3. **The user's current request.**

This ordering keeps token use bounded:

- Spec sections are referenced by §-number, never reproduced verbatim
  unless an edit requires it.
- `temp/` files are loaded on-demand by topic, not eagerly.
- The agent should prefer to update an existing `temp/` file over
  pasting the same context into the chat reply.

### 4.3 What belongs in `temp/` vs `tsh_requirement.md`

| Goes in `temp/` | Goes in `tsh_requirement.md` |
|---|---|
| Open questions still being negotiated with the user | Final, agreed behavior |
| Worker payload sketches mid-iteration | The final endpoint contract once accepted |
| Notes on _why_ a default was chosen during exploration | The final default in the feature-flag table |
| Cross-turn TODOs the user hasn't approved yet | Acceptance criteria once approved |
| Intermediate diffs / proposed wording for review | The committed wording |

### 4.4 Verification before finishing the task

- [ ] Did this turn produce intermediate notes that the next turn
      will need? → Saved under `temp/` with a clear name?
- [ ] Did any `temp/` content graduate into the spec or code this
      turn? → Corresponding `temp/` file deleted?
- [ ] Was anything from `temp/` accidentally staged for commit?
      `git status` must show no `temp/` paths in the staged set.


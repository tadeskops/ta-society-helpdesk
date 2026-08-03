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
     *   • memberAllowlist — optional per-caller allowlist of e-mail addresses
     *                     (Gmail today, but any RFC-lite address is accepted).
     *                     When FEATURE_TSH_VEHICLES_MEMBER_ALLOWLIST is on,
     *                     GET/PUT/DELETE /vehicles reject callers whose
     *                     signed-in e-mail is NOT in this list (editors
     *                     configured via `editorRoles` always bypass).
     *                     Empty [] + flag on = nobody except editors can
     *                     read/write; use this to lock the registry down
     *                     to a curated society-representative list.
     *   • memberAllowlistEditorRoles — who is allowed to edit the
     *                     `memberAllowlist` array itself via the Settings
     *                     page. Set-membership check, defaults to
     *                     ADMIN + CHAIRMAN + SECRETARY. Kept separate from
     *                     `editorRoles` so an admin can grant one committee
     *                     member the power to curate the allowlist without
     *                     also making them a general vehicle editor.
     */
    vehicles?: {
      editorRoles?: string[];
      stickerRoles?: string[];
      bulkEmailRoles?: string[];
      residentAddRoles?: string[];
      residentAddRequiresIdCheck?: boolean;
      maxBulkEmails?: number;
      memberAllowlist?: string[];
      memberAllowlistEditorRoles?: string[];
      /**
       * Per-tower schematic used by the seat-map UI on docs/vehicles.html.
       * Keys are single-letter tower codes (must exist in `lists.towers`).
       * `floors` = number of floors starting from 1 (top-down in the UI).
       * `unitsPerFloor` = number of flats on each floor (columns in the grid).
       *
       * The client falls back to `floors=10, unitsPerFloor=4` for any
       * tower missing from this map, so it is safe to omit for smaller
       * tenants and add only for the ones that differ.
       */
      towerLayouts?: Record<string, { floors: number; unitsPerFloor: number }>;
    };
    /**
     * Optional per-site maintenance-mode copy. When FEATURE_MAINTENANCE_MODE
     * is on, non-admin visitors see a full-page card with the society name
     * (system.logoNameUrl if set) plus this message. If message is absent
     * a sensible default is used.
     */
    maintenance?: {
      message?: string;
    };
    /**
     * EV Charging Services (FEATURE_TSH_EV_CHARGING) config.
     *
     * All keys are optional; the worker treats every leaf as advisory
     * and falls back to the baked-in defaults from DEFAULT_CONFIG.system.ev
     * when site.json omits them. Editors (MANAGER+) may tune every field
     * via the Settings page (Phase 4). See tsh_requirement.md §23.
     *
     * Sub-features (each with its own FEATURE_TSH_EV_* flag) that read
     * from this block: booking (§23.4 Phase 2), receipt (Phase 3),
     * admin dashboard (Phase 4), auto reports (Phase 5), RFID + support
     * + registration (Phase 6). Phase 1 only reads `station`, `booking`,
     * `usageGuidelines`, `provider`, `helpline` and `faqs` for the
     * GET /ev/config surface.
     *
     * `openMin` / `closeMin` are minutes-since-midnight IST (0..1440).
     * `mirrorCron` is a friendly cadence label consumed by the scheduled
     * handler in Phase 5 — 'off' disables the auto-mirror entirely.
     */
    ev?: {
      station?: {
        id?: string;
        name?: string;
        location?: string;
        capacityKw?: number;
        enabled?: boolean;
      };
      /**
       * Multi-station support (added 2026-08-02). When present and
       * non-empty, this array is the authoritative list of chargers on
       * the premises and drives the resident-facing station picker.
       * The legacy `station` block is treated as a synonym for the
       * first element when this array is absent, so single-station
       * deployments keep working unchanged.
       *
       * `kind` disambiguates 4-wheeler vs 2-wheeler chargers so the UI
       * can group them into two rows.
       * `currentType` (AC/DC) and `connector` are advisory strings
       * shown on the station card and receipt. `model` is the vendor
       * model code (e.g. SunArth "DCFC-080-CCA00-SA-CP-AE").
       */
      stations?: Array<{
        id?: string;
        name?: string;
        location?: string;
        capacityKw?: number;
        enabled?: boolean;
        kind?: '4W' | '2W';
        currentType?: 'AC' | 'DC';
        connector?: string;
        model?: string;
        /**
         * Optional product photo path (relative to the docs site root,
         * e.g. `./assets/images/ev/sunarth-dcfc-4w.png`) shown on the
         * resident station picker so the visual identity of the bay is
         * unmistakable.
         */
        image?: string;
        /** Optional short marketing tagline (e.g. "UltraPro Series - 80 kW"). */
        series?: string;
      }>;
      booking?: {
        stepMinutes?: number;
        minDurationMinutes?: number;
        maxDurationMinutes?: number;
        bufferMinutes?: number;
        advanceWindowDays?: number;
        maxActivePerFlat?: number;
        /** Global cap on active (upcoming) bookings per flat across all
         *  stations. `null` or omitted = unlimited. */
        maxTotalBookingsPerFlat?: number | null;
        /** Max total booked minutes per flat per IST calendar date,
         *  summed across all stations. `null` or omitted = unlimited. */
        maxDailyMinutesPerFlat?: number | null;
        openMin?: number;
        closeMin?: number;
        requiresApproval?: boolean;
        /** Whole-day blackouts (YYYY-MM-DD, IST). */
        blackoutDates?: string[];
      };
      usageGuidelines?: string[];
      provider?: {
        name?: string;
        androidUrl?: string;
        iosUrl?: string;
        website?: string;
        email?: string;
        tollFree?: string;
      };
      faqs?: Array<{ q: string; a: string }>;
      /** Directory-entry id shown as the "helpline" on receipts / PDFs. */
      helpline?: {
        directoryEntryId?: string;
      };
      reports?: {
        /** Markdown template used by report generation (Phase 5). Empty = default. */
        template?: string;
        /** How often the scheduled mirror runs. Default 'monthly'. */
        mirrorCron?: 'off' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
      };
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
    /**
     * Mobile "+" quick-actions bottom sheet — admin overrides the built-in
     * WhatsApp-style menu triggered by the tab-bar centre FAB (v2 UI).
     *
     * `title` replaces the default "Create" heading. Any short string.
     * `items` is an ordered list of registry keys plus per-item state.
     * Only keys present in the client-side registry
     * (`window.TSH_QUICK_ACTIONS_REGISTRY` in mobile-landing.js) are
     * rendered; unknown keys are silently ignored. `enabled: false`
     * removes an item without losing its position. `label` / `desc`
     * per-item overrides let admins rename an entry ("Report an issue" →
     * "Log a complaint") without touching code.
     *
     * When the block is absent, the client falls back to the first six
     * registry entries — the pre-2026-07-26 default.
     */
    mobileQuickActions?: {
      title?: string;
      items?: Array<{
        key: string;
        enabled?: boolean;
        label?: string;
        desc?: string;
      }>;
    };
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
    // Resident visibility of the "Treasury · this month" KPI card on
    // the landing page (docs/index.html #tshHomeTreasury). Committee+
    // roles (Treasurer / Chairman / Admin / Secretary) always see the
    // card when FEATURE_TREASURY is on — this is their at-a-glance
    // dashboard tile. When this flag is OFF (default) residents don't
    // see the card at all. When ON, any signed-in resident who can
    // read /treasury/summary sees the same 3 tiles (Total spend / Paid
    // / Open). Editors flip this via Settings > Treasury.
    FEATURE_TREASURY_HOME_SUMMARY_RESIDENT:  false,
    // Site-wide maintenance / "back soon" gate. When ON, non-admin
    // visitors see a full-page maintenance card on every page except
    // settings.html (so admins can still turn it off). Renders via
    // `Flags.ready()` in docs/assets/js/flags.js; audits + copy come
    // from system.maintenance.message. Default OFF.
    FEATURE_MAINTENANCE_MODE:                false,
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
    //  • MEMBER_ALLOWLIST: when on, GET/PUT/DELETE /vehicles requires the
    //    caller's signed-in e-mail to appear in system.vehicles.memberAllowlist
    //    (editors bypass). Off by default so today's behaviour — "any
    //    signed-in society user can search" — is unchanged. The allowlist
    //    itself is managed in Settings by roles listed in
    //    system.vehicles.memberAllowlistEditorRoles.
    //  • REPORT_PRINT: when on, editors see a "Print report" affordance in
    //    the manage view that renders a print-friendly table (including
    //    EV type variants). Off by default — the underlying report layout
    //    is client-only today and no server endpoint is required.
    //  • RESIDENT_GRID: when on, residents (read-only viewers) see the
    //    tower-based flat grid + tower filter in addition to the search
    //    bar. All write affordances (add / edit / delete / parking
    //    edit / print report) remain suppressed — residents only get
    //    a click-through to the read-only flat detail. Off by default
    //    so the resident view stays search-only unless an editor opts
    //    in via Settings. The flag lives fully client-side; the server
    //    already returns the same vehicles.json shape to every signed-in
    //    caller so no route change is required.
    FEATURE_TSH_VEHICLES_EMAIL_FILTER:        false,
    FEATURE_TSH_VEHICLES_STICKER_PATCH:       false,
    FEATURE_TSH_VEHICLES_BULK_EMAILS:         false,
    FEATURE_TSH_VEHICLES_RESIDENT_ADD:        false,
    FEATURE_TSH_VEHICLES_MEMBER_ALLOWLIST:    false,
    FEATURE_TSH_VEHICLES_REPORT_PRINT:        false,
    FEATURE_TSH_VEHICLES_RESIDENT_GRID:       false,
    // EV Charging Services (§23). Master flag off by default so the
    // resident page hides itself and every /ev/* route returns the
    // feature-disabled envelope until an admin opts in. Sub-flags are
    // seeded with the values they should take once the corresponding
    // phase ships — flipping the master ON is enough to activate the
    // Phase 2 booking core and the Phase 3 receipt without touching
    // individual sub-flags. Auto-reports + RFID + registration + support
    // (Phase 5–6 features) stay OFF even after master flips on, so an
    // admin explicitly opts into each.
    //  • CHARGING          — master. Gates every /ev/* route and the
    //                        landing tile / mobile-sheet entry. When OFF
    //                        every sub-flag becomes a no-op.
    //  • BOOKING           — Phase 2. Availability grid + create / cancel.
    //  • RECEIPT           — Phase 3. Digital receipt view / print / PDF.
    //  • ADMIN_DASHBOARD   — Phase 4. Editor analytics (Design 5).
    //  • AUTO_REPORTS      — Phase 5. Scheduled mirror + report generation
    //                        to `tadeskops/tsh-ev-charging-data`.
    //  • RFID              — Phase 6. RFID request lifecycle.
    //  • REGISTRATION      — Phase 6. Pre-registration workflow.
    //  • SUPPORT           — Phase 6. Support ticket taxonomy (12 cats).
    //  • AMC               — Phase 6b. Editor-only AMC record + document store.
    FEATURE_TSH_EV_CHARGING:                 true,
    FEATURE_TSH_EV_BOOKING:                  true,
    FEATURE_TSH_EV_RECEIPT:                  true,
    FEATURE_TSH_EV_ADMIN_DASHBOARD:          true,
    FEATURE_TSH_EV_AUTO_REPORTS:             true,
    FEATURE_TSH_EV_RFID:                     true,
    FEATURE_TSH_EV_REGISTRATION:             true,
    FEATURE_TSH_EV_SUPPORT:                  true,
    FEATURE_TSH_EV_AMC:                      true,
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
      // Curated per-caller allowlist for the whole registry. Off by
      // default (empty list + flag off = every signed-in society user
      // may search). When FEATURE_TSH_VEHICLES_MEMBER_ALLOWLIST flips
      // on, only e-mails in this list (plus roles in `editorRoles`)
      // can hit GET/PUT/DELETE /vehicles. Managed from Settings by the
      // roles listed in `memberAllowlistEditorRoles`.
      memberAllowlist:            [],
      // Who is permitted to add / remove entries in `memberAllowlist`
      // itself. Kept separate from `editorRoles` so an admin can grant
      // one committee member the power to curate the allowlist without
      // also making them a general vehicle editor. Set-membership check.
      memberAllowlistEditorRoles: ['ADMIN', 'CHAIRMAN', 'SECRETARY'],
      // Seat-map schematics for The Address (181 flats across 3 towers).
      // Tenants with a different layout override this from site.json.
      // Client falls back to floors=10, unitsPerFloor=4 for unknown towers.
      towerLayouts: {
        A: { floors: 13, unitsPerFloor: 4 },
        B: { floors: 13, unitsPerFloor: 6 },
        C: { floors: 13, unitsPerFloor: 4 },
      },
      // Positions inside the seat map that are NOT residential flats
      // (club house, gym, guard cabin, transformer room, ...). Keyed by
      // the same flat-id string used everywhere else (`<tower><floor><unit>`
      // with `<unit>` zero-padded to 2 digits). Values are the display
      // label shown on the tile. Cells listed here render as a disabled
      // muted tile — no click, no aria-pressed, no add / edit affordance
      // — so vehicles can never be attached to them and residents can't
      // accidentally open a details drawer for a common area. Tenants
      // override from site.json → system.vehicles.nonFlatCells.
      nonFlatCells: {
        C102: 'Club House',
      },
    },
    maintenance: {
      message: 'We are deploying new features and improvements. Please check back shortly.',
    },
    // EV Charging Services defaults. Every field is overridable from
    // site.json → system.ev; the resolver merges shallowly per sub-block.
    // Phase 1 only reads `station`, `booking`, `usageGuidelines`,
    // `provider`, `helpline` and `faqs`. Later phases add data files
    // (config/ev-bookings.json etc.) and the private-repo mirror.
    ev: {
      station: {
        id:         'ev-1',
        name:       'EV Charger #1',
        location:   'Basement 1',
        capacityKw: 7.4,
        enabled:    true,
      },
      booking: {
        stepMinutes:             30,
        minDurationMinutes:      30,
        maxDurationMinutes:      180,
        bufferMinutes:           5,
        // Tatkal-style short advance window (2 days) — editable in
        // config/site.json → system.ev.booking.advanceWindowDays.
        advanceWindowDays:       2,
        maxActivePerFlat:        1,
        // `null` = unlimited. Editors flip these two to positive
        // integers when they want a hard cap.
        maxTotalBookingsPerFlat: null,
        maxDailyMinutesPerFlat:  null,
        // 06:00 – 23:00 IST charging window. Minutes-since-midnight.
        openMin:                 360,
        closeMin:                1380,
        requiresApproval:        false,
        blackoutDates:           [],
      },
      usageGuidelines: [
        'Book a slot before you plug in. Walk-ups are not guaranteed.',
        'Sessions auto-end at your booked end-time. Please unplug promptly.',
        'Report faults via the Support tab so the next resident is not blocked.',
      ],
      provider: {
        name:      '',
        androidUrl: '',
        iosUrl:    '',
        website:   '',
        email:     '',
        tollFree:  '',
      },
      faqs: [],
      helpline: {
        directoryEntryId: '',
      },
      reports: {
        template:   '',
        mirrorCron: 'monthly',
      },
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

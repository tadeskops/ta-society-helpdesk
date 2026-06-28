// docs/assets/js/collapse-registry.js
// =======================================================================
// Central registry of collapsible sections across the project.
//
// Each entry below defines one section that the user can tap to collapse /
// expand on mobile, along with developer-friendly metadata. The Settings
// page reads this registry to build its "Collapsible sections" editor, and
// `ui.js` (SectionCollapse module) reads it to decide the SHIPPED defaults
// when no per-tenant override is configured.
//
// HOW IT WORKS
//   1. The HTML section must have `id="..."` and `data-tsh-collapsible`.
//   2. Add an entry below with the same `id`.
//   3. The Settings page exposes two toggles per entry:
//        - "Collapsible on mobile"  - if OFF, no chevron / no tap-to-toggle
//        - "Default collapsed"      - first-visit state (mobile only)
//      Edits there are saved to config.ui.collapse and apply to ALL users
//      within ~60 s of save (60 s = /config cache TTL).
//   4. The defaults defined HERE are the ship values. Developers should
//      edit this file when adding new sections; tweak per-tenant behaviour
//      via Settings.
//
// FIELD REFERENCE
//   id               (string)  HTML id of the <section>. REQUIRED.
//   label            (string)  Friendly name shown in the Settings editor.
//   description      (string)  Short developer note explaining what the
//                              section contains and why a different default
//                              might make sense. Shown verbatim in the
//                              Settings editor and exposed to authors.
//   collapsible      (bool)    Default for whether the section can be
//                              collapsed on mobile at all. true ships
//                              chevron + tap handlers.
//   defaultCollapsed (bool)    Default first-visit state on mobile when
//                              the visitor has not toggled this section
//                              themselves. true = start collapsed.
//
// CONSUMER PRECEDENCE (applied at runtime in ui.js)
//   1. Explicit user toggle for this device (localStorage)
//   2. Tenant override from config.ui.collapse[id]  (set via Settings)
//   3. Registry default below
//   4. Fallback {collapsible:true, defaultCollapsed:false}
//
// Desktop (>720px) always renders sections fully expanded. The collapse
// affordance is mobile-only by design.
// =======================================================================
(function (root) {
  'use strict';

  root.TSH_COLLAPSE_REGISTRY = [
    {
      id: 'tshQuick',
      label: 'Home \u00b7 Quick access',
      description:
        'Top-of-home grid with the four primary actions (Report issue, ' +
        'Public board, Directory, Daily report). Keep expanded so ' +
        'first-time visitors immediately see what they can do.',
      collapsible: true,
      defaultCollapsed: false,
    },
    {
      id: 'tshRecentIssues',
      label: 'Home \u00b7 Recent issues',
      description:
        'Preview list of the latest 5 public issues on the home page. ' +
        'Default to collapsed so the home page stays sleek; visitors ' +
        'tap the heading to expand. The full triage UI lives on the ' +
        'Public board and Manage pages.',
      collapsible: true,
      defaultCollapsed: true,
    },
    {
      id: 'tshAnnouncements',
      label: 'Home \u00b7 Announcements',
      description:
        'Notice-board posts from the committee. Often empty for new ' +
        'societies. Defaults to expanded so the few posts are visible.',
      collapsible: true,
      defaultCollapsed: false,
    },
    {
      id: 'tshEvents',
      label: 'Home \u00b7 Events',
      description:
        'Upcoming society events feed (gated by FEATURE_DAILY_EVENTS). ' +
        'Defaults to expanded; the section auto-hides when the feature ' +
        'is off or no events are scheduled.',
      collapsible: true,
      defaultCollapsed: false,
    },
    {
      id: 'tshPolls',
      label: 'Home \u00b7 Polls',
      description:
        'Active polls for residents. Defaults to expanded so visitors ' +
        'see open polls immediately. The section auto-hides when no ' +
        'polls are active.',
      collapsible: true,
      defaultCollapsed: false,
    },
    {
      id: 'tshStaff',
      label: 'Home \u00b7 Society staff',
      description:
        'Directory of on-duty staff and key contacts pulled from ' +
        'config/directory.json. Defaults to expanded.',
      collapsible: true,
      defaultCollapsed: false,
    },
  ];
})(window);

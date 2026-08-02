// docs/assets/js/mobile-landing.js
// Mobile-only enhancer that runs on EVERY page (the .tsh-mob-tabbar
// partial is now included site-wide).
// Responsibilities:
//   1. Highlight the active tab in the bottom tab-bar based on the
//      current pathname.
//   2. On localhost only, transparently force every FEATURE_* flag on
//      when /config is CORS-blocked so gated anchors (Board / Book /
//      Directory) remain visible during local design review.
//   3. Re-run both of the above whenever a new [data-include] partial
//      injects the tab-bar or a gated anchor after DOMContentLoaded.
//   4. Wire the tab-bar "+" FAB to open the WhatsApp-style bottom-
//      sheet (`docs/partials/mobile-actions-sheet.html`). Since 2026-
//      07-31 there is no v1/v2 opt-out — the sheet is the only mobile
//      "create" entry point.
//   5. Render the bottom-sheet contents from a client-side registry of
//      quick-actions, honouring an admin-configurable override at
//      site.json → ui.mobileQuickActions (title + enabled/ordered list).
//      Falls back to the registry defaults when the override is absent.
//   6. Site-wide accessibility polish: copy aria-label → title on any
//      icon-only interactive element so a hover reveals what it does.
// No new API calls, no new state, no changes to production behaviour.
(function (root) {
  'use strict';

  // --------------------------------------------------------------------
  // Quick-actions registry — the canonical list of "+" bottom-sheet
  // options. Admins in Settings toggle which ones appear and can rename
  // them (via ui.mobileQuickActions.items[].label / .desc overrides).
  // Keys are stable strings; anything referenced by config but missing
  // from this registry is silently ignored on render.
  // --------------------------------------------------------------------
  const QUICK_ACTIONS_REGISTRY = [
    // First 6 are the DEFAULT sheet (unchanged from the pre-2026-07-26
    // static partial — preserves behaviour for tenants who don't
    // customise). Anything past position 6 is added via the admin UI.
    { key: 'report',         label: 'Report an issue',    desc: 'Lift, water, lights, cleaning & more', href: './daily-report.html',            feature: null,                              icon: 'fa-screwdriver-wrench' },
    { key: 'reserve',        label: 'Reserve a space',    desc: 'Community hall, guest room & more',    href: './reservations.html',            feature: 'FEATURE_TSH_RESERVATIONS',        icon: 'fa-calendar-check' },
    { key: 'claim',          label: 'Claim an expense',   desc: 'Reimbursement request & ledger',       href: './treasury.html',                feature: 'FEATURE_TREASURY',                icon: 'fa-money-check-dollar' },
    { key: 'vehicle',        label: 'Search a vehicle',   desc: 'Find the flat for a number plate',     href: './vehicles.html',                feature: 'FEATURE_TSH_VEHICLES',            icon: 'fa-car-side' },
    { key: 'evcharging',     label: 'Book EV charging',   desc: 'Reserve a charger slot',               href: './ev-charging.html',             feature: 'FEATURE_TSH_EV_CHARGING',         icon: 'fa-charging-station' },
    { key: 'vote',           label: 'Cast a vote',        desc: 'Open polls & society decisions',       href: './index.html#tshPolls',          feature: 'FEATURE_DAILY_POLLS',             icon: 'fa-square-poll-vertical' },
    { key: 'myreports',      label: 'My reports',         desc: "See what you've raised recently",      href: './public-board.html?my=1',       feature: null,                              icon: 'fa-bookmark' },
    // Additional actions available for admins to enable.
    { key: 'myreservations', label: 'My reservations',    desc: 'View & manage your bookings',          href: './reservations.html#mine',       feature: 'FEATURE_TSH_RESERVATIONS',        icon: 'fa-user-clock' },
    { key: 'board',          label: 'Public board',       desc: "See what's reported by others",        href: './public-board.html',            feature: 'FEATURE_DAILY_PUBLIC_BOARD',      icon: 'fa-list-check' },
    { key: 'directory',      label: 'Directory',          desc: 'Committee, managers, vendors',         href: './directory.html',               feature: 'FEATURE_DAILY_DIRECTORY',         icon: 'fa-address-book' },
    { key: 'announcements',  label: 'Announcements',      desc: 'Latest updates & notices',             href: './index.html#tshAnnouncements',  feature: 'FEATURE_DAILY_ANNOUNCEMENTS',     icon: 'fa-bullhorn' },
    { key: 'events',         label: 'Events',             desc: 'Upcoming society events',              href: './index.html#tshEvents',         feature: 'FEATURE_DAILY_EVENTS',            icon: 'fa-calendar-days' },
    { key: 'committee',      label: 'Committee contacts', desc: 'Management committee members',         href: './directory.html#committee',     feature: 'FEATURE_DAILY_DIRECTORY',         icon: 'fa-people-group' },
    { key: 'manage',         label: 'Manage tickets',     desc: 'Triage, assign, resolve (staff only)', href: './manage.html',                  feature: 'FEATURE_DAILY_MANAGER_DASHBOARD', icon: 'fa-user-shield' },
    { key: 'settings',       label: 'Settings',           desc: 'Feature flags & access lists (admin)', href: './settings.html',                feature: null,                              icon: 'fa-sliders' },
  ];
  // Public accessor so settings.html can build the admin editor from the
  // same list. Kept read-only for the caller by returning a fresh copy.
  root.TSH_QUICK_ACTIONS_REGISTRY = QUICK_ACTIONS_REGISTRY.map((a) => ({ ...a }));

  // --------------------------------------------------------------------
  // Bottom-sheet wiring for the tab-bar "+" (WhatsApp-style).
  // Always intercepts the FAB click on mobile — the sheet is the sole
  // mobile "create" entry point (no v1/v2 opt-out, no direct-navigate
  // fallback). Users without JS still get the anchor's native
  // navigation to daily-report.html as a graceful degradation.
  // --------------------------------------------------------------------

  // Look up an override entry (from ui.mobileQuickActions.items) by key.
  function findOverride(cfgItems, key) {
    if (!Array.isArray(cfgItems)) return null;
    for (const it of cfgItems) {
      if (it && typeof it === 'object' && it.key === key) return it;
    }
    return null;
  }

  // Read admin override from the loaded /config, if present. Returns
  // { title, items } shaped like the config (missing keys → undefined).
  function readQuickActionsCfg() {
    try {
      const raw = (root.Flags && root.Flags.raw) || null;
      const ui = raw && typeof raw === 'object' ? raw.ui : null;
      const qa = ui && typeof ui === 'object' ? ui.mobileQuickActions : null;
      if (!qa || typeof qa !== 'object') return null;
      return {
        title: typeof qa.title === 'string' ? qa.title : undefined,
        items: Array.isArray(qa.items) ? qa.items : undefined,
      };
    } catch (_e) { return null; }
  }

  // Compute the effective render order + enabled subset from registry +
  // optional config override. Rules:
  //   - If config.items is present, only keys listed there in order are
  //     rendered (each honouring its `enabled` flag; default true). Keys
  //     not in the registry are dropped.
  //   - If config.items is absent, render the first 6 registry entries
  //     (the WhatsApp-style short list — everything else is one tap
  //     away via the tab-bar or All services grid).
  function computeSheetItems() {
    const cfg = readQuickActionsCfg();
    if (cfg && cfg.items && cfg.items.length) {
      const out = [];
      for (const it of cfg.items) {
        if (!it || typeof it !== 'object' || typeof it.key !== 'string') continue;
        if (it.enabled === false) continue;
        const base = QUICK_ACTIONS_REGISTRY.find((r) => r.key === it.key);
        if (!base) continue;
        out.push({
          ...base,
          label: typeof it.label === 'string' && it.label ? it.label : base.label,
          desc:  typeof it.desc  === 'string' && it.desc  ? it.desc  : base.desc,
        });
      }
      return out;
    }
    // Sensible default when no admin has customised the sheet: the first
    // six built-ins mirror what shipped as the static markup.
    return QUICK_ACTIONS_REGISTRY.slice(0, 6);
  }

  // Basic HTML escape for the small subset of user-controllable fields
  // (label / desc from config). Icon and href come from the registry,
  // NOT config, so they can't be injected.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderSheetContents(sheet) {
    const list  = sheet.querySelector('[data-tsh-mob-sheet-list]');
    const title = sheet.querySelector('[data-tsh-mob-sheet-title]');
    if (!list) return;
    const cfg   = readQuickActionsCfg();
    if (title && cfg && cfg.title) title.textContent = cfg.title;

    const items = computeSheetItems();
    const html = items.map((a) => {
      const featAttr = a.feature ? ` data-tsh-feature="${esc(a.feature)}"` : '';
      return (
        '<li>' +
          '<a href="' + esc(a.href) + '"' + featAttr + '>' +
            '<span class="tsh-mob-sheet-icon" aria-hidden="true">' +
              '<i class="fas ' + esc(a.icon || 'fa-circle') + '"></i>' +
            '</span>' +
            '<span class="tsh-mob-sheet-body">' +
              '<span class="tsh-mob-sheet-h">' + esc(a.label) + '</span>' +
              '<span class="tsh-mob-sheet-d">' + esc(a.desc)  + '</span>' +
            '</span>' +
            '<i class="fas fa-chevron-right tsh-mob-sheet-chev" aria-hidden="true"></i>' +
          '</a>' +
        '</li>'
      );
    }).join('');
    list.innerHTML = html;
  }

  function wireActionSheet() {
    const bar = document.querySelector('.tsh-mob-tabbar');
    const fab = bar && bar.querySelector('a.tsh-mob-fab');
    const sheet = document.querySelector('[data-tsh-mob-sheet]');
    if (!bar || !fab || !sheet) return;

    // First re-render from config (safe to run repeatedly).
    renderSheetContents(sheet);

    // Feature-flag pass inside the sheet itself. The parent LI is hidden
    // together with the anchor so grid gaps collapse cleanly.
    if (root.Flags && typeof root.Flags.on === 'function') {
      sheet.querySelectorAll('a[data-tsh-feature]').forEach((a) => {
        const off = !root.Flags.on(a.getAttribute('data-tsh-feature'));
        a.hidden = off;
        const li = a.closest('li');
        if (li) li.hidden = off;
      });
    }

    const openSheet = () => {
      sheet.hidden = false;
      sheet.setAttribute('aria-hidden', 'false');
      document.body.classList.add('tsh-mob-sheet-open');
    };
    const closeSheet = () => {
      sheet.hidden = true;
      sheet.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('tsh-mob-sheet-open');
    };

    if (!fab.dataset.tshSheetWired) {
      fab.dataset.tshSheetWired = '1';
      fab.addEventListener('click', (ev) => {
        ev.preventDefault();
        openSheet();
      });
    }
    sheet.querySelectorAll('[data-tsh-mob-sheet-close]').forEach((el) => {
      if (el.dataset.tshSheetWired) return;
      el.dataset.tshSheetWired = '1';
      el.addEventListener('click', closeSheet);
    });
    // Auto-close + iOS single-tap fallback.
    //
    // Historically: `a.addEventListener('click', () => setTimeout(closeSheet, 0));`
    // On iOS Safari (16-17 reproducible) that single click sometimes never
    // fires when the anchor sits inside a freshly-opened bottom sheet —
    // Safari eats the touch as a candidate for its own gesture heuristics
    // (double-tap-zoom, sticky-hover-first-touch, context-menu preview).
    // A long-press or a second tap does work, which is exactly what the
    // user reports.
    //
    // Fix (mirrors the header-icon fallback in ui.js#bindIconActivation):
    //   - touchstart records the initial Y so we can distinguish a tap
    //     from a scroll swipe (the sheet CAN be scrollable if list is long).
    //   - touchend, if the finger barely moved, cancels the pending
    //     synthetic click (preventDefault) and navigates programmatically
    //     via window.location — that path is unconditional and reliable.
    //   - click still runs as a fallback for desktop / touchend-that-didn't
    //     -preventDefault paths.  De-duped via lastNavAt so we never fire
    //     twice for a single gesture.
    sheet.querySelectorAll('a[href]').forEach((a) => {
      if (a.dataset.tshSheetWired) return;
      a.dataset.tshSheetWired = '1';

      let lastNavAt = 0;
      let touchStartY = null;
      let touchStartX = null;

      const doNav = (href) => {
        const now = Date.now();
        if (now - lastNavAt < 700) return;
        lastNavAt = now;
        // Close the sheet in the next tick so the current handler can
        // finish; navigation is fired synchronously below.
        setTimeout(closeSheet, 0);
        // Same-page hash link => let the browser handle it; otherwise
        // assign to force navigation even if click was preventDefault'd.
        try { window.location.assign(href); }
        catch (_e) { window.location.href = href; }
      };

      a.addEventListener('touchstart', (ev) => {
        if (ev.touches && ev.touches[0]) {
          touchStartY = ev.touches[0].clientY;
          touchStartX = ev.touches[0].clientX;
        }
      }, { passive: true });

      a.addEventListener('touchend', (ev) => {
        const t = ev.changedTouches && ev.changedTouches[0];
        if (!t || touchStartY === null) return;
        const dy = Math.abs(t.clientY - touchStartY);
        const dx = Math.abs(t.clientX - touchStartX);
        touchStartY = touchStartX = null;
        // Movement > 10px => this was a scroll, not a tap.
        if (dy > 10 || dx > 10) return;
        const href = a.getAttribute('href');
        if (!href) return;
        // Suppress the synthetic click that would otherwise follow so
        // we don't double-fire and so iOS can't drop it.
        ev.preventDefault();
        doNav(href);
      }, { passive: false });

      // Desktop + defensive fallback.
      a.addEventListener('click', (ev) => {
        const now = Date.now();
        if (now - lastNavAt < 700) {
          // touchend already navigated; swallow this click so the
          // browser's default doesn't produce a second history entry.
          ev.preventDefault();
          return;
        }
        lastNavAt = now;
        setTimeout(closeSheet, 0);
        // Let the browser's default click follow the href.
      });
    });
    if (!document.body.dataset.tshSheetEsc) {
      document.body.dataset.tshSheetEsc = '1';
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !sheet.hidden) closeSheet();
      });
    }
  }

  function highlightActiveTab() {
    const bar = document.querySelector('.tsh-mob-tabbar');
    if (!bar) return;
    const path = (window.location.pathname || '').replace(/\/+$/, '');
    const file = path.split('/').pop() || 'index.html';
    // Anchors declare their nav key via data-tsh-mob-tab so we don't
    // have to fuzzy-match hrefs. Kept in sync with partials/mobile-tabbar.html.
    const pageToTab = {
      'index.html': 'home',
      '': 'home',
      'public-board.html': 'board',
      'daily-report.html': 'report',
      'daily-confirm.html': 'report',
      'reservations.html': 'book',
      'directory.html': 'directory',
    };
    const active = pageToTab[file];
    bar.querySelectorAll('a[data-tsh-mob-tab]').forEach((a) => {
      if (active && a.getAttribute('data-tsh-mob-tab') === active) {
        a.setAttribute('aria-current', 'page');
        a.classList.add('is-active');
      } else {
        a.removeAttribute('aria-current');
        a.classList.remove('is-active');
      }
    });
  }

  // Re-runs the same feature-flag walker that ui.js applies at L1199 so
  // that (a) freshly-mounted partial anchors get gated correctly and
  // (b) the localhost fallback below has something to re-walk after it
  // monkey-patches Flags.on.
  function runFeatureWalker() {
    if (!root.Flags || typeof root.Flags.on !== 'function') return;
    document.querySelectorAll('a[data-tsh-feature]:not([data-tsh-role-link])').forEach((a) => {
      a.hidden = !root.Flags.on(a.getAttribute('data-tsh-feature'));
    });
    // The sheet items also need re-gating whenever flags change (localhost
    // fallback flips them on after a delay).
    wireActionSheet();
  }

  function isLocalhost() {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
  }

  // --------------------------------------------------------------------
  // Accessibility polish: give every icon-only interactive element a
  // hover tooltip so mouse users can discover what it does. We copy
  // aria-label → title when title is missing, and skip any element that
  // already has visible text content or its own title. This is safe to
  // run repeatedly (idempotent) and cheap enough to run after every
  // partial-mount batch.
  // --------------------------------------------------------------------
  function ensureAccessibleTooltips(scope) {
    const root_ = scope && typeof scope.querySelectorAll === 'function' ? scope : document;
    // Anything the user can hover / click. Include role="button" too
    // (used by some card-style widgets) and native inputs that render
    // as buttons.
    const sel = 'a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"], input[type="reset"], summary';
    const nodes = root_.querySelectorAll(sel);
    for (const el of nodes) {
      if (el.hasAttribute('title')) continue;
      // Skip anything with visible text (a hover on a "Save" button
      // that says "Save" is noise).
      const text = (el.textContent || '').replace(/\s+/g, '').trim();
      if (text.length > 0) continue;
      const label =
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby-text') ||
        el.getAttribute('data-tooltip') ||
        el.getAttribute('alt');
      if (label && label.trim()) {
        el.setAttribute('title', label.trim());
        continue;
      }
      // Fallback: derive from a child <i class="fa-*"> icon name so at
      // least SOMETHING shows on hover ("phone-volume" → "Phone volume"),
      // rather than the element being silent. Icons without an aria-
      // label are rare on this site, but the .fab tab-bar chunk and a
      // few utility icons benefit.
      const icon = el.querySelector('i[class*="fa-"]');
      if (icon) {
        const cls = (icon.className || '').match(/fa-([a-z0-9-]+)/);
        if (cls && cls[1]) {
          const pretty = cls[1].replace(/-/g, ' ');
          el.setAttribute(
            'title',
            pretty.charAt(0).toUpperCase() + pretty.slice(1),
          );
        }
      }
    }
  }

  // Dev-only fallback: on production the worker returns real feature flags
  // via /config, and Flags.on(name) reflects them. On a local static server
  // (python -m http.server) the worker rejects the origin via CORS, so
  // Flags.ready() rejects and every FEATURE_* comes back false — which
  // makes all flag-gated story rings and tab-bar items disappear, leaving
  // just "Report" and "Home". That's actively confusing during design
  // review, so on localhost only we monkey-patch Flags.on to answer true
  // for every FEATURE_* once the real fetch fails, then re-run the same
  // hidden-attr walker that ui.js uses so gated anchors re-appear.
  let localhostFallbackApplied = false;
  function applyLocalhostFlagsFallback() {
    if (!isLocalhost() || !root.Flags || typeof root.Flags.ready !== 'function') return;
    root.Flags.ready().catch(() => {
      // Config load failed (CORS-blocked on localhost). Force flags on.
      root.Flags.on = (name) => typeof name === 'string' && name.indexOf('FEATURE_') === 0;
      localhostFallbackApplied = true;
      runFeatureWalker();
      // eslint-disable-next-line no-console
      console.info('[MobileLanding] localhost dev-fallback: all FEATURE_* forced on because /config was unreachable.');
    });
  }

  // The tab-bar (and other feature-gated anchors) arrive via
  // Partials.mount() AFTER DOMContentLoaded. Watch the body for added
  // nodes and re-run the active-tab highlighter + feature walker once
  // per mount batch (rAF-debounced so a burst of partials only re-runs
  // once). We stop observing after the tab-bar is present AND we've
  // seen at least one mutation batch — further gating is ui.js's job.
  function observePartialMounts() {
    if (!document.body || typeof MutationObserver !== 'function') return;
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        _batchPostMount();
        if (localhostFallbackApplied) runFeatureWalker();
      });
    };
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) { schedule(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Schedule wrapper reused by both init and MutationObserver.
  function _batchPostMount() {
    highlightActiveTab();
    wireActionSheet();
    ensureAccessibleTooltips();
  }

  // Re-render the sheet contents once /config resolves so any admin
  // customisation (ui.mobileQuickActions) takes effect immediately after
  // the initial paint (which used the registry defaults).
  function refreshOnConfigReady() {
    if (!root.Flags || typeof root.Flags.ready !== 'function') return;
    root.Flags.ready().then(() => wireActionSheet()).catch(() => { /* localhost path handles it */ });
  }

  function init() {
    _batchPostMount();
    applyLocalhostFlagsFallback();
    refreshOnConfigReady();
    observePartialMounts();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  root.MobileLanding = {
    highlightActiveTab,
  };
})(window);

// docs/assets/js/flags.js
// Feature flag + role gating helpers. Reads `/config` via Api and
// caches for 60 s. Use Flags.ready() to await the first load.
//
//   await Flags.ready();
//   if (Flags.on('FEATURE_DAILY_PHOTO_UPLOAD')) { ... }
//   const who = await Flags.whoami();
//   if (!Flags.isAtLeast(who.primary, 'MANAGER')) location.href = './index.html';
(function (root) {
  'use strict';

  // Strict 8-tier hierarchy (matches worker/src/auth/roles.ts PRECEDENCE).
  // Higher NUMBER = higher authority. UNKNOWN sits at 0 (anonymous).
  // Kept as numeric ranks so `isAtLeast(actual, minimum)` is a simple >=.
  //   ADMIN > CHAIRMAN > SECRETARY > TREASURER > COMMITTEE
  //     > CONTRIBUTOR > MANAGER > RESIDENT > UNKNOWN
  const RANK = {
    UNKNOWN:     0,
    RESIDENT:    1,
    MANAGER:     2,
    CONTRIBUTOR: 3,
    COMMITTEE:   4,
    TREASURER:   5,
    SECRETARY:   6,
    CHAIRMAN:    7,
    ADMIN:       8,
  };

  let cfg = null;
  let cfgPromise = null;
  let whoamiCache = null;
  let whoamiAt = 0;
  // Maintenance gate — see maybeApplyMaintenance() below. Rendered as a
  // fixed overlay so header sign-in stays clickable for admins.
  let maintenanceApplied = false;

  // -----------------------------------------------------------------
  // Maintenance mode.
  // Feature flag: FEATURE_MAINTENANCE_MODE. When ON, non-ADMIN visitors
  // see a full-page card ("Under maintenance / new features under
  // deployment") on every page except settings.html (so admins can
  // still switch it off). Admins see a small banner but the site runs
  // normally.
  // -----------------------------------------------------------------
  function _currentPageIsSettings() {
    try {
      const p = String(location.pathname || '').toLowerCase();
      return /(^|\/)settings\.html$/.test(p) || p.endsWith('/settings');
    } catch (_e) { return false; }
  }

  function _renderMaintenanceOverlay(cfg2) {
    if (document.getElementById('tshMaintenanceOverlay')) return;
    const sys = (cfg2 && cfg2.system) || {};
    const site = (cfg2 && cfg2.site) || {};
    const message = (sys.maintenance && typeof sys.maintenance.message === 'string' && sys.maintenance.message.trim())
      ? sys.maintenance.message.trim()
      : 'We are deploying new features and improvements. Please check back shortly.';
    const societyName = String(site.name || sys.societyName || 'Society Help Desk');
    const logoUrl = String(sys.logoUrl || './assets/images/TaLogo.png');
    const style = document.createElement('style');
    style.id = 'tshMaintenanceOverlayStyle';
    style.textContent = ''
      + '#tshMaintenanceOverlay{position:fixed;inset:0;z-index:900;'
      + 'background:rgba(15,20,30,.94);display:flex;align-items:center;justify-content:center;'
      + 'padding:1.5rem;font-family:inherit;overflow-y:auto;}'
      + '#tshMaintenanceOverlay .tsh-mnt-card{max-width:520px;width:100%;background:var(--tsh-surface,#fff);'
      + 'border-radius:16px;padding:2.2rem 1.8rem;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.35);'
      + 'border:1px solid var(--tsh-accent,#b48a3c);}'
      + '#tshMaintenanceOverlay img.tsh-mnt-logo{max-width:120px;max-height:120px;margin:0 auto .8rem;display:block;}'
      + '#tshMaintenanceOverlay h1{margin:.2rem 0 .3rem;font-size:1.5rem;letter-spacing:.02em;color:var(--tsh-text,#223);}'
      + '#tshMaintenanceOverlay h2{margin:0 0 1rem;font-size:1.05rem;font-weight:600;'
      + 'color:var(--tsh-accent,#b48a3c);letter-spacing:.05em;text-transform:uppercase;}'
      + '#tshMaintenanceOverlay p{margin:.4rem 0;line-height:1.55;color:var(--tsh-text,#223);}'
      + '#tshMaintenanceOverlay .tsh-mnt-hint{font-size:.85rem;color:var(--tsh-muted,#667);margin-top:1.1rem;}'
      + '#tshMaintenanceOverlay .tsh-mnt-hint a{color:var(--tsh-accent,#b48a3c);text-decoration:underline;}'
      + '.tsh-mnt-admin-banner{position:fixed;top:0;left:0;right:0;z-index:1100;'
      + 'background:var(--tsh-accent,#b48a3c);color:#1a1f2e;text-align:center;'
      + 'padding:.35rem .8rem;font-size:.85rem;font-weight:600;letter-spacing:.03em;'
      + 'box-shadow:0 2px 8px rgba(0,0,0,.25);}'
      + '.tsh-mnt-admin-banner a{color:#1a1f2e;text-decoration:underline;margin-left:.6rem;}';
    document.head.appendChild(style);
    const overlay = document.createElement('div');
    overlay.id = 'tshMaintenanceOverlay';
    overlay.setAttribute('role', 'alert');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML = ''
      + '<div class="tsh-mnt-card">'
      +   '<img class="tsh-mnt-logo" src="' + logoUrl.replace(/"/g, '&quot;') + '" alt="Society logo" />'
      +   '<h1>' + societyName.replace(/</g, '&lt;') + '</h1>'
      +   '<h2><i class="fas fa-hammer" aria-hidden="true"></i> Under Maintenance</h2>'
      +   '<p>' + message.replace(/</g, '&lt;') + '</p>'
      +   '<p class="tsh-mnt-hint">If you are an administrator, please sign in from the top-right menu to continue.</p>'
      + '</div>';
    document.body.appendChild(overlay);
  }

  function _renderMaintenanceAdminBanner(cfg2) {
    if (document.getElementById('tshMaintenanceAdminBanner')) return;
    const sys = (cfg2 && cfg2.system) || {};
    const customMsg = (sys.maintenance && typeof sys.maintenance.message === 'string' && sys.maintenance.message.trim()) || '';
    const banner = document.createElement('div');
    banner.id = 'tshMaintenanceAdminBanner';
    banner.className = 'tsh-mnt-admin-banner';
    banner.innerHTML = ''
      + '<i class="fas fa-triangle-exclamation" aria-hidden="true"></i> '
      + 'Maintenance mode is ON — visitors see the "under maintenance" page. '
      + (customMsg ? '<span style="opacity:.85">Message: ' + customMsg.replace(/</g, '&lt;').slice(0, 90) + '</span> ' : '')
      + '<a href="./settings.html">Open Settings</a>';
    document.body.appendChild(banner);
  }

  async function maybeApplyMaintenance(cfg2) {
    if (maintenanceApplied) return;
    if (!cfg2 || !cfg2.features || cfg2.features.FEATURE_MAINTENANCE_MODE !== true) return;
    if (_currentPageIsSettings()) return; // Admin's escape hatch — never gate settings.
    maintenanceApplied = true;
    // Resolve identity so admins can bypass. Anonymous / non-admin get the overlay.
    let who = null;
    try { who = await whoami(); } catch (_e) { who = null; }
    const roles = _rolesOf(who);
    if (roles.includes('ADMIN')) {
      _renderMaintenanceAdminBanner(cfg2);
      return;
    }
    _renderMaintenanceOverlay(cfg2);
  }

  async function ready() {
    if (cfg) return cfg;
    if (!cfgPromise) {
      cfgPromise = root.Api.get('/config')
        .then((c) => {
          cfg = c;
          // Expose UI defaults to ui.js so FontSize/ThemeSwitcher can use
          // server-side defaults when the user hasn't picked yet.
          root.TSH_UI_DEFAULTS = (c && c.ui) || {};
          // Re-apply with the new defaults (no-op if user already chose).
          if (root.UI && root.UI.FontSize) root.UI.FontSize.init();
          if (root.UI && root.UI.ThemeSwitcher) root.UI.ThemeSwitcher.init();
          // Tenant overrides for collapsible sections (cfg.ui.collapse) may
          // change first-visit state — re-run defaults now that they're
          // loaded. No-op for sections the user has explicitly toggled.
          if (root.UI && root.UI.SectionCollapse && root.UI.SectionCollapse.reapplyDefaults) {
            root.UI.SectionCollapse.reapplyDefaults();
          }
          // Apply optional logo overrides (system.logoUrl / system.logoNameUrl).
          // Blank means "keep the bundled asset".
          const sys = (c && c.system) || {};
          if (sys.logoUrl) {
            for (const img of document.querySelectorAll('[data-tsh-logo]')) img.src = sys.logoUrl;
          }
          if (sys.logoNameUrl) {
            for (const img of document.querySelectorAll('[data-tsh-logo-name]')) {
              img.src = sys.logoNameUrl;
              img.hidden = false;
            }
            // Hide the composed live-text wordmark on the landing hero so
            // the custom bitmap takes its place cleanly.
            for (const brand of document.querySelectorAll('[data-tsh-brand]')) {
              brand.classList.add('has-bitmap-wordmark');
            }
          }
          // Maintenance mode gate. Non-blocking — the promise resolves as
          // usual so callers keep their normal flow. If maintenance is ON
          // and the visitor is not an ADMIN, the overlay renders on top of
          // whatever the page ends up showing.
          try { maybeApplyMaintenance(c); } catch (_e) { /* never block */ }
          return c;
        })
        .catch((e) => { cfgPromise = null; throw e; });
    }
    return cfgPromise;
  }

  function on(name) {
    if (!cfg || !cfg.features) return false;
    return cfg.features[name] === true;
  }

  function tunable(name, fallback) {
    if (!cfg || !cfg.tunables) return fallback;
    const v = cfg.tunables[name];
    return v === undefined ? fallback : v;
  }

  function list(name) {
    if (!cfg || !cfg.lists) return [];
    return cfg.lists[name] || [];
  }

  function subcats(category) {
    if (!cfg || !cfg.lists || !cfg.lists.subCategories) return [];
    return cfg.lists.subCategories[category] || [];
  }

  async function whoami(force) {
    const now = Date.now();
    if (!force && whoamiCache && now - whoamiAt < 2000) return whoamiCache;
    try {
      whoamiCache = await root.Api.get('/whoami');
      whoamiAt = now;
    } catch (_e) {
      whoamiCache = { email: null, roles: [], primary: 'UNKNOWN', identity: null };
      whoamiAt = now;
    }
    return whoamiCache;
  }

  function isAtLeast(actual, minimum) {
    return (RANK[actual] || 0) >= (RANK[minimum] || 0);
  }

  function hasRole(who, role) {
    if (!who || !who.roles) return false;
    return who.roles.includes(role);
  }

  // Page-level guard. Call near the top of a privileged page body.
  //   const who = await Flags.ensureAuthorized('MANAGER');
  // - Anonymous visitor: renders an inline sign-in gate; throws.
  // - Signed-in but role too low: renders a "not authorised" panel; throws.
  async function ensureAuthorized(minRole, redirectTo) {
    await ready();
    const tok = root.Auth ? root.Auth.token() : null;
    const who = await whoami();

    // No client token at all — show the sign-in gate.
    if (!tok) {
      renderSignInGate(minRole);
      throw new Error('Unauthenticated');
    }
    // Client thinks we're signed in, but the server rejected /whoami
    // (token expired, invalidated, signature failure). Drop the stale
    // session and offer Sign in again.
    if (!who.email) {
      try { root.Auth && root.Auth.signOut(); } catch (_e) { /* ignore */ }
      renderSignInGate(minRole);
      throw new Error('SessionExpired');
    }
    // Authenticated but the role isn't high enough for this page.
    if (!isAtLeast(who.primary, minRole)) {
      renderForbiddenGate(minRole, who, redirectTo);
      throw new Error('Forbidden');
    }
    return who;
  }

  function renderSignInGate(minRole) {
    const main = document.querySelector('main') || document.body;
    const need = String(minRole || '').toLowerCase();
    main.innerHTML =
      '<section class="tsh-card" style="max-width:560px;margin:8vh auto;text-align:center;">' +
      '  <header class="tsh-card-head"><h1><i class="fas fa-lock gold-accent"></i> Sign in required</h1></header>' +
      '  <p class="tsh-sub">This page is restricted to <strong id="tshGateRole"></strong> access and above. ' +
      '     Please sign in with your authorised Google account.</p>' +
      '  <div class="tsh-toolbar" style="justify-content:center;margin-top:1rem;gap:.5rem;">' +
      '    <button type="button" class="tsh-btn tsh-btn-primary" id="tshGateSignIn">' +
      '      <i class="fas fa-right-to-bracket"></i> Sign in with Google</button>' +
      '    <a class="tsh-btn tsh-btn-ghost" href="./index.html"><i class="fas fa-house"></i> Home</a>' +
      '  </div>' +
      '  <p class="tsh-sub" style="margin-top:1rem;font-size:.85rem;">' +
      '    Tip: you can also use the <em>Sign in</em> button in the top-right.</p>' +
      '</section>';
    const roleEl = document.getElementById('tshGateRole');
    if (roleEl) roleEl.textContent = need;
    const btn = document.getElementById('tshGateSignIn');
    if (btn && root.Auth) {
      btn.addEventListener('click', async () => {
        try { await root.Auth.signIn(); } catch (_e) { /* user dismissed */ }
      });
      // When sign-in succeeds, reload so the page re-runs its bootstrap.
      const off = root.Auth.onChange((s) => {
        if (s.signedIn) { try { off && off(); } catch (_e) {} location.reload(); }
      });
    }
  }

  function renderForbiddenGate(minRole, who, redirectTo) {
    const main = document.querySelector('main') || document.body;
    const need = String(minRole || '').toLowerCase();
    const cur = String((who && who.primary) || 'unknown').toLowerCase();
    const back = redirectTo || './index.html';
    main.innerHTML =
      '<section class="tsh-card" style="max-width:560px;margin:8vh auto;text-align:center;">' +
      '  <header class="tsh-card-head"><h1><i class="fas fa-ban gold-accent"></i> Not authorised</h1></header>' +
      '  <p class="tsh-sub">You are signed in as <strong id="tshFbEmail"></strong> ' +
      '     (role: <strong id="tshFbRole"></strong>), but this page requires ' +
      '     <strong id="tshFbNeed"></strong> access or higher.</p>' +
      '  <p class="tsh-sub">Ask an admin to add you to the correct access list ' +
      '     in <em>Settings</em>, or sign in with a different account.</p>' +
      '  <div class="tsh-toolbar" style="justify-content:center;margin-top:1rem;gap:.5rem;flex-wrap:wrap;">' +
      '    <a class="tsh-btn tsh-btn-primary" id="tshFbBack"><i class="fas fa-arrow-left"></i> Back</a>' +
      '    <button type="button" class="tsh-btn tsh-btn-ghost" id="tshFbSwitch">' +
      '      <i class="fas fa-right-from-bracket"></i> Sign out &amp; switch account</button>' +
      '  </div>' +
      '</section>';
    const emailEl = document.getElementById('tshFbEmail');
    if (emailEl) emailEl.textContent = (who && who.email) || '—';
    const roleEl  = document.getElementById('tshFbRole');
    if (roleEl)  roleEl.textContent = cur;
    const needEl  = document.getElementById('tshFbNeed');
    if (needEl)  needEl.textContent = need;
    const backBtn = document.getElementById('tshFbBack');
    if (backBtn) backBtn.setAttribute('href', back);
    const out = document.getElementById('tshFbSwitch');
    if (out && root.Auth) {
      out.addEventListener('click', () => {
        try { root.Auth.signOut(); } catch (_e) { /* ignore */ }
        invalidate();
        location.replace('./index.html');
      });
    }
  }

  function invalidate() {
    cfg = null; cfgPromise = null;
    whoamiCache = null; whoamiAt = 0;
    if (root.Api && root.Api.invalidate) {
      root.Api.invalidate('/config');
      root.Api.invalidate('/whoami');
    }
  }

  // Page-level guard for whole pages that can be turned off via a flag.
  // Renders an inline "disabled" placeholder and throws when the flag is off.
  // Caller pattern (after Flags.ready()):
  //   try { Flags.ensureFeature('FEATURE_DAILY_PUBLIC_BOARD', 'Public board'); }
  //   catch (_e) { return; }
  //
  // IMPORTANT: this reads cfg synchronously. If cfg has not loaded yet
  // (i.e. the caller forgot `await Flags.ready()`), we treat that as a
  // programmer error rather than silently rendering the disabled gate —
  // otherwise a page will appear disabled even when the flag is on in
  // Settings. Warn loudly in the console + block on ready() before
  // deciding. This makes ensureFeature safe to call in any order.
  function ensureFeature(flag, friendlyName) {
    if (!cfg) {
      // Fire-and-forget: schedule the real check on next tick after ready
      // resolves. If the flag turns out to be off, the gate will render
      // then. Meanwhile we throw so the current bootstrap stops (matches
      // the sync semantics existing callers rely on).
      // eslint-disable-next-line no-console
      console.warn('[Flags.ensureFeature] called before Flags.ready(); page will re-check once config loads. flag=' + flag);
      ready().then(() => { try { ensureFeature(flag, friendlyName); } catch (_e) { /* gate already rendered */ } });
      throw new Error('FlagsNotReady:' + flag);
    }
    if (on(flag)) return;
    const main = document.querySelector('main') || document.body;
    const name = friendlyName || flag;
    main.innerHTML =
      '<section class="tsh-card" style="max-width:560px;margin:8vh auto;text-align:center;">' +
      '  <header class="tsh-card-head"><h1><i class="fas fa-circle-pause gold-accent"></i> ' + name + ' is disabled</h1></header>' +
      '  <p class="tsh-sub">This section is currently turned off. Ask an admin to re-enable <code>' + flag + '</code> in Settings.</p>' +
      '  <div class="tsh-toolbar" style="justify-content:center;margin-top:1rem;">' +
      '    <a class="tsh-btn tsh-btn-ghost" href="./index.html"><i class="fas fa-house"></i> Home</a>' +
      '  </div>' +
      '</section>';
    throw new Error('FeatureDisabled:' + flag);
  }

  // ---- Treasury access helpers (mirror worker/src/auth/roles.ts) ----
  //
  // Under the strict 8-tier hierarchy (2026-07-12 refactor):
  //   ADMIN > CHAIRMAN > SECRETARY > TREASURER > COMMITTEE > CONTRIBUTOR
  //     > MANAGER > RESIDENT
  // treasury view + act inherit down from TREASURER-and-above, i.e.
  // ADMIN / CHAIRMAN / SECRETARY / TREASURER all see and act on the
  // ledger. COMMITTEE is included here as a client-side grandfather
  // fallback (the client can't tell whether the three treasury lists
  // are seeded — only /access-lists returns that, and only committee+
  // can read it). The Worker is the authoritative enforcer; if a plain
  // committee member on a seeded install clicks through, their API
  // calls will 403 and treasury.js surfaces the error.
  //
  // FEATURE_TREASURY_SECRETARY_ACCESS is deprecated (secretary
  // inherits view via the hierarchy) but the flag is left in defaults
  // for backward compatibility with legacy site.json files.
  function _rolesOf(who) {
    if (!who) return [];
    if (Array.isArray(who.roles)) return who.roles;
    return [];
  }

  function _hasTreasuryTier(who) {
    // ADMIN / CHAIRMAN / SECRETARY / TREASURER — any of these grants
    // treasury access under the strict hierarchy. Membership in one of
    // these lists is reflected in `who.roles[]`; the primary tier
    // (highest match) also appears there.
    const roles = _rolesOf(who);
    return roles.includes('ADMIN')
        || roles.includes('CHAIRMAN')
        || roles.includes('SECRETARY')
        || roles.includes('TREASURER');
  }

  function canViewTreasury(who) {
    if (_hasTreasuryTier(who)) return true;
    // Client-side grandfather fallback — server has the last word.
    return _rolesOf(who).includes('COMMITTEE');
  }

  function canActOnTreasury(who) {
    if (_hasTreasuryTier(who)) return true;
    // Client-side grandfather fallback — server has the last word.
    return _rolesOf(who).includes('COMMITTEE');
  }

  root.Flags = {
    ready, on, tunable, list, subcats,
    whoami, isAtLeast, hasRole, ensureAuthorized, ensureFeature,
    canViewTreasury, canActOnTreasury,
    invalidate,
    get raw() { return cfg; },
  };
})(window);

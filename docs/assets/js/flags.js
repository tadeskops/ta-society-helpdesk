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

  const RANK = { UNKNOWN: 0, RESIDENT: 1, MANAGER: 2, COMMITTEE: 3, DEVELOPER: 4 };

  let cfg = null;
  let cfgPromise = null;
  let whoamiCache = null;
  let whoamiAt = 0;

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
          // Apply optional logo overrides (system.logoUrl / system.logoNameUrl).
          // Blank means "keep the bundled asset".
          const sys = (c && c.system) || {};
          if (sys.logoUrl) {
            for (const img of document.querySelectorAll('[data-tsh-logo]')) img.src = sys.logoUrl;
          }
          if (sys.logoNameUrl) {
            for (const img of document.querySelectorAll('[data-tsh-logo-name]')) img.src = sys.logoNameUrl;
          }
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
    if (!force && whoamiCache && now - whoamiAt < 5000) return whoamiCache;
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
  // - Signed in but wrong role: redirects to home; throws.
  async function ensureAuthorized(minRole, redirectTo) {
    await ready();
    const tok = root.Auth ? root.Auth.token() : null;
    const who = await whoami();

    // Anonymous: don't bounce — let the user sign in here.
    if (!tok || !who.email) {
      renderSignInGate(minRole);
      throw new Error('Unauthenticated');
    }

    if (!isAtLeast(who.primary, minRole)) {
      const target = redirectTo || './index.html';
      // eslint-disable-next-line no-restricted-globals
      location.replace(target);
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
      '  <p class="tsh-sub">This page is restricted to <strong>' + need + '</strong> access and above. ' +
      '     Please sign in with your authorised Google account.</p>' +
      '  <div class="tsh-toolbar" style="justify-content:center;margin-top:1rem;gap:.5rem;">' +
      '    <button type="button" class="tsh-btn tsh-btn-primary" id="tshGateSignIn">' +
      '      <i class="fas fa-right-to-bracket"></i> Sign in with Google</button>' +
      '    <a class="tsh-btn tsh-btn-ghost" href="./index.html"><i class="fas fa-house"></i> Home</a>' +
      '  </div>' +
      '  <p class="tsh-sub" style="margin-top:1rem;font-size:.85rem;">' +
      '    Tip: you can also use the <em>Sign in</em> button in the top-right.</p>' +
      '</section>';
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
  function ensureFeature(flag, friendlyName) {
    if (on(flag)) return;
    const main = document.querySelector('main') || document.body;
    const name = friendlyName || flag;
    main.innerHTML =
      '<section class="tsh-card" style="max-width:560px;margin:8vh auto;text-align:center;">' +
      '  <header class="tsh-card-head"><h1><i class="fas fa-circle-pause gold-accent"></i> ' + name + ' is disabled</h1></header>' +
      '  <p class="tsh-sub">This section is currently turned off. Ask a developer to re-enable <code>' + flag + '</code> in Settings.</p>' +
      '  <div class="tsh-toolbar" style="justify-content:center;margin-top:1rem;">' +
      '    <a class="tsh-btn tsh-btn-ghost" href="./index.html"><i class="fas fa-house"></i> Home</a>' +
      '  </div>' +
      '</section>';
    throw new Error('FeatureDisabled:' + flag);
  }

  root.Flags = {
    ready, on, tunable, list, subcats,
    whoami, isAtLeast, hasRole, ensureAuthorized, ensureFeature,
    invalidate,
    get raw() { return cfg; },
  };
})(window);

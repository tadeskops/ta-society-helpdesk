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
        .then((c) => { cfg = c; return c; })
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
  // Redirects to home if the visitor doesn't meet the minimum.
  async function ensureAuthorized(minRole, redirectTo) {
    await ready();
    const who = await whoami();
    if (!isAtLeast(who.primary, minRole)) {
      const target = redirectTo || './index.html';
      // eslint-disable-next-line no-restricted-globals
      location.replace(target);
      // Throw so callers can short-circuit
      throw new Error('Forbidden');
    }
    return who;
  }

  function invalidate() {
    cfg = null; cfgPromise = null;
    whoamiCache = null; whoamiAt = 0;
    if (root.Api && root.Api.invalidate) {
      root.Api.invalidate('/config');
      root.Api.invalidate('/whoami');
    }
  }

  root.Flags = {
    ready, on, tunable, list, subcats,
    whoami, isAtLeast, hasRole, ensureAuthorized,
    invalidate,
    get raw() { return cfg; },
  };
})(window);

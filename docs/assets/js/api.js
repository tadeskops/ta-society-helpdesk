// docs/assets/js/api.js
// Worker fetch wrapper. Handles the {ok, data | error} envelope,
// bearer injection from Auth.token(), and per-endpoint caches for
// /config (60 s) and /whoami (5 s) per spec §6.6.
//
// Set window.TSH_WORKER_BASE before this script loads to override
// the default Worker URL.
(function (root) {
  'use strict';

  const DEFAULT_BASE = 'https://tsh-worker.tadeskops.workers.dev';
  const base = () => (root.TSH_WORKER_BASE || DEFAULT_BASE).replace(/\/+$/, '');

  const ttls = { '/config': 60_000, '/whoami': 5_000 };
  const cache = new Map();   // path -> { at, value }

  function cachedKey(method, path) {
    return method === 'GET' ? path.split('?')[0] : null;
  }

  function cacheGet(key) {
    if (!key) return null;
    const ttl = ttls[key];
    if (!ttl) return null;
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > ttl) { cache.delete(key); return null; }
    return hit.value;
  }

  function cacheSet(key, value) {
    if (key && ttls[key]) cache.set(key, { at: Date.now(), value });
  }

  function invalidate(prefix) {
    if (!prefix) { cache.clear(); return; }
    for (const k of Array.from(cache.keys())) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
  }

  async function request(method, path, opts = {}) {
    const ckey = cachedKey(method, path);
    if (ckey) {
      const hit = cacheGet(ckey);
      if (hit) return hit;
    }

    const headers = { 'Accept': 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const tok = root.Auth ? root.Auth.token() : null;
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    if (opts.headers) Object.assign(headers, opts.headers);

    let res;
    // Bump the ambient top-progress bar (UI.NetworkProgress) around the
    // whole request lifecycle — including the 401 retry path — so the
    // user always sees an activity cue while the worker is being talked
    // to. Wrapped in a try to survive ui.js not being loaded yet on
    // early pages.
    const progressStart = () => {
      try { root.UI && root.UI.NetworkProgress && root.UI.NetworkProgress.push(); }
      catch (_e) { /* ignore */ }
    };
    const progressEnd = () => {
      try { root.UI && root.UI.NetworkProgress && root.UI.NetworkProgress.pop(); }
      catch (_e) { /* ignore */ }
    };
    progressStart();
    try {
      res = await fetch(base() + path, {
        method,
        headers,
        credentials: 'omit',
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (netErr) {
      progressEnd();
      throw new ApiError('NetworkError', 'Network unreachable', 0, netErr);
    }

    let json;
    try { json = await res.json(); }
    catch (_e) {
      progressEnd();
      throw new ApiError('BadResponse', `HTTP ${res.status}: non-JSON response`, res.status);
    }

    if (!res.ok || json.ok === false) {
      // 401: token missing / invalid / expired. Try one silent re-auth then
      // retry once. If still 401, drop the cached session and let the page
      // re-render its sign-in gate or the user click Sign in.
      if (res.status === 401 && !opts.__retried && root.Auth) {
        const hadToken = !!tok;
        if (hadToken) {
          // Force the next request to omit the stale bearer.
          try { root.Auth.signOut(); } catch (_e) { /* ignore */ }
        }
        try { await root.Auth.signIn(); } catch (_e) { /* user dismissed */ }
        if (root.Auth.token()) {
          // Invalidate any 401-poisoned caches before retry.
          invalidate('/whoami');
          progressEnd();
          return request(method, path, Object.assign({}, opts, { __retried: true }));
        }
        // Couldn't re-auth. Make sure callers don't see stale role data.
        if (root.Flags && root.Flags.invalidate) root.Flags.invalidate();
      }
      progressEnd();
      throw new ApiError(json.code || 'ApiError', json.error || `HTTP ${res.status}`, res.status, json);
    }

    if (ckey) cacheSet(ckey, json.data);
    progressEnd();
    return json.data;
  }

  class ApiError extends Error {
    constructor(code, message, status, detail) {
      super(message);
      this.code = code; this.status = status; this.detail = detail;
    }
  }

  const Api = {
    get:   (path)          => request('GET', path),
    post:  (path, body)    => request('POST', path, { body }),
    patch: (path, body)    => request('PATCH', path, { body }),
    put:   (path, body)    => request('PUT', path, { body }),
    del:   (path, body)    => request('DELETE', path, body === undefined ? {} : { body }),
    base,
    invalidate,
    ApiError,
  };

  root.Api = Api;
  root.ApiError = ApiError;
})(window);

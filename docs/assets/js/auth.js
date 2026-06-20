// docs/assets/js/auth.js
// Google Identity Services (GIS) shim. Holds the ID token in memory
// only — never written to localStorage / cookies (spec §15.2).
//
// Usage on a page:
//   await Auth.init({ clientId: '<GOOGLE_OAUTH_CLIENT_ID>' });
//   Auth.onChange((state) => { ... });        // state: { token, email, signedIn }
//   await Auth.signIn();                       // opens GIS prompt
//   Auth.signOut();
//   Auth.token();                              // current bearer or null
(function (root) {
  'use strict';

  const state = {
    clientId: null,
    token: null,         // raw JWT
    email: null,
    name: null,
    picture: null,
    expiry: 0,           // ms epoch
  };
  const listeners = new Set();

  function notify() {
    const snap = {
      signedIn: !!state.token,
      token: state.token,
      email: state.email,
      name: state.name,
      picture: state.picture,
    };
    for (const fn of listeners) {
      try { fn(snap); } catch (e) { console.error(e); }
    }
  }

  function decodeJwt(jwt) {
    try {
      const [, payload] = jwt.split('.');
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decodeURIComponent(escape(json)));
    } catch (_e) {
      return null;
    }
  }

  function applyToken(jwt) {
    const claims = decodeJwt(jwt);
    if (!claims || !claims.email) {
      console.warn('TSH auth: invalid id_token');
      return;
    }
    state.token = jwt;
    state.email = String(claims.email).toLowerCase();
    state.name = claims.name || null;
    state.picture = claims.picture || null;
    state.expiry = (claims.exp || 0) * 1000;
    // Tab-scoped hint (NOT the token, NOT the email) so the next page in
    // this tab knows to ask GIS for silent re-auth. Cleared on signOut.
    try { sessionStorage.setItem('tsh_signed_in', '1'); } catch (_e) { /* ignore */ }
    notify();
  }

  function clear() {
    state.token = null;
    state.email = null;
    state.name = null;
    state.picture = null;
    state.expiry = 0;
    try { sessionStorage.removeItem('tsh_signed_in'); } catch (_e) { /* ignore */ }
    notify();
  }

  async function loadGisScript() {
    if (window.google && window.google.accounts && window.google.accounts.id) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('GIS script failed to load'));
      document.head.appendChild(s);
    });
  }

  async function init(opts) {
    state.clientId = opts.clientId;
    await loadGisScript();
    window.google.accounts.id.initialize({
      client_id: state.clientId,
      callback: (resp) => { if (resp && resp.credential) applyToken(resp.credential); },
      auto_select: true,           // silent re-auth for returning users
      cancel_on_tap_outside: true,
    });
    // Silent re-auth: only ask GIS to re-emit a credential if THIS tab
    // has previously seen the user signed in. Avoids surprising anonymous
    // landing-page visitors with a One Tap prompt. No PII is stored — the
    // JWT is fetched fresh from Google on every page load (spec §3.3).
    let hint = '';
    try { hint = sessionStorage.getItem('tsh_signed_in') || ''; } catch (_e) { /* ignore */ }
    if (hint === '1') {
      try { window.google.accounts.id.prompt(); } catch (_e) { /* ignore */ }
    }
    // Re-trigger UI even if no user yet — surfaces sign-in button etc.
    notify();
  }

  async function signIn() {
    if (!state.clientId) throw new Error('Auth.init() not called');
    return new Promise((resolve) => {
      window.google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  function signOut() {
    try {
      if (window.google && window.google.accounts && window.google.accounts.id) {
        window.google.accounts.id.disableAutoSelect();
      }
    } catch (_e) { /* ignore */ }
    clear();
  }

  function tokenIfFresh() {
    if (!state.token) return null;
    // 30 s clock-skew buffer
    if (Date.now() > state.expiry - 30_000) {
      clear();
      return null;
    }
    return state.token;
  }

  function onChange(fn) {
    listeners.add(fn);
    // Fire immediately with current state.
    try { fn({ signedIn: !!state.token, token: state.token, email: state.email, name: state.name, picture: state.picture }); }
    catch (e) { console.error(e); }
    return () => listeners.delete(fn);
  }

  root.Auth = { init, signIn, signOut, token: tokenIfFresh, onChange, email: () => state.email };
})(window);

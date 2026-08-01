// docs/assets/js/auth.js
// Google Identity Services (GIS) shim. Holds the ID token in memory
// AND in localStorage (persisted across tabs + browser restarts until
// the JWT expires — typically ~1 h). Prior versions used sessionStorage
// which is tab-scoped and forced re-sign-in in every new tab.
//
// Usage on a page:
//   await Auth.init({ clientId: '<GOOGLE_OAUTH_CLIENT_ID>' });
//   Auth.onChange((state) => { ... });        // state: { token, email, signedIn }
//   await Auth.signIn();                       // opens GIS prompt
//   Auth.signOut();
//   Auth.token();                              // current bearer or null
//   Auth.hasSession();                         // sync bool — is there a
//                                              //   valid persisted JWT?
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

  const STORAGE_KEY = 'tsh_id_token';
  const HINT_KEY    = 'tsh_signed_in';

  // Persistent, cross-tab storage. We used to use sessionStorage (tab-
  // scoped), which forced users to re-sign-in every time they opened a
  // new tab — e.g. clicking a link from WhatsApp / email opens a new
  // tab and the fresh tab had no token, so the role-gated page rendered
  // the sign-in card even though the user had signed in seconds earlier
  // in another tab. Switching to localStorage lets one sign-in cover
  // the whole browser profile until the JWT actually expires. The
  // stored value is the Google id_token JWT only — no refresh token,
  // no PII beyond what's in the JWT itself — and is cleared on
  // Auth.signOut(). See auth.js docstring for the security posture.
  const STORE = (function () {
    try {
      const t = '__tsh_probe__';
      localStorage.setItem(t, '1'); localStorage.removeItem(t);
      return localStorage;
    } catch (_e) {
      // localStorage disabled (e.g. Safari private) — fall back to
      // sessionStorage so the token at least survives navigations in
      // the same tab.
      try { return sessionStorage; } catch (_e2) { return null; }
    }
  })();

  function safeRead(key) {
    if (!STORE) return '';
    try { return STORE.getItem(key) || ''; } catch (_e) { return ''; }
  }
  function safeWrite(key, val) {
    if (!STORE) return;
    try { STORE.setItem(key, val); } catch (_e) { /* ignore quota / SecurityError */ }
  }
  function safeRemove(key) {
    if (!STORE) return;
    try { STORE.removeItem(key); } catch (_e) { /* ignore */ }
  }

  // One-shot migration: if the previous session-only token is still in
  // sessionStorage (older release), copy it to STORE so the user isn't
  // signed out on upgrade.
  (function migrateSessionStorage() {
    try {
      if (STORE === sessionStorage) return;
      const legacyJwt  = sessionStorage.getItem(STORAGE_KEY);
      const legacyHint = sessionStorage.getItem(HINT_KEY);
      if (legacyJwt && !safeRead(STORAGE_KEY)) safeWrite(STORAGE_KEY, legacyJwt);
      if (legacyHint && !safeRead(HINT_KEY))  safeWrite(HINT_KEY,   legacyHint);
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(HINT_KEY);
    } catch (_e) { /* ignore */ }
  })();

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
    // Persist across tabs + browser restarts (until JWT expires).
    safeWrite(HINT_KEY, '1');
    safeWrite(STORAGE_KEY, jwt);
    notify();
  }

  function clear() {
    state.token = null;
    state.email = null;
    state.name = null;
    state.picture = null;
    state.expiry = 0;
    safeRemove(HINT_KEY);
    safeRemove(STORAGE_KEY);
    notify();
  }

  function restoreFromStorage() {
    const jwt = safeRead(STORAGE_KEY);
    if (!jwt) return false;
    const claims = decodeJwt(jwt);
    if (!claims || !claims.exp) return false;
    const expMs = claims.exp * 1000;
    // 60 s clock-skew buffer — if it's already about to expire, drop it.
    if (Date.now() > expMs - 60_000) {
      safeRemove(STORAGE_KEY);
      safeRemove(HINT_KEY);
      return false;
    }
    state.token = jwt;
    state.email = String(claims.email || '').toLowerCase();
    state.name = claims.name || null;
    state.picture = claims.picture || null;
    state.expiry = expMs;
    return true;
  }

  // Synchronous helper: "is there a valid persisted session I can trust
  // right now, without waiting for the network?" Pages can use this to
  // avoid rendering a Sign in gate while /whoami is still in flight.
  function hasSession() {
    if (state.token && Date.now() < state.expiry - 30_000) return true;
    const jwt = safeRead(STORAGE_KEY);
    if (!jwt) return false;
    const claims = decodeJwt(jwt);
    if (!claims || !claims.exp) return false;
    return Date.now() < (claims.exp * 1000) - 30_000;
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

    // 1) Restore from tab-scoped cache first. If it works, the page can
    //    proceed immediately without waiting on Google.
    const restored = restoreFromStorage();

    await loadGisScript();
    window.google.accounts.id.initialize({
      client_id: state.clientId,
      callback: (resp) => { if (resp && resp.credential) applyToken(resp.credential); },
      auto_select: true,           // silent re-auth for returning users
      cancel_on_tap_outside: true,
      use_fedcm_for_prompt: true,  // Chrome 117+ requires FedCM for One Tap
      itp_support: true,
    });

    // 2) Only when there was no cached token AND a previous tab-session hint
    //    exists, attempt the GIS silent re-auth as a fallback. Otherwise we
    //    just notify (anonymous) and let the UI offer Sign in.
    let hint = safeRead(HINT_KEY);
    if (!restored && hint === '1') {
      await new Promise((resolve) => {
        let done = false;
        const off = onChange((s) => {
          if (done || !s.signedIn) return;
          done = true;
          try { off(); } catch (_e) { /* ignore */ }
          resolve();
        });
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          try { off(); } catch (_e) { /* ignore */ }
          resolve();
        }, 2500);
        try {
          window.google.accounts.id.prompt((notification) => {
            if (done) return;
            if (notification && (
              (typeof notification.isNotDisplayed === 'function' && notification.isNotDisplayed()) ||
              (typeof notification.isSkippedMoment === 'function' && notification.isSkippedMoment())
            )) {
              done = true;
              clearTimeout(timer);
              try { off(); } catch (_e) { /* ignore */ }
              safeRemove(HINT_KEY);
              resolve();
            }
          });
        } catch (_e) {
          done = true;
          clearTimeout(timer);
          try { off(); } catch (_e2) { /* ignore */ }
          resolve();
        }
      });
    }
    // Re-trigger UI — surfaces restored session (if any) or the Sign in button.
    notify();
  }

  // Rendered Google Sign-In button used as a reliable fallback when One Tap
  // is suppressed (FedCM off, third-party cookies blocked, GIS exponential
  // backoff after a previous dismissal, etc.). The rendered button always
  // opens the OAuth popup directly, no cookies/FedCM dependency.
  let renderedBtnHost = null;

  function ensureRenderedButton() {
    if (renderedBtnHost && document.body.contains(renderedBtnHost)) return renderedBtnHost;
    if (!window.google || !window.google.accounts || !window.google.accounts.id) return null;
    renderedBtnHost = document.createElement('div');
    // Off-screen but interactable — visibility:hidden suppresses GIS click events.
    renderedBtnHost.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:auto;';
    renderedBtnHost.setAttribute('aria-hidden', 'true');
    document.body.appendChild(renderedBtnHost);
    try {
      window.google.accounts.id.renderButton(renderedBtnHost, {
        type: 'standard', theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'rectangular',
      });
    } catch (e) {
      console.warn('TSH auth: renderButton failed', e);
    }
    return renderedBtnHost;
  }

  function clickRenderedButton() {
    const host = ensureRenderedButton();
    if (!host) return false;
    // GIS renders an inner clickable element. Try common selectors.
    const target =
      host.querySelector('div[role="button"]') ||
      host.querySelector('button') ||
      host.querySelector('div[tabindex]') ||
      host.firstElementChild;
    if (!target) return false;
    try { target.click(); return true; } catch (_e) { return false; }
  }

  async function signIn() {
    if (!state.clientId) throw new Error('Auth.init() not called');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; resolve(ok); };

      // Resolve as soon as a credential actually arrives.
      const off = onChange((s) => {
        if (s.signedIn) { try { off(); } catch (_e) {} finish(true); }
      });

      let promptTried = false;
      try {
        window.google.accounts.id.prompt((notification) => {
          // If One Tap can't show, fall back to the rendered button click —
          // which opens the OAuth popup synchronously and is not affected by
          // FedCM / third-party-cookie suppression.
          const blocked =
            (notification && (
              (typeof notification.isNotDisplayed === 'function' && notification.isNotDisplayed()) ||
              (typeof notification.isSkippedMoment === 'function' && notification.isSkippedMoment()) ||
              (typeof notification.isDismissedMoment === 'function' && notification.isDismissedMoment())
            ));
          if (blocked && !settled) {
            const clicked = clickRenderedButton();
            if (!clicked) { try { off(); } catch (_e) {} finish(false); }
          }
        });
        promptTried = true;
      } catch (_e) {
        // GIS not ready — go straight to the rendered button.
        const clicked = clickRenderedButton();
        if (!clicked) { try { off(); } catch (_e2) {} finish(false); }
      }

      // Safety net: if neither path produces a credential within 8 s, give up
      // so the caller's UI can recover.
      setTimeout(() => {
        if (settled) return;
        if (promptTried) {
          // Try the rendered button explicitly in case the prompt callback
          // never fired (rare, but documented in GIS issues).
          clickRenderedButton();
        }
        setTimeout(() => { try { off(); } catch (_e) {} finish(false); }, 4000);
      }, 4000);
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

  root.Auth = { init, signIn, signOut, token: tokenIfFresh, hasSession, onChange, email: () => state.email };
})(window);


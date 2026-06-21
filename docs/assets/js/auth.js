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
      use_fedcm_for_prompt: true,  // Chrome 117+ requires FedCM for One Tap
      itp_support: true,
    });
    // Silent re-auth: only ask GIS to re-emit a credential if THIS tab
    // has previously seen the user signed in. Avoids surprising anonymous
    // landing-page visitors with a One Tap prompt. No PII is stored — the
    // JWT is fetched fresh from Google on every page load (spec §3.3).
    let hint = '';
    try { hint = sessionStorage.getItem('tsh_signed_in') || ''; } catch (_e) { /* ignore */ }
    if (hint === '1') {
      // Wait briefly for the silent credential callback so page guards
      // (Flags.ensureAuthorized) don't run before the token arrives.
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
            if (notification && (notification.isNotDisplayed() || notification.isSkippedMoment())) {
              done = true;
              clearTimeout(timer);
              try { off(); } catch (_e) { /* ignore */ }
              // Stale hint (user signed out elsewhere / cookies cleared) — drop it
              // so we don't re-prompt on every page load.
              try { sessionStorage.removeItem('tsh_signed_in'); } catch (_e) { /* ignore */ }
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
    // Re-trigger UI even if no user yet — surfaces sign-in button etc.
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

  root.Auth = { init, signIn, signOut, token: tokenIfFresh, onChange, email: () => state.email };
})(window);


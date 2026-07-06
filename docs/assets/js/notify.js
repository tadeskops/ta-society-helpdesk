/*!
 * TSH Notifications — in-app notification bell (header).
 * Exposes `window.Notify` with `init()`, `refresh()`, `stop()`.
 *
 * Auto-boots on DOMContentLoaded. Hooks Auth.onChange to reveal the bell
 * only when a user is signed in. Polls /notifications/count every 60s
 * and opens a dropdown of recent items on click.
 *
 * All calls are best-effort — errors never bubble to the UI.
 */
(function (root) {
  'use strict';

  const POLL_MS = 60_000;
  const LIST_LIMIT = 20;
  const CSS_ID = 'tsh-notify-css';

  const state = {
    bootDone: false,
    poller: null,
    dropdown: null,
    countEl: null,
    bellBtn: null,
    lastCount: 0,
  };

  function api() {
    return (root.Api && typeof root.Api.base === 'function') ? root.Api.base() : '';
  }

  function authToken() {
    if (root.Auth && typeof root.Auth.token === 'function') return root.Auth.token();
    return null;
  }

  async function fetchJson(path, init) {
    const token = authToken();
    const headers = Object.assign(
      { 'Accept': 'application/json' },
      (init && init.body) ? { 'Content-Type': 'application/json' } : {},
      token ? { 'Authorization': `Bearer ${token}` } : {},
      (init && init.headers) || {},
    );
    const res = await fetch(api() + path, Object.assign({}, init || {}, { headers }));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = `
      .tsh-bell { position: relative; }
      .tsh-bell-badge {
        position: absolute; top: -4px; right: -4px;
        min-width: 16px; height: 16px; padding: 0 4px;
        border-radius: 999px;
        background: var(--tsh-color-danger, #e53935); color: #fff;
        font-size: 10px; line-height: 16px; text-align: center;
        font-weight: 700;
      }
      .tsh-notify-drop {
        position: fixed; z-index: 4000; display: none;
        width: min(360px, calc(100vw - 24px));
        max-height: 60vh; overflow: auto;
        background: var(--tsh-surface, #fff); color: var(--tsh-fg, #222);
        border: 1px solid var(--tsh-border, rgba(0,0,0,.12));
        border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.18);
      }
      .tsh-notify-drop.is-open { display: block; }
      .tsh-notify-drop-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 12px; border-bottom: 1px solid var(--tsh-border, rgba(0,0,0,.08));
        font-weight: 600;
      }
      .tsh-notify-drop-head button {
        border: 0; background: transparent; color: inherit; cursor: pointer;
        font-size: 12px; text-decoration: underline; padding: 4px 6px;
      }
      .tsh-notify-item {
        display: block; padding: 10px 12px; text-decoration: none; color: inherit;
        border-bottom: 1px solid var(--tsh-border, rgba(0,0,0,.06));
        cursor: pointer;
      }
      .tsh-notify-item:hover { background: rgba(0,0,0,.04); }
      .tsh-notify-item.is-unread { background: rgba(33,150,243,.06); }
      .tsh-notify-item .t { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
      .tsh-notify-item .b { font-size: 12px; color: var(--tsh-fg-muted, #555); }
      .tsh-notify-item .m { font-size: 11px; color: var(--tsh-fg-muted, #888); margin-top: 2px; }
      .tsh-notify-empty { padding: 16px; text-align: center; color: var(--tsh-fg-muted, #888); font-size: 13px; }
    `;
    document.head.appendChild(s);
  }

  function findEls() {
    state.bellBtn = document.querySelector('[data-tsh-notify-bell]');
    state.countEl = document.querySelector('[data-tsh-notify-count]');
    return !!state.bellBtn;
  }

  function setCount(n) {
    state.lastCount = n | 0;
    if (!state.countEl) return;
    if (state.lastCount > 0) {
      state.countEl.textContent = state.lastCount > 99 ? '99+' : String(state.lastCount);
      state.countEl.hidden = false;
    } else {
      state.countEl.textContent = '0';
      state.countEl.hidden = true;
    }
  }

  async function refresh() {
    if (!authToken()) return;
    try {
      const j = await fetchJson('/notifications/count');
      setCount((j && j.data && j.data.unread) || 0);
    } catch (_e) { /* silent */ }
  }

  function relTime(iso) {
    try {
      const d = new Date(iso).getTime();
      const s = Math.max(1, Math.round((Date.now() - d) / 1000));
      if (s < 60)     return `${s}s ago`;
      if (s < 3600)   return `${Math.round(s / 60)}m ago`;
      if (s < 86400)  return `${Math.round(s / 3600)}h ago`;
      return `${Math.round(s / 86400)}d ago`;
    } catch (_e) { return ''; }
  }

  function ensureDropdown() {
    if (state.dropdown) return state.dropdown;
    const d = document.createElement('div');
    d.className = 'tsh-notify-drop';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'Notifications');
    d.innerHTML = `
      <div class="tsh-notify-drop-head">
        <span>Notifications</span>
        <button type="button" data-notify-mark-all>Mark all read</button>
      </div>
      <div data-notify-list></div>
    `;
    document.body.appendChild(d);
    d.querySelector('[data-notify-mark-all]').addEventListener('click', async () => {
      try {
        await fetchJson('/notifications/mark-all-read', { method: 'POST', body: '{}' });
      } catch (_e) { /* silent */ }
      await loadList();
      await refresh();
    });
    // Close on outside click
    document.addEventListener('click', (ev) => {
      if (!d.classList.contains('is-open')) return;
      if (state.bellBtn && state.bellBtn.contains(ev.target)) return;
      if (d.contains(ev.target)) return;
      d.classList.remove('is-open');
    });
    state.dropdown = d;
    return d;
  }

  function positionDropdown() {
    if (!state.dropdown || !state.bellBtn) return;
    const r = state.bellBtn.getBoundingClientRect();
    const d = state.dropdown;
    d.style.top  = (r.bottom + 6) + 'px';
    // Right-align with the bell.
    const width = Math.min(360, window.innerWidth - 24);
    let left = r.right - width;
    if (left < 12) left = 12;
    d.style.left = left + 'px';
    d.style.width = width + 'px';
  }

  async function loadList() {
    const d = ensureDropdown();
    const list = d.querySelector('[data-notify-list]');
    list.innerHTML = `<div class="tsh-notify-empty">Loading…</div>`;
    try {
      const j = await fetchJson(`/notifications?limit=${LIST_LIMIT}`);
      const items = (j && j.data && Array.isArray(j.data.items)) ? j.data.items : [];
      if (!items.length) {
        list.innerHTML = `<div class="tsh-notify-empty">No notifications yet</div>`;
        return;
      }
      list.innerHTML = '';
      for (const n of items) {
        const a = document.createElement('a');
        a.className = 'tsh-notify-item' + (n.readAt ? '' : ' is-unread');
        a.href = n.link || '#';
        a.innerHTML = `
          <div class="t"></div>
          <div class="b"></div>
          <div class="m"></div>
        `;
        a.querySelector('.t').textContent = n.title || '(untitled)';
        a.querySelector('.b').textContent = n.body || '';
        a.querySelector('.m').textContent = relTime(n.createdAt);
        a.addEventListener('click', async (ev) => {
          // Mark read, then let the browser follow the link (if any).
          if (!n.readAt) {
            try { await fetchJson(`/notifications/${encodeURIComponent(n.id)}/read`, { method: 'PATCH', body: '{}' }); } catch (_e) { /* silent */ }
            a.classList.remove('is-unread');
            setCount(Math.max(0, state.lastCount - 1));
          }
          if (!n.link) { ev.preventDefault(); state.dropdown.classList.remove('is-open'); }
        });
        list.appendChild(a);
      }
    } catch (_e) {
      list.innerHTML = `<div class="tsh-notify-empty">Failed to load</div>`;
    }
  }

  function toggleDropdown() {
    const d = ensureDropdown();
    if (d.classList.contains('is-open')) { d.classList.remove('is-open'); return; }
    positionDropdown();
    d.classList.add('is-open');
    loadList();
  }

  function startPoller() {
    stopPoller();
    if (!authToken()) return;
    state.poller = setInterval(refresh, POLL_MS);
    refresh();
  }
  function stopPoller() {
    if (state.poller) { clearInterval(state.poller); state.poller = null; }
  }

  function boot() {
    if (state.bootDone) return;
    if (!findEls()) return;
    injectCss();
    state.bellBtn.addEventListener('click', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      toggleDropdown();
    });
    window.addEventListener('resize', () => { if (state.dropdown && state.dropdown.classList.contains('is-open')) positionDropdown(); });
    if (root.Auth && typeof root.Auth.onChange === 'function') {
      root.Auth.onChange((s) => {
        if (s && s.signedIn) {
          state.bellBtn.hidden = false;
          startPoller();
        } else {
          state.bellBtn.hidden = true;
          setCount(0);
          stopPoller();
          if (state.dropdown) state.dropdown.classList.remove('is-open');
        }
      });
      if (root.Auth.isSignedIn && root.Auth.isSignedIn()) {
        state.bellBtn.hidden = false;
        startPoller();
      }
    }
    state.bootDone = true;
  }

  // Header is loaded async via partials.js — retry until the button appears.
  function attemptBoot(tries) {
    if (state.bootDone) return;
    if (findEls()) { boot(); return; }
    if (tries <= 0) return;
    setTimeout(() => attemptBoot(tries - 1), 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => attemptBoot(20));
  } else {
    attemptBoot(20);
  }

  root.Notify = { init: () => attemptBoot(20), refresh, stop: stopPoller };
})(window);

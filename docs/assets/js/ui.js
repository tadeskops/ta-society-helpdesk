// docs/assets/js/ui.js
// Tiny UI helpers: toast(), modal(), formatRel(), copy(), download().
// Depends on partials/toast.html and partials/modal.html being mounted.
(function (root) {
  'use strict';

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v != null && v !== false) node.setAttribute(k, String(v));
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function toast(message, opts) {
    const region = $('[data-tsh-toasts]');
    if (!region) { console.log('toast:', message); return; }
    const kind = (opts && opts.kind) || 'info';
    const t = el('output', { class: `tsh-toast tsh-toast-${kind}`, role: 'status' }, message);
    region.appendChild(t);
    const ttl = (opts && opts.ttl) || 4500;
    setTimeout(() => {
      t.classList.add('tsh-toast-leave');
      setTimeout(() => t.remove(), 350);
    }, ttl);
  }

  function modal({ title, body, actions }) {
    const m = $('[data-tsh-modal]');
    if (!m) throw new Error('modal partial missing');
    m.querySelector('.tsh-modal-title').textContent = title || '';
    const bodyEl = m.querySelector('.tsh-modal-body');
    bodyEl.innerHTML = '';
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);

    const actionsEl = m.querySelector('.tsh-modal-actions');
    actionsEl.innerHTML = '';

    return new Promise((resolve) => {
      const close = (value) => {
        m.hidden = true;
        m.removeEventListener('click', backdrop);
        document.removeEventListener('keydown', esc);
        resolve(value);
      };
      const backdrop = (e) => {
        if (e.target.matches('[data-tsh-modal-close]')) close(null);
      };
      const esc = (e) => { if (e.key === 'Escape') close(null); };

      for (const a of (actions || [{ label: 'OK', value: true, primary: true }])) {
        const btn = el('button', {
          type: 'button',
          class: `tsh-btn ${a.primary ? 'tsh-btn-primary' : 'tsh-btn-ghost'} ${a.danger ? 'tsh-btn-danger' : ''}`,
          onclick: () => close(a.value === undefined ? a.label : a.value),
        }, a.label);
        actionsEl.appendChild(btn);
      }

      m.hidden = false;
      m.addEventListener('click', backdrop);
      document.addEventListener('keydown', esc);
      const firstBtn = actionsEl.querySelector('button');
      if (firstBtn) firstBtn.focus();
    });
  }

  function confirmModal(title, body) {
    return modal({
      title, body,
      actions: [
        { label: 'Cancel', value: false },
        { label: 'Confirm', value: true, primary: true },
      ],
    });
  }

  function formatRel(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!t) return '';
    const diff = Date.now() - t;
    const min = 60_000, hr = 60 * min, day = 24 * hr;
    if (diff < min) return 'just now';
    if (diff < hr) return Math.floor(diff / min) + ' min ago';
    if (diff < day) return Math.floor(diff / hr) + ' hr ago';
    if (diff < 7 * day) return Math.floor(diff / day) + ' d ago';
    return new Date(iso).toLocaleDateString();
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', { kind: 'success' });
    } catch (_e) {
      toast('Copy failed — select and Ctrl+C', { kind: 'warn' });
    }
  }

  function statusPill(status) {
    return el('span', { class: `tsh-pill tsh-pill-${status}` }, status);
  }

  function severityPill(sev) {
    if (!sev) return el('span', { class: 'tsh-pill tsh-pill-low' }, '—');
    return el('span', { class: `tsh-pill tsh-pill-sev-${sev}` }, sev);
  }

  // Wire header sign-in/out buttons once partials are mounted + Auth init'd.
  function bindHeader() {
    const signin  = document.querySelector('[data-tsh-signin]');
    const signout = document.querySelector('[data-tsh-signout]');
    const userEl  = document.querySelector('[data-tsh-user]');
    if (!signin || !signout || !userEl || !root.Auth) return;

    // Mark the active nav entry so the gold-pill style applies (aria-current).
    try {
      const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
      for (const a of document.querySelectorAll('.tsh-nav a[href]')) {
        const target = (a.getAttribute('href') || '').split('/').pop().toLowerCase();
        if (target === here) a.setAttribute('aria-current', 'page');
      }
    } catch (_e) { /* ignore */ }

    signin.addEventListener('click', () => root.Auth.signIn());
    signout.addEventListener('click', () => { root.Auth.signOut(); root.Flags && root.Flags.invalidate(); location.reload(); });

    const hideRoleLinks = () => {
      for (const a of document.querySelectorAll('[data-tsh-role-link]')) a.hidden = true;
    };

    const refreshRoleLinks = () => {
      if (!root.Flags) return Promise.resolve();
      // Force /whoami to re-fetch with the (new) bearer token — but DON'T
      // invalidate the rest of the Flags cache (config/lists) because the
      // page may already be using it for the form / table.
      if (root.Api && root.Api.invalidate) root.Api.invalidate('/whoami');
      return root.Flags.whoami(true).then((who) => {
        for (const a of document.querySelectorAll('[data-tsh-role-link]')) {
          const need = a.getAttribute('data-tsh-role-link');
          a.hidden = !root.Flags.isAtLeast(who.primary, need);
        }
      }).catch(() => hideRoleLinks());
    };

    let lastSignedIn = null;
    root.Auth.onChange((s) => {
      if (s.signedIn) {
        userEl.textContent = s.email;
        userEl.classList.remove('tsh-user-anon');
        signin.hidden = true;
        signout.hidden = false;
      } else {
        userEl.textContent = 'Not signed in';
        userEl.classList.add('tsh-user-anon');
        signin.hidden = false;
        signout.hidden = true;
        hideRoleLinks();
      }
      // Re-fetch /whoami whenever the auth state actually flips so role-gated
      // nav links (Manager / Committee / Settings) appear immediately after
      // sign-in instead of only on the next full page load.
      if (s.signedIn !== lastSignedIn) {
        lastSignedIn = s.signedIn;
        if (s.signedIn) refreshRoleLinks();
      }
    });

    // Anonymous initial reveal — runs even without a token so cached /whoami
    // (e.g. silent re-auth completed before bindHeader fires) is honoured.
    refreshRoleLinks();
  }

  root.UI = { el, $, toast, modal, confirmModal, formatRel, copyToClipboard, statusPill, severityPill, bindHeader };
})(window);

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

  // ----- Loading / empty / error state cards -----
  // Render with stateLoading('Loading issues…'), stateEmpty('inbox', 'No issues yet'),
  // stateError('Could not load').  Returns a DOM node ready to append into a list/grid host.
  function stateNode(kind, icon, title, msg) {
    return el('div', { class: `tsh-state tsh-state-${kind}` },
      el('i', { class: `tsh-state-icon fas ${icon}` }),
      title ? el('p', { class: 'tsh-state-title' }, title) : null,
      msg   ? el('p', { class: 'tsh-state-msg' }, msg) : null);
  }
  function stateLoading(msg) { return stateNode('loading', 'fa-spinner fa-spin', null, msg || 'Loading…'); }
  function stateEmpty(icon, title, msg) { return stateNode('empty', icon || 'fa-inbox', title || 'Nothing to show', msg || ''); }
  function stateError(msg)   { return stateNode('error',   'fa-exclamation-triangle', 'Something went wrong', msg || 'Please try again.'); }

  // ----- Lightbox (photo viewer) -----
  // Open with Lightbox.open([url1, url2, ...], startIndex).  Photos that look like
  // Google Drive URLs (/d/<id>/) get an "Open in Drive" link.
  const Lightbox = (function () {
    let host = null;
    let imgEl, counterEl, driveEl, urls = [], idx = 0;

    function isDriveUrl(u) { return /drive\.google\.com|googleusercontent\.com/i.test(u); }

    function ensureHost() {
      if (host) return host;
      host = el('div', { class: 'tsh-lightbox', role: 'dialog', 'aria-modal': 'true', hidden: true });
      driveEl   = el('a',      { class: 'tsh-lightbox-drive',   target: '_blank', rel: 'noopener', hidden: true },
                     el('i', { class: 'fab fa-google-drive' }), ' Open original');
      const closeBtn = el('button', { type: 'button', class: 'tsh-lightbox-close', 'aria-label': 'Close', onclick: close },
                          el('i', { class: 'fas fa-times' }));
      const prevBtn  = el('button', { type: 'button', class: 'tsh-lightbox-prev', 'aria-label': 'Previous', onclick: prev },
                          el('i', { class: 'fas fa-chevron-left' }));
      const nextBtn  = el('button', { type: 'button', class: 'tsh-lightbox-next', 'aria-label': 'Next', onclick: next },
                          el('i', { class: 'fas fa-chevron-right' }));
      imgEl     = el('img',    { class: 'tsh-lightbox-img', alt: '' });
      counterEl = el('div',    { class: 'tsh-lightbox-counter' }, '1 / 1');
      host.append(driveEl, closeBtn, prevBtn, nextBtn, imgEl, counterEl);
      host.addEventListener('click', (e) => { if (e.target === host) close(); });
      document.body.appendChild(host);
      return host;
    }

    function paint() {
      const u = urls[idx];
      imgEl.src = u;
      counterEl.textContent = `${idx + 1} / ${urls.length}`;
      const showPrevNext = urls.length > 1;
      host.querySelector('.tsh-lightbox-prev').hidden = !showPrevNext;
      host.querySelector('.tsh-lightbox-next').hidden = !showPrevNext;
      counterEl.hidden = !showPrevNext;
      driveEl.hidden = !isDriveUrl(u);
      if (!driveEl.hidden) driveEl.href = u;
    }
    function prev() { idx = (idx - 1 + urls.length) % urls.length; paint(); }
    function next() { idx = (idx + 1) % urls.length; paint(); }

    function onKey(e) {
      if (!host || host.hidden) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft')  prev();
      else if (e.key === 'ArrowRight') next();
    }

    function open(list, startIndex) {
      ensureHost();
      urls = Array.isArray(list) ? list.filter(Boolean) : [];
      if (!urls.length) return;
      idx = Math.max(0, Math.min(startIndex || 0, urls.length - 1));
      paint();
      host.hidden = false;
      document.addEventListener('keydown', onKey);
    }
    function close() {
      if (!host) return;
      host.hidden = true;
      document.removeEventListener('keydown', onKey);
    }

    // Auto-wire any photo grid: pass `{ root: containerEl }` to make every
    // <img> inside open the lightbox bound to its sibling URLs.
    function attach(scope) {
      const container = (scope && scope.querySelectorAll) ? scope : document;
      for (const grid of container.querySelectorAll('.tsh-photo-grid')) {
        if (grid.dataset.tshLightboxBound === '1') continue;
        grid.dataset.tshLightboxBound = '1';
        grid.addEventListener('click', (e) => {
          const img = e.target.closest('img');
          if (!img) return;
          e.preventDefault();
          const imgs = Array.from(grid.querySelectorAll('img'));
          const list = imgs.map((i) => i.getAttribute('data-tsh-full') || i.src);
          open(list, imgs.indexOf(img));
        });
      }
    }

    return { open, close, attach };
  })();

  // ----- FontSize switcher (a11y) -----
  // Three scales: md (16px, default), lg (17.5px), xl (19px).  Persisted in
  // localStorage as `tsh_fontsize`.  Applied via html[data-fontsize] which
  // theme.css picks up to scale all rem-sized tokens.
  const FontSize = (function () {
    const KEY = 'tsh_fontsize';
    const ALLOWED = ['md', 'lg', 'xl'];

    function get() {
      try { const v = localStorage.getItem(KEY); if (ALLOWED.includes(v)) return v; } catch (_e) {}
      return 'md';
    }
    function apply(size) {
      const v = ALLOWED.includes(size) ? size : 'md';
      document.documentElement.setAttribute('data-fontsize', v);
      try { localStorage.setItem(KEY, v); } catch (_e) {}
      // Update any switcher widgets on the page.
      for (const btn of document.querySelectorAll('[data-tsh-fontsize]')) {
        btn.setAttribute('aria-pressed', btn.getAttribute('data-tsh-fontsize') === v ? 'true' : 'false');
      }
    }
    function bind(scope) {
      const container = (scope && scope.querySelectorAll) ? scope : document;
      for (const btn of container.querySelectorAll('[data-tsh-fontsize]')) {
        if (btn.dataset.tshFontsizeBound === '1') continue;
        btn.dataset.tshFontsizeBound = '1';
        btn.addEventListener('click', () => apply(btn.getAttribute('data-tsh-fontsize')));
      }
      apply(get());
    }
    function init() { apply(get()); }
    return { init, bind, apply, get };
  })();

  // Apply the persisted font-size immediately (before partials mount) so the
  // page renders at the user's chosen scale without a visible jump.
  FontSize.init();

  // ----- Draft (localStorage form persistence) -----
  // Draft.bind(form, 'TSH_KEY') auto-saves every input change and restores
  // on next visit.  Call Draft.clear('TSH_KEY') after a successful submit.
  const Draft = {
    save(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); } catch (_e) {} },
    load(key) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (_e) { return null; }
    },
    clear(key) { try { localStorage.removeItem(key); } catch (_e) {} },
    bind(form, key, opts) {
      if (!form) return;
      const skip = new Set((opts && opts.skip) || ['photos']);
      // Restore existing draft.
      const saved = this.load(key);
      if (saved) {
        for (const [name, value] of Object.entries(saved)) {
          const el = form.elements[name];
          if (!el || skip.has(name)) continue;
          if (el.type === 'checkbox') el.checked = !!value;
          else el.value = value;
        }
      }
      // Save on any change.
      const persist = () => {
        const out = {};
        for (const el of form.elements) {
          if (!el.name || skip.has(el.name) || el.type === 'file' || el.type === 'submit') continue;
          out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
        }
        this.save(key, out);
      };
      form.addEventListener('input', persist);
      form.addEventListener('change', persist);
    },
  };

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

    // Wire the font-size switcher embedded in the header partial.
    FontSize.bind(document);
  }

  root.UI = {
    el, $, toast, modal, confirmModal, formatRel, copyToClipboard,
    statusPill, severityPill, bindHeader,
    stateLoading, stateEmpty, stateError,
    Lightbox, FontSize, Draft,
  };
})(window);

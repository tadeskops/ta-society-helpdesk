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

  // Status wire value -> human label. Keep wire values stable (they're the
  // GitHub label names on stored issues); the UI just prints something a
  // resident can read. 'triaging' historically came from incident-management
  // tooling — we surface it as 'Reviewing' for clarity.
  const STATUS_TEXT = {
    new:           'New',
    triaging:      'Reviewing',
    assigned:      'Assigned',
    'in-progress': 'In progress',
    in_progress:   'In progress',
    resolved:      'Resolved',
    rejected:      'Rejected',
    reopened:      'Reopened',
    deleted:       'Deleted',
  };
  function statusText(s) { return STATUS_TEXT[s] || (s ? String(s) : '—'); }

  function statusPill(status) {
    return el('span', { class: `tsh-pill tsh-pill-${status}` }, statusText(status));
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
  //
  // Server default (cfg.ui.defaultFontScale) is consulted only when the user
  // has not yet chosen a size in this browser.  Populated by flags.js into
  // window.TSH_UI_DEFAULTS after /config loads.
  const FontSize = (function () {
    const KEY = 'tsh_fontsize';
    const ALLOWED = ['md', 'lg', 'xl'];

    function serverDefault() {
      const d = (root.TSH_UI_DEFAULTS && root.TSH_UI_DEFAULTS.defaultFontScale) || '';
      return ALLOWED.includes(d) ? d : 'md';
    }
    function get() {
      try { const v = localStorage.getItem(KEY); if (ALLOWED.includes(v)) return v; } catch (_e) {}
      return serverDefault();
    }
    function apply(size) {
      const v = ALLOWED.includes(size) ? size : serverDefault();
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

  // ----- Theme switcher (3 tones: dark / light / medium) -----
  // Persisted in localStorage as `tsh_theme`.  Applied via html[data-theme]
  // which theme.css uses to swap the surface + text + border tokens.
  // `dark` is the default and is represented by the ABSENCE of the attribute
  // (so first-paint matches the base :root variables — no FOUC).
  const ThemeSwitcher = (function () {
    const KEY = 'tsh_theme';
    const ALLOWED = ['dark', 'light', 'medium'];

    function serverDefault() {
      const d = (root.TSH_UI_DEFAULTS && root.TSH_UI_DEFAULTS.defaultTheme) || '';
      return ALLOWED.includes(d) ? d : 'light';
    }
    function get() {
      try { const v = localStorage.getItem(KEY); if (ALLOWED.includes(v)) return v; } catch (_e) {}
      return serverDefault();
    }
    function apply(tone) {
      const v = ALLOWED.includes(tone) ? tone : serverDefault();
      if (v === 'dark') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', v);
      try { localStorage.setItem(KEY, v); } catch (_e) {}
      for (const btn of document.querySelectorAll('[data-tsh-theme]')) {
        btn.setAttribute('aria-pressed', btn.getAttribute('data-tsh-theme') === v ? 'true' : 'false');
      }
    }
    function bind(scope) {
      const container = (scope && scope.querySelectorAll) ? scope : document;
      for (const btn of container.querySelectorAll('[data-tsh-theme]')) {
        if (btn.dataset.tshThemeBound === '1') continue;
        btn.dataset.tshThemeBound = '1';
        btn.addEventListener('click', () => apply(btn.getAttribute('data-tsh-theme')));
      }
      apply(get());
    }
    function init() { apply(get()); }
    return { init, bind, apply, get };
  })();

  ThemeSwitcher.init();

  // ----- FloatDock (draggable display-controls dock) -----
  // Position persisted per-device in localStorage as `tsh_floatdock_pos`
  // (JSON {left, top}). Default is bottom-right (right/bottom CSS). When
  // a saved position exists OR the user drags, we set inline left/top and
  // add .is-floating which neutralises the default right/bottom anchors.
  // Double-click the handle to reset.
  const FloatDock = (function () {
    const KEY = 'tsh_floatdock_pos';
    const MARGIN = 4;

    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (typeof p.left !== 'number' || typeof p.top !== 'number') return null;
        return p;
      } catch (_e) { return null; }
    }
    function save(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_e) {} }
    function clear() { try { localStorage.removeItem(KEY); } catch (_e) {} }

    function clamp(dock, left, top) {
      const r = dock.getBoundingClientRect();
      const maxL = Math.max(MARGIN, window.innerWidth  - r.width  - MARGIN);
      const maxT = Math.max(MARGIN, window.innerHeight - r.height - MARGIN);
      return {
        left: Math.min(Math.max(MARGIN, left), maxL),
        top:  Math.min(Math.max(MARGIN, top),  maxT),
      };
    }

    function applyPos(dock, p) {
      if (!p) {
        dock.classList.remove('is-floating');
        dock.style.left = '';
        dock.style.top  = '';
        return;
      }
      const c = clamp(dock, p.left, p.top);
      dock.classList.add('is-floating');
      dock.style.left = c.left + 'px';
      dock.style.top  = c.top  + 'px';
    }

    function bind(scope) {
      const container = (scope && scope.querySelector) ? scope : document;
      const dock = container.querySelector('[data-tsh-floatdock]');
      if (!dock || dock.dataset.tshFloatdockBound === '1') return;
      dock.dataset.tshFloatdockBound = '1';

      const handle = dock.querySelector('[data-tsh-floatdock-handle]');
      const saved = load();
      if (saved) applyPos(dock, saved);

      let dragging = false;
      let pid = null;
      let startX = 0, startY = 0;
      let baseL = 0, baseT = 0;

      function onDown(ev) {
        // Left mouse / primary pointer only.
        if (ev.button != null && ev.button !== 0) return;
        const r = dock.getBoundingClientRect();
        baseL = r.left; baseT = r.top;
        startX = ev.clientX; startY = ev.clientY;
        dragging = true;
        pid = ev.pointerId;
        dock.classList.add('is-dragging');
        try { handle.setPointerCapture(pid); } catch (_e) {}
        ev.preventDefault();
      }
      function onMove(ev) {
        if (!dragging) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        applyPos(dock, { left: baseL + dx, top: baseT + dy });
      }
      function onUp(ev) {
        if (!dragging) return;
        dragging = false;
        dock.classList.remove('is-dragging');
        try { if (pid != null) handle.releasePointerCapture(pid); } catch (_e) {}
        pid = null;
        // Persist final clamped position.
        const r = dock.getBoundingClientRect();
        save({ left: r.left, top: r.top });
      }

      handle.addEventListener('pointerdown', onDown);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup',   onUp);
      handle.addEventListener('pointercancel', onUp);

      // Double-click handle → reset to default bottom-right corner.
      handle.addEventListener('dblclick', (e) => {
        e.preventDefault();
        clear();
        applyPos(dock, null);
      });

      // Re-clamp on viewport resize so the dock stays on-screen.
      window.addEventListener('resize', () => {
        const p = load();
        if (p) applyPos(dock, p);
      });
    }

    return { bind };
  })();

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
      // Wait for config too so we can AND role checks with feature flags.
      const pCfg = root.Flags.ready ? root.Flags.ready().catch(() => null) : Promise.resolve(null);
      const pWho = root.Flags.whoami(true);
      return Promise.all([pCfg, pWho]).then(([_c, who]) => {
        // Role-gated nav links: visible only if the user's role is high enough
        // AND the optional feature flag (if any) is on.
        for (const a of document.querySelectorAll('[data-tsh-role-link]')) {
          const need = a.getAttribute('data-tsh-role-link');
          const flag = a.getAttribute('data-tsh-feature');
          const roleOk = root.Flags.isAtLeast(who.primary, need);
          const flagOk = !flag || root.Flags.on(flag);
          a.hidden = !(roleOk && flagOk);
        }
        // Pure feature-gated nav links (no role requirement) — e.g. Board.
        for (const a of document.querySelectorAll('a[data-tsh-feature]:not([data-tsh-role-link])')) {
          const flag = a.getAttribute('data-tsh-feature');
          a.hidden = !root.Flags.on(flag);
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
    ThemeSwitcher.bind(document);
    FloatDock.bind(document);
    MyReports.refreshBadge();
  }

  // MyReports: lightweight per-device memory of tickets the visitor filed
  // on this browser. No PII; just the ticket id + timestamp. The header
  // badge stays hidden until at least one ticket is recorded, so first-time
  // visitors see no extra UI.
  const MyReports = (function () {
    const KEY = 'tsh_my_tickets';
    const CAP = 20;
    function readSafe() {
      try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; }
      catch (_e) { return []; }
    }
    function writeSafe(arr) {
      try { localStorage.setItem(KEY, JSON.stringify(arr.slice(-CAP))); } catch (_e) { /* quota */ }
    }
    function add(id) {
      if (!id) return;
      const now = new Date().toISOString();
      const cur = readSafe().filter((e) => e && e.id !== id);
      cur.push({ id, ts: now });
      writeSafe(cur);
      refreshBadge();
    }
    function list() { return readSafe().slice().reverse(); }   // newest first
    function ids()  { return list().map((e) => e.id); }
    function count() { return readSafe().length; }
    function clear() { try { localStorage.removeItem(KEY); } catch (_e) { /* ignore */ } refreshBadge(); }
    function refreshBadge() {
      const link = document.querySelector('[data-tsh-myreports]');
      if (!link) return;
      const n = count();
      const c = link.querySelector('[data-tsh-myreports-count]');
      if (c) c.textContent = n ? `(${n})` : '';
      link.hidden = n === 0;
    }
    return { add, list, ids, count, clear, refreshBadge };
  })();

  // PhotoTray: client-side resize + thumbnail grid for the report form.
  // - Reads File objects, downscales to maxDim, encodes as JPEG at quality.
  // - Renders a live grid of thumbnails with per-item delete.
  // - Owner reads selected photos via .photos() which returns
  //   [{ dataUrl, name }] ready to POST inline with the issue create call.
  // The native <input type="file"> stays in the form for accessibility
  // and mobile camera capture, but its FileList is NOT what we submit;
  // we own the processed list.
  const PhotoTray = (function () {
    function create({ input, tray, max = 6, maxDim = 1600, quality = 0.85, onChange }) {
      const items = [];   // [{ dataUrl, name, w, h, bytes }]

      async function processFile(file) {
        if (!/^image\//.test(file.type)) throw new Error(`${file.name}: not an image`);
        const bmp = await readImage(file);
        const { canvas, w, h } = downscale(bmp, maxDim);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        return { dataUrl, name: file.name || `photo-${items.length + 1}.jpg`, w, h, bytes: estimateBytes(dataUrl) };
      }

      async function add(files) {
        const list = Array.from(files || []);
        for (const f of list) {
          if (items.length >= max) { toast(`Max ${max} photos`, { kind: 'warn' }); break; }
          try { items.push(await processFile(f)); }
          catch (err) { toast(err.message || 'Image error', { kind: 'danger' }); }
        }
        input.value = '';   // allow re-selecting the same file
        render();
        if (onChange) onChange(items.slice());
      }
      function removeAt(i) { items.splice(i, 1); render(); if (onChange) onChange(items.slice()); }
      function clear()     { items.length = 0; render(); if (onChange) onChange(items.slice()); }
      function photos()    { return items.map((p) => ({ dataUrl: p.dataUrl, name: p.name })); }
      function count()     { return items.length; }

      function render() {
        tray.innerHTML = '';
        if (!items.length) { tray.hidden = true; return; }
        tray.hidden = false;
        items.forEach((p, i) => {
          const thumb = el('div', { class: 'tsh-photo-thumb' },
            el('img', { src: p.dataUrl, alt: p.name }),
            el('button', {
              type: 'button', class: 'tsh-photo-thumb-x',
              title: `Remove ${p.name}`, 'aria-label': `Remove ${p.name}`,
              onclick: () => removeAt(i),
            }, '×'));
          tray.appendChild(thumb);
        });
      }

      input.addEventListener('change', (e) => add(e.target.files));
      return { add, removeAt, clear, photos, count };
    }

    function readImage(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name}: decode failed`)); };
        img.src = url;
      });
    }
    function downscale(img, maxDim) {
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return { canvas: c, w, h };
    }
    function estimateBytes(dataUrl) {
      const i = dataUrl.indexOf(','); if (i < 0) return 0;
      const b64 = dataUrl.slice(i + 1);
      const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
      return Math.floor((b64.length * 3) / 4) - pad;
    }
    return { create };
  })();

  // Shared bottom-left help tip. Same widget settings.html and manage.html
  // share to surface short context-sensitive help without modal blocking.
  // Anchor is optional but useful for toggle-off-on-same-click and
  // aria-expanded tracking on the trigger element.
  const Tip = (function () {
    let root_, titleEl, bodyEl, closeBtn, anchor;
    function ensure() {
      if (root_) return root_;
      root_ = document.createElement('aside');
      root_.className = 'tsh-tip';
      root_.id = 'tshTip';
      root_.setAttribute('role', 'dialog');
      root_.setAttribute('aria-live', 'polite');
      root_.setAttribute('aria-labelledby', 'tshTipTitle');
      root_.hidden = true;
      root_.innerHTML =
        '<header class="tsh-tip-head">' +
        '  <h3 class="tsh-tip-title" id="tshTipTitle"></h3>' +
        '  <button type="button" class="tsh-tip-close" aria-label="Close help">' +
        '    <i class="fas fa-xmark" aria-hidden="true"></i>' +
        '  </button>' +
        '</header>' +
        '<div class="tsh-tip-body" id="tshTipBody"></div>';
      document.body.appendChild(root_);
      titleEl  = root_.querySelector('.tsh-tip-title');
      bodyEl   = root_.querySelector('.tsh-tip-body');
      closeBtn = root_.querySelector('.tsh-tip-close');
      closeBtn.addEventListener('click', hide);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && root_ && !root_.hidden) {
          const prev = anchor;
          hide();
          if (prev) { try { prev.focus(); } catch (_e) {} }
        }
      });
      return root_;
    }
    function show(title, html, anchorEl) {
      ensure();
      // Toggle off when called twice for the same anchor.
      if (anchorEl && anchor === anchorEl && !root_.hidden) { hide(); return; }
      if (anchor && anchor !== anchorEl) {
        try { anchor.setAttribute('aria-expanded', 'false'); } catch (_e) {}
      }
      titleEl.textContent = title || '';
      bodyEl.innerHTML = html || '';
      root_.hidden = false;
      root_.classList.add('is-open');
      anchor = anchorEl || null;
      if (anchor) { try { anchor.setAttribute('aria-expanded', 'true'); } catch (_e) {} }
    }
    function hide() {
      if (!root_) return;
      root_.classList.remove('is-open');
      root_.hidden = true;
      if (anchor) {
        try { anchor.setAttribute('aria-expanded', 'false'); } catch (_e) {}
        anchor = null;
      }
    }
    function isOpen() { return !!(root_ && !root_.hidden); }
    return { show, hide, isOpen };
  })();

  // ----- busyButton: standard "saving…" affordance for any async click ----
  // Usage:  UI.busyButton(btnEl, async () => { await Api.put(...); }, { label: 'Saving\u2026' });
  // While the asyncFn runs the button is disabled, swapped for a spinner,
  // and shows opts.label (or the existing aria-busy fallback). Original
  // contents are restored when the promise settles, regardless of outcome.
  async function busyButton(btn, asyncFn, opts) {
    if (!btn) return asyncFn ? asyncFn() : undefined;
    const label = (opts && opts.label) || 'Saving\u2026';
    const original = btn.innerHTML;
    const wasDisabled = btn.disabled;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>${label}</span>`;
    try {
      return await asyncFn();
    } finally {
      btn.innerHTML = original;
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
      btn.disabled = wasDisabled;
    }
  }

  // ----- FilterBar: unified "All + dropdown + Go" filter widget --------
  // Usage:
  //   const fb = UI.FilterBar(hostEl, {
  //     label: 'Category',
  //     options: ['Plumber', { value: 'elec', label: 'Electrician' }],
  //     value: '',                  // '' = All
  //     onApply: (val) => render(val),
  //   });
  //   fb.setOptions([...]); fb.setValue('Plumber'); fb.getValue();
  // Builds a label + native <select> (with an "All" first option) + Go
  // button, and only invokes onApply when Go is pressed (or on Enter).
  function FilterBar(host, opts) {
    if (!host) return null;
    host.innerHTML = '';
    host.classList.add('tsh-filterbar');
    const labelText = opts && opts.label ? opts.label : 'Filter';
    const allLabel  = opts && opts.allLabel ? opts.allLabel : 'All';
    const goLabel   = opts && opts.goLabel ? opts.goLabel : 'Go';
    const onApply   = (opts && typeof opts.onApply === 'function') ? opts.onApply : () => {};

    const lab = document.createElement('label');
    lab.className = 'tsh-filterbar-label';
    lab.textContent = labelText;

    const sel = document.createElement('select');
    sel.className = 'tsh-filterbar-select';
    const id = `tsh-fb-${Math.random().toString(36).slice(2, 8)}`;
    sel.id = id; lab.setAttribute('for', id);

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'tsh-btn tsh-btn-primary tsh-filterbar-go';
    go.textContent = goLabel;

    host.append(lab, sel, go);

    const buildOptions = (list, current) => {
      sel.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = allLabel;
      sel.appendChild(allOpt);
      for (const item of (list || [])) {
        const opt = document.createElement('option');
        if (typeof item === 'string') { opt.value = item; opt.textContent = item; }
        else { opt.value = item.value; opt.textContent = item.label || item.value; }
        sel.appendChild(opt);
      }
      sel.value = current != null ? current : '';
    };

    buildOptions(opts && opts.options, opts && opts.value);

    const apply = () => onApply(sel.value);
    go.addEventListener('click', apply);
    sel.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });

    return {
      setOptions: (list) => buildOptions(list, sel.value),
      setValue: (v) => { sel.value = v != null ? v : ''; },
      getValue: () => sel.value,
      apply,
      el: host,
    };
  }

  root.UI = {
    el, $, toast, modal, confirmModal, formatRel, copyToClipboard,
    statusPill, statusText, severityPill, bindHeader,
    stateLoading, stateEmpty, stateError, busyButton, FilterBar,
    Lightbox, FontSize, ThemeSwitcher, FloatDock, Draft, MyReports, PhotoTray, Tip,
  };
})(window);

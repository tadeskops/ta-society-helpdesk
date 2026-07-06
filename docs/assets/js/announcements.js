// Admin-toggled announcements section.
// - Announcements.mountList(host) — read-only list card. No-op if flag off.
// - Announcements.mountEditor(host) — MANAGER+ editor. No-op if flag off.
(function (root) {
  'use strict';

  async function fetchList() {
    try {
      const res = await Api.get('/announcements');
      return Array.isArray(res && res.items) ? res.items : [];
    } catch (_e) {
      return [];
    }
  }

  function isActive(it, now) {
    if (!it) return false;
    if (it.expiresAt) {
      const t = Date.parse(it.expiresAt);
      if (Number.isFinite(t) && t < now) return false;
    }
    return true;
  }

  function mountList(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_ANNOUNCEMENTS')) { host.hidden = true; return; }
    host.classList.add('tsh-ann-list');
    fetchList().then((rawItems) => {
      // Worker already filters expired, but the client also filters to
      // cover any stale cached response from a previous TTL.
      const now = Date.now();
      let items = rawItems.filter((it) => isActive(it, now));
      if (!items.length) { host.hidden = true; return; }
      host.hidden = false;
      // Sort: pinned first, then newest by createdAt.
      items = items.slice().sort((a, b) => {
        if ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) !== 0) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      });

      // Item 8: rotating single-card carousel mirroring the banner widget.
      // Two stacked layers crossfade so the text never reflows mid-rotation.
      // Auto-rotation pauses on hover, keyboard focus, tab blur, or when the
      // panel scrolls out of the viewport. Reduced-motion users see all
      // items stacked vertically (no rotation, no transition).
      const ROTATE_MS = 8000;
      const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // Build chrome (header + stage + controls).
      host.innerHTML = '';
      host.classList.add('tsh-ann-panel');

      const head = document.createElement('header');
      head.className = 'tsh-ann-panel-head';
      head.innerHTML = '<h2 class="tsh-ann-list-title"><i class="fas fa-newspaper" aria-hidden="true"></i> Announcements</h2>';
      const counter = document.createElement('span');
      counter.className = 'tsh-ann-counter';
      counter.setAttribute('aria-live', 'polite');
      head.appendChild(counter);
      host.appendChild(head);

      // Reduced-motion → stacked list, no carousel.
      if (reduceMotion || items.length === 1) {
        const list = document.createElement('div');
        list.className = 'tsh-ann-list-cards';
        items.forEach((it) => list.appendChild(cardEl(it)));
        host.appendChild(list);
        counter.textContent = items.length > 1 ? `${items.length} items` : '';
        return;
      }

      const stage = document.createElement('div');
      stage.className = 'tsh-ann-stage';
      const layerA = document.createElement('div');
      const layerB = document.createElement('div');
      layerA.className = 'tsh-ann-layer is-active';
      layerB.className = 'tsh-ann-layer';
      stage.append(layerA, layerB);
      host.appendChild(stage);

      const controls = document.createElement('div');
      controls.className = 'tsh-ann-controls';
      const prev = document.createElement('button');
      prev.type = 'button'; prev.className = 'tsh-ann-nav'; prev.setAttribute('aria-label', 'Previous announcement');
      prev.innerHTML = '<i class="fas fa-chevron-left" aria-hidden="true"></i>';
      const next = document.createElement('button');
      next.type = 'button'; next.className = 'tsh-ann-nav'; next.setAttribute('aria-label', 'Next announcement');
      next.innerHTML = '<i class="fas fa-chevron-right" aria-hidden="true"></i>';
      const dots = document.createElement('div');
      dots.className = 'tsh-ann-dots';
      const dotEls = items.map((_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tsh-ann-dot';
        b.setAttribute('aria-label', `Show announcement ${i + 1} of ${items.length}`);
        b.addEventListener('click', () => { goTo(i); restartTimer(); });
        dots.appendChild(b);
        return b;
      });
      controls.append(prev, dots, next);
      host.appendChild(controls);

      // State.
      let idx = 0;
      let active = layerA;
      let back = layerB;
      let timer = null;
      let paused = false;

      fillLayer(active, items[0]);
      updateChrome();

      function fillLayer(el, it) { el.innerHTML = ''; el.appendChild(cardEl(it)); }
      function updateChrome() {
        counter.textContent = `${idx + 1} / ${items.length}`;
        dotEls.forEach((d, i) => d.classList.toggle('is-active', i === idx));
      }
      function goTo(targetIdx) {
        const n = items.length;
        const t = ((targetIdx % n) + n) % n;
        if (t === idx) return;
        fillLayer(back, items[t]);
        // Force reflow so the transition runs from the new starting state.
        // eslint-disable-next-line no-unused-expressions
        back.offsetWidth;
        back.classList.add('is-active');
        active.classList.remove('is-active');
        const tmp = active; active = back; back = tmp;
        idx = t;
        updateChrome();
      }
      function tick() { if (!paused) goTo(idx + 1); }
      function startTimer() { stopTimer(); timer = setInterval(tick, ROTATE_MS); }
      function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
      function restartTimer() { startTimer(); }

      prev.addEventListener('click', () => { goTo(idx - 1); restartTimer(); });
      next.addEventListener('click', () => { goTo(idx + 1); restartTimer(); });

      // Pause on hover/focus.
      host.addEventListener('mouseenter', () => { paused = true; });
      host.addEventListener('mouseleave', () => { paused = false; });
      host.addEventListener('focusin',    () => { paused = true; });
      host.addEventListener('focusout',   () => { paused = false; });
      // Pause when tab not visible.
      document.addEventListener('visibilitychange', () => { paused = document.hidden; });
      // Pause when out of viewport (saves CPU on long pages).
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) paused = !e.isIntersecting;
        }, { threshold: 0.2 });
        io.observe(host);
      }

      startTimer();
    });
  }

  function cardEl(it) {
    const article = document.createElement('article');
    article.className = 'tsh-ann-card' + (it.pinned ? ' is-pinned' : '');
    const head = document.createElement('header');
    head.className = 'tsh-ann-card-head';
    if (it.pinned) {
      const pin = document.createElement('i');
      pin.className = 'fas fa-thumbtack tsh-ann-pin';
      pin.setAttribute('aria-label', 'Pinned');
      head.appendChild(pin);
    }
    const h3 = document.createElement('h3');
    h3.textContent = it.title || '';
    head.appendChild(h3);
    const time = document.createElement('time');
    time.className = 'tsh-ann-card-time';
    time.textContent = it.createdAt ? new Date(it.createdAt).toLocaleDateString() : '';
    head.appendChild(time);
    article.appendChild(head);
    const body = document.createElement('div');
    body.className = 'tsh-ann-card-body';
    body.innerHTML = escapeHtml(it.body || '').replace(/\n/g, '<br>');
    article.appendChild(body);
    // Subtle "expires in N days" footer so residents know how long it stays.
    if (it.expiresAt) {
      const t = Date.parse(it.expiresAt);
      if (Number.isFinite(t)) {
        const days = Math.max(0, Math.ceil((t - Date.now()) / (24 * 60 * 60 * 1000)));
        const foot = document.createElement('div');
        foot.className = 'tsh-ann-card-exp';
        foot.innerHTML = '<i class="fas fa-hourglass-half" aria-hidden="true"></i>' +
          (days <= 1 ? 'Expires soon' : `Expires in ${days} days`);
        article.appendChild(foot);
      }
    }
    return article;
  }

  async function mountEditor(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_ANNOUNCEMENTS')) { host.hidden = true; return; }
    host.classList.add('tsh-ann-editor');
    host.innerHTML = '<p class="tsh-text-muted">Loading announcements…</p>';
    let items = [];
    try {
      const res = await Api.get('/announcements');
      items = Array.isArray(res && res.items) ? res.items.slice() : [];
    } catch (_e) { items = []; }
    render();

    function render() {
      host.innerHTML = '';
      const title = document.createElement('h3');
      title.innerHTML = '<i class="fas fa-newspaper"></i> Manage announcements';
      title.className = 'tsh-ann-editor-title';
      host.appendChild(title);

      const help = document.createElement('p');
      help.className = 'tsh-text-muted tsh-text-sm';
      help.textContent = 'If you leave the "Expires" date blank, the announcement auto-hides after 1 week. Past-expiry items are pruned on save.';
      host.appendChild(help);

      const list = document.createElement('ul');
      list.className = 'tsh-ann-editor-rows';
      items.forEach((it, idx) => list.appendChild(rowEl(it, idx)));
      host.appendChild(list);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      addBtn.innerHTML = '<i class="fas fa-plus"></i>Add announcement';
      addBtn.addEventListener('click', () => {
        items.push({ title: '', body: '', pinned: false });
        render();
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'tsh-btn tsh-btn-primary';
      saveBtn.innerHTML = '<i class="fas fa-save"></i>Save announcements';
      saveBtn.addEventListener('click', () => {
        UI.busyButton(saveBtn, async () => {
          const clean = items.filter((it) => (it.title || '').trim() && (it.body || '').trim());
          try {
            await Api.put('/announcements', { announcements: { version: 1, items: clean } });
            items = clean.slice();
            UI.toast('Announcements saved.', { kind: 'success' });
            render();
          } catch (e) {
            UI.toast('Could not save announcements.', { kind: 'danger' });
            console.error(e);
            throw e;
          }
        }, { label: 'Saving…' });
      });

      const bar = document.createElement('div');
      bar.className = 'tsh-ann-editor-actions';
      bar.append(addBtn, saveBtn);
      host.appendChild(bar);
    }

    function rowEl(it, idx) {
      const li = document.createElement('li');
      li.className = 'tsh-ann-editor-row';

      const titleIn = document.createElement('input');
      titleIn.type = 'text';
      titleIn.maxLength = 160;
      titleIn.placeholder = 'Title (max 160 chars)';
      titleIn.value = it.title || '';
      titleIn.addEventListener('input', () => { items[idx].title = titleIn.value; });

      const bodyIn = document.createElement('textarea');
      bodyIn.rows = 4;
      bodyIn.maxLength = 4000;
      bodyIn.placeholder = 'Body (max 4000 chars)';
      bodyIn.value = it.body || '';
      bodyIn.addEventListener('input', () => { items[idx].body = bodyIn.value; });

      const pinLabel = document.createElement('label');
      pinLabel.className = 'tsh-ann-editor-pin';
      const pinIn = document.createElement('input');
      pinIn.type = 'checkbox';
      pinIn.checked = !!it.pinned;
      pinIn.addEventListener('change', () => { items[idx].pinned = pinIn.checked; });
      pinLabel.append(pinIn, document.createTextNode(' Pin to top'));

      const expWrap = document.createElement('label');
      expWrap.className = 'tsh-ann-editor-exp';
      expWrap.innerHTML = '<span class="tsh-label">Expires</span>';
      const expIn = document.createElement('input');
      expIn.type = 'date';
      expIn.value = it.expiresAt ? new Date(it.expiresAt).toISOString().slice(0, 10) : '';
      expIn.title = 'Leave blank to auto-expire 1 week from now';
      expIn.addEventListener('change', () => {
        items[idx].expiresAt = expIn.value ? new Date(expIn.value + 'T23:59:59Z').toISOString() : undefined;
      });
      expWrap.appendChild(expIn);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      del.innerHTML = '<i class="fas fa-trash"></i>';
      del.setAttribute('aria-label', 'Delete this announcement');
      del.addEventListener('click', () => { items.splice(idx, 1); render(); });

      const rowActions = document.createElement('div');
      rowActions.className = 'tsh-ann-editor-row-actions';
      rowActions.append(pinLabel, expWrap, del);

      li.append(titleIn, bodyIn, rowActions);
      return li;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  root.Announcements = { mountList, mountEditor };
})(window);

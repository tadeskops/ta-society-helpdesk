// Manager-curated banner widget.
// - Banner.mountStrip(host)   — rotating top strip (one item visible at a
//   time, advances every ~6s with fade).
// - Banner.mountList(host)    — stacked list panel (all active items).
// - Banner.mountEditor(host)  — manage UI (add/edit/delete items, save).
//
// Reads /banner. Filters out expired items client-side. All three mounts
// are no-ops when FEATURE_DAILY_BANNER is off.
(function (root) {
  'use strict';

  const ROTATE_MS = 6000;
  const SEVERITY_ICON = { info: 'fa-circle-info', warn: 'fa-triangle-exclamation', alert: 'fa-bell' };

  function isActive(it) {
    if (!it || !it.text) return false;
    if (it.expiresAt) {
      const t = Date.parse(it.expiresAt);
      if (!Number.isNaN(t) && t < Date.now()) return false;
    }
    return true;
  }

  async function fetchItems() {
    try {
      const res = await Api.get('/banner');
      const items = (res && res.items) || [];
      return items.filter(isActive);
    } catch (_e) {
      return [];
    }
  }

  function mountStrip(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_BANNER')) { host.hidden = true; return; }
    host.classList.add('tsh-banner-strip');
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'true');
    host.hidden = true;

    fetchItems().then((items) => {
      if (!items.length) return;
      host.hidden = false;

      // Two stacked layers (occupy same grid cell) crossfade between items;
      // we never swap innerHTML on the visible layer mid-animation. The
      // screen-reader copy is updated separately so AT announces each item
      // without being spammed by animated nodes.
      const stage = document.createElement('div');
      stage.className = 'tsh-banner-stage';
      const layerA = document.createElement('div');
      const layerB = document.createElement('div');
      layerA.className = 'tsh-banner-layer is-active is-sev-info';
      layerB.className = 'tsh-banner-layer is-sev-info';
      layerA.setAttribute('aria-hidden', 'true');
      layerB.setAttribute('aria-hidden', 'true');
      stage.append(layerA, layerB);

      const dots = document.createElement('div');
      dots.className = 'tsh-banner-dots';
      dots.setAttribute('aria-hidden', 'true');

      const sr = document.createElement('span');
      sr.className = 'tsh-visually-hidden';

      host.innerHTML = '';
      host.append(stage, dots, sr);

      let i = 0;
      let front = layerA;
      let back = layerB;

      const fillLayer = (el, it) => {
        const sev = it.severity || 'info';
        const icon = SEVERITY_ICON[sev] || SEVERITY_ICON.info;
        const body = `<i class="fas ${icon} tsh-banner-icon" aria-hidden="true"></i>` +
          `<span class="tsh-banner-text">${escapeHtml(it.text)}</span>`;
        el.classList.remove('is-sev-info', 'is-sev-warn', 'is-sev-alert');
        el.classList.add(`is-sev-${sev}`);
        el.innerHTML = it.href
          ? `<a class="tsh-banner-inner" href="${escapeAttr(it.href)}" target="_blank" rel="noopener">${body}</a>`
          : `<div class="tsh-banner-inner">${body}</div>`;
      };

      const renderDots = () => {
        if (items.length <= 1) { dots.hidden = true; return; }
        dots.innerHTML = items
          .map((_, idx) => `<span class="tsh-banner-dot${idx === i ? ' is-active' : ''}"></span>`)
          .join('');
      };

      // Initial paint on the front layer only.
      fillLayer(front, items[i]);
      sr.textContent = items[i].text;
      renderDots();

      if (items.length <= 1) return;

      const advance = () => {
        i = (i + 1) % items.length;
        fillLayer(back, items[i]);
        sr.textContent = items[i].text;
        // Force browser to commit the back layer's content before toggling
        // is-active so the crossfade transition actually plays.
        // eslint-disable-next-line no-unused-expressions
        back.offsetWidth;
        back.classList.add('is-active');
        front.classList.remove('is-active');
        const tmp = front; front = back; back = tmp;
        renderDots();
      };

      let timer = null;
      let paused = false;
      let visible = true;
      const start = () => {
        if (timer || paused || !visible) return;
        timer = setInterval(advance, ROTATE_MS);
      };
      const stop = () => {
        if (timer) { clearInterval(timer); timer = null; }
      };

      // Pause on user attention (hover / keyboard focus).
      host.addEventListener('mouseenter', () => { paused = true; stop(); });
      host.addEventListener('mouseleave', () => { paused = false; start(); });
      host.addEventListener('focusin', () => { paused = true; stop(); });
      host.addEventListener('focusout', () => { paused = false; start(); });

      // Pause when tab hidden.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop(); else start();
      });

      // Pause when the banner scrolls off screen.
      if ('IntersectionObserver' in root) {
        const io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            visible = e.isIntersecting;
            if (visible) start(); else stop();
          }
        }, { threshold: 0.01 });
        io.observe(host);
      } else {
        start();
      }
    });
  }

  function mountList(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_BANNER')) { host.hidden = true; return; }
    host.classList.add('tsh-banner-list');
    fetchItems().then((items) => {
      if (!items.length) { host.hidden = true; return; }
      host.hidden = false;
      const head = `<h3 class="tsh-banner-list-title"><i class="fas fa-bullhorn" aria-hidden="true"></i> Notices</h3>`;
      const rows = items.map((it) => {
        const sev = it.severity || 'info';
        const icon = SEVERITY_ICON[sev] || SEVERITY_ICON.info;
        const meta = it.expiresAt ? `<small class="tsh-banner-list-meta">until ${escapeHtml(new Date(it.expiresAt).toLocaleDateString())}</small>` : '';
        const inner = `<i class="fas ${icon}" aria-hidden="true"></i> <span>${escapeHtml(it.text)}</span> ${meta}`;
        return it.href
          ? `<li class="is-sev-${sev}"><a href="${escapeAttr(it.href)}" target="_blank" rel="noopener">${inner}</a></li>`
          : `<li class="is-sev-${sev}">${inner}</li>`;
      }).join('');
      host.innerHTML = `${head}<ul class="tsh-banner-list-items">${rows}</ul>`;
    });
  }

  // Manage UI for banner items. Loads /banner, renders a tiny editor with
  // an add row, a list of existing rows (text + severity + expiry + delete),
  // and a Save button that PUTs the new list. RBAC-enforced server-side.
  async function mountEditor(host) {
    if (!host) return;
    host.classList.add('tsh-banner-editor');
    host.innerHTML = '<p class="tsh-text-muted">Loading banner items…</p>';
    let items = [];
    try {
      const res = await Api.get('/banner');
      items = Array.isArray(res && res.items) ? res.items.slice() : [];
    } catch (_e) {
      items = [];
    }
    render();

    function render() {
      host.innerHTML = '';
      const title = document.createElement('h3');
      title.innerHTML = '<i class="fas fa-bullhorn"></i> Manage banner';
      title.className = 'tsh-banner-editor-title';
      host.appendChild(title);

      const list = document.createElement('ul');
      list.className = 'tsh-banner-editor-rows';
      items.forEach((it, idx) => list.appendChild(rowEl(it, idx)));
      host.appendChild(list);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      addBtn.innerHTML = '<i class="fas fa-plus"></i>Add item';
      addBtn.addEventListener('click', () => {
        items.push({ text: '', severity: 'info' });
        render();
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'tsh-btn tsh-btn-primary';
      saveBtn.innerHTML = '<i class="fas fa-save"></i>Save banner';
      saveBtn.addEventListener('click', () => {
        UI.busyButton(saveBtn, async () => {
          // Strip blanks before sending.
          const clean = items.filter((it) => (it.text || '').trim());
          try {
            await Api.put('/banner', { banner: { version: 1, items: clean } });
            items = clean.slice();
            UI.toast('Banner saved.', { kind: 'success' });
            render();
          } catch (e) {
            UI.toast('Could not save banner.', { kind: 'danger' });
            console.error(e);
            throw e;
          }
        }, { label: 'Saving banner…' });
      });

      const bar = document.createElement('div');
      bar.className = 'tsh-banner-editor-actions';
      bar.append(addBtn, saveBtn);
      host.appendChild(bar);
    }

    function rowEl(it, idx) {
      const li = document.createElement('li');
      li.className = 'tsh-banner-editor-row';

      const txt = document.createElement('input');
      txt.type = 'text';
      txt.maxLength = 240;
      txt.placeholder = 'Notice text (max 240 chars)';
      txt.value = it.text || '';
      txt.addEventListener('input', () => { items[idx].text = txt.value; });

      const sev = document.createElement('select');
      for (const v of [['info', 'Info'], ['warn', 'Warning'], ['alert', 'Alert']]) {
        const opt = document.createElement('option');
        opt.value = v[0]; opt.textContent = v[1];
        sev.appendChild(opt);
      }
      sev.value = it.severity || 'info';
      sev.addEventListener('change', () => { items[idx].severity = sev.value; });

      const exp = document.createElement('input');
      exp.type = 'date';
      exp.value = it.expiresAt ? new Date(it.expiresAt).toISOString().slice(0, 10) : '';
      exp.addEventListener('change', () => {
        items[idx].expiresAt = exp.value ? new Date(exp.value + 'T23:59:59Z').toISOString() : undefined;
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      del.innerHTML = '<i class="fas fa-trash"></i>';
      del.setAttribute('aria-label', 'Delete this banner item');
      del.addEventListener('click', () => { items.splice(idx, 1); render(); });

      li.append(txt, sev, exp, del);
      return li;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  root.Banner = { mountStrip, mountList, mountEditor };
})(window);

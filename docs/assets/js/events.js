// Upcoming events panel.
// - Events.mountList(host)   — resident-facing list (no-op when flag off).
// - Events.mountEditor(host) — MANAGER+ editor (no-op when flag off).
//
// Mirrors the announcements module shape so layout + theming feel
// consistent. Items are auto-pruned server-side after expiry; this client
// also filters in case the read is cached. Default expiry is the day
// after the event (set by the worker). Editor lets the user override.
(function (root) {
  'use strict';

  function isActive(it, now) {
    if (!it) return false;
    if (it.expiresAt) {
      const t = Date.parse(it.expiresAt);
      if (Number.isFinite(t) && t < now) return false;
    }
    return true;
  }

  async function fetchItems() {
    try {
      const res = await Api.get('/events');
      return Array.isArray(res && res.items) ? res.items : [];
    } catch (_e) { return []; }
  }

  function fmtWhen(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
    return d.toLocaleString(undefined, opts);
  }

  function relWhen(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const diff = t - Date.now();
    const day = 24 * 60 * 60 * 1000;
    if (diff < 0) return 'now';
    if (diff < day) return 'today';
    if (diff < 2 * day) return 'tomorrow';
    if (diff < 7 * day) return `in ${Math.round(diff / day)} days`;
    return 'this month';
  }

  function cardEl(it) {
    const article = document.createElement('article');
    article.className = 'tsh-event-card';

    const when = document.createElement('div');
    when.className = 'tsh-event-when';
    const dayBadge = document.createElement('div');
    dayBadge.className = 'tsh-event-daybadge';
    const t = Date.parse(it.eventAt);
    if (Number.isFinite(t)) {
      const d = new Date(t);
      const mon = d.toLocaleString(undefined, { month: 'short' });
      dayBadge.innerHTML = `<span class="tsh-event-daybadge-mon">${escapeHtml(mon)}</span>` +
                          `<span class="tsh-event-daybadge-day">${d.getDate()}</span>`;
    } else {
      dayBadge.textContent = '—';
    }
    when.appendChild(dayBadge);

    const body = document.createElement('div');
    body.className = 'tsh-event-body';
    const h3 = document.createElement('h3');
    h3.className = 'tsh-event-title';
    h3.textContent = it.title || '';
    body.appendChild(h3);

    const meta = document.createElement('p');
    meta.className = 'tsh-event-meta';
    const parts = [];
    if (it.eventAt) parts.push(fmtWhen(it.eventAt));
    if (it.location) parts.push(it.location);
    meta.textContent = parts.join(' · ');
    body.appendChild(meta);

    if (it.body) {
      const p = document.createElement('p');
      p.className = 'tsh-event-desc';
      p.textContent = it.body;
      body.appendChild(p);
    }

    if (it.href) {
      const a = document.createElement('a');
      a.className = 'tsh-event-link';
      a.href = it.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.innerHTML = '<i class="fas fa-up-right-from-square" aria-hidden="true"></i>Details';
      body.appendChild(a);

      // Whole-card click → open the event. Users were tapping the title
      // expecting it to redirect; only the tiny "Details" pill was
      // active. Now the entire card surface opens the href in a new
      // tab. Keyboard users get the same affordance via Enter/Space.
      article.classList.add('tsh-event-card--linked');
      article.tabIndex = 0;
      article.setAttribute('role', 'link');
      article.setAttribute('aria-label', `${it.title || 'Event'} — open details`);
      const open = (ev) => {
        // Don't double-open when the user already clicked the inner anchor.
        if (ev && ev.target && ev.target.closest && ev.target.closest('a')) return;
        window.open(it.href, '_blank', 'noopener');
      };
      article.addEventListener('click', open);
      article.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open(ev);
        }
      });
    }

    const rel = document.createElement('span');
    rel.className = 'tsh-event-rel';
    rel.textContent = relWhen(it.eventAt);
    body.appendChild(rel);

    article.append(when, body);
    return article;
  }

  // Keep the home-page "Upcoming Events" quick-tile visibility in sync
  // with whether the events section actually has anything to show.
  // Without this, the tile stays clickable even when every event is
  // expired → it scrolls to a hidden anchor and the click feels dead.
  //
  // We also stamp data-tsh-no-content on the tile so ui.js#refreshRoleLinks
  // (which runs on every auth-state flip and sets a.hidden purely from the
  // feature flag) does not race us into re-showing the tile while the
  // backing section is still hidden.
  function syncQuickTile(visible) {
    try {
      document.querySelectorAll('a[href="#tshEvents"]').forEach((tile) => {
        tile.hidden = !visible;
        if (visible) {
          delete tile.dataset.tshNoContent;
        } else {
          tile.dataset.tshNoContent = 'true';
        }
      });
    } catch (_e) { /* DOM may not be ready in unusual mount orders */ }
  }

  function mountList(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_EVENTS')) {
      host.hidden = true;
      syncQuickTile(false);
      return;
    }
    host.classList.add('tsh-event-panel');
    host.innerHTML = '<p class="tsh-text-muted"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading events…</p>';

    fetchItems().then((raw) => {
      const now = Date.now();
      const items = raw.filter((it) => isActive(it, now));
      host.innerHTML = '';
      if (!items.length) {
        // Hide the whole section on the home page when there's nothing
        // to show — mirrors the announcements panel behaviour. Also
        // hide the quick-tile so users don't click an anchor that goes
        // nowhere visible.
        host.hidden = true;
        syncQuickTile(false);
        return;
      }
      host.hidden = false;
      syncQuickTile(true);
      const list = document.createElement('div');
      list.className = 'tsh-event-list';
      items.forEach((it) => list.appendChild(cardEl(it)));
      host.appendChild(list);
    });
  }

  async function mountEditor(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_EVENTS')) { host.hidden = true; return; }
    host.classList.add('tsh-event-editor');
    host.innerHTML = '<p class="tsh-text-muted">Loading events…</p>';
    let items = [];
    try {
      const res = await Api.get('/events');
      items = Array.isArray(res && res.items) ? res.items.slice() : [];
    } catch (_e) { items = []; }
    render();

    function render() {
      host.innerHTML = '';
      const title = document.createElement('h3');
      title.innerHTML = '<i class="fas fa-calendar-days"></i> Manage upcoming events';
      title.className = 'tsh-event-editor-title';
      host.appendChild(title);

      const help = document.createElement('p');
      help.className = 'tsh-text-muted tsh-text-sm';
      help.textContent = 'If you leave the "Expires" date blank, the event auto-hides 1 day after it happens. Past-expiry items are pruned on save.';
      host.appendChild(help);

      const list = document.createElement('ul');
      list.className = 'tsh-event-editor-rows';
      items.forEach((it, idx) => list.appendChild(rowEl(it, idx)));
      host.appendChild(list);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      addBtn.innerHTML = '<i class="fas fa-plus"></i>Add event';
      addBtn.addEventListener('click', () => {
        items.push({ title: '', body: '', eventAt: defaultEventAt(), location: '' });
        render();
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'tsh-btn tsh-btn-primary';
      saveBtn.innerHTML = '<i class="fas fa-save"></i>Save events';
      saveBtn.addEventListener('click', () => {
        UI.busyButton(saveBtn, async () => {
          const clean = items.filter((it) => (it.title || '').trim() && (it.eventAt || '').trim());
          try {
            await Api.put('/events', { events: { version: 1, items: clean } });
            UI.toast('Events saved.', { kind: 'success' });
            // Refresh from server to pick up pruned items + default expiries.
            try {
              const res = await Api.get('/events');
              items = Array.isArray(res && res.items) ? res.items.slice() : [];
            } catch (_e) { /* keep local */ }
            render();
          } catch (e) {
            UI.toast('Could not save events.', { kind: 'danger' });
            console.error(e);
            throw e;
          }
        }, { label: 'Saving…' });
      });

      const bar = document.createElement('div');
      bar.className = 'tsh-event-editor-actions';
      bar.append(addBtn, saveBtn);
      host.appendChild(bar);
    }

    function rowEl(it, idx) {
      const li = document.createElement('li');
      li.className = 'tsh-event-editor-row';

      const titleIn = document.createElement('input');
      titleIn.type = 'text';
      titleIn.maxLength = 160;
      titleIn.placeholder = 'Title (max 160 chars)';
      titleIn.value = it.title || '';
      titleIn.addEventListener('input', () => { items[idx].title = titleIn.value; });

      const whenIn = document.createElement('input');
      whenIn.type = 'datetime-local';
      whenIn.value = toLocalDateTime(it.eventAt);
      whenIn.addEventListener('change', () => {
        items[idx].eventAt = whenIn.value ? new Date(whenIn.value).toISOString() : '';
      });

      const locIn = document.createElement('input');
      locIn.type = 'text';
      locIn.maxLength = 240;
      locIn.placeholder = 'Location (optional)';
      locIn.value = it.location || '';
      locIn.addEventListener('input', () => { items[idx].location = locIn.value; });

      const bodyIn = document.createElement('textarea');
      bodyIn.rows = 2;
      bodyIn.maxLength = 4000;
      bodyIn.placeholder = 'Description (optional)';
      bodyIn.value = it.body || '';
      bodyIn.addEventListener('input', () => { items[idx].body = bodyIn.value; });

      const expWrap = document.createElement('label');
      expWrap.className = 'tsh-event-editor-exp';
      expWrap.innerHTML = '<span class="tsh-label">Expires</span>';
      const expIn = document.createElement('input');
      expIn.type = 'date';
      expIn.value = it.expiresAt ? new Date(it.expiresAt).toISOString().slice(0, 10) : '';
      expIn.addEventListener('change', () => {
        items[idx].expiresAt = expIn.value ? new Date(expIn.value + 'T23:59:59Z').toISOString() : undefined;
      });
      expWrap.appendChild(expIn);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      del.innerHTML = '<i class="fas fa-trash"></i>';
      del.setAttribute('aria-label', 'Delete this event');
      del.addEventListener('click', () => { items.splice(idx, 1); render(); });

      const grid = document.createElement('div');
      grid.className = 'tsh-event-editor-row-grid';
      grid.append(titleIn, whenIn, locIn, expWrap, del);
      li.append(grid, bodyIn);
      return li;
    }

    function defaultEventAt() {
      // Default new event = tomorrow at 6 PM local.
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(18, 0, 0, 0);
      return d.toISOString();
    }

    function toLocalDateTime(iso) {
      if (!iso) return '';
      const t = Date.parse(iso);
      if (!Number.isFinite(t)) return '';
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  root.Events = { mountList, mountEditor };
})(window);

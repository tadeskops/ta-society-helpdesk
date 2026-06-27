// Developer-toggled announcements section.
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

  function mountList(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_ANNOUNCEMENTS')) { host.hidden = true; return; }
    host.classList.add('tsh-ann-list');
    fetchList().then((items) => {
      if (!items.length) { host.hidden = true; return; }
      host.hidden = false;
      // Pinned first, then by createdAt desc.
      items = items.slice().sort((a, b) => {
        if ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) !== 0) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      });
      const head = `<h2 class="tsh-ann-list-title"><i class="fas fa-newspaper"></i> Announcements</h2>`;
      const cards = items.map((it) => `
        <article class="tsh-ann-card${it.pinned ? ' is-pinned' : ''}">
          <header class="tsh-ann-card-head">
            ${it.pinned ? '<i class="fas fa-thumbtack tsh-ann-pin" aria-label="Pinned"></i>' : ''}
            <h3>${escapeHtml(it.title)}</h3>
            <time class="tsh-ann-card-time">${it.createdAt ? new Date(it.createdAt).toLocaleDateString() : ''}</time>
          </header>
          <div class="tsh-ann-card-body">${escapeHtml(it.body).replace(/\n/g, '<br>')}</div>
        </article>
      `).join('');
      host.innerHTML = `${head}<div class="tsh-ann-list-cards">${cards}</div>`;
    });
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

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      del.innerHTML = '<i class="fas fa-trash"></i>';
      del.setAttribute('aria-label', 'Delete this announcement');
      del.addEventListener('click', () => { items.splice(idx, 1); render(); });

      const rowActions = document.createElement('div');
      rowActions.className = 'tsh-ann-editor-row-actions';
      rowActions.append(pinLabel, del);

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

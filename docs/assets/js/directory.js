// docs/assets/js/directory.js
// Society directory — vendors, community contacts, resources.
// Reads /directory on load, lets MANAGER/COMMITTEE/DEVELOPER edit
// inline. Save commits the whole document (PUT /directory). Filter
// pills + search work locally on the loaded copy.
(function (root) {
  'use strict';

  const KIND_LABEL = {
    vendors:   { singular: 'vendor',   icon: 'fa-toolbox' },
    contacts:  { singular: 'contact',  icon: 'fa-users'   },
    resources: { singular: 'resource', icon: 'fa-link'    },
  };

  // Field schema per kind — drives form rendering + card rendering.
  const SCHEMA = {
    vendors: [
      { name: 'name',     label: 'Vendor name',   type: 'text',   required: true, max: 120 },
      { name: 'category', label: 'Category',      type: 'select', source: 'vendorCategories', allowEmpty: true, max: 60 },
      { name: 'phone',    label: 'Phone',         type: 'tel',    max: 30 },
      { name: 'address',  label: 'Address',       type: 'text',   max: 240 },
      { name: 'notes',    label: 'Notes',         type: 'textarea', max: 500 },
    ],
    contacts: [
      { name: 'name',  label: 'Name',     type: 'text', required: true, max: 120 },
      { name: 'role',  label: 'Role',     type: 'text', max: 80, placeholder: 'e.g. Security gate, Committee Chair' },
      { name: 'phone', label: 'Phone',    type: 'tel',  max: 30 },
      { name: 'notes', label: 'Notes',    type: 'textarea', max: 500 },
    ],
    resources: [
      { name: 'name',        label: 'Title',       type: 'text', required: true, max: 120 },
      { name: 'url',         label: 'Link (URL)',  type: 'url',  max: 500, placeholder: 'https://…' },
      { name: 'description', label: 'Description', type: 'textarea', max: 500 },
    ],
  };

  // Working copy. Mutated locally on edits; saved with PUT /directory.
  let state = null;
  let canEdit = false;
  let dirty = false;
  let activeTab = 'vendors';
  let activeCategory = '';  // '' = all
  let searchTerm = '';

  function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function setDirty(v) {
    dirty = v;
    const save = $('#dirSaveBtn');
    const discard = $('#dirDiscardBtn');
    if (save) save.disabled = !v;
    if (discard) discard.disabled = !v;
    // Beforeunload prompt only while dirty.
    if (v) window.addEventListener('beforeunload', warnUnsaved);
    else  window.removeEventListener('beforeunload', warnUnsaved);
  }
  function warnUnsaved(e) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  function whatsappLink(phone) {
    if (!phone) return null;
    const digits = String(phone).replace(/\D+/g, '');
    if (digits.length < 10) return null;
    const intl = digits.length === 10 ? '91' + digits : digits;
    return `https://wa.me/${intl}`;
  }
  function telLink(phone) {
    if (!phone) return null;
    const digits = String(phone).replace(/\s+/g, '');
    return `tel:${digits}`;
  }
  function safeUrl(u) {
    if (!u) return null;
    try {
      const url = new URL(u, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
      return url.toString();
    } catch (_e) { return null; }
  }

  // ----- Render -----------------------------------------------------------
  function render() {
    renderCategoryPills();
    for (const kind of Object.keys(KIND_LABEL)) renderGrid(kind);
    renderCounts();
    renderEditAffordances();
  }

  function renderCounts() {
    for (const kind of Object.keys(KIND_LABEL)) {
      const n = (state[kind] || []).length;
      const el = $(`[data-dir-count="${kind}"]`);
      if (el) el.textContent = n;
    }
  }

  function renderEditAffordances() {
    for (const el of $$('[data-dir-edit-only]')) el.hidden = !canEdit;
    const tb = $('#dirToolbar');
    if (tb) tb.hidden = !canEdit;
  }

  function renderCategoryPills() {
    const host = $('#dirCategoryPills');
    if (!host) return;
    host.innerHTML = '';
    const cats = ['', ...(state.vendorCategories || [])];
    for (const cat of cats) {
      const label = cat || 'All';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsh-dir-pill' + (cat === activeCategory ? ' is-active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        activeCategory = cat;
        renderCategoryPills();
        renderGrid('vendors');
      });
      host.appendChild(btn);
    }
  }

  function renderGrid(kind) {
    const grid = $(`[data-dir-grid="${kind}"]`);
    if (!grid) return;
    grid.innerHTML = '';

    const term = searchTerm.toLowerCase();
    const items = (state[kind] || []).filter((row) => {
      if (kind === 'vendors' && activeCategory && row.category !== activeCategory) return false;
      if (!term) return true;
      const blob = Object.values(row).filter((v) => typeof v === 'string').join(' ').toLowerCase();
      return blob.includes(term);
    });

    if (items.length === 0) {
      grid.appendChild(emptyState(kind, items.length === 0 && (state[kind] || []).length > 0));
      return;
    }

    for (const row of items) grid.appendChild(renderCard(kind, row));
  }

  function emptyState(kind, becauseFiltered) {
    const div = document.createElement('div');
    div.className = 'tsh-state tsh-state-empty';
    const icon = becauseFiltered ? 'fa-filter-circle-xmark' : KIND_LABEL[kind].icon;
    const title = becauseFiltered ? 'No matches' : `No ${kind} yet`;
    const msg = becauseFiltered
      ? 'Try a different search or clear the category filter.'
      : (canEdit ? `Click "Add ${KIND_LABEL[kind].singular}" to get started.` : 'Nothing has been added yet.');
    div.innerHTML = `<i class="tsh-state-icon fas ${icon}"></i><p class="tsh-state-title">${escapeHtml(title)}</p><p class="tsh-state-msg">${escapeHtml(msg)}</p>`;
    return div;
  }

  function renderCard(kind, row) {
    const card = document.createElement('article');
    card.className = 'tsh-dir-card';
    card.dataset.id = row.id;

    const head = document.createElement('header');
    head.className = 'tsh-dir-card-head';
    const title = document.createElement('h3');
    title.className = 'tsh-dir-card-title';
    title.textContent = row.name || '(unnamed)';
    head.appendChild(title);

    if (kind === 'vendors' && row.category) {
      const tag = document.createElement('span');
      tag.className = 'tsh-dir-card-tag';
      tag.textContent = row.category;
      head.appendChild(tag);
    } else if (kind === 'contacts' && row.role) {
      const tag = document.createElement('span');
      tag.className = 'tsh-dir-card-tag';
      tag.textContent = row.role;
      head.appendChild(tag);
    }
    card.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'tsh-dir-card-meta';

    if (row.phone) {
      const dial = telLink(row.phone);
      const wa = whatsappLink(row.phone);
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line';
      line.innerHTML = `<i class="fas fa-phone" aria-hidden="true"></i>` +
        (dial ? `<a href="${escapeHtml(dial)}" class="tsh-dir-card-link">${escapeHtml(row.phone)}</a>` : `<span>${escapeHtml(row.phone)}</span>`) +
        (wa ? `<a class="tsh-dir-card-wa" href="${escapeHtml(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp ${escapeHtml(row.name || '')}"><i class="fab fa-whatsapp" aria-hidden="true"></i></a>` : '');
      meta.appendChild(line);
    }
    if (row.address) {
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line';
      line.innerHTML = `<i class="fas fa-location-dot" aria-hidden="true"></i><span>${escapeHtml(row.address)}</span>`;
      meta.appendChild(line);
    }
    if (kind === 'resources' && row.url) {
      const safe = safeUrl(row.url);
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line';
      line.innerHTML = `<i class="fas fa-link" aria-hidden="true"></i>` +
        (safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener" class="tsh-dir-card-link">${escapeHtml(row.url)}</a>` : `<span>${escapeHtml(row.url)}</span>`);
      meta.appendChild(line);
    }
    if (row.description) {
      const p = document.createElement('p');
      p.className = 'tsh-dir-card-desc';
      p.textContent = row.description;
      meta.appendChild(p);
    }
    if (row.notes) {
      const p = document.createElement('p');
      p.className = 'tsh-dir-card-notes';
      p.textContent = row.notes;
      meta.appendChild(p);
    }
    card.appendChild(meta);

    if (canEdit) {
      const actions = document.createElement('footer');
      actions.className = 'tsh-dir-card-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      editBtn.innerHTML = '<i class="fas fa-pen"></i>Edit';
      editBtn.addEventListener('click', () => openForm(kind, row));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      delBtn.innerHTML = '<i class="fas fa-trash"></i>Delete';
      delBtn.addEventListener('click', () => confirmDelete(kind, row));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
    }

    return card;
  }

  // ----- Add / Edit form modal -------------------------------------------
  function openForm(kind, existing) {
    const isEdit = !!existing;
    const data = existing ? { ...existing } : {};
    const form = document.createElement('form');
    form.className = 'tsh-dir-form';
    form.addEventListener('submit', (e) => e.preventDefault());

    for (const field of SCHEMA[kind]) {
      const wrap = document.createElement('div');
      wrap.className = 'tsh-field';
      const label = document.createElement('span');
      label.className = 'tsh-label';
      label.textContent = field.label + (field.required ? ' *' : '');
      wrap.appendChild(label);

      let input;
      if (field.type === 'select') {
        input = document.createElement('select');
        const opts = state[field.source] || [];
        if (field.allowEmpty) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '— none —';
          input.appendChild(opt);
        }
        for (const o of opts) {
          const opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o;
          input.appendChild(opt);
        }
      } else if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
      } else {
        input = document.createElement('input');
        input.type = field.type;
      }
      input.name = field.name;
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.max) input.maxLength = field.max;
      if (data[field.name] != null) input.value = data[field.name];
      wrap.appendChild(input);
      form.appendChild(wrap);
    }

    UI.modal({
      title: (isEdit ? 'Edit ' : 'Add ') + KIND_LABEL[kind].singular,
      body: form,
      actions: [
        { label: 'Cancel', value: null },
        { label: isEdit ? 'Save' : 'Add', value: 'save', primary: true },
      ],
    }).then((choice) => {
      if (choice !== 'save') return;
      const next = {};
      for (const field of SCHEMA[kind]) {
        const el = form.elements[field.name];
        const v = (el.value || '').trim();
        if (v) next[field.name] = v;
      }
      if (!next.name) { UI.toast('Name is required', { kind: 'warn' }); return; }

      const list = state[kind] = state[kind] || [];
      if (isEdit) {
        const i = list.findIndex((x) => x.id === existing.id);
        if (i >= 0) list[i] = { ...existing, ...next, updatedAt: new Date().toISOString() };
      } else {
        list.push({
          ...next,
          id: 'tmp-' + Math.random().toString(36).slice(2, 12),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      setDirty(true);
      render();
    });
  }

  function confirmDelete(kind, row) {
    UI.confirmModal(
      'Delete ' + KIND_LABEL[kind].singular,
      `Remove "${escapeHtml(row.name)}" from the directory? Click Save afterwards to make it permanent.`,
    ).then((yes) => {
      if (!yes) return;
      const list = state[kind] || [];
      const i = list.findIndex((x) => x.id === row.id);
      if (i >= 0) list.splice(i, 1);
      setDirty(true);
      render();
    });
  }

  // ----- Vendor CSV import ------------------------------------------------
  // Minimal RFC-4180 CSV parser: supports quoted fields, embedded commas
  // and newlines, and doubled-quote escaping ("" inside a quoted field).
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let i = 0;
    let inQuotes = false;
    const len = text.length;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (inQuotes) {
        if (c === 34 /* " */) {
          if (i + 1 < len && text.charCodeAt(i + 1) === 34) { cell += '"'; i += 2; continue; }
          inQuotes = false; i += 1; continue;
        }
        cell += text[i]; i += 1; continue;
      }
      if (c === 34) { inQuotes = true; i += 1; continue; }
      if (c === 44 /* , */) { row.push(cell); cell = ''; i += 1; continue; }
      if (c === 13 /* \r */) { i += 1; continue; }
      if (c === 10 /* \n */) { row.push(cell); rows.push(row); row = []; cell = ''; i += 1; continue; }
      cell += text[i]; i += 1;
    }
    // Flush trailing cell / row (file without trailing newline).
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Recognised vendor columns. Aliases let us accept common header variants.
  const VENDOR_CSV_ALIASES = {
    name:     ['name', 'vendor', 'vendor name', 'business', 'business name'],
    category: ['category', 'type', 'service', 'trade'],
    phone:    ['phone', 'mobile', 'contact', 'contact number', 'phone number', 'number'],
    address:  ['address', 'location'],
    notes:    ['notes', 'note', 'remarks', 'description'],
  };
  function mapVendorHeaders(headerRow) {
    const map = {};
    headerRow.forEach((h, idx) => {
      const key = String(h || '').trim().toLowerCase();
      if (!key) return;
      for (const field of Object.keys(VENDOR_CSV_ALIASES)) {
        if (VENDOR_CSV_ALIASES[field].includes(key)) { map[field] = idx; break; }
      }
    });
    return map;
  }
  function vendorDedupeKey(row) {
    const name = String(row.name || '').trim().toLowerCase();
    const phoneDigits = String(row.phone || '').replace(/\D+/g, '');
    return name + '|' + phoneDigits;
  }

  function openVendorImport() {
    const form = document.createElement('form');
    form.className = 'tsh-dir-form';
    form.addEventListener('submit', (e) => e.preventDefault());

    const help = document.createElement('p');
    help.className = 'tsh-hint';
    help.style.margin = '0 0 .5em';
    help.innerHTML =
      'Paste a CSV with a header row. Recognised columns: ' +
      '<code>name</code> (required), <code>category</code>, <code>phone</code>, ' +
      '<code>address</code>, <code>notes</code>. Duplicates (same name + phone) are skipped. ' +
      'New categories are added automatically.';
    form.appendChild(help);

    const ta = document.createElement('textarea');
    ta.name = 'csv';
    ta.rows = 12;
    ta.placeholder = 'name,category,phone,address,notes\nAlpha Elec,Electrician,9999999999,101 Main,"Reliable, fast"';
    ta.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ta.style.fontSize = '.85em';
    const wrap = document.createElement('div');
    wrap.className = 'tsh-field';
    const label = document.createElement('span');
    label.className = 'tsh-label';
    label.textContent = 'Paste CSV';
    wrap.append(label, ta);
    form.appendChild(wrap);

    UI.modal({
      title: 'Import vendors from CSV',
      body: form,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Import', value: 'import', primary: true },
      ],
    }).then((choice) => {
      if (choice !== 'import') return;
      const raw = (ta.value || '').trim();
      if (!raw) { UI.toast('Nothing to import — paste some CSV first.', { kind: 'warn' }); return; }
      const rows = parseCsv(raw).filter((r) => r.some((c) => String(c).trim().length));
      if (rows.length < 2) {
        UI.toast('CSV needs a header row plus at least one data row.', { kind: 'warn' });
        return;
      }
      const headerMap = mapVendorHeaders(rows[0]);
      if (headerMap.name == null) {
        UI.toast('CSV header must include a "name" column.', { kind: 'warn' });
        return;
      }

      const existing = state.vendors = state.vendors || [];
      const existingKeys = new Set(existing.map(vendorDedupeKey));
      const knownCats = new Set((state.vendorCategories || []).map((c) => c.toLowerCase()));
      const newCats = [];
      const seenInBatch = new Set();
      let imported = 0;
      let skipped = 0;
      let invalid = 0;

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const pick = (k) => {
          const idx = headerMap[k];
          return idx == null ? '' : String(row[idx] == null ? '' : row[idx]).trim();
        };
        const next = {
          name:     pick('name').slice(0, 120),
          category: pick('category').slice(0, 60),
          phone:    pick('phone').slice(0, 30),
          address:  pick('address').slice(0, 240),
          notes:    pick('notes').slice(0, 500),
        };
        if (!next.name) { invalid++; continue; }
        const key = vendorDedupeKey(next);
        if (existingKeys.has(key) || seenInBatch.has(key)) { skipped++; continue; }
        seenInBatch.add(key);

        // Strip empty optional fields for a tidy payload.
        for (const k of Object.keys(next)) if (!next[k]) delete next[k];

        // Auto-add any unseen category.
        if (next.category) {
          const ck = next.category.toLowerCase();
          if (!knownCats.has(ck)) { knownCats.add(ck); newCats.push(next.category); }
        }

        const now = new Date().toISOString();
        existing.push({
          ...next,
          id: 'tmp-' + Math.random().toString(36).slice(2, 12),
          createdAt: now,
          updatedAt: now,
        });
        imported++;
      }

      if (newCats.length) {
        state.vendorCategories = (state.vendorCategories || []).concat(newCats);
      }

      const parts = [`Imported ${imported}`];
      if (skipped) parts.push(`${skipped} duplicate${skipped === 1 ? '' : 's'} skipped`);
      if (invalid) parts.push(`${invalid} without a name skipped`);
      if (newCats.length) parts.push(`${newCats.length} new categor${newCats.length === 1 ? 'y' : 'ies'} added`);

      if (imported > 0) {
        setDirty(true);
        render();
        UI.toast(parts.join(' · ') + '. Remember to Save.', { kind: 'success', ttl: 8000 });
      } else {
        UI.toast(parts.join(' · ') + '.', { kind: 'warn' });
      }
    });
  }

  function openCategoryManager() {
    const form = document.createElement('form');
    form.className = 'tsh-dir-form';
    form.addEventListener('submit', (e) => e.preventDefault());
    const label = document.createElement('span');
    label.className = 'tsh-label';
    label.textContent = 'Vendor categories (one per line)';
    const ta = document.createElement('textarea');
    ta.name = 'categories';
    ta.rows = 10;
    ta.value = (state.vendorCategories || []).join('\n');
    const wrap = document.createElement('div');
    wrap.className = 'tsh-field';
    wrap.append(label, ta);
    form.appendChild(wrap);

    UI.modal({
      title: 'Vendor categories',
      body: form,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Apply', value: 'save', primary: true },
      ],
    }).then((choice) => {
      if (choice !== 'save') return;
      const next = ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const seen = new Set();
      state.vendorCategories = next.filter((c) => {
        const k = c.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      // If the active filter is removed, reset to "All".
      if (activeCategory && !state.vendorCategories.includes(activeCategory)) {
        activeCategory = '';
      }
      // Vendors carrying a removed category keep it locally (no destructive
      // change) — user can re-add the category or edit each vendor.
      setDirty(true);
      render();
    });
  }

  // ----- Save / Discard ---------------------------------------------------
  async function save() {
    const btn = $('#dirSaveBtn');
    btn.disabled = true;
    try {
      // Strip tmp- ids so the server assigns proper ones.
      const payload = ['vendors', 'contacts', 'resources'].reduce((acc, kind) => {
        acc[kind] = (state[kind] || []).map((row) => {
          const out = { ...row };
          if (typeof out.id === 'string' && out.id.startsWith('tmp-')) delete out.id;
          return out;
        });
        return acc;
      }, { version: state.version || 1, vendorCategories: state.vendorCategories || [] });

      await Api.put('/directory', { directory: payload });
      // Reload to pick up server-assigned ids.
      const fresh = await Api.get('/directory');
      state = normalise(fresh);
      setDirty(false);
      render();
      UI.toast('Directory saved.', { kind: 'success' });
    } catch (e) {
      UI.toast(e.message || 'Save failed.', { kind: 'danger' });
      btn.disabled = false;
    }
  }

  async function discard() {
    if (!dirty) return;
    const yes = await UI.confirmModal('Discard changes', 'Throw away your unsaved edits?');
    if (!yes) return;
    const fresh = await Api.get('/directory').catch(() => null);
    state = normalise(fresh || { vendors: [], contacts: [], resources: [], vendorCategories: [] });
    setDirty(false);
    render();
  }

  function normalise(raw) {
    return {
      version: (raw && raw.version) || 1,
      vendorCategories: Array.isArray(raw && raw.vendorCategories) ? raw.vendorCategories : [],
      vendors:   Array.isArray(raw && raw.vendors)   ? raw.vendors   : [],
      contacts:  Array.isArray(raw && raw.contacts)  ? raw.contacts  : [],
      resources: Array.isArray(raw && raw.resources) ? raw.resources : [],
    };
  }

  // ----- Tabs + search wiring --------------------------------------------
  function activateTab(name) {
    activeTab = name;
    for (const btn of $$('[data-dir-tab]')) {
      const on = btn.dataset.dirTab === name;
      btn.classList.toggle('tsh-tab-active', on);
      btn.setAttribute('aria-selected', String(on));
    }
    for (const sec of $$('[data-dir-section]')) {
      sec.hidden = sec.dataset.dirSection !== name;
    }
  }

  // ----- Init -------------------------------------------------------------
  async function init(opts) {
    canEdit = !!(opts && opts.canEdit);
    const hint = $('#dirRoleHint');
    if (hint) hint.textContent = canEdit
      ? 'You can add, edit and delete entries. Don\u2019t forget to Save.'
      : 'Read-only — sign in as Manager, Committee or Developer to edit.';

    let raw = null;
    try { raw = await Api.get('/directory'); }
    catch (e) { UI.toast('Couldn\u2019t load directory.', { kind: 'danger' }); raw = null; }
    state = normalise(raw || {});
    render();

    // Tabs.
    for (const btn of $$('[data-dir-tab]')) {
      btn.addEventListener('click', () => activateTab(btn.dataset.dirTab));
    }

    // Search.
    const search = $('#dirSearch');
    if (search) {
      search.addEventListener('input', () => {
        searchTerm = search.value || '';
        for (const kind of Object.keys(KIND_LABEL)) renderGrid(kind);
      });
    }

    // Add buttons.
    for (const btn of $$('[data-dir-add]')) {
      btn.addEventListener('click', () => openForm(btn.dataset.dirAdd, null));
    }

    // Manage categories.
    const mgr = $('#dirManageCategoriesBtn');
    if (mgr) mgr.addEventListener('click', openCategoryManager);

    // Import vendors from CSV.
    const importBtn = $('#dirImportVendorsBtn');
    if (importBtn) importBtn.addEventListener('click', openVendorImport);

    // Save / Discard.
    const save_ = $('#dirSaveBtn');
    if (save_) save_.addEventListener('click', save);
    const discard_ = $('#dirDiscardBtn');
    if (discard_) discard_.addEventListener('click', discard);
  }

  root.Directory = { init };
})(window);

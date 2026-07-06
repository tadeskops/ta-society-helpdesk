// docs/assets/js/directory.js
// Society directory — vendors, community contacts, resources.
// Reads /directory on load, lets MANAGER/COMMITTEE/ADMIN edit
// inline. Save commits the whole document (PUT /directory). Filter
// pills + search work locally on the loaded copy.
(function (root) {
  'use strict';

  const KIND_LABEL = {
    emergency: { singular: 'emergency contact', icon: 'fa-triangle-exclamation' },
    vendors:   { singular: 'vendor',   icon: 'fa-toolbox' },
    services:  { singular: 'service',  icon: 'fa-handshake-angle' },
    contacts:  { singular: 'committee member', icon: 'fa-people-group' },
    resources: { singular: 'resource', icon: 'fa-link'    },
  };

  // Field schema per kind — drives form rendering + card rendering.
  // type: 'phones' renders a repeater (multiple tel inputs with + / −
  // buttons); collect() reads it into row.phones[]. Legacy single `phone`
  // is auto-migrated by the worker on save.
  const SCHEMA = {
    emergency: [
      { name: 'name',    label: 'Contact name', type: 'text',     required: true, max: 120, placeholder: 'e.g. Mr. Manish Pande' },
      { name: 'role',    label: 'Service / Role', type: 'text',   max: 80,  placeholder: 'e.g. Security, Electrician, Plumber (A Wing)' },
      { name: 'phones',  label: 'Phones',       type: 'phones',   max: 30, maxCount: 5 },
      { name: 'address', label: 'Address',      type: 'text',     max: 240 },
      { name: 'email',   label: 'Email',        type: 'email',    max: 120 },
      { name: 'notes',   label: 'Notes',        type: 'textarea', max: 500, placeholder: 'Wing covered, shift hours, alternate contact…' },
    ],
    vendors: [
      { name: 'name',     label: 'Vendor name',   type: 'text',   required: true, max: 120 },
      { name: 'category', label: 'Category',      type: 'select', source: 'vendorCategories', allowEmpty: true, max: 60 },
      { name: 'phones',   label: 'Phones',        type: 'phones', max: 30, maxCount: 5 },
      { name: 'address',  label: 'Address',       type: 'text',   max: 240 },
      { name: 'notes',    label: 'Notes',         type: 'textarea', max: 500 },
    ],
    contacts: [
      { name: 'name',        label: 'Name',          type: 'text', required: true, max: 120 },
      { name: 'role',        label: 'Role',          type: 'text', max: 80, placeholder: 'e.g. Security gate, Committee Chair' },
      // Committee-view enrichment (FEATURE_DAILY_COMMITTEE_VIEW). The
      // form filters these out when the flag is OFF; the worker accepts
      // them either way so toggling the flag never loses data.
      { name: 'designation', label: 'Designation',   type: 'text', max: 80,  placeholder: 'e.g. Treasurer, Block A Rep', committeeOnly: true },
      { name: 'term',        label: 'Term (from / to)', type: 'monthRange', startName: 'termStart', endName: 'termEnd', committeeOnly: true },
      { name: 'responsibilities', label: 'Roles & Responsibilities (optional)', type: 'textarea', max: 1000, placeholder: 'e.g. Chairs monthly committee meetings; signs off on vendor contracts; liaises with security agency.', committeeOnly: true },
      { name: 'email',       label: 'Email',         type: 'email', max: 120, committeeOnly: true },
      { name: 'photoUrl',    label: 'Photo',         type: 'photo', max: 500, placeholder: 'https://… (paste a URL or use Upload)', committeeOnly: true },
      { name: 'phones',      label: 'Phones',        type: 'phones', max: 30, maxCount: 5 },
      { name: 'notes',       label: 'Notes',         type: 'textarea', max: 500 },
    ],
    resources: [
      { name: 'name',        label: 'Title',       type: 'text', required: true, max: 120 },
      { name: 'url',         label: 'Link (URL)',  type: 'url',  max: 500, placeholder: 'https://…' },
      { name: 'description', label: 'Description', type: 'textarea', max: 500 },
    ],
    services: [
      { name: 'name',       label: 'Service-provider name', type: 'text',     required: true, max: 120 },
      { name: 'category',   label: 'Sub-category',          type: 'select',   source: 'serviceCategories', allowEmpty: true, max: 60 },
      { name: 'phones',     label: 'Phones',                type: 'phones',   max: 30, maxCount: 5 },
      { name: 'priceRange', label: 'Suggested price range', type: 'text',     max: 60, placeholder: 'e.g. ₹2,500 – 4,000 / month' },
      { name: 'comment',    label: 'Brief comment',         type: 'textarea', max: 500, placeholder: 'Notes about the provider — areas served, languages, references…' },
      { name: 'verified',   label: 'Society-verified',      type: 'checkbox', help: 'Tick only after identity / police-verification has been completed by the society manager.' },
    ],
  };

  // Working copy. Mutated locally on edits; saved with PUT /directory.
  let state = null;
  let canEdit = false;
  let dirty = false;
  let activeTab = 'emergency';
  let activeCategory = '';  // '' = all
  let activeServiceCategory = '';
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
  // Canonical accessor: always returns an array. Reads new `phones` field
  // when present; falls back to legacy single `phone` for older entries.
  function getPhones(row) {
    if (!row) return [];
    if (Array.isArray(row.phones) && row.phones.length) {
      return row.phones.map((p) => String(p || '').trim()).filter(Boolean);
    }
    if (row.phone) return [String(row.phone).trim()].filter(Boolean);
    return [];
  }
  function safeUrl(u) {
    if (!u) return null;
    try {
      const url = new URL(u, location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return null;
      return url.toString();
    } catch (_e) { return null; }
  }

  // Build a human-friendly display string for a committee term from the
  // canonical YYYY-MM pair. Empty inputs yield '' (caller decides whether
  // to write that back to the entry).
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtYearMonth(s) {
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(s || ''));
    if (!m) return '';
    return `${MONTH_SHORT[Number(m[2]) - 1]} ${m[1]}`;
  }
  function formatTermDisplay(start, end) {
    const a = fmtYearMonth(start);
    const b = fmtYearMonth(end);
    if (a && b) return `${a} \u2013 ${b}`;
    return a || b || '';
  }

  // ----- Render -----------------------------------------------------------
  function render() {
    renderCategoryPills();
    renderServiceSidebar();
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

  let categoryFilter = null;
  function renderCategoryPills() {
    // Mobile pills (hidden on desktop by CSS via .tsh-dir-filter-pills-mobile).
    const host = $('#dirCategoryPills');
    if (host) {
      if (!categoryFilter) {
        categoryFilter = UI.FilterBar(host, {
          label: 'Category',
          options: state.vendorCategories || [],
          value: activeCategory,
          onApply: (val) => { setActiveVendorCategory(val); renderGrid('vendors'); renderCategoryPills(); },
        });
      } else {
        categoryFilter.setOptions(state.vendorCategories || []);
        categoryFilter.setValue(activeCategory);
      }
    }
    // Desktop sidebar list with per-category counts. Mirrors renderServiceSidebar.
    const ul = $('#dirVendorSidebar');
    if (!ul) return;
    const cats = state.vendorCategories || [];
    const items = state.vendors || [];
    ul.innerHTML = '';
    const make = (cat, count, isActive) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsh-dir-sidebar-item' + (isActive ? ' is-active' : '');
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(!!isActive));
      btn.innerHTML = `<span class="tsh-dir-sidebar-label">${escapeHtml(cat || 'All vendors')}</span><span class="tsh-dir-sidebar-badge">${count}</span>`;
      btn.addEventListener('click', () => {
        const next = cat === '' ? '' : cat;
        if (activeCategory === next) return;
        setActiveVendorCategory(next);
        renderGrid('vendors');
        renderCategoryPills();
      });
      li.appendChild(btn);
      return li;
    };
    ul.appendChild(make('', items.length, !activeCategory));
    for (const cat of cats) {
      const count = items.filter((v) => (v.category || '').toLowerCase() === cat.toLowerCase()).length;
      ul.appendChild(make(cat, count, activeCategory === cat));
    }
    const countEl = $('#dirVendorSidebarCount');
    if (countEl) countEl.textContent = String(cats.length);
  }

  function setActiveVendorCategory(val) {
    activeCategory = val || '';
    if (categoryFilter) categoryFilter.setValue(activeCategory);
  }

  // Desktop sidebar + mobile pills for the Services tab. Sidebar shows all
  // sub-categories with per-category counts; clicking one filters the grid.
  let serviceFilter = null;
  function renderServiceSidebar() {
    const host = $('#dirServicePills');
    if (host) {
      if (!serviceFilter) {
        serviceFilter = UI.FilterBar(host, {
          label: 'Sub-category',
          options: state.serviceCategories || [],
          value: activeServiceCategory,
          onApply: (val) => { setActiveServiceCategory(val); renderGrid('services'); renderServiceSidebar(); },
        });
      } else {
        serviceFilter.setOptions(state.serviceCategories || []);
        serviceFilter.setValue(activeServiceCategory);
      }
    }
    const ul = $('#dirServiceSidebar');
    if (!ul) return;
    const cats = state.serviceCategories || [];
    const items = state.services || [];
    ul.innerHTML = '';
    const make = (cat, count, isActive) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsh-dir-sidebar-item' + (isActive ? ' is-active' : '');
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', String(!!isActive));
      btn.innerHTML = `<span class="tsh-dir-sidebar-label">${escapeHtml(cat || 'All services')}</span><span class="tsh-dir-sidebar-badge">${count}</span>`;
      btn.addEventListener('click', () => {
        const next = cat === '' ? '' : cat;
        if (activeServiceCategory === next) return;
        setActiveServiceCategory(next);
        renderGrid('services');
        renderServiceSidebar();
      });
      li.appendChild(btn);
      return li;
    };
    ul.appendChild(make('', items.length, !activeServiceCategory));
    for (const cat of cats) {
      const count = items.filter((s) => (s.category || '').toLowerCase() === cat.toLowerCase()).length;
      ul.appendChild(make(cat, count, activeServiceCategory === cat));
    }
    const countEl = $('#dirSidebarCount');
    if (countEl) countEl.textContent = String(cats.length);
  }

  function setActiveServiceCategory(val) {
    activeServiceCategory = val || '';
    if (serviceFilter) serviceFilter.setValue(activeServiceCategory);
  }

  function renderGrid(kind) {
    const grid = $(`[data-dir-grid="${kind}"]`);
    if (!grid) return;
    grid.innerHTML = '';

    const term = searchTerm.toLowerCase();
    let items = (state[kind] || []).filter((row) => {
      if (kind === 'vendors' && activeCategory && row.category !== activeCategory) return false;
      if (kind === 'services' && activeServiceCategory && row.category !== activeServiceCategory) return false;
      if (!term) return true;
      const blob = Object.values(row).filter((v) => typeof v === 'string').join(' ').toLowerCase();
      return blob.includes(term);
    });

    // Committee tab: honour sortOrder when present (lower first), then
    // name. Other tabs keep insertion order.
    if (kind === 'contacts'
        && window.Flags && Flags.on && Flags.on('FEATURE_DAILY_COMMITTEE_VIEW')) {
      items = items.slice().sort((a, b) => {
        const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : 999;
        const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : 999;
        if (ao !== bo) return ao - bo;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
    }
    // Emergency tab is always sorted by sortOrder (then by role/name) so
    // critical contacts like Security and Housekeeping lead the list.
    if (kind === 'emergency') {
      items = items.slice().sort((a, b) => {
        const ao = Number.isFinite(a.sortOrder) ? a.sortOrder : 999;
        const bo = Number.isFinite(b.sortOrder) ? b.sortOrder : 999;
        if (ao !== bo) return ao - bo;
        return String(a.role || a.name || '').localeCompare(String(b.role || b.name || ''));
      });
    }

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

  function renderCommitteeCard(row) {
    const card = document.createElement('article');
    card.className = 'tsh-dir-card tsh-committee-card';
    card.dataset.id = row.id;

    // Avatar: photo if provided, otherwise initials chip.
    const avatar = document.createElement('div');
    avatar.className = 'tsh-committee-avatar';
    if (row.photoUrl) {
      const img = document.createElement('img');
      img.src = row.photoUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => { img.remove(); avatar.textContent = initials(row.name); };
      avatar.appendChild(img);
    } else {
      avatar.textContent = initials(row.name);
    }
    card.appendChild(avatar);

    const body = document.createElement('div');
    body.className = 'tsh-committee-body';

    const name = document.createElement('h3');
    name.className = 'tsh-committee-name';
    name.textContent = row.name || '(unnamed)';
    body.appendChild(name);

    if (row.designation || row.role) {
      const d = document.createElement('div');
      d.className = 'tsh-committee-role';
      d.textContent = row.designation || row.role;
      body.appendChild(d);
    }

    if (row.term) {
      const t = document.createElement('span');
      t.className = 'tsh-committee-term';
      t.innerHTML = `<i class="fas fa-calendar" aria-hidden="true"></i>${escapeHtml(row.term)}`;
      body.appendChild(t);
    }

    const contacts = document.createElement('div');
    contacts.className = 'tsh-committee-contacts';
    if (row.address) {
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line tsh-dir-card-flat';
      line.innerHTML = `<i class="fas fa-house" aria-hidden="true"></i>` +
        `<span>${escapeHtml(row.address)}</span>`;
      contacts.appendChild(line);
    }
    const phones = getPhones(row);
    for (const phone of phones) {
      const dial = telLink(phone);
      const wa = whatsappLink(phone);
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line tsh-dir-card-phone';
      line.innerHTML = `<i class="fas fa-phone" aria-hidden="true"></i>` +
        `<span class="tsh-dir-card-phone-num">${escapeHtml(phone)}</span>` +
        (dial ? `<a class="tsh-dir-card-call" href="${escapeHtml(dial)}" aria-label="Call ${escapeHtml(phone)}" title="Call"><i class="fas fa-phone-volume" aria-hidden="true"></i></a>` : '') +
        (wa ? `<a class="tsh-dir-card-wa" href="${escapeHtml(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp ${escapeHtml(phone)}" title="WhatsApp"><i class="fab fa-whatsapp" aria-hidden="true"></i></a>` : '');
      contacts.appendChild(line);
    }
    if (row.email) {
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line';
      line.innerHTML = `<i class="fas fa-envelope" aria-hidden="true"></i>` +
        `<a class="tsh-dir-card-link" href="mailto:${escapeHtml(row.email)}">${escapeHtml(row.email)}</a>`;
      contacts.appendChild(line);
    }
    if (contacts.children.length) body.appendChild(contacts);

    if (row.responsibilities) {
      const wrap = document.createElement('div');
      wrap.className = 'tsh-committee-resp';
      const h = document.createElement('div');
      h.className = 'tsh-committee-resp-h';
      h.innerHTML = '<i class="fas fa-list-check" aria-hidden="true"></i>Roles & Responsibilities';
      const p = document.createElement('p');
      p.className = 'tsh-committee-resp-body';
      p.textContent = row.responsibilities;
      wrap.append(h, p);
      body.appendChild(wrap);
    }

    if (row.notes) {
      const p = document.createElement('p');
      p.className = 'tsh-dir-card-notes';
      p.textContent = row.notes;
      body.appendChild(p);
    }
    card.appendChild(body);

    if (canEdit) {
      const actions = document.createElement('footer');
      actions.className = 'tsh-dir-card-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      editBtn.innerHTML = '<i class="fas fa-pen"></i>Edit';
      editBtn.addEventListener('click', () => openForm('contacts', row));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      delBtn.innerHTML = '<i class="fas fa-trash"></i>Delete';
      delBtn.addEventListener('click', () => confirmDelete('contacts', row));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
    }
    return card;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function renderServiceCard(row) {
    const card = document.createElement('article');
    card.className = 'tsh-dir-card tsh-service-card' + (row.verified ? ' is-verified' : '');
    card.dataset.id = row.id;

    const head = document.createElement('header');
    head.className = 'tsh-dir-card-head';
    const titleWrap = document.createElement('div');
    titleWrap.className = 'tsh-service-titlewrap';
    const title = document.createElement('h3');
    title.className = 'tsh-dir-card-title';
    title.textContent = row.name || '(unnamed)';
    titleWrap.appendChild(title);
    if (row.verified) {
      const tip = row.verifiedBy
        ? `Verified by ${row.verifiedBy}${row.verifiedAt ? ' on ' + new Date(row.verifiedAt).toLocaleDateString() : ''} \u2014 identity confirmed by the society manager.`
        : 'Verified by the society manager through identity / police-verification.';
      const badge = document.createElement('span');
      badge.className = 'tsh-verified-badge';
      badge.setAttribute('title', tip);
      badge.setAttribute('aria-label', tip);
      badge.tabIndex = 0;
      badge.innerHTML = '<i class="fas fa-shield-halved" aria-hidden="true"></i><span class="tsh-verified-text">Verified</span>';
      titleWrap.appendChild(badge);
    }
    head.appendChild(titleWrap);
    if (row.category) {
      const tag = document.createElement('span');
      tag.className = 'tsh-dir-card-tag';
      tag.textContent = row.category;
      head.appendChild(tag);
    }
    card.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'tsh-dir-card-meta';
    for (const phone of getPhones(row)) {
      const dial = telLink(phone);
      const wa = whatsappLink(phone);
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line tsh-dir-card-phone';
      line.innerHTML = `<i class="fas fa-phone" aria-hidden="true"></i>` +
        `<span class="tsh-dir-card-phone-num">${escapeHtml(phone)}</span>` +
        (dial ? `<a class="tsh-dir-card-call" href="${escapeHtml(dial)}" aria-label="Call ${escapeHtml(phone)}" title="Call"><i class="fas fa-phone-volume" aria-hidden="true"></i></a>` : '') +
        (wa ? `<a class="tsh-dir-card-wa" href="${escapeHtml(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp ${escapeHtml(phone)}" title="WhatsApp"><i class="fab fa-whatsapp" aria-hidden="true"></i></a>` : '');
      meta.appendChild(line);
    }
    if (row.priceRange) {
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line';
      line.innerHTML = `<i class="fas fa-indian-rupee-sign" aria-hidden="true"></i>` +
        `<span class="tsh-service-price">${escapeHtml(row.priceRange)}</span>`;
      meta.appendChild(line);
    }
    if (row.comment) {
      const p = document.createElement('p');
      p.className = 'tsh-dir-card-desc tsh-service-comment';
      p.textContent = row.comment;
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
      editBtn.addEventListener('click', () => openForm('services', row));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      delBtn.innerHTML = '<i class="fas fa-trash"></i>Delete';
      delBtn.addEventListener('click', () => confirmDelete('services', row));
      actions.append(editBtn, delBtn);
      card.appendChild(actions);
    }
    return card;
  }

  function renderCard(kind, row) {
    // Committee-view enriched card: only when the flag is on, the kind is
    // contacts, and the entry actually has one of the enrichment fields.
    // Without one of those, we fall back to the basic card so unchanged
    // entries look exactly as before.
    if (kind === 'contacts'
        && window.Flags && Flags.on && Flags.on('FEATURE_DAILY_COMMITTEE_VIEW')
        && (row.designation || row.term || row.email || row.photoUrl || row.responsibilities)) {
      return renderCommitteeCard(row);
    }
    if (kind === 'services') return renderServiceCard(row);

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
    } else if ((kind === 'contacts' || kind === 'emergency') && row.role) {
      const tag = document.createElement('span');
      tag.className = 'tsh-dir-card-tag';
      tag.textContent = row.role;
      head.appendChild(tag);
    }
    card.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'tsh-dir-card-meta';

    const phones = getPhones(row);
    for (const phone of phones) {
      const dial = telLink(phone);
      const wa = whatsappLink(phone);
      const line = document.createElement('div');
      line.className = 'tsh-dir-card-line tsh-dir-card-phone';
      line.innerHTML = `<i class="fas fa-phone" aria-hidden="true"></i>` +
        `<span class="tsh-dir-card-phone-num">${escapeHtml(phone)}</span>` +
        (dial ? `<a class="tsh-dir-card-call" href="${escapeHtml(dial)}" aria-label="Call ${escapeHtml(phone)}" title="Call"><i class="fas fa-phone-volume" aria-hidden="true"></i></a>` : '') +
        (wa ? `<a class="tsh-dir-card-wa" href="${escapeHtml(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp ${escapeHtml(phone)}" title="WhatsApp"><i class="fab fa-whatsapp" aria-hidden="true"></i></a>` : '');
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

    // Filter out fields the active feature flags don't enable. Contacts
    // gets the enrichment fields only when FEATURE_DAILY_COMMITTEE_VIEW
    // is on; the worker still accepts them when sent, so existing data
    // is preserved across toggles.
    const committeeOn = !!(window.Flags && Flags.on && Flags.on('FEATURE_DAILY_COMMITTEE_VIEW'));
    const fields = SCHEMA[kind].filter((f) => !(f.committeeOnly && !committeeOn));

    for (const field of fields) {
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
      } else if (field.type === 'checkbox') {
        const inline = document.createElement('label');
        inline.className = 'tsh-checkbox-inline';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.name = field.name;
        if (data[field.name]) input.checked = true;
        const txt = document.createElement('span');
        txt.textContent = field.help || field.label;
        inline.append(input, txt);
        wrap.appendChild(inline);
        if (data.verified && data.verifiedBy) {
          const meta = document.createElement('p');
          meta.className = 'tsh-hint';
          meta.style.margin = '.25rem 0 0';
          const when = data.verifiedAt ? ' on ' + new Date(data.verifiedAt).toLocaleString() : '';
          meta.textContent = `Currently verified by ${data.verifiedBy}${when}.`;
          wrap.appendChild(meta);
        }
        form.appendChild(wrap);
        continue;
      } else if (field.type === 'phones') {
        // Multi-phone repeater. Stored on the form as a <fieldset> with
        // child .tsh-phone-row items; collect() reads them via the DOM.
        const fs = document.createElement('fieldset');
        fs.className = 'tsh-phones-repeater';
        fs.dataset.fieldName = field.name;
        const initial = Array.isArray(data[field.name]) && data[field.name].length
          ? data[field.name]
          : (data.phone ? [data.phone] : ['']);
        const maxCount = field.maxCount || 5;
        const addRow = (val) => {
          if (fs.querySelectorAll('.tsh-phone-row').length >= maxCount) return;
          const row = document.createElement('div');
          row.className = 'tsh-phone-row';
          const inp = document.createElement('input');
          inp.type = 'tel';
          inp.maxLength = field.max || 30;
          inp.placeholder = 'e.g. 9999999999';
          if (val) inp.value = val;
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm tsh-phone-del';
          del.setAttribute('aria-label', 'Remove this phone');
          del.innerHTML = '<i class="fas fa-minus" aria-hidden="true"></i>';
          del.addEventListener('click', () => {
            if (fs.querySelectorAll('.tsh-phone-row').length > 1) row.remove();
            else inp.value = '';
            refreshAdd();
          });
          row.append(inp, del);
          fs.insertBefore(row, addBtn);
          refreshAdd();
        };
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm tsh-phone-add';
        addBtn.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i>Add another phone';
        addBtn.addEventListener('click', () => addRow(''));
        const refreshAdd = () => {
          addBtn.disabled = fs.querySelectorAll('.tsh-phone-row').length >= maxCount;
        };
        fs.appendChild(addBtn);
        for (const v of initial) addRow(v);
        wrap.appendChild(fs);
        form.appendChild(wrap);
        continue;
      } else if (field.type === 'monthRange') {
        // Two <input type="month"> controls + an en-dash separator.
        // Bound to field.startName / field.endName on form.elements so
        // the collect step can read them by name.
        const row = document.createElement('div');
        row.className = 'tsh-month-range';
        const from = document.createElement('input');
        from.type = 'month';
        from.name = field.startName || 'termStart';
        from.className = 'tsh-month-range-input';
        from.setAttribute('aria-label', (field.label || 'Term') + ' \u2014 from (month + year)');
        const sep = document.createElement('span');
        sep.className = 'tsh-month-range-sep';
        sep.textContent = '\u2013';
        const to = document.createElement('input');
        to.type = 'month';
        to.name = field.endName || 'termEnd';
        to.className = 'tsh-month-range-input';
        to.setAttribute('aria-label', (field.label || 'Term') + ' \u2014 to (month + year)');
        const parseYM = (s) => {
          const m = /^(\d{4})-(0[1-9]|1[0-2])/.exec(String(s || ''));
          return m ? `${m[1]}-${m[2]}` : '';
        };
        from.value = parseYM(data[field.startName || 'termStart']) || '';
        to.value   = parseYM(data[field.endName   || 'termEnd'])   || '';
        // Legacy fall-back: if neither pair value is set but we have a
        // legacy term string like "2025-2026" or "Jun 2025 - May 2026",
        // best-effort split so the user does not lose context.
        if (!from.value && !to.value && data.term) {
          const parts = String(data.term).split(/\s*(?:\u2013|\u2014|-|to)\s*/i).slice(0, 2);
          const looksLikeYear = (s) => /^\d{4}$/.test(String(s || '').trim());
          if (parts[0] && looksLikeYear(parts[0])) from.value = `${parts[0].trim()}-01`;
          if (parts[1] && looksLikeYear(parts[1])) to.value   = `${parts[1].trim()}-12`;
        }
        row.append(from, sep, to);
        wrap.appendChild(row);
        const hint = document.createElement('span');
        hint.className = 'tsh-hint tsh-month-range-hint';
        hint.textContent = 'Pick the start and end month / year of this committee term.';
        wrap.appendChild(hint);
        form.appendChild(wrap);
        continue;
      } else if (field.type === 'photo') {
        // File picker + URL input + thumb preview. A selected file is
        // uploaded to /directory/photo which commits it to the repo and
        // returns the raw URL; that URL is then written into the URL
        // input. The URL input also accepts pasted external URLs.
        const photoWrap = document.createElement('div');
        photoWrap.className = 'tsh-photo-upload';
        const thumb = document.createElement('div');
        thumb.className = 'tsh-photo-thumb';
        const setThumb = (src) => {
          thumb.innerHTML = '';
          if (src) {
            const im = document.createElement('img');
            im.alt = '';
            im.referrerPolicy = 'no-referrer';
            im.onerror = () => { thumb.innerHTML = '<i class="fas fa-image-portrait" aria-hidden="true"></i>'; };
            im.src = src;
            thumb.appendChild(im);
          } else {
            thumb.innerHTML = '<i class="fas fa-image-portrait" aria-hidden="true"></i>';
          }
        };
        setThumb(data[field.name] || '');
        const fileId = `tsh-photo-${field.name}-${Math.random().toString(36).slice(2, 8)}`;
        const file = document.createElement('input');
        file.type = 'file';
        file.id = fileId;
        file.accept = 'image/jpeg,image/png,image/webp,image/gif';
        file.className = 'tsh-photo-file';
        const fileBtn = document.createElement('label');
        fileBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm tsh-photo-btn';
        fileBtn.htmlFor = fileId;
        fileBtn.innerHTML = '<i class="fas fa-upload" aria-hidden="true"></i><span>Upload</span>';
        input = document.createElement('input');
        input.type = 'url';
        input.name = field.name;
        input.className = 'tsh-photo-url';
        input.placeholder = field.placeholder || 'https://\u2026 or use Upload';
        input.maxLength = field.max || 500;
        if (data[field.name] != null) input.value = data[field.name];
        input.addEventListener('input', () => setThumb(input.value));
        const hint = document.createElement('span');
        hint.className = 'tsh-hint tsh-photo-hint';
        hint.textContent = 'Optional. Use Upload to commit a photo to the repo, or paste an external URL.';
        file.addEventListener('change', async () => {
          const f = file.files && file.files[0];
          if (!f) return;
          if (f.size > 5_000_000) {
            UI.toast('Image too large (max 5 MB)', { kind: 'warn' });
            file.value = '';
            return;
          }
          fileBtn.classList.add('is-busy');
          fileBtn.setAttribute('aria-disabled', 'true');
          hint.textContent = 'Uploading\u2026';
          try {
            const dataUrl = await new Promise((res, rej) => {
              const r = new FileReader();
              r.onload = () => res(String(r.result || ''));
              r.onerror = () => rej(r.error || new Error('read failed'));
              r.readAsDataURL(f);
            });
            const out = await Api.post('/directory/photo', { dataUrl, name: f.name });
            if (out && out.url) {
              input.value = out.url;
              setThumb(out.url);
              hint.textContent = 'Uploaded \u00b7 committed to repo.';
              UI.toast('Photo uploaded', { kind: 'ok' });
            } else {
              throw new Error('No URL returned');
            }
          } catch (e) {
            hint.textContent = 'Optional. Use Upload to commit a photo to the repo, or paste an external URL.';
            UI.toast('Upload failed: ' + (e && e.message ? e.message : e), { kind: 'error' });
          } finally {
            fileBtn.classList.remove('is-busy');
            fileBtn.removeAttribute('aria-disabled');
            file.value = '';
          }
        });
        photoWrap.append(thumb, fileBtn, file, input);
        wrap.appendChild(photoWrap);
        wrap.appendChild(hint);
        form.appendChild(wrap);
        continue;
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
      for (const field of fields) {
        if (field.type === 'phones') {
          const fs = form.querySelector(`fieldset.tsh-phones-repeater[data-field-name="${field.name}"]`);
          const arr = [];
          if (fs) {
            for (const inp of fs.querySelectorAll('.tsh-phone-row input')) {
              const v = (inp.value || '').trim();
              if (v && !arr.includes(v)) arr.push(v);
            }
          }
          if (arr.length) next[field.name] = arr;
          continue;
        }
        if (field.type === 'checkbox') {
          const el = form.elements[field.name];
          next[field.name] = !!(el && el.checked);
          continue;
        }
        if (field.type === 'monthRange') {
          const sName = field.startName || 'termStart';
          const eName = field.endName   || 'termEnd';
          const sEl = form.elements[sName];
          const eEl = form.elements[eName];
          const s = (sEl && sEl.value || '').trim();
          const e = (eEl && eEl.value || '').trim();
          if (s) next[sName] = s; else next[sName] = '';
          if (e) next[eName] = e; else next[eName] = '';
          const display = formatTermDisplay(s, e);
          if (display) next[field.name] = display; else next[field.name] = '';
          continue;
        }
        const el = form.elements[field.name];
        const v = (el && el.value || '').trim();
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

  function openCategoryManager(scope) {
    scope = scope || 'vendor';
    const isService = scope === 'service';
    const key = isService ? 'serviceCategories' : 'vendorCategories';
    const form = document.createElement('form');
    form.className = 'tsh-dir-form';
    form.addEventListener('submit', (e) => e.preventDefault());
    const label = document.createElement('span');
    label.className = 'tsh-label';
    label.textContent = isService ? 'Service sub-categories (one per line)' : 'Vendor categories (one per line)';
    const ta = document.createElement('textarea');
    ta.name = 'categories';
    ta.rows = 10;
    ta.value = (state[key] || []).join('\n');
    const wrap = document.createElement('div');
    wrap.className = 'tsh-field';
    wrap.append(label, ta);
    form.appendChild(wrap);

    UI.modal({
      title: isService ? 'Service sub-categories' : 'Vendor categories',
      body: form,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Apply', value: 'save', primary: true },
      ],
    }).then((choice) => {
      if (choice !== 'save') return;
      const next = ta.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const seen = new Set();
      state[key] = next.filter((c) => {
        const k = c.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
      // If the active filter is removed, reset to "All".
      if (isService) {
        if (activeServiceCategory && !state[key].includes(activeServiceCategory)) setActiveServiceCategory('');
      } else {
        if (activeCategory && !state[key].includes(activeCategory)) activeCategory = '';
      }
      setDirty(true);
      render();
    });
  }

  // ----- Save / Discard ---------------------------------------------------
  async function save() {
    const btn = $('#dirSaveBtn');
    await UI.busyButton(btn, async () => {
      try {
        // Strip tmp- ids so the server assigns proper ones.
        const payload = ['vendors', 'contacts', 'resources', 'services'].reduce((acc, kind) => {
          acc[kind] = (state[kind] || []).map((row) => {
            const out = { ...row };
            if (typeof out.id === 'string' && out.id.startsWith('tmp-')) delete out.id;
            return out;
          });
          return acc;
        }, {
          version: state.version || 1,
          vendorCategories: state.vendorCategories || [],
          serviceCategories: state.serviceCategories || [],
        });

        await Api.put('/directory', { directory: payload });
        // Reload to pick up server-assigned ids.
        const fresh = await Api.get('/directory');
        state = normalise(fresh);
        setDirty(false);
        render();
        UI.toast('Directory saved.', { kind: 'success' });
      } catch (e) {
        UI.toast(e.message || 'Save failed.', { kind: 'danger' });
        throw e;
      }
    }, { label: 'Saving directory\u2026' });
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
      vendorCategories:  Array.isArray(raw && raw.vendorCategories)  ? raw.vendorCategories  : [],
      serviceCategories: Array.isArray(raw && raw.serviceCategories) ? raw.serviceCategories : [],
      vendors:   Array.isArray(raw && raw.vendors)   ? raw.vendors   : [],
      services:  Array.isArray(raw && raw.services)  ? raw.services  : [],
      contacts:  Array.isArray(raw && raw.contacts)  ? raw.contacts  : [],
      resources: Array.isArray(raw && raw.resources) ? raw.resources : [],
      emergency: Array.isArray(raw && raw.emergency) ? raw.emergency : [],
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
      : 'Read-only — sign in as Manager, Committee or Admin to edit.';

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
    if (mgr) mgr.addEventListener('click', () => openCategoryManager('vendor'));
    const svcMgr = $('#dirManageServiceCategoriesBtn');
    if (svcMgr) svcMgr.addEventListener('click', () => openCategoryManager('service'));

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

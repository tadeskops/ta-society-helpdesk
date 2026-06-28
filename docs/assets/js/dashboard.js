// docs/assets/js/dashboard.js
// Shared dashboard logic for manager + committee pages. Lifecycle
// transitions are gated by the §7 table (the Worker is authoritative;
// this is purely UX).
(function (root) {
  'use strict';

  const Edges = {
    new:         ['triaging', 'assigned', 'rejected'],
    triaging:    ['assigned', 'in_progress', 'rejected'],
    assigned:    ['in_progress', 'resolved', 'rejected'],
    in_progress: ['resolved', 'rejected'],
    resolved:    ['reopened'],
    rejected:    ['reopened'],
    reopened:    ['triaging', 'assigned', 'in_progress'],
  };

  let opts = { role: 'MANAGER', allowDelete: false };
  let allIssues = [];
  let currentStatus = 'new';

  async function reload() {
    const tbody = document.querySelector('#issuesTable tbody');
    tbody.innerHTML = '';
    const loader = root.UI.el('tr', null,
      root.UI.el('td', { colspan: '7' }, root.UI.stateLoading('Loading issues…')));
    tbody.appendChild(loader);
    try {
      const params = new URLSearchParams();
      if (currentStatus) params.set('status', currentStatus);
      const res = await root.Api.get(`/issues?${params.toString()}`);
      allIssues = Array.isArray(res) ? res : (res.items || []);
      render();
    } catch (e) {
      tbody.innerHTML = '';
      const errRow = root.UI.el('tr', null,
        root.UI.el('td', { colspan: '7' }, root.UI.stateError(e.message || 'Could not load issues.')));
      tbody.appendChild(errRow);
      root.UI.toast(e.message || 'Could not load issues.', { kind: 'danger' });
    }
  }

  function applyFilters(list) {
    const t = document.getElementById('filterTower').value;
    const c = document.getElementById('filterCategory').value;
    const s = document.getElementById('filterSeverity').value;
    return list.filter((i) => {
      if (t && i.tower !== t) return false;
      if (c && i.category !== c) return false;
      if (s && i.severity !== s) return false;
      return true;
    });
  }

  function render() {
    const tbody = document.querySelector('#issuesTable tbody');
    const empty = document.getElementById('dashEmpty');
    tbody.innerHTML = '';
    const filtered = applyFilters(allIssues);
    empty.hidden = filtered.length !== 0;

    const overdueHrs = (root.Flags && root.Flags.tunable && root.Flags.tunable('DAILY_AUTO_ACK_HOURS', 24)) || 24;
    const overdueMs = overdueHrs * 3600 * 1000;
    const now = Date.now();

    for (const i of filtered) {
      const created = new Date(i.createdAt || 0).getTime();
      const overdue = i.status === 'new' && (now - created) > overdueMs;
      // .tsh-mcard + .is-collapsed start state: on mobile (≤720px) only the
      // summary head is visible; tap to expand. Desktop ignores both classes
      // — the head td is display:none and all other cells render normally.
      const tr = root.UI.el('tr', {
        class: (overdue ? 'tsh-row-overdue ' : '') + 'tsh-mcard is-collapsed',
      });
      tr.append(
        td('', summaryHeadFor(i), 'tsh-mcard-head'),
        td('ID',       root.UI.el('code', { class: 'tsh-id' }, i.id)),
        td('Tower',    i.tower || '—'),
        td('Category', i.category || '—'),
        td('Severity', root.UI.severityPill(i.severity)),
        td('Status',   root.UI.statusPill(i.status)),
        td('Age',      root.UI.formatRel(i.updatedAt || i.createdAt)),
        td('Actions',  actionsFor(i), 'tsh-actions-col'),
      );
      // The head cell drives the collapse toggle on phones (CSS gates the
      // visibility; the click handler is harmless on desktop because the
      // head is display:none there and never receives the event).
      const head = tr.firstChild;
      head.setAttribute('role', 'button');
      head.setAttribute('tabindex', '0');
      head.setAttribute('aria-expanded', 'false');
      const toggle = () => {
        const collapsed = tr.classList.toggle('is-collapsed');
        head.setAttribute('aria-expanded', String(!collapsed));
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
      tbody.appendChild(tr);
    }
  }

  // Mobile-only summary strip rendered inside the first cell of every row.
  // Carries the at-a-glance fields (ID + status + age + chevron) so the
  // user can scan the list without first expanding every card.
  function summaryHeadFor(i) {
    const wrap = root.UI.el('div', { class: 'tsh-mcard-summary' });
    wrap.append(
      root.UI.el('code', { class: 'tsh-mcard-summary-id' }, i.id),
      root.UI.statusPill(i.status),
      root.UI.el('span', { class: 'tsh-mcard-summary-age' },
        root.UI.formatRel(i.updatedAt || i.createdAt)),
    );
    const chev = root.UI.el('i', {
      class: 'fas fa-chevron-down tsh-mcard-summary-chev',
      'aria-hidden': 'true',
    });
    wrap.appendChild(chev);
    return wrap;
  }

  // data-label drives the responsive stacked layout on phones (theme.css
  // ".tsh-table td::before { content: attr(data-label); }").
  function td(label, content, cls) {
    const cell = document.createElement('td');
    cell.setAttribute('data-label', label);
    if (cls) cell.className = cls;
    if (content && content.nodeType) cell.appendChild(content);
    else cell.textContent = content == null ? '' : String(content);
    return cell;
  }

  function actionsFor(issue) {
    const wrap = root.UI.el('div', { class: 'tsh-row-actions' });
    const btn = root.UI.el('button', {
      type: 'button',
      class: 'tsh-btn tsh-btn-info tsh-btn-sm tsh-row-actions-view',
      onclick: (e) => { e.stopPropagation(); openDetail(issue); },
    },
      root.UI.el('i', { class: 'fas fa-eye', 'aria-hidden': 'true' }),
      ' View & take action');
    wrap.appendChild(btn);
    return wrap;
  }

  async function openDetail(issue) {
    const next = Edges[issue.status] || [];
    const body = root.UI.el('div', { class: 'tsh-detail' });
    body.appendChild(detailMeta(issue));
    if (issue.description) body.appendChild(root.UI.el('p', { class: 'tsh-detail-desc' }, issue.description));
    if (issue.photos && issue.photos.length) {
      const ph = root.UI.el('div', { class: 'tsh-photo-grid' });
      for (const url of issue.photos) {
        ph.appendChild(root.UI.el('img', { src: url, 'data-tsh-full': url, alt: '', loading: 'lazy' }));
      }
      body.appendChild(ph);
      // Bind the lightbox after the modal paints (next microtask).
      setTimeout(() => root.UI.Lightbox.attach(body), 0);
    }

    const actions = [];
    for (const to of next) {
      actions.push({ label: `→ ${labelFor(to)}`, value: { kind: 'transition', to }, primary: to === 'assigned' || to === 'resolved' });
    }
    if (opts.allowDelete) {
      actions.push({ label: 'Delete', value: { kind: 'delete' }, danger: true });
    }
    actions.push({ label: 'Close', value: null });

    const result = await root.UI.modal({ title: issue.id + ' · ' + (issue.category || ''), body, actions });
    if (!result) return;

    if (result.kind === 'transition') return doTransition(issue, result.to);
    if (result.kind === 'delete')     return doDelete(issue);
  }

  function labelFor(s) {
    return ({ triaging: 'Start review', assigned: 'Assign', in_progress: 'In progress', resolved: 'Resolve', rejected: 'Reject', reopened: 'Reopen' }[s]) || s;
  }

  function detailMeta(issue) {
    const grid = root.UI.el('dl', { class: 'tsh-detail-meta' });
    const add = (k, v) => { grid.appendChild(root.UI.el('dt', null, k)); grid.appendChild(root.UI.el('dd', null, v == null || v === '' ? '—' : String(v))); };
    add('ID', issue.id);
    add('Tower', issue.tower);
    add('Category', issue.category + ' · ' + (issue.subCategory || ''));
    add('Location', issue.location);
    add('Severity', issue.severity || '—');
    add('Status', issue.status);
    add('Created', root.UI.formatRel(issue.createdAt));
    add('Updated', root.UI.formatRel(issue.updatedAt));
    return grid;
  }

  async function doTransition(issue, to) {
    let extra = {};
    if (to === 'resolved') {
      const notes = await promptText('Resolution notes (required)');
      if (!notes) return;
      extra.resolutionNotes = notes;
      if (root.Flags.on('FEATURE_DAILY_COST_FIELD')) {
        const c = await promptText('Cost (optional, numeric)');
        if (c && !isNaN(Number(c))) extra.cost = Number(c);
      }
    } else if (to === 'rejected') {
      const reason = await promptText('Rejection reason');
      if (!reason) return;
      extra.notes = reason;
    } else if (to === 'assigned') {
      const sev = await promptSeverity();
      if (sev) extra.severity = sev;
      const v = await promptText('Vendor / assignee (optional)');
      if (v) extra.notes = v;
    }

    try {
      await root.Api.patch(`/issues/${encodeURIComponent(issue.id)}`, { to, ...extra });
      root.UI.toast(`${issue.id} → ${to}`, { kind: 'success' });
      reload();
    } catch (e) {
      root.UI.toast(e.message || 'Update failed.', { kind: 'danger' });
    }
  }

  async function doDelete(issue) {
    const reason = await promptText('Reason for deletion');
    if (!reason) return;
    try {
      await root.Api.post(`/issues/${encodeURIComponent(issue.id)}/delete`, { reason });
      root.UI.toast(`${issue.id} deleted.`, { kind: 'success' });
      reload();
    } catch (e) {
      root.UI.toast(e.message || 'Delete failed.', { kind: 'danger' });
    }
  }

  function promptText(title) {
    return new Promise((resolve) => {
      const input = root.UI.el('textarea', { rows: 3, class: 'tsh-input-block', style: { width: '100%' } });
      root.UI.modal({
        title, body: input,
        actions: [
          { label: 'Cancel', value: null },
          { label: 'OK', value: 'OK', primary: true },
        ],
      }).then((v) => resolve(v ? input.value.trim() : null));
      setTimeout(() => input.focus(), 50);
    });
  }

  function promptSeverity() {
    return new Promise((resolve) => {
      const sel = root.UI.el('select', { class: 'tsh-input-block', style: { width: '100%' } },
        root.UI.el('option', { value: '' }, '(unchanged)'),
        root.UI.el('option', { value: 'critical' }, 'Critical'),
        root.UI.el('option', { value: 'high' }, 'High'),
        root.UI.el('option', { value: 'medium' }, 'Medium'),
        root.UI.el('option', { value: 'low' }, 'Low'),
      );
      root.UI.modal({
        title: 'Set severity', body: sel,
        actions: [
          { label: 'Skip', value: null },
          { label: 'Apply', value: 'apply', primary: true },
        ],
      }).then((v) => resolve(v ? sel.value : null));
    });
  }

  function boot(o) {
    opts = Object.assign({}, opts, o || {});

    // On phones default the status tab to "All" so visitors see every issue
    // in a single scroll without first switching tabs. Desktop keeps "New"
    // as the actionable focus for triage. mobileifyTabs syncs the native
    // <select> off these aria-selected flags.
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
    if (isMobile) {
      currentStatus = '';
      for (const t of document.querySelectorAll('.tsh-tab')) {
        const isAll = (t.dataset.status === '');
        t.classList.toggle('tsh-tab-active', isAll);
        t.setAttribute('aria-selected', String(isAll));
      }
    }

    // Populate filter selects from /config.
    const towerSel = document.getElementById('filterTower');
    const catSel   = document.getElementById('filterCategory');
    for (const t of root.Flags.list('towers'))     towerSel.appendChild(root.UI.el('option', { value: t }, t));
    for (const c of root.Flags.list('categories')) catSel.appendChild(root.UI.el('option', { value: c }, c));

    for (const tab of document.querySelectorAll('.tsh-tab')) {
      tab.addEventListener('click', () => {
        for (const t of document.querySelectorAll('.tsh-tab')) { t.classList.remove('tsh-tab-active'); t.setAttribute('aria-selected', 'false'); }
        tab.classList.add('tsh-tab-active'); tab.setAttribute('aria-selected', 'true');
        currentStatus = tab.dataset.status;
        reload();
      });
    }
    for (const id of ['filterTower', 'filterCategory', 'filterSeverity']) {
      document.getElementById(id).addEventListener('change', render);
    }
    const applyBtn = document.getElementById('applyFiltersBtn');
    if (applyBtn) applyBtn.addEventListener('click', render);
    document.getElementById('refreshBtn').addEventListener('click', reload);
    reload();
  }

  root.Dashboard = { boot, reload };
})(window);

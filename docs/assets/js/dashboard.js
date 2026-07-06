// docs/assets/js/dashboard.js
// Shared dashboard logic for manager + committee pages. Lifecycle
// transitions are gated by the §7 table (the Worker is authoritative;
// this is purely UX).
(function (root) {
  'use strict';

  // Minimized default lifecycle (see APP_BRIEF_PROMPT.md §7).
  // `triaging` is retained only as an outgoing source so legacy tickets
  // that were created before the Reviewing step was retired can still be
  // moved forward. New tickets never enter `triaging`.
  //
  // Wire values match the Worker Status enum exactly (hyphen, not
  // underscore) — the client sends these strings back on PATCH
  // /issues/:id and the worker rejects anything not in STATUSES.
  const Edges = {
    new:           ['assigned', 'rejected'],
    triaging:      ['assigned', 'rejected'],
    assigned:      ['in-progress', 'resolved', 'rejected'],
    'in-progress': ['resolved', 'rejected'],
    resolved:      ['reopened'],
    rejected:      ['reopened'],
    reopened:      ['assigned', 'in-progress'],
  };

  // role-keyed flags drive what the detail modal exposes. The Worker is
  // authoritative; these flags only shape what the UI offers.
  //   allowArchive  -> shows 'Archive' (reason REQUIRED). Manager only.
  //   allowDelete   -> shows 'Delete'  (reason optional). Committee+.
  let opts = { role: 'MANAGER', allowDelete: false, allowArchive: false };
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

    const overdueHrs = (root.Flags && root.Flags.tunable && root.Flags.tunable('DAILY_AUTO_ASSIGN_HOURS', 4)) || 4;
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
        td('ID',       idCellFor(i), 'tsh-id-col'),
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

  // ID cell on desktop carries the ticket id plus a single-line description
  // preview so a reviewer can scan the table without opening every row.
  function idCellFor(i) {
    const wrap = root.UI.el('div', { class: 'tsh-id-wrap' });
    wrap.appendChild(root.UI.el('code', { class: 'tsh-id' }, i.id));
    const desc = (i.description || '').trim();
    if (desc) {
      wrap.appendChild(root.UI.el('span',
        { class: 'tsh-id-desc', title: desc },
        desc.slice(0, 90)));
    }
    return wrap;
  }

  // Mobile-only summary strip rendered inside the first cell of every row.
  // Carries the at-a-glance fields (ID + status + age + chevron) plus a
  // single-line description preview so the user can scan the list without
  // first expanding every card.
  function summaryHeadFor(i) {
    const wrap = root.UI.el('div', { class: 'tsh-mcard-summary' });
    const top  = root.UI.el('div', { class: 'tsh-mcard-summary-top' },
      root.UI.el('code', { class: 'tsh-mcard-summary-id' }, i.id),
      root.UI.statusPill(i.status),
      root.UI.el('span', { class: 'tsh-mcard-summary-age' },
        root.UI.formatRel(i.updatedAt || i.createdAt)),
      root.UI.el('i', {
        class: 'fas fa-chevron-down tsh-mcard-summary-chev',
        'aria-hidden': 'true',
      }));
    wrap.appendChild(top);
    const desc = (i.description || '').trim();
    if (desc) {
      wrap.appendChild(root.UI.el('p',
        { class: 'tsh-mcard-summary-desc' },
        desc.slice(0, 120)));
    }
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
    if (opts.allowArchive) {
      actions.push({ label: 'Archive', value: { kind: 'archive' } });
    }
    if (opts.allowDelete) {
      actions.push({ label: 'Delete', value: { kind: 'delete' }, danger: true });
    }
    actions.push({ label: 'Close', value: null });

    const result = await root.UI.modal({ title: issue.id + ' · ' + (issue.category || ''), body, actions });
    if (!result) return;

    if (result.kind === 'transition') return doTransition(issue, result.to);
    if (result.kind === 'archive')    return doArchive(issue);
    if (result.kind === 'delete')     return doDelete(issue);
  }

  function labelFor(s) {
    return ({ triaging: 'Start review', assigned: 'Assign', 'in-progress': 'In progress', resolved: 'Resolve', rejected: 'Reject', reopened: 'Reopen' }[s]) || s;
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

    const busy = root.UI.busyOverlay(`Saving ${issue.id} \u2192 ${labelFor(to)}\u2026`);
    try {
      await root.Api.patch(`/issues/${encodeURIComponent(issue.id)}`, { to, ...extra });
      busy.close();
      root.UI.toast(`${issue.id} \u2192 ${labelFor(to)}`, { kind: 'success' });
      const after = opts.onReload || reload;
      after();
    } catch (e) {
      busy.close();
      root.UI.toast(e.message || 'Update failed.', { kind: 'danger' });
    }
  }

  // Archive: manager-facing soft-removal. Reason is REQUIRED because the
  // audit log captures *why* a ticket left the active board, and managers
  // operate without the elevated committee oversight. The textarea shows
  // an asterisk and an empty submit is rejected with a popup.
  async function doArchive(issue) {
    let reason;
    while (true) {
      reason = await promptText('Reason to archive', { required: true });
      if (reason === null) return;
      if (reason) break;
      await root.UI.modal({
        title: 'Reason required',
        body: 'Please record why this issue is being archived. The reason is logged with your account.',
        actions: [{ label: 'OK', value: true, primary: true }],
      });
    }

    const busy = root.UI.busyOverlay(`Archiving ${issue.id}\u2026`);
    try {
      // Backed by the existing soft-delete route — the Worker already
      // permits MANAGER on /delete. We tag the audit detail with an
      // [archive] prefix so the audit log distinguishes archives from
      // committee/dev deletions.
      await root.Api.post(`/issues/${encodeURIComponent(issue.id)}/delete`,
        { reason: `[archive] ${reason}` });
      busy.close();
      root.UI.toast(`${issue.id} archived.`, { kind: 'success' });
      const after = opts.onReload || reload;
      after();
    } catch (e) {
      busy.close();
      root.UI.toast(e.message || 'Archive failed.', { kind: 'danger' });
    }
  }

  // Delete: committee / admin hard-removal. Reason is OPTIONAL —
  // committee oversight already covers intent; the audit log still
  // captures the actor + timestamp even if the reason is blank.
  async function doDelete(issue) {
    const reason = await promptText('Reason for deletion (optional)');
    if (reason === null) return;          // user cancelled
    const busy = root.UI.busyOverlay(`Deleting ${issue.id}\u2026`);
    try {
      await root.Api.post(`/issues/${encodeURIComponent(issue.id)}/delete`, { reason: reason || '' });
      busy.close();
      root.UI.toast(`${issue.id} deleted.`, { kind: 'success' });
      const after = opts.onReload || reload;
      after();
    } catch (e) {
      busy.close();
      root.UI.toast(e.message || 'Delete failed.', { kind: 'danger' });
    }
  }

  // promptText shows a textarea modal and resolves with the trimmed
  // value, or `null` if the user cancels.
  // When `opts.required` is true the body shows a red asterisk hint so
  // the user sees the field is mandatory; the caller is still responsible
  // for re-prompting if the value comes back empty.
  function promptText(title, promptOpts) {
    const required = !!(promptOpts && promptOpts.required);
    return new Promise((resolve) => {
      const input = root.UI.el('textarea', { rows: 3, class: 'tsh-input-block', style: { width: '100%' } });
      const body = root.UI.el('div', { class: 'tsh-prompt-body' });
      if (required) {
        body.appendChild(root.UI.el('p', { class: 'tsh-required-hint' },
          root.UI.el('span', { class: 'tsh-required-mark', 'aria-hidden': 'true' }, '*'),
          ' This field is required.'));
      }
      body.appendChild(input);
      root.UI.modal({
        title,
        body,
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

  // Allow other pages (e.g. public-board) to wire actions through this
  // module without booting the manage-page table. Callers configure the
  // role + reload hook, then call openDetail(issue) directly.
  function configure(o) {
    opts = Object.assign({}, opts, o || {});
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
    // Register the current filtered list as the data source for the
    // header's "Export PDF" button. Re-evaluated at click time so
    // freshly applied filters are honoured. Exception: the canonical
    // "full report" export must not be silently narrowed by the current
    // tab or filter widgets, so we fetch a fresh unfiltered snapshot at
    // click time. The server side still gates the always-latest write
    // behind role >= COMMITTEE + updateCanonical=true.
    if (root.TSH_REPORT && typeof root.TSH_REPORT.bind === 'function') {
      root.TSH_REPORT.bind({
        title: (document.title || 'Society Help Desk').replace(/\s*·.*$/, '') + ' — Report',
        source: 'manage',
        getItems: async () => {
          if (!root.Api || !root.Api.get) return applyFilters(allIssues);
          try {
            const res = await root.Api.get('/issues');
            const full = Array.isArray(res) ? res : (res.items || []);
            return full;
          } catch (_e) {
            // Fallback: reuse whatever's already loaded rather than blocking
            // the export. The user still gets a PDF, just narrower.
            return applyFilters(allIssues);
          }
        },
      });
    }
    reload();
  }

  root.Dashboard = { boot, reload, configure, openDetail };
})(window);

// docs/assets/js/treasury.js
// Treasury & Reimbursements — controller for docs/treasury.html.
//
// Feature-flag gated (FEATURE_TREASURY). Talks to the Worker's /treasury/*
// routes; unwraps the {ok, data, error} envelope via the Api helper
// (which returns json.data directly).
//
// Contract (see worker/src/routes/treasury.ts):
//   GET  /treasury/reimbursements               -> { items, storageConfigured }
//   POST /treasury/reimbursements                -> { reimbursement }
//   PATCH /treasury/reimbursements/:id           -> { reimbursement }
//   POST /treasury/reimbursements/:id/payment    -> { reimbursement, expense }
//   GET  /treasury/expenses?month=YYYY-MM        -> { items, storageConfigured }
//   POST /treasury/expenses                      -> { expense }
//   PATCH /treasury/expenses/:id                 -> { expense }
//   POST /treasury/expenses/:id/delete           -> { expense }
//   GET  /treasury/summary?month=YYYY-MM         -> { month, totalMonth,
//                                                     byCategory, openLiability,
//                                                     openCount, paidMonth,
//                                                     paidMonthCount,
//                                                     expenseCount }
//
// Reimbursement record fields we consume:
//   id, createdAt, createdBy, createdByFlat?, category, purpose, amount,
//   expenseDate, mode, originalRef?, status, proofs[], paymentProofs[],
//   timeline[{at,by,action,note?}], approvals[], rejectReason?,
//   linkedExpenseId?, updatedAt
//
// Expense record fields we consume:
//   id, createdAt, createdBy, date, payee, category, amount, mode,
//   reference?, notes?, receipts[], linkedReimbursementId?, updatedAt,
//   deletedAt?, deletedBy?, deletedReason?
(function (root) {
  'use strict';

  // --------------- Constants ------------------------------------------------
  // These MUST stay aligned with worker/src/routes/treasury.ts (ALL_MODES,
  // ALL_STATUSES). If the worker adds/removes a mode, update here.
  const MODES = ['cash', 'upi', 'card', 'cheque', 'bank', 'auto-debit', 'other'];
  const MODE_LABEL = {
    cash: 'Cash',
    upi: 'UPI',
    card: 'Card',
    cheque: 'Cheque',
    bank: 'Bank transfer',
    'auto-debit': 'Auto-debit',
    other: 'Other',
  };
  const STATUS_LABEL = {
    requested: 'Requested',
    'under-review': 'Under review',
    approved: 'Approved',
    paid: 'Paid',
    rejected: 'Rejected',
    closed: 'Closed',
  };
  const FALLBACK_CATEGORIES = [
    'Repairs', 'Plumbing', 'Electrical', 'Housekeeping', 'Security',
    'Utilities', 'Office/Admin', 'Miscellaneous',
  ];
  const MAX_FILE_MB = 5;

  // --------------- State ----------------------------------------------------
  const state = {
    who: null,          // { email, roles, primary, identity }
    isStaff: false,
    isCommittee: false,
    canApprove: false,
    canPay: false,
    canRecordExpense: false,
    canRaise: false,
    storageConfigured: true,

    categories: FALLBACK_CATEGORIES,

    reimbursements: [],
    expenses: [],
    summary: null,

    // UI
    activeTab: 'reimbursements',
    filters: { search: '', status: '', category: '', scope: 'all' },
    expFilters: { search: '', month: '', category: '' },
    sumMonth: monthKeyIst(),
    selectedRmbId: null,
    listBusy: false,
  };

  // --------------- Small utilities ------------------------------------------
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v != null && v !== false) n.setAttribute(k, String(v));
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  function debounce(fn, ms) {
    let t; return function () {
      clearTimeout(t);
      const args = arguments, ctx = this;
      t = setTimeout(() => fn.apply(ctx, args), ms);
    };
  }
  function inr(n) {
    const v = Number(n) || 0;
    return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }
  function dateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  function dateLong(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function relDay(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!t) return '';
    const now = Date.now();
    const days = Math.floor((now - t) / 86400000);
    if (days < 1) return 'Today';
    if (days < 2) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return dateShort(iso);
  }
  function monthKeyIst(iso) {
    // Return YYYY-MM in Asia/Kolkata. IST is UTC+5:30 with no DST.
    const t = iso ? new Date(iso).getTime() : Date.now();
    if (isNaN(t)) return '';
    const ist = new Date(t + 5.5 * 60 * 60 * 1000);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    return y + '-' + m;
  }
  function monthLabel(key) {
    if (!key) return '';
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  }
  function personLabel(email, flat) {
    // Derive a compact display name from the requester's email.
    // Prefer flat number if we have one — much friendlier than an email.
    if (flat) return flat + ' · ' + (email || '').split('@')[0];
    if (!email) return '—';
    const local = email.split('@')[0];
    // "first.last" -> "First Last"; single token stays as-is.
    return local.split('.').map(p => p ? p[0].toUpperCase() + p.slice(1) : '').join(' ').trim() || email;
  }
  function isImage(name) { return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name || ''); }
  function isPdf(name)   { return /\.pdf$/i.test(name || ''); }

  // --------------- Init -----------------------------------------------------
  async function init() {
    if (!root.Flags) throw new Error('Flags module missing');
    if (!root.Api)   throw new Error('Api module missing');

    // Boot the Flags/Auth pipeline (loads /config + /whoami).
    await root.Flags.ready();

    // Master gate — throws FeatureDisabled:FEATURE_TREASURY if off. The Flags
    // module will surface the standard "Feature disabled" page.
    root.Flags.ensureFeature('FEATURE_TREASURY', 'Treasury');

    // Any resident that made it past auth can see their own history.
    root.Flags.ensureAuthorized('RESIDENT');

    state.who = await root.Flags.whoami();
    const primary = (state.who && state.who.primary) || 'UNKNOWN';
    state.isStaff       = root.Flags.isAtLeast(primary, 'MANAGER');
    state.isCommittee   = root.Flags.isAtLeast(primary, 'COMMITTEE');
    // Manager-side flags are additive on top of role rank.
    state.canApprove       = state.isStaff && !!root.Flags.on('FEATURE_TREASURY_MANAGER_APPROVE');
    state.canPay           = state.isStaff && !!root.Flags.on('FEATURE_TREASURY_MANAGER_PAY');
    state.canRecordExpense = state.isStaff && !!root.Flags.on('FEATURE_TREASURY_MANAGER_RECORD_EXPENSE');
    state.canRaise         = !!root.Flags.on('FEATURE_TREASURY_RESIDENT_RAISE');

    // Categories from site.json (falls back to a sane default list).
    const cfg = await root.Api.get('/config').catch(() => null);
    const cats = cfg && cfg.lists && cfg.lists.treasuryCategories;
    if (Array.isArray(cats) && cats.length) state.categories = cats;

    populateFilters();
    populateMonthPickers();
    wireStaticEvents();
    applyRoleVisibility();

    // Fetch reimbursements first (needed for every role); staff also get
    // expenses + summary in parallel.
    await refreshRmb();
    if (state.isStaff) {
      await Promise.all([refreshExpenses(), refreshSummary()]);
    }
    computeKpis();
  }

  // --------------- Role visibility ------------------------------------------
  // Anything marked data-tr-min-role="MANAGER"/"COMMITTEE" is revealed only
  // for roles that clear the bar. Doing this once at init keeps the DOM
  // consistent and avoids relying on inline handlers.
  function applyRoleVisibility() {
    const primary = (state.who && state.who.primary) || 'UNKNOWN';
    $$('[data-tr-min-role]').forEach((n) => {
      const min = n.getAttribute('data-tr-min-role');
      n.hidden = !root.Flags.isAtLeast(primary, min);
    });
    // Hide "New request" if resident-raise flag is off AND user has no role
    // higher than resident. Committee/Admin can always create on behalf.
    const canCreate = state.canRaise || state.isStaff;
    ['#trNewBtn', '#trFab'].forEach((s) => {
      const b = $(s);
      if (b) b.hidden = !canCreate;
    });
    // Storage banner (only reveal for staff — residents don't need to see
    // config drift).
    if (state.isStaff) $('#trStorageWarn').hidden = state.storageConfigured;
  }

  // --------------- Filter dropdowns + month pickers -------------------------
  function populateFilters() {
    const catSel = $('#trCategoryFilter');
    const expCatSel = $('#trExpCategory');
    for (const c of state.categories) {
      catSel.appendChild(el('option', { value: c }, c));
      expCatSel.appendChild(el('option', { value: c }, c));
    }
  }
  function populateMonthPickers() {
    const now = new Date();
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      months.push({ key: k, label: monthLabel(k) });
    }
    for (const sel of [$('#trExpMonth'), $('#trSumMonth')]) {
      if (!sel) continue;
      for (const m of months) sel.appendChild(el('option', { value: m.key }, m.label));
      sel.value = months[0].key;
    }
    state.expFilters.month = months[0].key;
    state.sumMonth = months[0].key;
  }

  // --------------- Event wiring ---------------------------------------------
  function wireStaticEvents() {
    // Tabs
    $$('.tr-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tr-tab');
        if (!tab || btn.hidden) return;
        state.activeTab = tab;
        $$('.tr-tab').forEach((b) => {
          const on = b.getAttribute('data-tr-tab') === tab;
          b.classList.toggle('on', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        $$('.tr-section').forEach((s) => { s.hidden = s.getAttribute('data-tr-section') !== tab; });
        if (tab === 'summary') refreshSummary();
        if (tab === 'expenses') refreshExpenses();
      });
    });

    // Ribbon filters (reimbursements)
    const onSearch = debounce(() => { state.filters.search = $('#trSearch').value.trim().toLowerCase(); renderRmb(); }, 180);
    $('#trSearch').addEventListener('input', onSearch);
    $('#trStatusFilter').addEventListener('change', (e) => { state.filters.status = e.target.value; renderRmb(); });
    $('#trCategoryFilter').addEventListener('change', (e) => { state.filters.category = e.target.value; renderRmb(); });
    $('#trScopeFilter').addEventListener('change', (e) => { state.filters.scope = e.target.value; refreshRmb(); });

    // Expenses filters
    const onExpSearch = debounce(() => { state.expFilters.search = $('#trExpSearch').value.trim().toLowerCase(); renderExpenses(); }, 180);
    $('#trExpSearch').addEventListener('input', onExpSearch);
    $('#trExpMonth').addEventListener('change', (e) => { state.expFilters.month = e.target.value; refreshExpenses(); });
    $('#trExpCategory').addEventListener('change', (e) => { state.expFilters.category = e.target.value; refreshExpenses(); });
    $('#trAddExpenseBtn').addEventListener('click', openExpenseModal);

    // Summary month
    $('#trSumMonth').addEventListener('change', (e) => { state.sumMonth = e.target.value; refreshSummary(); });

    // Create buttons
    $('#trNewBtn').addEventListener('click', openNewRmbModal);
    const fab = $('#trFab'); if (fab) fab.addEventListener('click', openNewRmbModal);

    // PDF export
    $('#trExportBtn').addEventListener('click', exportCurrentView);
  }

  // --------------- Reimbursement fetch --------------------------------------
  async function refreshRmb() {
    if (state.listBusy) return;
    state.listBusy = true;
    try {
      const params = new URLSearchParams();
      // 'scope' controls staff view: resident always gets own via server;
      // staff can toggle 'mine' to filter down.
      params.set('scope', state.isStaff ? state.filters.scope : 'mine');
      const data = await root.Api.get('/treasury/reimbursements?' + params.toString());
      const items = Array.isArray(data && data.items) ? data.items : [];
      state.reimbursements = items;
      state.storageConfigured = !!(data && data.storageConfigured);
      if (state.isStaff) $('#trStorageWarn').hidden = state.storageConfigured;
      // If selected id is no longer in list, drop it.
      if (state.selectedRmbId && !items.some((r) => r.id === state.selectedRmbId)) {
        state.selectedRmbId = null;
      }
      renderRmb();
      computeKpis();
    } catch (e) {
      root.UI.toast('Could not load reimbursements: ' + (e && e.message || 'error'), { kind: 'error' });
      state.reimbursements = [];
      renderRmb();
    } finally {
      state.listBusy = false;
    }
  }

  // Client-side filter/sort. Server already scopes by identity.
  function filteredRmb() {
    const f = state.filters;
    return state.reimbursements
      .filter((r) => {
        if (f.status && r.status !== f.status) return false;
        if (f.category && r.category !== f.category) return false;
        if (f.search) {
          const hay = [
            r.id, r.createdBy, r.createdByFlat, r.category, r.purpose,
            String(r.amount || ''), r.status,
          ].map((x) => String(x || '').toLowerCase()).join(' ');
          if (!hay.includes(f.search)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  function renderRmb() {
    const ul = $('#trRmbList');
    const empty = $('#trRmbEmpty');
    // Preserve the column-header row; wipe everything else.
    const head = ul.querySelector('.tr-list-head');
    ul.innerHTML = '';
    if (head) ul.appendChild(head);

    const items = filteredRmb();
    // Update tab count.
    const tabCount = $('[data-tr-count="reimbursements"]'); if (tabCount) tabCount.textContent = String(items.length);

    if (!items.length) {
      empty.hidden = false;
      renderInspector(null);
      return;
    }
    empty.hidden = true;

    // Group by day for the mobile card feed. Day headers are hidden on
    // desktop by CSS.
    let lastDay = null;
    for (const r of items) {
      const day = (r.createdAt || '').slice(0, 10);
      if (day && day !== lastDay) {
        lastDay = day;
        ul.appendChild(el('li', { class: 'tr-day-h', 'aria-hidden': 'true' }, relDay(r.createdAt)));
      }
      ul.appendChild(rmbRow(r));
    }
    if (state.selectedRmbId) {
      const found = state.reimbursements.find((r) => r.id === state.selectedRmbId);
      renderInspector(found || null);
    }
  }

  function rmbRow(r) {
    const mine = (state.who && r.createdBy === state.who.email);
    const li = el('li', { class: 'tr-item' + (mine ? ' mine' : '') + (state.selectedRmbId === r.id ? ' on' : ''), 'data-id': r.id, tabindex: 0 });
    li.setAttribute('role', 'button');

    li.appendChild(el('span', { class: 'tr-i-id' }, r.id));
    const whoNode = el('span', { class: 'tr-i-who' },
      el('b', {}, personLabel(r.createdBy, r.createdByFlat)),
      mine ? el('span', { class: 'tr-badge-you' }, 'YOU') : null,
    );
    li.appendChild(whoNode);
    li.appendChild(el('span', { class: 'tr-i-cat' }, el('span', { class: 'tr-pill tr-pill-cat' }, r.category || '—')));
    li.appendChild(el('span', { class: 'tr-i-purp' }, r.purpose || '—'));
    li.appendChild(el('span', { class: 'tr-i-date' }, dateShort(r.expenseDate || r.createdAt)));
    li.appendChild(el('span', { class: 'tr-i-amt' }, inr(r.amount)));
    li.appendChild(el('span', { class: 'tr-i-proofs' }, proofsCell(r)));
    li.appendChild(el('span', { class: 'tr-i-status' }, statusPill(r.status)));

    // Meta line (mobile only — hidden by CSS on desktop). Uses the same
    // child <span>s cloned briefly by reference to avoid extra render cost;
    // simpler to just render textual meta here.
    const proofCount = (r.proofs || []).length + (r.paymentProofs || []).length;
    li.appendChild(el('span', { class: 'tr-i-meta' },
      el('span', {}, r.category || '—'),
      el('span', {}, dateShort(r.expenseDate || r.createdAt)),
      el('span', {}, proofCount ? (proofCount + ' file' + (proofCount === 1 ? '' : 's')) : 'No files'),
    ));

    li.addEventListener('click', () => selectRmb(r.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRmb(r.id); }
    });
    return li;
  }

  function statusPill(status) {
    return el('span', { class: 'tr-pill tr-pill-' + (status || 'requested') }, STATUS_LABEL[status] || status || '—');
  }
  function modePill(mode) {
    return el('span', { class: 'tr-pill tr-pill-mode' }, MODE_LABEL[mode] || mode || '—');
  }
  function proofsCell(r) {
    const proofs = (r.proofs || []).length;
    const paid   = (r.paymentProofs || []).length;
    if (!proofs && !paid) return el('span', { class: 'tr-proofs-cell' }, '—');
    const parts = [];
    if (proofs) parts.push(el('span', {},
      el('i', { class: 'fas fa-paperclip', style: 'font-size:10px;margin-right:3px' }), String(proofs)));
    if (paid) parts.push(el('span', { class: 'pay' },
      el('i', { class: 'fas fa-money-check', style: 'font-size:10px;margin-right:3px' }), String(paid)));
    return el('span', { class: 'tr-proofs-cell' }, ...parts);
  }

  function selectRmb(id) {
    state.selectedRmbId = id;
    // Repaint the previously-active card; then re-highlight new one.
    $$('.tr-item.on', $('#trRmbList')).forEach((n) => n.classList.remove('on'));
    const node = $('#trRmbList').querySelector(`.tr-item[data-id="${cssEscape(id)}"]`);
    if (node) node.classList.add('on');
    const r = state.reimbursements.find((x) => x.id === id);
    // On phones/tablets the inspector is display:none; we open a modal
    // instead so residents actually see the detail.
    if (window.matchMedia('(min-width: 1100px)').matches) {
      renderInspector(r || null);
    } else {
      openDetailSheet(r);
    }
  }
  function cssEscape(s) {
    // Minimal — our ids are RMB-<digits>[-<n>] so a strict escape is not
    // strictly required, but keep it safe.
    return String(s).replace(/["\\]/g, (m) => '\\' + m);
  }

  // --------------- Inspector -----------------------------------------------
  function renderInspector(r) {
    const empty = $('#trInspEmpty');
    const body  = $('#trInspBody');
    if (!r) { empty.hidden = false; body.hidden = true; body.innerHTML = ''; return; }
    empty.hidden = true; body.hidden = false;
    body.innerHTML = '';
    body.appendChild(buildDetail(r, /*inline=*/true));
  }
  function openDetailSheet(r) {
    if (!r) return;
    root.UI.modal({
      title: r.id,
      body: buildDetail(r, /*inline=*/false),
      actions: [{ label: 'Close', value: null }],
    });
  }

  function buildDetail(r, inline) {
    const wrap = el('div', {});
    if (inline) {
      wrap.appendChild(el('div', { class: 'tr-insp-hdr' },
        el('h3', {}, r.id),
        statusPill(r.status),
      ));
      wrap.appendChild(el('div', { class: 'tr-insp-sub' }, r.purpose || '—'));
    } else {
      wrap.appendChild(el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px' },
        el('span', { style: 'color:var(--c-text-muted);font-size:12px' }, r.purpose || '—'),
        statusPill(r.status),
      ));
    }
    wrap.appendChild(el('div', { class: 'tr-insp-big' }, inr(r.amount)));

    const kv = el('div', { class: 'tr-insp-kv' });
    kv.append(
      el('div', { class: 'k' }, 'Requester'), el('div', {}, personLabel(r.createdBy, r.createdByFlat)),
      el('div', { class: 'k' }, 'Category'),  el('div', {}, r.category || '—'),
      el('div', { class: 'k' }, 'Spent on'),  el('div', {}, r.expenseDate || '—'),
      el('div', { class: 'k' }, 'Paid via'),  el('div', {}, MODE_LABEL[r.mode] || r.mode || '—'),
    );
    if (r.originalRef) kv.append(el('div', { class: 'k' }, 'Reference'), el('div', {}, r.originalRef));
    if (r.linkedExpenseId) kv.append(el('div', { class: 'k' }, 'Booked as'), el('div', {}, r.linkedExpenseId));
    if (r.rejectReason)    kv.append(el('div', { class: 'k' }, 'Reason'), el('div', {}, r.rejectReason));
    wrap.appendChild(kv);

    // Proofs
    const proofs = r.proofs || [];
    if (proofs.length) {
      wrap.appendChild(el('div', { class: 'tr-insp-h4' }, 'Original receipts'));
      wrap.appendChild(fileGrid(proofs, false));
    }
    // Payment slips
    const paid = r.paymentProofs || [];
    if (paid.length) {
      wrap.appendChild(el('div', { class: 'tr-insp-h4' }, 'Payment proofs'));
      wrap.appendChild(fileGrid(paid, true));
    }

    // Timeline
    const tl = r.timeline || [];
    if (tl.length) {
      wrap.appendChild(el('div', { class: 'tr-insp-h4' }, 'Timeline'));
      const ol = el('ul', { class: 'tr-timeline' });
      // Newest first for scanability.
      const sorted = tl.slice().sort((a, b) => (b.at || '').localeCompare(a.at || ''));
      for (const t of sorted) {
        const cls = t.action === 'requested' ? 'req'
                  : t.action === 'approved' || t.action === 'under-review' ? 'apr'
                  : t.action === 'paid' ? 'pai'
                  : t.action === 'rejected' ? 'rej' : '';
        ol.appendChild(el('li', {},
          el('div', { class: 'tr-dot ' + cls }),
          el('div', {},
            el('div', {}, el('span', { class: 'who' }, personLabel(t.by)), ' ', humanAction(t.action)),
            t.note ? el('div', { style: 'color:var(--c-text-muted);font-size:11px' }, t.note) : null,
            el('div', { class: 'when' }, dateLong(t.at)),
          ),
        ));
      }
      wrap.appendChild(ol);
    }

    wrap.appendChild(buildActions(r));
    return wrap;
  }
  function humanAction(a) {
    switch (a) {
      case 'requested': return 'raised the request';
      case 'under-review': return 'moved to under review';
      case 'approved': return 'approved';
      case 'paid': return 'marked as paid';
      case 'rejected': return 'rejected';
      case 'commented': return 'added a note';
      case 'closed': return 'closed';
      case 'reopened': return 'reopened';
      default: return a || '—';
    }
  }
  function fileGrid(files, isPayment) {
    const g = el('div', { class: 'tr-files' });
    for (const f of files) {
      const cls = 'tr-file ' + (isImage(f.name) ? 'img' : isPdf(f.name) ? 'pdf' : '') + (isPayment ? ' pay' : '');
      const icon = isPdf(f.name) ? 'fa-file-pdf' : isImage(f.name) ? 'fa-image' : 'fa-file';
      g.appendChild(el('a', { class: cls, href: '#', title: f.name, onclick: (e) => { e.preventDefault(); showFileInfo(f); } },
        el('i', { class: 'fas ' + icon }),
        el('span', { class: 'lbl' }, f.name),
      ));
    }
    return g;
  }
  function showFileInfo(f) {
    // Files live in the private treasury repo. Manager+ can view them
    // via /treasury/file (RBAC + path validation on the worker); the
    // link below fetches through the authenticated Api base so the JWT
    // bearer is attached, then hands the browser an object URL so
    // images/PDFs open inline in a new tab.
    const canView = f.path && (state.isCommittee || state.canApprove || state.canPay || state.canRecordExpense);
    const openBtn = canView ? el('button', {
      type: 'button', class: 'tsh-btn tsh-btn-secondary',
      style: 'margin-top:10px',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = 'Opening…';
        try {
          const tok = root.Auth && root.Auth.token();
          const url = root.Api.base() + '/treasury/file?path=' + encodeURIComponent(f.path);
          const res = await fetch(url, {
            method: 'GET',
            headers: tok ? { Authorization: `Bearer ${tok}` } : {},
            credentials: 'omit',
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || `HTTP ${res.status}`);
          }
          const blob = await res.blob();
          const objUrl = URL.createObjectURL(blob);
          const win = window.open(objUrl, '_blank', 'noopener,noreferrer');
          // Revoke after the tab has had time to load the blob so we
          // don't leak the URL forever (or invalidate it before the tab
          // reads it on a slow device).
          setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
          if (!win) alert('Popup was blocked — allow popups for this site.');
        } catch (err) {
          alert('Could not open receipt: ' + (err && err.message ? err.message : err));
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
      },
    }, el('i', { class: 'fas fa-arrow-up-right-from-square' }), ' Open receipt') : null;

    root.UI.modal({
      title: f.name,
      body: el('div', { style: 'font-size:13px;line-height:1.6' },
        el('div', {}, el('b', {}, 'Type: '), f.mime || 'unknown'),
        el('div', {}, el('b', {}, 'Size: '), Math.round((f.size || 0) / 1024) + ' KB'),
        f.path ? el('div', {}, el('b', {}, 'Path: '), el('code', { style: 'font-size:11px' }, f.path)) : null,
        el('div', { style: 'color:var(--c-text-muted);font-size:11px;margin-top:8px' },
          f.path
            ? 'Stored in the private treasury repository. Manager+ access required to open.'
            : 'File metadata only — no binary was uploaded when this record was created.'),
        openBtn,
      ),
      actions: [{ label: 'Close', value: null }],
    });
  }

  // --------------- Action buttons ------------------------------------------
  function buildActions(r) {
    const wrap = el('div', { class: 'tr-actions' });
    const isOwner = state.who && r.createdBy === state.who.email;

    // Approve / reject (Committee always; Managers with approve flag).
    if (state.isCommittee || state.canApprove) {
      if (r.status === 'requested' || r.status === 'under-review') {
        wrap.appendChild(el('button', {
          type: 'button', class: 'tsh-btn tsh-btn-approve',
          onclick: () => transition(r, 'approved'),
        }, el('i', { class: 'fas fa-check' }), ' Approve'));
        wrap.appendChild(el('button', {
          type: 'button', class: 'tsh-btn tsh-btn-reject',
          onclick: () => transition(r, 'rejected'),
        }, el('i', { class: 'fas fa-xmark' }), ' Reject'));
      }
    }
    // Pay (Committee always; Managers with pay flag).
    if ((state.isCommittee || state.canPay) && r.status === 'approved') {
      wrap.appendChild(el('button', {
        type: 'button', class: 'tsh-btn tsh-btn-pay',
        onclick: () => openPayModal(r),
      }, el('i', { class: 'fas fa-money-bill-wave' }), ' Mark as paid'));
    }
    // Close (Committee only; only from paid).
    if (state.isCommittee && r.status === 'paid') {
      wrap.appendChild(el('button', {
        type: 'button', class: 'tsh-btn tsh-btn-ghost tsh-btn-close',
        onclick: () => transition(r, 'closed'),
      }, el('i', { class: 'fas fa-lock' }), ' Close'));
    }
    // Reopen from rejected — the owner can resubmit.
    if (isOwner && r.status === 'rejected') {
      wrap.appendChild(el('button', {
        type: 'button', class: 'tsh-btn tsh-btn-ghost tsh-btn-close',
        onclick: () => transition(r, 'requested'),
      }, el('i', { class: 'fas fa-rotate-right' }), ' Resubmit'));
    }
    // Comment.
    wrap.appendChild(el('button', {
      type: 'button', class: 'tsh-btn tsh-btn-ghost tsh-btn-close',
      onclick: () => openCommentModal(r),
    }, el('i', { class: 'fas fa-comment' }), ' Add note'));

    return wrap;
  }

  async function transition(r, target) {
    let note = '';
    if (target === 'rejected') {
      const v = await promptText({ title: 'Reject reimbursement', label: 'Reason (required)', required: true });
      if (v == null) return;
      note = v;
    } else if (target === 'approved' || target === 'closed') {
      const v = await promptText({ title: target === 'approved' ? 'Approve request' : 'Close request', label: 'Note (optional)', required: false });
      if (v == null) return;
      note = v;
    } else if (target === 'requested') {
      const v = await promptText({ title: 'Resubmit', label: 'What changed? (optional)', required: false });
      if (v == null) return;
      note = v;
    }
    try {
      const body = { status: target };
      if (note) body.note = note;
      const data = await root.Api.patch('/treasury/reimbursements/' + encodeURIComponent(r.id), body);
      mergeRmb(data && data.reimbursement);
      root.UI.toast('Reimbursement updated', { kind: 'success' });
    } catch (e) {
      root.UI.toast('Update failed: ' + (e && e.message || 'error'), { kind: 'error' });
    }
  }

  async function openCommentModal(r) {
    const v = await promptText({ title: 'Add note to ' + r.id, label: 'Note', required: true });
    if (v == null) return;
    try {
      const data = await root.Api.patch('/treasury/reimbursements/' + encodeURIComponent(r.id), { note: v });
      mergeRmb(data && data.reimbursement);
      root.UI.toast('Note added', { kind: 'success' });
    } catch (e) {
      root.UI.toast('Failed: ' + (e && e.message || 'error'), { kind: 'error' });
    }
  }

  function promptText({ title, label, required, placeholder, multiline }) {
    return new Promise((resolve) => {
      const input = multiline
        ? el('textarea', { rows: 4, style: 'width:100%;box-sizing:border-box;padding:8px;font:inherit;background:var(--c-input-bg);color:var(--c-text);border:1px solid var(--c-input-border);border-radius:6px', placeholder: placeholder || '' })
        : el('input', { type: 'text', style: 'width:100%;box-sizing:border-box;padding:8px;font:inherit;background:var(--c-input-bg);color:var(--c-text);border:1px solid var(--c-input-border);border-radius:6px', placeholder: placeholder || '' });
      const body = el('div', {},
        el('label', { style: 'font-size:12px;color:var(--c-text-muted);display:block;margin-bottom:4px' }, label),
        input,
      );
      root.UI.modal({
        title,
        body,
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Save', value: '__save__', primary: true },
        ],
      }).then((ans) => {
        if (ans !== '__save__') return resolve(null);
        const v = input.value.trim();
        if (required && !v) { root.UI.toast('This field is required', { kind: 'warn' }); return resolve(null); }
        resolve(v);
      });
      // Focus after the modal partial mounts.
      setTimeout(() => { try { input.focus(); } catch (_) {} }, 40);
    });
  }

  // --------------- Payment modal --------------------------------------------
  function openPayModal(r) {
    const modeSel = el('select', { style: fieldCss() });
    for (const m of MODES) modeSel.appendChild(el('option', { value: m }, MODE_LABEL[m]));
    modeSel.value = 'bank';

    const refInput = el('input', { type: 'text', style: fieldCss(), placeholder: 'UTR / txn id / cheque no.' });
    const noteInput = el('input', { type: 'text', style: fieldCss(), placeholder: 'Optional' });
    const filePick = el('input', { type: 'file', multiple: true, accept: 'image/*,application/pdf' });
    const fileHint = el('div', { style: 'font-size:11px;color:var(--c-text-muted);margin-top:4px' },
      'Payment slip is required when paying by cash. Max ' + MAX_FILE_MB + 'MB per file.');

    const body = el('div', { style: 'display:flex;flex-direction:column;gap:10px;font-size:13px' },
      pairLabel('Mode', modeSel),
      pairLabel('Reference', refInput),
      pairLabel('Note', noteInput),
      pairLabel('Payment slip', el('div', {}, filePick, fileHint)),
    );

    root.UI.modal({
      title: 'Record payment for ' + r.id,
      body,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Confirm payment', value: '__go__', primary: true },
      ],
    }).then(async (ans) => {
      if (ans !== '__go__') return;
      const payMode = modeSel.value;
      const payRef  = refInput.value.trim();
      const note    = noteInput.value.trim();
      const files   = filePick.files;
      if (payMode === 'cash' && (!files || !files.length)) {
        root.UI.toast('Cash payment requires at least one payment slip.', { kind: 'warn' });
        return;
      }
      let paymentProofs = [];
      try {
        paymentProofs = await filesToPayload(files);
      } catch (e) {
        root.UI.toast(String(e && e.message || e), { kind: 'error' });
        return;
      }
      try {
        const data = await root.Api.post('/treasury/reimbursements/' + encodeURIComponent(r.id) + '/payment',
          { payMode, payRef: payRef || undefined, note: note || undefined, paymentProofs });
        mergeRmb(data && data.reimbursement);
        if (data && data.expense) {
          // Optimistically slot into the expenses list so switching to the
          // ledger tab immediately shows the auto-booked entry.
          state.expenses.unshift(data.expense);
          renderExpenses();
        }
        root.UI.toast('Payment recorded', { kind: 'success' });
      } catch (e) {
        root.UI.toast('Payment failed: ' + (e && e.message || 'error'), { kind: 'error' });
      }
    });
  }

  // --------------- New reimbursement modal ----------------------------------
  function openNewRmbModal() {
    const catSel = el('select', { style: fieldCss() });
    for (const c of state.categories) catSel.appendChild(el('option', { value: c }, c));
    const purpose = el('input', { type: 'text', style: fieldCss(), placeholder: 'What did you buy or pay for?', maxlength: 200 });
    const amount = el('input', { type: 'number', min: '1', step: '1', style: fieldCss(), placeholder: '0' });
    const modeSel = el('select', { style: fieldCss() });
    for (const m of MODES) modeSel.appendChild(el('option', { value: m }, MODE_LABEL[m]));
    modeSel.value = 'upi';
    const today = new Date().toISOString().slice(0, 10);
    const spentAt = el('input', { type: 'date', value: today, max: today, style: fieldCss() });
    const flat = el('input', { type: 'text', style: fieldCss(), placeholder: 'e.g. A-1204 (optional)', maxlength: 20 });
    const ref = el('input', { type: 'text', style: fieldCss(), placeholder: 'Invoice / bill number (optional)', maxlength: 100 });
    const files = el('input', { type: 'file', multiple: true, accept: 'image/*,application/pdf' });
    const filesHint = el('div', { style: 'font-size:11px;color:var(--c-text-muted);margin-top:4px' },
      'Attach the original receipt(s). Max ' + MAX_FILE_MB + 'MB per file.');

    const body = el('div', { style: 'display:flex;flex-direction:column;gap:10px;font-size:13px' },
      pairLabel('Category', catSel),
      pairLabel('Purpose', purpose),
      pairLabel('Amount (₹)', amount),
      pairLabel('Paid via', modeSel),
      pairLabel('Spent on', spentAt),
      pairLabel('Flat', flat),
      pairLabel('Reference', ref),
      pairLabel('Receipts', el('div', {}, files, filesHint)),
    );

    root.UI.modal({
      title: 'New reimbursement request',
      body,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Submit', value: '__go__', primary: true },
      ],
    }).then(async (ans) => {
      if (ans !== '__go__') return;
      const category = catSel.value;
      const purposeV = purpose.value.trim();
      const amountV = Math.round(Number(amount.value));
      const mode = modeSel.value;
      const expenseDate = spentAt.value;
      if (!category)   { root.UI.toast('Category is required', { kind: 'warn' }); return; }
      if (!purposeV)   { root.UI.toast('Purpose is required', { kind: 'warn' }); return; }
      if (!(amountV > 0)) { root.UI.toast('Amount must be positive', { kind: 'warn' }); return; }
      if (!expenseDate){ root.UI.toast('Please pick a spent-on date', { kind: 'warn' }); return; }
      let proofs = [];
      try { proofs = await filesToPayload(files.files); }
      catch (e) { root.UI.toast(String(e && e.message || e), { kind: 'error' }); return; }
      try {
        const data = await root.Api.post('/treasury/reimbursements', {
          category, purpose: purposeV, amount: amountV, expenseDate, mode,
          originalRef: ref.value.trim() || undefined,
          flat: flat.value.trim() || undefined,
          proofs,
        });
        const rec = data && data.reimbursement;
        if (rec) { state.reimbursements.unshift(rec); state.selectedRmbId = rec.id; }
        renderRmb();
        computeKpis();
        root.UI.toast('Reimbursement submitted', { kind: 'success' });
      } catch (e) {
        root.UI.toast('Submit failed: ' + (e && e.message || 'error'), { kind: 'error' });
      }
    });
    setTimeout(() => { try { purpose.focus(); } catch (_) {} }, 40);
  }

  // --------------- Expenses -------------------------------------------------
  async function refreshExpenses() {
    if (!state.isStaff) return;
    try {
      const p = new URLSearchParams();
      if (state.expFilters.month)    p.set('month', state.expFilters.month);
      if (state.expFilters.category) p.set('category', state.expFilters.category);
      const data = await root.Api.get('/treasury/expenses?' + p.toString());
      state.expenses = Array.isArray(data && data.items) ? data.items : [];
      renderExpenses();
    } catch (e) {
      root.UI.toast('Could not load expenses: ' + (e && e.message || 'error'), { kind: 'error' });
      state.expenses = [];
      renderExpenses();
    }
  }
  function filteredExpenses() {
    const f = state.expFilters;
    return state.expenses
      .filter((e) => {
        if (e.deletedAt) return false;
        if (f.search) {
          const hay = [e.id, e.payee, e.category, e.reference, e.notes, String(e.amount || '')]
            .map((x) => String(x || '').toLowerCase()).join(' ');
          if (!hay.includes(f.search)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.date || b.createdAt || '').localeCompare(a.date || a.createdAt || ''));
  }
  function renderExpenses() {
    const ul = $('#trExpList');
    const empty = $('#trExpEmpty');
    const head = ul.querySelector('.tr-list-head');
    ul.innerHTML = '';
    if (head) ul.appendChild(head);

    const items = filteredExpenses();
    const tabCount = $('[data-tr-count="expenses"]'); if (tabCount) tabCount.textContent = String(items.length);

    if (!items.length) { empty.hidden = false; return; }
    empty.hidden = true;

    let lastDay = null;
    for (const e of items) {
      const day = (e.date || e.createdAt || '').slice(0, 10);
      if (day && day !== lastDay) {
        lastDay = day;
        ul.appendChild(el('li', { class: 'tr-day-h', 'aria-hidden': 'true' }, relDay(e.date || e.createdAt)));
      }
      ul.appendChild(expRow(e));
    }
  }
  function expRow(e) {
    const li = el('li', { class: 'tr-item', 'data-id': e.id, tabindex: 0 });
    li.setAttribute('role', 'button');
    li.appendChild(el('span', { class: 'tr-i-id' }, e.id));
    li.appendChild(el('span', { class: 'tr-i-who' }, el('b', {}, e.payee || '—')));
    li.appendChild(el('span', { class: 'tr-i-cat' }, el('span', { class: 'tr-pill tr-pill-cat' }, e.category || '—')));
    const desc = [e.reference, e.notes].filter(Boolean).join(' · ') || '—';
    li.appendChild(el('span', { class: 'tr-i-purp' }, desc));
    li.appendChild(el('span', { class: 'tr-i-date' }, dateShort(e.date || e.createdAt)));
    li.appendChild(el('span', { class: 'tr-i-amt' }, inr(e.amount)));
    const rc = (e.receipts || []).length;
    li.appendChild(el('span', { class: 'tr-i-proofs' }, rc ? el('span', { class: 'tr-proofs-cell' },
      el('i', { class: 'fas fa-paperclip', style: 'font-size:10px;margin-right:3px' }), String(rc)) : '—'));
    li.appendChild(el('span', { class: 'tr-i-status' }, modePill(e.mode)));
    li.appendChild(el('span', { class: 'tr-i-meta' },
      el('span', {}, e.category || '—'),
      el('span', {}, dateShort(e.date || e.createdAt)),
      el('span', {}, MODE_LABEL[e.mode] || e.mode || '—'),
    ));
    li.addEventListener('click', () => openExpenseDetail(e));
    li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openExpenseDetail(e); } });
    return li;
  }
  function openExpenseDetail(e) {
    const body = el('div', {},
      el('div', { class: 'tr-insp-big' }, inr(e.amount)),
      el('div', { class: 'tr-insp-kv' },
        el('div', { class: 'k' }, 'Payee'),    el('div', {}, e.payee || '—'),
        el('div', { class: 'k' }, 'Category'), el('div', {}, e.category || '—'),
        el('div', { class: 'k' }, 'Date'),     el('div', {}, e.date || '—'),
        el('div', { class: 'k' }, 'Mode'),     el('div', {}, MODE_LABEL[e.mode] || e.mode || '—'),
        e.reference ? el('div', { class: 'k' }, 'Reference') : null,
        e.reference ? el('div', {}, e.reference) : null,
        e.linkedReimbursementId ? el('div', { class: 'k' }, 'Linked to') : null,
        e.linkedReimbursementId ? el('div', {}, e.linkedReimbursementId) : null,
        el('div', { class: 'k' }, 'Recorded by'), el('div', {}, personLabel(e.createdBy)),
      ),
      e.notes ? el('div', { class: 'tr-insp-h4' }, 'Notes') : null,
      e.notes ? el('div', { style: 'font-size:12px' }, e.notes) : null,
    );
    const actions = [{ label: 'Close', value: null }];
    if (state.isCommittee) {
      actions.unshift({ label: 'Delete', value: '__del__', danger: true });
    }
    root.UI.modal({ title: e.id, body, actions }).then(async (ans) => {
      if (ans !== '__del__') return;
      const reason = await promptText({ title: 'Delete expense', label: 'Reason (required)', required: true, multiline: true });
      if (reason == null) return;
      try {
        await root.Api.post('/treasury/expenses/' + encodeURIComponent(e.id) + '/delete', { reason });
        state.expenses = state.expenses.filter((x) => x.id !== e.id);
        renderExpenses();
        root.UI.toast('Expense deleted', { kind: 'success' });
      } catch (err) {
        root.UI.toast('Delete failed: ' + (err && err.message || 'error'), { kind: 'error' });
      }
    });
  }

  function openExpenseModal() {
    if (!state.canRecordExpense) {
      root.UI.toast('Recording direct expenses is not enabled.', { kind: 'warn' });
      return;
    }
    const catSel = el('select', { style: fieldCss() });
    for (const c of state.categories) catSel.appendChild(el('option', { value: c }, c));
    const payee = el('input', { type: 'text', style: fieldCss(), placeholder: 'Vendor / person paid', maxlength: 120 });
    const amount = el('input', { type: 'number', min: '1', step: '1', style: fieldCss(), placeholder: '0' });
    const modeSel = el('select', { style: fieldCss() });
    for (const m of MODES) modeSel.appendChild(el('option', { value: m }, MODE_LABEL[m]));
    modeSel.value = 'bank';
    const today = new Date().toISOString().slice(0, 10);
    const date = el('input', { type: 'date', value: today, max: today, style: fieldCss() });
    const ref = el('input', { type: 'text', style: fieldCss(), placeholder: 'UTR / txn id / bill no. (optional)', maxlength: 100 });
    const notes = el('textarea', { rows: 3, style: fieldCss({ minHeight: '80px' }), placeholder: 'Optional context', maxlength: 500 });
    const receipts = el('input', { type: 'file', multiple: true, accept: 'image/*,application/pdf' });

    const body = el('div', { style: 'display:flex;flex-direction:column;gap:10px;font-size:13px' },
      pairLabel('Payee', payee),
      pairLabel('Category', catSel),
      pairLabel('Amount (₹)', amount),
      pairLabel('Mode', modeSel),
      pairLabel('Date', date),
      pairLabel('Reference', ref),
      pairLabel('Notes', notes),
      pairLabel('Receipts', receipts),
    );
    root.UI.modal({
      title: 'Record direct expense',
      body,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Save', value: '__go__', primary: true },
      ],
    }).then(async (ans) => {
      if (ans !== '__go__') return;
      const payeeV = payee.value.trim();
      const amountV = Math.round(Number(amount.value));
      if (!payeeV) { root.UI.toast('Payee required', { kind: 'warn' }); return; }
      if (!(amountV > 0)) { root.UI.toast('Amount must be positive', { kind: 'warn' }); return; }
      let receiptsPayload = [];
      try { receiptsPayload = await filesToPayload(receipts.files); }
      catch (e) { root.UI.toast(String(e && e.message || e), { kind: 'error' }); return; }
      try {
        const data = await root.Api.post('/treasury/expenses', {
          payee: payeeV, category: catSel.value, amount: amountV, mode: modeSel.value,
          date: date.value, reference: ref.value.trim() || undefined,
          notes: notes.value.trim() || undefined, receipts: receiptsPayload,
        });
        const rec = data && data.expense;
        if (rec) state.expenses.unshift(rec);
        renderExpenses();
        root.UI.toast('Expense saved', { kind: 'success' });
      } catch (e) {
        root.UI.toast('Save failed: ' + (e && e.message || 'error'), { kind: 'error' });
      }
    });
  }

  // --------------- Summary --------------------------------------------------
  async function refreshSummary() {
    if (!state.isStaff) return;
    try {
      const data = await root.Api.get('/treasury/summary?month=' + encodeURIComponent(state.sumMonth));
      state.summary = data || null;
      renderSummary();
      computeKpis();
    } catch (e) {
      root.UI.toast('Could not load summary: ' + (e && e.message || 'error'), { kind: 'error' });
    }
  }
  function renderSummary() {
    const bars = $('#trSumBars');
    const snap = $('#trSumSnapshot');
    if (!bars || !snap) return;
    bars.innerHTML = '';
    snap.innerHTML = '';
    const s = state.summary;
    if (!s || !s.byCategory) {
      bars.appendChild(el('div', { class: 'tr-state' }, el('i', { class: 'fas fa-chart-column' }), 'No spend recorded yet.'));
      return;
    }
    const entries = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]);
    const max = entries.reduce((m, [, v]) => Math.max(m, v), 0) || 1;
    if (!entries.length) {
      bars.appendChild(el('div', { class: 'tr-state' }, el('i', { class: 'fas fa-chart-column' }), 'No spend recorded yet.'));
    } else {
      for (const [cat, amt] of entries) {
        const pct = Math.round((amt / max) * 100);
        bars.appendChild(el('div', { class: 'tr-bar-row' },
          el('div', {}, cat),
          el('div', { class: 'tr-bar-track' }, el('div', { class: 'tr-bar-fill', style: 'width:' + pct + '%' })),
          el('div', { class: 'tr-bar-val' }, inr(amt)),
        ));
      }
    }
    snap.append(
      el('div', { class: 'k' }, 'Month'),          el('div', {}, monthLabel(s.month || state.sumMonth)),
      el('div', { class: 'k' }, 'Total spend'),    el('div', {}, inr(s.totalMonth)),
      el('div', { class: 'k' }, 'Paid reimburse'), el('div', {}, inr(s.paidMonth) + ' (' + (s.paidMonthCount || 0) + ')'),
      el('div', { class: 'k' }, 'Direct expenses'),el('div', {}, String(s.expenseCount || 0)),
      el('div', { class: 'k' }, 'Open liability'), el('div', {}, inr(s.openLiability) + ' (' + (s.openCount || 0) + ')'),
    );
  }

  // --------------- KPIs -----------------------------------------------------
  // Computed client-side from the loaded reimbursements + (staff) summary.
  // Avoids an extra round trip and keeps the KPIs live after mutations.
  function computeKpis() {
    const openStatuses = new Set(['requested', 'under-review', 'approved']);
    let open = 0, openLiab = 0;
    const nowKey = monthKeyIst();
    for (const r of state.reimbursements) {
      if (openStatuses.has(r.status)) { open++; openLiab += Number(r.amount) || 0; }
    }
    setKpi('open', String(open));
    setKpi('openLiability', inr(openLiab));
    // If we have a live summary use it; else derive from what we have.
    if (state.summary && state.summary.month === nowKey) {
      setKpi('paidMonth', inr(state.summary.paidMonth) + ' (' + (state.summary.paidMonthCount || 0) + ')');
      setKpi('totalMonth', inr(state.summary.totalMonth));
    } else {
      let paidM = 0, paidC = 0;
      for (const r of state.reimbursements) {
        if (r.status === 'paid' && monthKeyIst(r.updatedAt || r.createdAt) === nowKey) {
          paidM += Number(r.amount) || 0; paidC++;
        }
      }
      setKpi('paidMonth', inr(paidM) + ' (' + paidC + ')');
      // 'totalMonth' needs expenses; leave em-dash until summary loads.
      if (!state.isStaff) setKpi('totalMonth', '—');
    }
  }
  function setKpi(key, val) {
    const n = document.querySelector(`[data-tr-kpi="${key}"]`);
    if (n) n.textContent = val;
  }

  // --------------- Local update helpers -------------------------------------
  function mergeRmb(rec) {
    if (!rec || !rec.id) return;
    const idx = state.reimbursements.findIndex((r) => r.id === rec.id);
    if (idx >= 0) state.reimbursements[idx] = rec;
    else state.reimbursements.unshift(rec);
    state.selectedRmbId = rec.id;
    renderRmb();
    computeKpis();
  }

  // --------------- File payload builder ------------------------------------
  // Convert a FileList into the { name, mime, size, dataBase64 } shape the
  // worker persists to the treasury private repo. We DON'T upload here;
  // the worker takes care of writing to GitHub with the correct token.
  async function filesToPayload(fileList) {
    const out = [];
    const files = fileList ? Array.from(fileList) : [];
    const maxBytes = MAX_FILE_MB * 1024 * 1024;
    for (const f of files) {
      if (f.size > maxBytes) throw new Error(`"${f.name}" exceeds ${MAX_FILE_MB}MB`);
      const buf = await f.arrayBuffer();
      // btoa can't handle raw binary — go via a chunked Uint8Array.
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      out.push({ name: f.name, mime: f.type || 'application/octet-stream', size: f.size, dataBase64: btoa(bin) });
    }
    return out;
  }

  // --------------- Cosmetic helpers ----------------------------------------
  function fieldCss(extra) {
    return Object.assign({
      padding: '8px 10px', background: 'var(--c-input-bg)', color: 'var(--c-text)',
      border: '1px solid var(--c-input-border)', borderRadius: '6px',
      font: 'inherit', width: '100%', boxSizing: 'border-box',
    }, extra || {});
  }
  function pairLabel(labelText, node) {
    return el('label', { style: 'display:flex;flex-direction:column;gap:4px' },
      el('span', { style: 'font-size:11px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600' }, labelText),
      node,
    );
  }

  // --------------- PDF export ----------------------------------------------
  function exportCurrentView() {
    if (!root.PdfReport || typeof root.PdfReport.build !== 'function') {
      root.UI.toast('PDF export not available.', { kind: 'warn' });
      return;
    }
    const rows = filteredRmb().map((r) => [
      r.id, personLabel(r.createdBy, r.createdByFlat), r.category || '',
      (r.purpose || '').slice(0, 60), r.expenseDate || '',
      inr(r.amount), STATUS_LABEL[r.status] || r.status,
    ]);
    root.PdfReport.build({
      title: 'Treasury — Reimbursements',
      subtitle: monthLabel(monthKeyIst()),
      columns: ['ID', 'Requester', 'Category', 'Purpose', 'Date', 'Amount', 'Status'],
      rows,
    });
  }

  // --------------- Export ---------------------------------------------------
  root.Treasury = { init };
})(window);

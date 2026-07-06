// docs/assets/js/reservations.js
// Reservation Engine controller. Reuses existing Api / Auth / Flags / UI.
// Spec: tsh_requirement.md §10.
//
// The controller intentionally keeps three concerns separate:
//   (1) FACILITIES + AVAILABILITY — read-mostly; refreshed when a booking
//       is created/cancelled so the grid instantly reflects the change.
//   (2) MY RESERVATIONS         — resident-scoped list.
//   (3) MANAGE QUEUE            — MANAGER+ only. Approve / reject inline
//                                  (reject prompts for a required reason).
//
// The facility model is generic — nothing in this file assumes "Community
// Hall". Adding a Guest Room / Sports Court / Pool is a config-only
// change to config/facilities.json (plus, optionally, a distinct slot
// list per facility).

(function (root) {
  'use strict';

  const $  = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));

  // -------------------------------------------------------- state

  let who = null;          // Flags.whoami() result
  let facilities = [];     // list from /facilities
  let selectedFacility = null;
  let currentTab = 'book';
  let mineCache = [];      // resident scope
  let manageCache = [];    // staff scope

  const RESIDENT_STATUS_LABEL = {
    'requested':    'Requested',
    'under-review': 'Under Review',
    'confirmed':    'Confirmed',
    'rejected':     'Rejected',
    'cancelled':    'Cancelled',
  };

  const TIMELINE_LABEL = {
    'created':           'Reservation created',
    'commented':         'Comment',
    'approved':          'Approved',
    'rejected':          'Rejected',
    'cancelled':         'Cancelled',
    'edited':            'Edited',
    'overridden':        'Overridden',
    'payment-uploaded':  'Payment proof uploaded',
    'payment-verified':  'Payment verified',
    'payment-rejected':  'Payment rejected',
  };

  const TIMELINE_ICON = {
    'created':           'fa-circle-plus',
    'commented':         'fa-comment',
    'approved':          'fa-circle-check',
    'rejected':          'fa-circle-xmark',
    'cancelled':         'fa-ban',
    'edited':            'fa-pen',
    'overridden':        'fa-shield-halved',
    'payment-uploaded':  'fa-file-invoice-dollar',
    'payment-verified':  'fa-money-check-dollar',
    'payment-rejected':  'fa-triangle-exclamation',
  };

  const PAYMENT_STATUS_LABEL = {
    'not-required': 'Not required',
    'pending':      'Awaiting proof',
    'submitted':    'Under review',
    'verified':     'Verified',
    'rejected':     'Rejected',
  };

  // -------------------------------------------------------- date utils

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function istToday() {
    const d = new Date(Date.now() + IST_OFFSET_MS);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  function istPlusDays(days) {
    const d = new Date(Date.now() + IST_OFFSET_MS + days * 24 * 60 * 60 * 1000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  function friendlyDate(ymd) {
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    if (!y || !m || !d) return ymd;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function friendlyRelDate(ymd) {
    if (!ymd) return '';
    const today = istToday();
    if (ymd === today) return 'Today';
    if (ymd === istPlusDays(1)) return 'Tomorrow';
    return friendlyDate(ymd);
  }

  function friendlyDateTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (_e) { return iso; }
  }

  // -------------------------------------------------------- init

  async function init() {
    // Feature flag gate.
    try {
      await root.Flags.ready();
    } catch (_e) { /* offline: still show the sign-in state */ }
    if (root.Flags && root.Flags.on && !root.Flags.on('FEATURE_TSH_RESERVATIONS')) {
      document.body.innerHTML = '<main class="tsh-main"><section class="tsh-card"><p>Reservations are not enabled for this site.</p></section></main>';
      return;
    }
    // Sign-in gate.
    if (!root.Auth || !root.Auth.token || !root.Auth.token()) {
      $('[data-res-signin]').hidden = false;
      $('[data-res-main]').hidden = true;
      return;
    }
    $('[data-res-signin]').hidden = true;
    $('[data-res-main]').hidden = false;

    who = await root.Flags.whoami();
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
    $$('[data-res-staff-only]').forEach((el) => { el.hidden = !isStaff; });

    wireTabs();
    wireRange();

    try {
      const res = await root.Api.get('/facilities');
      facilities = (res && res.facilities) || [];
    } catch (e) {
      root.UI.toast('Could not load facilities: ' + (e && e.message || e), { kind: 'danger' });
      return;
    }
    renderFacilityPicker();
    if (facilities.length) {
      selectFacility(facilities[0].id);
    }
    // Preload the resident list so the tab count is accurate on first visit.
    refreshMine();
    if (isStaff) refreshManage();
  }

  // -------------------------------------------------------- tabs

  function wireTabs() {
    $$('[data-res-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-res-tab');
        if (!t) return;
        showTab(t);
      });
    });
  }

  function showTab(name) {
    currentTab = name;
    $$('[data-res-tab]').forEach((b) => {
      const active = b.getAttribute('data-res-tab') === name;
      b.classList.toggle('tsh-tab-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $$('[data-res-panel]').forEach((p) => { p.hidden = p.getAttribute('data-res-panel') !== name; });
    if (name === 'mine') refreshMine();
    if (name === 'manage') refreshManage();
    if (name === 'book') renderAvailabilityGrid();
  }

  // -------------------------------------------------------- facilities

  function renderFacilityPicker() {
    const host = $('#resFacilityList');
    host.innerHTML = '';
    if (!facilities.length) {
      host.innerHTML = '<p class="tsh-empty">No facilities are configured yet. Contact the site admin.</p>';
      $('#resBookBody').hidden = true;
      return;
    }
    facilities.forEach((f) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'tsh-res-fac';
      card.setAttribute('data-fac', f.id);
      const capMsg = f.capacity ? ` · up to ${f.capacity} people` : '';
      const payMsg = f.policy.requiresPayment ? ` · ₹${f.policy.paymentAmount} deposit` : '';
      card.innerHTML =
        '<span class="tsh-res-fac-name">' + escape(f.name) + '</span>' +
        (f.description ? '<span class="tsh-res-fac-desc">' + escape(f.description) + '</span>' : '') +
        '<span class="tsh-res-fac-meta">' +
          f.slots.length + ' slot' + (f.slots.length === 1 ? '' : 's') + '/day · ' +
          'up to ' + f.policy.maxAdvanceDays + 'd ahead' +
          capMsg + payMsg +
        '</span>';
      card.addEventListener('click', () => selectFacility(f.id));
      host.appendChild(card);
    });
  }

  function selectFacility(id) {
    selectedFacility = facilities.find((f) => f.id === id) || null;
    $$('#resFacilityList .tsh-res-fac').forEach((el) => {
      el.classList.toggle('tsh-res-fac-active', el.getAttribute('data-fac') === id);
    });
    if (!selectedFacility) return;
    $('#resBookBody').hidden = false;
    renderFacilityRules();
    // Default range: today .. +14d
    const from = $('#resRangeFrom');
    const to   = $('#resRangeTo');
    if (!from.value) from.value = istToday();
    if (!to.value)   to.value   = istPlusDays(14);
    renderAvailabilityGrid();
  }

  function renderFacilityRules() {
    const host = $('#resFacilityRules');
    if (!selectedFacility) { host.innerHTML = ''; return; }
    const rules = selectedFacility.rules || [];
    if (!rules.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<strong>House rules:</strong> ' + rules.map(escape).join(' · ');
  }

  function wireRange() {
    $('#resRangeReload').addEventListener('click', renderAvailabilityGrid);
    $('#resRangeFrom').addEventListener('change', renderAvailabilityGrid);
    $('#resRangeTo').addEventListener('change', renderAvailabilityGrid);
    $('#resManageSearch').addEventListener('input', () => renderManageList());
    $('#resManageStatus').addEventListener('change', () => refreshManage());
  }

  // -------------------------------------------------------- availability grid

  async function renderAvailabilityGrid() {
    if (!selectedFacility) return;
    const host = $('#resAvailabilityGrid');
    const from = $('#resRangeFrom').value || istToday();
    const to   = $('#resRangeTo').value   || istPlusDays(14);
    host.innerHTML = '';
    const spinner = document.createElement('p');
    spinner.className = 'tsh-hint';
    spinner.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading availability…';
    host.appendChild(spinner);
    let payload;
    try {
      payload = await root.Api.get(`/facilities/${encodeURIComponent(selectedFacility.id)}/availability?from=${from}&to=${to}`);
    } catch (e) {
      host.innerHTML = '<p class="tsh-empty">Could not load availability: ' + escape(e && e.message || String(e)) + '</p>';
      return;
    }
    host.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'tsh-res-grid';
    grid.style.gridTemplateColumns = `100px repeat(${selectedFacility.slots.length}, 1fr)`;

    // Header row
    grid.appendChild(headCell('Date'));
    selectedFacility.slots.forEach((s) => grid.appendChild(headCell(s.label)));

    const today = istToday();
    const nowMs = Date.now();
    const minAdvanceMs = (selectedFacility.policy.minAdvanceHours || 0) * 3600 * 1000;

    (payload.days || []).forEach((day) => {
      const cell = document.createElement('div');
      cell.className = 'tsh-res-grid-day';
      cell.innerHTML =
        '<span>' + escape(friendlyRelDate(day.date)) + '</span>' +
        '<span class="tsh-res-grid-daydate">' + escape(day.date) + '</span>';
      grid.appendChild(cell);

      day.slots.forEach((slot) => {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'tsh-res-grid-cell';
        // Compute IST epoch for this slot to enforce min-advance visually.
        const [y, m, d] = day.date.split('-').map(Number);
        const startMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS + slot.startHour * 3600 * 1000;
        const inPast = startMs - nowMs < minAdvanceMs;

        let label = 'Available';
        if (slot.status === 'confirmed') {
          c.classList.add('tsh-res-grid-cell-confirmed');
          label = 'Confirmed';
        } else if (slot.status === 'held') {
          c.classList.add('tsh-res-grid-cell-held');
          label = 'Requested';
        } else if (slot.status === 'blackout' || day.blackout) {
          c.classList.add('tsh-res-grid-cell-blackout');
          label = 'Blocked';
        } else if (inPast) {
          c.classList.add('tsh-res-grid-cell-past');
          label = 'Available';
        }

        c.innerHTML = '<div>' + escape(label) + '</div>';
        if (slot.status === 'available' && !inPast) {
          c.addEventListener('click', () => openBookModal(day.date, slot));
        } else if (slot.status === 'held' || slot.status === 'confirmed') {
          c.addEventListener('click', () => openReservationById(slot.reservationId));
        }
        grid.appendChild(c);
      });
    });
    host.appendChild(grid);
  }

  function headCell(text) {
    const c = document.createElement('div');
    c.className = 'tsh-res-grid-head';
    c.textContent = text;
    return c;
  }

  // -------------------------------------------------------- book modal

  function openBookModal(date, slot) {
    if (!selectedFacility) return;
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');

    const wrap = document.createElement('div');
    wrap.className = 'tsh-form';
    const policy = selectedFacility.policy || {};
    const perFlatCap = Number(policy.maxPerFlatPerYear || 2);
    const chargesInfo = (policy.chargesInfo || '').trim();
    wrap.innerHTML =
      '<div class="tsh-form-row"><label><span class="tsh-form-label">Facility</span>' +
      '<input type="text" value="' + escape(selectedFacility.name) + '" disabled /></label></div>' +
      '<div class="tsh-form-row"><label><span class="tsh-form-label">Date &amp; slot</span>' +
      '<input type="text" value="' + escape(friendlyDate(date)) + ' · ' + escape(slot.label) + '" disabled /></label></div>' +
      '<div class="tsh-form-row"><label><span class="tsh-form-label">Purpose <span style="color:#dc2626">*</span></span>' +
      '<input type="text" data-book-purpose maxlength="400" placeholder="e.g., 8th birthday party for A-101" required /></label></div>' +
      '<div class="tsh-form-row"><label><span class="tsh-form-label">Flat number <span style="color:#dc2626">*</span></span>' +
      '<input type="text" data-book-flat maxlength="40" placeholder="A-101" required /></label>' +
      '<span class="tsh-hint" style="display:block;margin-top:4px;font-size:12px;color:var(--tsh-muted,#6b7280)">' +
      '<i class="fas fa-info-circle"></i> Each flat can book this facility up to <strong>' + perFlatCap + '</strong> time(s) per calendar year.' +
      '</span></div>' +
      '<div class="tsh-form-row"><label><span class="tsh-form-label">Phone (optional)</span>' +
      '<input type="tel" data-book-phone maxlength="40" placeholder="+91-9x-xxx-xxxx" /></label></div>' +
      (isStaff ?
        '<div class="tsh-form-row"><label><span class="tsh-form-label">Book on behalf of (email)</span>' +
        '<input type="email" data-book-owner maxlength="120" placeholder="Leave blank to book for yourself" /></label></div>' : '') +
      (chargesInfo ?
        '<p class="tsh-hint" style="background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;padding:8px 10px;border-radius:4px;margin-top:8px;">' +
        '<i class="fas fa-receipt"></i> <strong>Charges:</strong> ' + escape(chargesInfo) + '</p>' : '') +
      (policy.requiresPayment ?
        '<p class="tsh-hint"><i class="fas fa-info-circle"></i> This facility requires a deposit of ₹' + policy.paymentAmount +
        (policy.paymentPayee ? ' to ' + escape(policy.paymentPayee) : '') +
        '. You will be asked to upload payment proof after the booking is created.</p>' : '');

    root.UI.modal({
      title: 'Request Reservation',
      body: wrap,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Submit Request', value: 'submit', primary: true },
      ],
    }).then((choice) => {
      if (choice !== 'submit') return;
      const purpose = wrap.querySelector('[data-book-purpose]').value.trim();
      const flat    = wrap.querySelector('[data-book-flat]').value.trim();
      const phone   = wrap.querySelector('[data-book-phone]').value.trim();
      const ownerEl = wrap.querySelector('[data-book-owner]');
      const owner   = ownerEl ? ownerEl.value.trim() : '';
      if (!purpose || purpose.length < 3) { root.UI.toast('Please describe the purpose (min 3 characters).', { kind: 'warn' }); return; }
      if (!flat) { root.UI.toast('Flat number is required — it is used to enforce the yearly booking limit.', { kind: 'warn' }); return; }
      submitBooking(date, slot.id, purpose, flat, phone, owner);
    });
    setTimeout(() => wrap.querySelector('[data-book-purpose]').focus(), 60);
  }

  async function submitBooking(date, slotId, purpose, flat, phone, ownerEmail) {
    const body = { facilityId: selectedFacility.id, date, slotId, purpose, ownerFlat: flat };
    if (phone) body.ownerPhone = phone;
    if (ownerEmail) body.ownerEmail = ownerEmail;
    try {
      const res = await root.Api.post('/reservations', body);
      root.UI.toast('Reservation ' + res.reservation.id + ' created.', { kind: 'success' });
      renderAvailabilityGrid();
      refreshMine();
      refreshManage();
    } catch (e) {
      root.UI.toast(e && e.message || 'Booking failed', { kind: 'danger' });
    }
  }

  // -------------------------------------------------------- my reservations

  async function refreshMine() {
    try {
      const res = await root.Api.get('/reservations?scope=mine');
      mineCache = (res && res.items) || [];
    } catch (_e) {
      mineCache = [];
    }
    updateCount('mine', mineCache.length);
    renderMine();
  }

  function renderMine() {
    const host = $('#resMineList');
    host.innerHTML = '';
    if (!mineCache.length) {
      host.innerHTML = '<p class="tsh-empty">You have no reservations yet. Use the <strong>Book</strong> tab to request one.</p>';
      return;
    }
    mineCache.forEach((r) => host.appendChild(renderReservationCard(r, /*staffMode*/ false)));
  }

  // -------------------------------------------------------- manage queue

  async function refreshManage() {
    const status = $('#resManageStatus').value || 'requested';
    try {
      const res = await root.Api.get('/reservations?scope=all&status=' + encodeURIComponent(status));
      manageCache = (res && res.items) || [];
    } catch (_e) {
      manageCache = [];
    }
    updateCount('manage', manageCache.filter((r) => r.status === 'requested' || r.status === 'under-review').length);
    renderManageList();
  }

  function renderManageList() {
    const host = $('#resManageList');
    host.innerHTML = '';
    const q = ($('#resManageSearch').value || '').trim().toLowerCase();
    const filtered = manageCache.filter((r) => !q ||
      r.id.toLowerCase().includes(q) ||
      (r.owner.name || '').toLowerCase().includes(q) ||
      (r.owner.flat || '').toLowerCase().includes(q) ||
      (r.owner.phone || '').toLowerCase().includes(q) ||
      (r.owner.email || '').toLowerCase().includes(q) ||
      (r.purpose || '').toLowerCase().includes(q) ||
      r.date.includes(q));
    if (!filtered.length) {
      host.innerHTML = '<p class="tsh-empty">Nothing to review.</p>';
      return;
    }
    filtered.forEach((r) => host.appendChild(renderReservationCard(r, /*staffMode*/ true)));
  }

  // -------------------------------------------------------- card + timeline

  function renderReservationCard(r, staffMode) {
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
    const meEmail = (who && who.email || '').toLowerCase();
    const isOwner = r.owner.email.toLowerCase() === meEmail;

    const card = document.createElement('div');
    card.className = 'tsh-res-card';

    const head = document.createElement('div');
    head.className = 'tsh-res-card-head';
    head.innerHTML =
      '<div>' +
        '<h3 class="tsh-res-card-title">' + escape(r.facilityLabel) + '</h3>' +
        '<div class="tsh-res-card-meta">' +
          '<i class="fas fa-calendar-day"></i> ' + escape(friendlyRelDate(r.date)) + ' · ' + escape(r.slotLabel) +
        '</div>' +
      '</div>' +
      '<span class="tsh-res-pill tsh-res-pill-' + r.status + '">' + escape(RESIDENT_STATUS_LABEL[r.status] || r.status) + '</span>';
    card.appendChild(head);

    const purpose = document.createElement('div');
    purpose.className = 'tsh-res-card-purpose';
    purpose.textContent = r.purpose;
    card.appendChild(purpose);

    const meta = document.createElement('div');
    meta.className = 'tsh-res-card-owner';
    meta.innerHTML =
      '<i class="fas fa-id-badge"></i> ' + escape(r.id) + ' · ' +
      (staffMode ? escape(r.owner.name || r.owner.email) + (r.owner.flat ? ' · ' + escape(r.owner.flat) : '') + ' · ' : '') +
      'created ' + escape(root.UI.formatRel ? root.UI.formatRel(r.createdAt) : friendlyDateTime(r.createdAt));
    card.appendChild(meta);

    if (r.payment) {
      const pay = document.createElement('div');
      pay.className = 'tsh-res-card-payment';
      pay.innerHTML =
        '<i class="fas fa-indian-rupee-sign"></i> ' +
        (r.payment.amount ? '₹' + r.payment.amount + ' · ' : '') +
        '<span class="tsh-res-pill tsh-res-pill-pay-' + r.payment.status + '">' +
        escape(PAYMENT_STATUS_LABEL[r.payment.status] || r.payment.status) + '</span>' +
        (r.payment.proofs && r.payment.proofs.length ? ' · ' + r.payment.proofs.length + ' proof(s)' : '');
      card.appendChild(pay);
    }

    const actions = document.createElement('div');
    actions.className = 'tsh-res-card-actions';

    // Detail button always available.
    const detailBtn = document.createElement('button');
    detailBtn.type = 'button';
    detailBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
    detailBtn.innerHTML = '<i class="fas fa-clock-rotate-left"></i> Timeline';
    detailBtn.addEventListener('click', () => openDetailModal(r));
    actions.appendChild(detailBtn);

    if (staffMode && (r.status === 'requested' || r.status === 'under-review')) {
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'tsh-btn tsh-btn-primary tsh-btn-sm';
      approveBtn.innerHTML = '<i class="fas fa-check"></i> Approve';
      approveBtn.addEventListener('click', () => doTransition(r, 'confirmed'));
      actions.appendChild(approveBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      rejectBtn.innerHTML = '<i class="fas fa-xmark"></i> Reject';
      rejectBtn.addEventListener('click', () => doReject(r));
      actions.appendChild(rejectBtn);
    }

    if ((isOwner || isStaff) && (r.status === 'requested' || r.status === 'under-review' || r.status === 'confirmed')) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      cancelBtn.innerHTML = '<i class="fas fa-ban"></i> Cancel';
      cancelBtn.addEventListener('click', async () => {
        const ok = await root.UI.confirmModal('Cancel reservation?', 'This will free up the slot for others. You can request a new booking anytime.');
        if (ok) doTransition(r, 'cancelled');
      });
      actions.appendChild(cancelBtn);
    }

    card.appendChild(actions);
    return card;
  }

  async function openReservationById(id) {
    if (!id) return;
    try {
      const res = await root.Api.get('/reservations/' + encodeURIComponent(id));
      if (res && res.reservation) openDetailModal(res.reservation);
    } catch (e) {
      root.UI.toast(e && e.message || 'Not authorised to view this reservation.', { kind: 'warn' });
    }
  }

  function openDetailModal(r) {
    const wrap = document.createElement('div');
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
    const meEmail = (who && who.email || '').toLowerCase();
    const isOwner = r.owner.email.toLowerCase() === meEmail;
    wrap.innerHTML =
      '<p><strong>' + escape(r.facilityLabel) + '</strong> · ' + escape(friendlyRelDate(r.date)) + ' · ' + escape(r.slotLabel) + '</p>' +
      '<p style="margin:6px 0"><span class="tsh-res-pill tsh-res-pill-' + r.status + '">' + escape(RESIDENT_STATUS_LABEL[r.status] || r.status) + '</span> · ID <code>' + escape(r.id) + '</code></p>' +
      '<p style="margin:6px 0;font-size:13px">' + escape(r.purpose) + '</p>' +
      (isStaff ?
        '<p class="tsh-res-card-owner" style="margin:6px 0">Owner: ' + escape(r.owner.name || r.owner.email) +
        (r.owner.flat ? ' · ' + escape(r.owner.flat) : '') +
        (r.owner.phone ? ' · ' + escape(r.owner.phone) : '') +
        ' · ' + escape(r.owner.email) + '</p>' : '');

    // Payment panel — only shown when the facility policy requires payment.
    if (r.payment) {
      const pay = document.createElement('div');
      pay.className = 'tsh-res-payment-panel';
      pay.innerHTML =
        '<h4 style="margin:12px 0 6px"><i class="fas fa-indian-rupee-sign"></i> Payment</h4>' +
        '<p style="margin:2px 0;font-size:13px">' +
          (r.payment.amount ? '<strong>₹' + r.payment.amount + '</strong>' : '') +
          (r.payment.payee ? ' to ' + escape(r.payment.payee) : '') +
          ' · <span class="tsh-res-pill tsh-res-pill-pay-' + r.payment.status + '">' +
          escape(PAYMENT_STATUS_LABEL[r.payment.status] || r.payment.status) + '</span>' +
        '</p>' +
        (r.payment.txnRef ? '<p style="margin:2px 0;font-size:12px">Ref: <code>' + escape(r.payment.txnRef) + '</code></p>' : '') +
        (r.payment.note ? '<p style="margin:2px 0;font-size:12px;color:var(--tsh-muted,#6b7280)">Note: ' + escape(r.payment.note) + '</p>' : '');

      const list = document.createElement('ul');
      list.className = 'tsh-res-proof-list';
      (r.payment.proofs || []).forEach((p, idx) => {
        const li = document.createElement('li');
        const kbytes = Math.max(1, Math.round((p.size || 0) / 1024));
        const iconClass = p.mime === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-image';
        li.innerHTML =
          '<i class="fas ' + iconClass + '"></i> ' +
          '<a href="#" data-proof-idx="' + (idx + 1) + '">' + escape(p.name) + '</a> ' +
          '<span style="color:var(--tsh-muted,#6b7280);font-size:12px">' + kbytes + ' KB · ' + escape(friendlyDateTime(p.uploadedAt)) + '</span>';
        list.appendChild(li);
      });
      pay.appendChild(list);
      // Delegate clicks — worker streams the file behind auth.
      list.addEventListener('click', (ev) => {
        const a = ev.target && ev.target.closest && ev.target.closest('a[data-proof-idx]');
        if (!a) return;
        ev.preventDefault();
        const idx = a.getAttribute('data-proof-idx');
        openProofDownload(r.id, idx);
      });

      const canUpload = (isOwner || isStaff) &&
        (r.payment.status === 'pending' || r.payment.status === 'rejected') &&
        (r.status === 'requested' || r.status === 'under-review');
      const canDecide = isStaff && r.payment.proofs && r.payment.proofs.length > 0 && r.payment.status === 'submitted';

      const btns = document.createElement('div');
      btns.className = 'tsh-res-card-actions';
      btns.style.marginTop = '8px';

      if (canUpload) {
        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'tsh-btn tsh-btn-primary tsh-btn-sm';
        upBtn.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Upload proof';
        upBtn.addEventListener('click', () => uploadPaymentProof(r));
        btns.appendChild(upBtn);
      }
      if (canDecide) {
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'tsh-btn tsh-btn-primary tsh-btn-sm';
        okBtn.innerHTML = '<i class="fas fa-check"></i> Verify payment';
        okBtn.addEventListener('click', () => verifyPayment(r));
        btns.appendChild(okBtn);

        const noBtn = document.createElement('button');
        noBtn.type = 'button';
        noBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
        noBtn.innerHTML = '<i class="fas fa-xmark"></i> Reject payment';
        noBtn.addEventListener('click', () => rejectPayment(r));
        btns.appendChild(noBtn);
      }
      if (btns.childNodes.length) pay.appendChild(btns);
      wrap.appendChild(pay);
    }

    const hr = document.createElement('hr');
    wrap.appendChild(hr);
    const acth = document.createElement('h4');
    acth.style.margin = '0 0 8px';
    acth.textContent = 'Activity';
    wrap.appendChild(acth);
    const tl = document.createElement('ul');
    tl.className = 'tsh-res-timeline';
    (r.timeline || []).slice().reverse().forEach((t) => {
      const li = document.createElement('li');
      const icon = TIMELINE_ICON[t.event] || 'fa-circle';
      li.innerHTML =
        '<div class="tsh-res-tl-dot"></div>' +
        '<div class="tsh-res-tl-body">' +
          '<span class="tsh-res-tl-head"><i class="fas ' + icon + '"></i> ' + escape(TIMELINE_LABEL[t.event] || t.event) + '</span>' +
          (t.note ? '<span class="tsh-res-tl-note">' + escape(t.note) + '</span>' : '') +
          '<span class="tsh-res-tl-when">' + escape(friendlyDateTime(t.at)) + ' · ' + escape(t.by && (t.by.name || t.by.email) || 'system') + '</span>' +
        '</div>';
      tl.appendChild(li);
    });
    wrap.appendChild(tl);

    // Comment box
    const commentWrap = document.createElement('div');
    commentWrap.style.marginTop = '12px';
    commentWrap.innerHTML =
      '<label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Add a note</label>' +
      '<textarea data-res-comment style="width:100%;min-height:60px;padding:8px;border-radius:8px;border:1px solid var(--tsh-border,#d1d5db)" placeholder="Question, update, or context — visible to owner and staff."></textarea>';
    wrap.appendChild(commentWrap);

    root.UI.modal({
      title: 'Reservation details',
      body: wrap,
      actions: [
        { label: 'Close', value: null },
        { label: 'Post note', value: 'note', primary: true },
      ],
    }).then((choice) => {
      if (choice !== 'note') return;
      const note = commentWrap.querySelector('[data-res-comment]').value.trim();
      if (!note) return;
      postComment(r.id, note);
    });
  }

  async function postComment(id, note) {
    try {
      await root.Api.post('/reservations/' + encodeURIComponent(id) + '/comments', { note });
      root.UI.toast('Note added.', { kind: 'success' });
      refreshMine();
      refreshManage();
    } catch (e) {
      root.UI.toast(e && e.message || 'Could not post note.', { kind: 'danger' });
    }
  }

  async function doTransition(r, to) {
    try {
      await root.Api.patch('/reservations/' + encodeURIComponent(r.id), { status: to });
      root.UI.toast('Reservation ' + to + '.', { kind: 'success' });
      renderAvailabilityGrid();
      refreshMine();
      refreshManage();
    } catch (e) {
      root.UI.toast(e && e.message || 'Update failed.', { kind: 'danger' });
    }
  }

  async function doReject(r) {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<p>Please share a short reason. It will be recorded in the timeline and shown to the resident.</p>' +
      '<textarea data-reject-reason style="width:100%;min-height:80px;padding:8px;border-radius:8px;border:1px solid var(--tsh-border,#d1d5db)" placeholder="e.g., Facility is under maintenance on that date."></textarea>';
    const choice = await root.UI.modal({
      title: 'Reject reservation',
      body: wrap,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Reject', value: 'reject', primary: true, danger: true },
      ],
    });
    if (choice !== 'reject') return;
    const reason = wrap.querySelector('[data-reject-reason]').value.trim();
    if (!reason) { root.UI.toast('Reason is required to reject.', { kind: 'warn' }); return; }
    try {
      await root.Api.patch('/reservations/' + encodeURIComponent(r.id), { status: 'rejected', note: reason });
      root.UI.toast('Reservation rejected.', { kind: 'success' });
      renderAvailabilityGrid();
      refreshMine();
      refreshManage();
    } catch (e) {
      root.UI.toast(e && e.message || 'Reject failed.', { kind: 'danger' });
    }
  }

  // -------------------------------------------------------- payment proofs

  const PROOF_MAX_BYTES = 5 * 1024 * 1024;
  const PROOF_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('Could not read file'));
      fr.readAsDataURL(file);
    });
  }

  function uploadPaymentProof(r) {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<p style="margin:0 0 8px;font-size:13px">Upload a UPI / bank screenshot or receipt PDF. Max 5&nbsp;MB. Only you and society staff can view it.</p>' +
      '<input type="file" data-proof-file accept="image/png,image/jpeg,image/webp,application/pdf" />' +
      '<label style="display:block;margin-top:10px;font-size:12px;font-weight:600">Transaction reference (optional)</label>' +
      '<input type="text" data-proof-ref maxlength="80" placeholder="e.g., UPI ref, txn id" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--tsh-border,#d1d5db)" />';
    root.UI.modal({
      title: 'Upload payment proof',
      body: wrap,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Upload', value: 'upload', primary: true },
      ],
    }).then(async (choice) => {
      if (choice !== 'upload') return;
      const fEl = wrap.querySelector('[data-proof-file]');
      const f = fEl && fEl.files && fEl.files[0];
      if (!f) { root.UI.toast('Pick a file first.', { kind: 'warn' }); return; }
      if (PROOF_MIMES.indexOf(f.type) === -1) { root.UI.toast('Only images (JPG/PNG/WebP) or PDF are accepted.', { kind: 'warn' }); return; }
      if (f.size > PROOF_MAX_BYTES) { root.UI.toast('File is too large (max 5 MB).', { kind: 'warn' }); return; }
      const ref = (wrap.querySelector('[data-proof-ref]').value || '').trim();
      try {
        const dataUrl = await fileToDataUrl(f);
        const body = { dataUrl, name: f.name };
        if (ref) body.txnRef = ref;
        await root.Api.post('/reservations/' + encodeURIComponent(r.id) + '/payment-proof', body);
        root.UI.toast('Payment proof uploaded. Staff will verify shortly.', { kind: 'success' });
        refreshMine();
        refreshManage();
      } catch (e) {
        root.UI.toast(e && e.message || 'Upload failed', { kind: 'danger' });
      }
    });
  }

  async function openProofDownload(resId, idx) {
    // The worker route is authenticated. We fetch the file as a blob and
    // pop it in a new tab so the browser handles PDF vs image rendering.
    try {
      const base = (root.Api && root.Api.base && root.Api.base()) || (root.TSH_WORKER_BASE || '');
      const url = base + '/reservations/' + encodeURIComponent(resId) + '/payment-proof/' + encodeURIComponent(idx);
      const token = root.Auth && root.Auth.token && root.Auth.token();
      const res = await fetch(url, {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const w = window.open(objUrl, '_blank');
      if (!w) root.UI.toast('Pop-up blocked. Allow pop-ups to view the proof.', { kind: 'warn' });
      // Revoke shortly after; the new tab has already latched onto the URL.
      setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
    } catch (e) {
      root.UI.toast('Could not open proof: ' + (e && e.message || e), { kind: 'danger' });
    }
  }

  async function verifyPayment(r) {
    try {
      await root.Api.patch('/reservations/' + encodeURIComponent(r.id) + '/payment', {
        status: 'verified',
        note: 'Verified from statement',
      });
      root.UI.toast('Payment verified. You can now confirm the booking.', { kind: 'success' });
      refreshMine();
      refreshManage();
    } catch (e) {
      root.UI.toast(e && e.message || 'Verify failed', { kind: 'danger' });
    }
  }

  async function rejectPayment(r) {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<p>Share a short reason for rejecting the payment. The resident will see this and can re-upload.</p>' +
      '<textarea data-pay-reject-reason style="width:100%;min-height:80px;padding:8px;border-radius:8px;border:1px solid var(--tsh-border,#d1d5db)" placeholder="e.g., screenshot is not readable"></textarea>';
    const choice = await root.UI.modal({
      title: 'Reject payment proof',
      body: wrap,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Reject', value: 'reject', primary: true, danger: true },
      ],
    });
    if (choice !== 'reject') return;
    const reason = wrap.querySelector('[data-pay-reject-reason]').value.trim();
    if (!reason) { root.UI.toast('Reason is required.', { kind: 'warn' }); return; }
    try {
      await root.Api.patch('/reservations/' + encodeURIComponent(r.id) + '/payment', {
        status: 'rejected', note: reason,
      });
      root.UI.toast('Payment rejected. Resident will be prompted to re-upload.', { kind: 'success' });
      refreshMine();
      refreshManage();
    } catch (e) {
      root.UI.toast(e && e.message || 'Reject failed', { kind: 'danger' });
    }
  }

  // -------------------------------------------------------- misc

  function updateCount(name, n) {
    const el = document.querySelector('[data-res-count="' + name + '"]');
    if (el) el.textContent = String(n);
  }

  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  root.Reservations = { init };

})(window);

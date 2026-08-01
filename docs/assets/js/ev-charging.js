// EV Charging Services — resident page controller (Phase 1).
// -----------------------------------------------------------------------------
// Responsibilities:
//   1. Wait for feature flags to load, then render either the signed-in
//      shell, the sign-in gate, or the feature-disabled gate.
//   2. Fetch GET /ev/config and paint the station bar + guidelines strip.
//   3. Wire the subnav pills; hide any pill whose sub-flag is off.
//   4. Render FAQ list from config when non-empty.
//
// Real booking / receipt / RFID / support behaviour ships in later phases
// behind their own sub-flag — this file will grow with helpers that plug
// into those panels. Keep additions small and additive.
// Spec: tsh_requirement.md §23.

(function (root) {
  'use strict';

  const MASTER_FLAG = 'FEATURE_TSH_EV_CHARGING';
  // Map of sub-panel key → sub-flag name. Kept in one place so we do not
  // sprinkle flag literals across the render code.
  const SUB_FLAG_MAP = {
    booking:  'FEATURE_TSH_EV_BOOKING',
    receipt:  'FEATURE_TSH_EV_RECEIPT',
    rfid:     'FEATURE_TSH_EV_RFID',
    support:  'FEATURE_TSH_EV_SUPPORT',
  };

  const $  = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));

  // ---- Render helpers ------------------------------------------------------

  function renderStationBar(station) {
    const nameEl = $('[data-ev-station-name]');
    const locEl  = $('[data-ev-station-location]');
    const capEl  = $('[data-ev-station-capacity]');
    const statEl = $('[data-ev-station-status]');
    if (nameEl) nameEl.textContent = station && station.name  ? station.name  : '—';
    if (locEl)  locEl.innerHTML    = '<i class="fas fa-location-dot"></i> ' + esc(station && station.location ? station.location : '—');
    const kw = station && Number.isFinite(station.capacityKw) ? station.capacityKw : null;
    if (capEl)  capEl.innerHTML    = '<i class="fas fa-bolt"></i> ' + (kw !== null ? kw + ' kW' : '—');
    if (statEl) {
      const on = !!(station && station.enabled);
      statEl.textContent = on ? 'Online' : 'Offline';
      statEl.className   = 'tsh-ev-status-pill ' + (on ? 'tsh-ev-status-online' : 'tsh-ev-status-offline');
    }
  }

  function renderGuidelines(list) {
    const ul = $('#evGuidelinesList');
    const wrap = $('#evGuidelines');
    if (!ul || !wrap) return;
    if (!Array.isArray(list) || list.length === 0) {
      wrap.hidden = true;
      ul.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    ul.innerHTML = list.map((s) => '<li>' + esc(s) + '</li>').join('');
  }

  function renderFaqs(list) {
    const host = $('#evFaqList');
    if (!host) return;
    if (!Array.isArray(list) || list.length === 0) {
      // Leave the built-in "no FAQs configured" hint in place.
      return;
    }
    host.innerHTML = list.map((it) => {
      const q = esc(it && it.q ? it.q : '');
      const a = esc(it && it.a ? it.a : '');
      return '<div class="tsh-ev-faq-item"><p class="tsh-ev-faq-q">' + q + '</p><p class="tsh-ev-faq-a">' + a + '</p></div>';
    }).join('');
  }

  // Hide any pill / panel whose sub-flag is off. `subFlags` comes from
  // GET /ev/config so we do not have to re-derive via Flags.on() per node.
  function applySubFlagVisibility(subFlags) {
    $$('[data-tsh-ev-sub]').forEach((el) => {
      const key = el.getAttribute('data-tsh-ev-sub');
      if (!key) return;
      const enabled = !!(subFlags && subFlags[key]);
      if (!enabled) {
        // Remove from the DOM entirely so keyboard tab-order and
        // aria-selected do not land on a hidden control.
        el.remove();
      }
    });
  }

  function wirePills() {
    const pills  = $$('.tsh-ev-pill');
    const panels = $$('.tsh-ev-tab-panel');
    pills.forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-ev-tab');
        pills.forEach((p) => {
          const on = p === btn;
          p.classList.toggle('tsh-ev-pill-active', on);
          p.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panels.forEach((panel) => {
          panel.hidden = panel.getAttribute('data-ev-panel') !== target;
        });
        // Lazy-load per-panel data.
        if (target === 'book')    refreshAvailability();
        if (target === 'history') refreshHistory();
      });
    });
  }

  // ---- Phase 2: Booking (availability grid + form + history) --------------

  // Populated by GET /ev/config so the grid respects site policy.
  let bookingPolicy = null;
  let stationId     = null;
  // Currently selected slot range on the grid: [startMin, endMin) in local
  // minutes-since-midnight IST. Null when nothing is selected.
  let selection = null;
  // In-flight availability data for the picked date.
  let currentAvailability = null;

  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const minsToHHMM = (m) => pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  const todayIstYmd = () => {
    // Simple approximation: use client TZ. Server uses IST for the actual
    // window check, so a mismatch just falls through to the server error.
    const d = new Date();
    const y = d.getFullYear();
    return y + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };

  function primeBookingContext(cfg) {
    bookingPolicy = cfg && cfg.booking ? cfg.booking : null;
    stationId     = cfg && cfg.station && cfg.station.id ? cfg.station.id : 'ev-1';
    const dateEl = $('#evDate');
    if (dateEl && !dateEl.value) {
      dateEl.value = todayIstYmd();
      dateEl.min   = todayIstYmd();
    }
    if (dateEl) dateEl.addEventListener('change', () => refreshAvailability());
    const form = $('#evBookForm');
    if (form) form.addEventListener('submit', onBookSubmit);
    const cancelBtn = $('#evBookCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', clearSelection);
  }

  async function refreshAvailability() {
    if (!bookingPolicy) return;
    const dateEl = $('#evDate');
    const grid   = $('#evSlotGrid');
    const status = $('#evGridStatus');
    if (!dateEl || !grid) return;
    const date = dateEl.value || todayIstYmd();
    grid.innerHTML = '';
    if (status) status.textContent = 'Loading availability…';
    clearSelection();
    try {
      const q = new URLSearchParams({ from: date, to: date, stationId: stationId });
      const payload = await root.Api.get('/ev/availability?' + q.toString());
      const data = payload && payload.ok ? payload.data : payload;
      currentAvailability = data;
      renderSlotGrid(data);
      if (status) status.textContent = '';
    } catch (e) {
      if (status) status.textContent = 'Could not load availability: ' + (e && e.message || e);
    }
  }

  function renderSlotGrid(data) {
    const grid = $('#evSlotGrid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!data || !Array.isArray(data.days) || !data.days.length) {
      grid.innerHTML = '<p class="tsh-sub">No slots configured.</p>';
      return;
    }
    const day = data.days[0];
    const slots = Array.isArray(day.slots) ? day.slots : [];
    if (!slots.length) {
      grid.innerHTML = '<p class="tsh-sub">Charger is closed on this date.</p>';
      return;
    }
    slots.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsh-ev-slot' + (s.booked ? ' tsh-ev-slot--booked' : '');
      btn.setAttribute('role', 'gridcell');
      btn.dataset.startMin = String(s.startMin);
      btn.dataset.endMin   = String(s.endMin);
      btn.disabled = !!s.booked;
      btn.innerHTML = '<span class="tsh-ev-slot-time">' + minsToHHMM(s.startMin) + '</span>';
      btn.setAttribute('aria-label', minsToHHMM(s.startMin) + '–' + minsToHHMM(s.endMin) + (s.booked ? ' (booked)' : ''));
      btn.addEventListener('click', () => onSlotClick(s.startMin, s.endMin));
      grid.appendChild(btn);
    });
  }

  function onSlotClick(startMin, endMin) {
    const p = bookingPolicy || {};
    const step = p.stepMinutes || 30;
    const min  = p.minDurationMinutes || step;
    const max  = p.maxDurationMinutes || step;
    if (!selection) {
      selection = { start: startMin, end: startMin + Math.max(step, min) };
    } else if (startMin < selection.start) {
      selection = { start: startMin, end: selection.end };
    } else {
      const newEnd = endMin;
      if (newEnd - selection.start > max) {
        toast('Cannot exceed ' + max + '-min booking window', { kind: 'warn' });
        return;
      }
      selection = { start: selection.start, end: newEnd };
    }
    // Validate no booked slot falls inside the selection.
    if (hasBookedInRange(selection.start, selection.end)) {
      toast('Selection overlaps a booked slot', { kind: 'warn' });
      selection = null;
    }
    paintSelection();
    updateBookForm();
  }

  function hasBookedInRange(s, e) {
    if (!currentAvailability || !currentAvailability.days || !currentAvailability.days[0]) return false;
    const slots = currentAvailability.days[0].slots || [];
    return slots.some((sl) => sl.booked && sl.startMin < e && s < sl.endMin);
  }

  function paintSelection() {
    $$('#evSlotGrid .tsh-ev-slot').forEach((btn) => {
      btn.classList.remove('tsh-ev-slot--selected');
      if (!selection) return;
      const sm = +btn.dataset.startMin;
      const em = +btn.dataset.endMin;
      if (sm >= selection.start && em <= selection.end) {
        btn.classList.add('tsh-ev-slot--selected');
      }
    });
  }

  function clearSelection() {
    selection = null;
    paintSelection();
    updateBookForm();
  }

  function updateBookForm() {
    const form = $('#evBookForm');
    const sum  = $('#evBookSummary');
    if (!form || !sum) return;
    if (!selection) {
      form.hidden = true;
      sum.textContent = '';
      return;
    }
    form.hidden = false;
    const date = ($('#evDate') && $('#evDate').value) || todayIstYmd();
    sum.innerHTML = '<i class="fas fa-clock"></i> <strong>' + esc(date) + '</strong> · '
      + minsToHHMM(selection.start) + '–' + minsToHHMM(selection.end)
      + ' <span class="tsh-sub">(' + (selection.end - selection.start) + ' min)</span>';
    // Pre-fill owner name from Auth if empty.
    const nameEl = $('#evOwnerName');
    if (nameEl && !nameEl.value && root.Auth && root.Auth.identity) {
      const id = root.Auth.identity();
      if (id && id.name) nameEl.value = id.name;
    }
  }

  async function onBookSubmit(ev) {
    ev.preventDefault();
    if (!selection) return;
    const date = ($('#evDate') && $('#evDate').value) || todayIstYmd();
    const ownerFlat = ($('#evOwnerFlat') && $('#evOwnerFlat').value || '').trim();
    const ownerName = ($('#evOwnerName') && $('#evOwnerName').value || '').trim();
    const notes     = ($('#evNotes')     && $('#evNotes').value     || '').trim();
    if (!ownerFlat) {
      toast('Please enter your flat/unit', { kind: 'warn' });
      return;
    }
    const btn = $('#evBookSubmit');
    if (btn) { btn.disabled = true; btn.dataset.origHtml = btn.innerHTML; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Booking…'; }
    try {
      const payload = await root.Api.post('/ev/bookings', {
        date, startMin: selection.start, endMin: selection.end,
        ownerFlat, ownerName: ownerName || undefined,
        notes: notes || undefined,
      });
      const item = payload && payload.data ? payload.data.item : null;
      toast(item && item.status === 'pending' ? 'Booking submitted — awaiting approval' : 'Slot booked!', { kind: 'success' });
      clearSelection();
      const form = $('#evBookForm');
      if (form) form.reset();
      await refreshAvailability();
    } catch (e) {
      toast('Booking failed: ' + (e && e.message || e), { kind: 'danger' });
    } finally {
      if (btn) { btn.disabled = false; if (btn.dataset.origHtml) btn.innerHTML = btn.dataset.origHtml; }
    }
  }

  async function refreshHistory() {
    const list   = $('#evHistoryList');
    const status = $('#evHistoryStatus');
    if (!list) return;
    list.innerHTML = '';
    if (status) status.textContent = 'Loading your bookings…';
    try {
      const payload = await root.Api.get('/ev/bookings?scope=own');
      const items = payload && payload.data ? (payload.data.items || []) : [];
      if (!items.length) {
        if (status) status.textContent = 'No bookings yet. Head to Book to reserve your first slot.';
        return;
      }
      if (status) status.textContent = '';
      items.forEach((it) => list.appendChild(renderHistoryCard(it)));
    } catch (e) {
      if (status) status.textContent = 'Could not load history: ' + (e && e.message || e);
    }
  }

  function renderHistoryCard(it) {
    const li = document.createElement('li');
    li.className = 'tsh-ev-hist-card tsh-ev-hist-' + esc(it.status || 'pending');
    const isActive = it.status === 'pending' || it.status === 'confirmed';
    const start = Number.isFinite(it.startMin) ? minsToHHMM(it.startMin) : '—';
    const end   = Number.isFinite(it.endMin)   ? minsToHHMM(it.endMin)   : '—';
    li.innerHTML = ''
      + '<div class="tsh-ev-hist-head">'
      +   '<span class="tsh-ev-hist-date"><i class="fas fa-calendar"></i> ' + esc(it.date) + '</span>'
      +   '<span class="tsh-ev-hist-time"><i class="fas fa-clock"></i> ' + start + '–' + end + '</span>'
      +   '<span class="tsh-ev-hist-status tsh-ev-hist-status-' + esc(it.status) + '">' + esc(it.status) + '</span>'
      + '</div>'
      + '<div class="tsh-ev-hist-meta">'
      +   '<span><i class="fas fa-door-open"></i> Flat ' + esc(it.owner && it.owner.flat) + '</span>'
      +   (it.notes ? '<span class="tsh-ev-hist-notes"><i class="fas fa-note-sticky"></i> ' + esc(it.notes) + '</span>' : '')
      + '</div>'
      + (isActive ? '<div class="tsh-ev-hist-actions"><button type="button" class="tsh-btn tsh-btn-ghost tsh-ev-hist-cancel" data-id="' + esc(it.id) + '"><i class="fas fa-xmark"></i> Cancel booking</button></div>' : '');
    const cancelBtn = li.querySelector('.tsh-ev-hist-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelBooking(it.id));
    return li;
  }

  async function cancelBooking(id) {
    if (!id) return;
    if (!confirm('Cancel this booking?')) return;
    try {
      await root.Api.patch('/ev/bookings/' + encodeURIComponent(id), { status: 'cancelled' });
      toast('Booking cancelled', { kind: 'success' });
      await refreshHistory();
    } catch (e) {
      toast('Cancel failed: ' + (e && e.message || e), { kind: 'danger' });
    }
  }

  function toast(msg, opts) {
    if (root.UI && root.UI.toast) root.UI.toast(msg, opts || {});
  }

  // ---- Gates ---------------------------------------------------------------

  function renderDisabledGate() {
    const main = document.querySelector('main.tsh-main');
    if (!main) return;
    main.innerHTML = ''
      + '<section class="tsh-card">'
      + '<header class="tsh-card-head"><h1><i class="fas fa-charging-station gold-accent"></i> EV Charging</h1></header>'
      + '<div class="tsh-ev-disabled-gate">'
      + '<i class="fas fa-power-off"></i>'
      + '<p><strong>EV Charging is not enabled for this site.</strong></p>'
      + '<p class="tsh-sub">Ask an admin to turn on <code>FEATURE_TSH_EV_CHARGING</code> in Settings → Feature flags → EV charging.</p>'
      + '</div></section>';
  }

  const isSignedIn = () => !!(root.Auth && root.Auth.token && root.Auth.token());

  // ---- Bootstrap -----------------------------------------------------------

  let bootstrapped = false;
  let signinCard;
  let mainCard;

  async function bootstrapSignedIn() {
    if (bootstrapped) return;
    bootstrapped = true;
    let payload;
    try {
      payload = await root.Api.get('/ev/config');
    } catch (e) {
      if (root.UI && root.UI.toast) {
        root.UI.toast('Could not load EV config: ' + (e && e.message || e), { kind: 'danger' });
      }
      return;
    }
    const data = payload && payload.ok ? payload.data : payload;
    if (!data) return;
    applySubFlagVisibility(data.subFlags || {});
    renderStationBar(data.station || {});
    renderGuidelines(data.usageGuidelines || []);
    renderFaqs(data.faqs || []);
    wirePills();
    // Phase 2: booking UI. Only prime + fetch when the sub-flag is on.
    if (data.subFlags && data.subFlags.booking) {
      primeBookingContext(data);
      // Kick off initial availability render on the default (Book) tab.
      await refreshAvailability();
    }
  }

  async function syncGate() {
    if (isSignedIn()) {
      if (signinCard) signinCard.hidden = true;
      if (mainCard)   mainCard.hidden   = false;
      await bootstrapSignedIn();
    } else if (!bootstrapped) {
      if (signinCard) signinCard.hidden = false;
      if (mainCard)   mainCard.hidden   = true;
    }
  }

  async function init() {
    try {
      await root.Flags.ready();
    } catch (_e) { /* keep the sign-in card visible on config failure */ }
    if (root.Flags && root.Flags.on && !root.Flags.on(MASTER_FLAG)) {
      renderDisabledGate();
      return;
    }
    signinCard = $('[data-ev-signin]');
    mainCard   = $('[data-ev-main]');
    if (root.Auth && typeof root.Auth.onChange === 'function') {
      root.Auth.onChange(() => { syncGate(); });
    }
    await syncGate();
  }

  root.EvCharging = { init, _renderStationBar: renderStationBar, _SUB_FLAG_MAP: SUB_FLAG_MAP };
})(window);

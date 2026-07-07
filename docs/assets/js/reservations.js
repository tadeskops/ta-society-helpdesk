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

  // Calendar-view state.
  let calView = 'week';      // 'week' | 'day' | (future: 'month')
  let calAnchor = null;      // YYYY-MM-DD (Monday for week view, that day for day view)
  let calPayload = null;     // last availability response

  // Wizard-mode state (Book tab). `bookMode` toggles between the calendar
  // and the 4-step guided wizard (Facility → Date & Time → Details → Review).
  // Residents default to 'wizard'; staff default to 'calendar' since the
  // drag-book UX + on-behalf-of workflow is faster there.
  let bookMode = 'wizard';
  let wiz = { step: 1, date: null, startMin: null, durationMin: null, purpose: '', flat: '', phone: '', ownerEmail: '', tc: false, heatmapMonth: null, heatmap: null, submitting: false };

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
    'deleted':           'Removed from list',
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
    'deleted':           'fa-trash',
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

    // Staff default to Calendar mode; residents to the guided Wizard.
    bookMode = isStaff ? 'calendar' : 'wizard';
    wireBookMode();

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

    bindPdfReport();
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
    if (name === 'book' && selectedFacility) renderCalendar();
  }

  // -------------------------------------------------------- time / range utils

  // Local-timezone (IST-agnostic) helpers work on YYYY-MM-DD strings only.
  function ymdToParts(ymd) { const [y,m,d] = ymd.split('-').map(Number); return { y, m, d }; }
  function partsToDate(p)  { return new Date(Date.UTC(p.y, p.m - 1, p.d)); }
  function dateToYmd(d)    { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }

  // Add N calendar days (can be negative) to a YYYY-MM-DD.
  function addDays(ymd, n) {
    const p = ymdToParts(ymd);
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return dateToYmd(d);
  }

  // Return the Monday of the ISO week containing ymd (Mon..Sun grid).
  function mondayOf(ymd) {
    const p = ymdToParts(ymd);
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
    const dow = d.getUTCDay();              // 0=Sun..6=Sat
    const offset = (dow === 0) ? -6 : 1 - dow;
    return addDays(ymd, offset);
  }

  function formatHHMM(min) {
    const m = Math.max(0, Math.floor(min));
    return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  }

  function facilityHoursLabel(f) {
    const p = (f && f.policy) || {};
    const o = Number(p.openMin);
    const c = Number(p.closeMin);
    if (Number.isFinite(o) && Number.isFinite(c) && c > o) {
      return `${formatHHMM(o)}–${formatHHMM(c)}`;
    }
    return 'flexible hours';
  }

  function reservationTimeLabel(r) {
    if (r && typeof r.startMin === 'number' && typeof r.endMin === 'number' && r.endMin > r.startMin) {
      return `${formatHHMM(r.startMin)}–${formatHHMM(r.endMin)}`;
    }
    return (r && r.slotLabel) || '';
  }

  // Rate-card + usage-guidelines are read-only in the booking modal; the
  // admin/committee/manager Settings modal below is the only writer.
  function renderRateCard(rateCard) {
    const rows = Array.isArray(rateCard) ? rateCard.filter((r) => r && r.label) : [];
    if (!rows.length) return '';
    const body = rows.map((r) => {
      const amt = (typeof r.amount === 'number') ? '₹' + Number(r.amount).toLocaleString('en-IN') : '—';
      const note = r.note ? '<div style="font-size:11px;opacity:.75;">' + escape(r.note) + '</div>' : '';
      return '<tr><td>' + escape(r.label) + note + '</td><td class="tsh-res-rc-amount">' + amt + '</td></tr>';
    }).join('');
    return (
      '<div class="tsh-res-ratecard">' +
        '<div style="font-weight:600;margin-bottom:4px;font-size:12px;"><i class="fas fa-indian-rupee-sign"></i> Rate card <span style="font-weight:400;opacity:.65;">(indicative — manager confirms final amount)</span></div>' +
        '<table><tbody>' + body + '</tbody></table>' +
      '</div>'
    );
  }

  function renderGuidelines(g) {
    if (!g) return '';
    const before = Array.isArray(g.before) ? g.before.filter(Boolean) : [];
    const after  = Array.isArray(g.after)  ? g.after.filter(Boolean)  : [];
    if (!before.length && !after.length) return '';
    const block = (title, icon, items) => items.length
      ? '<div class="tsh-res-guide"><h5>' + icon + ' ' + escape(title) + '</h5><ul>' +
        items.map((s) => '<li>' + escape(s) + '</li>').join('') + '</ul></div>'
      : '';
    return (
      block('Before you use the facility', '<i class="fas fa-clipboard-check"></i>', before) +
      block('After you finish', '<i class="fas fa-broom"></i>', after)
    );
  }

  // -------------------------------------------------------- facilities

  function renderFacilityPicker() {
    const sel  = $('#resFacilitySelect');
    const bar  = $('#resFacilitySettings');
    const blurb = $('#resFacilityBlurb');
    if (!sel) return;
    sel.innerHTML = '';
    if (!facilities.length) {
      sel.innerHTML = '<option value="">— No facilities configured —</option>';
      sel.disabled = true;
      if (blurb) blurb.textContent = '';
      $('#resBookBody').hidden = true;
      return;
    }
    sel.disabled = false;
    facilities.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = f.name + (f.capacity ? ` · up to ${f.capacity} people` : '');
      sel.appendChild(opt);
    });
    sel.onchange = () => selectFacility(sel.value);
    if (bar) {
      const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
      bar.hidden = !isStaff;
      bar.title = 'Society Manager, Committee & Admin: edit rates, rate history, rules and policy for this facility.';
      bar.onclick = () => openFacilitySettings();
    }
    const tplBtn = $('#resReceiptTemplate');
    if (tplBtn) {
      const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
      tplBtn.hidden = !isStaff;
      tplBtn.onclick = () => openReceiptTemplateManager();
    }
  }

  function selectFacility(id) {
    selectedFacility = facilities.find((f) => f.id === id) || null;
    const sel = $('#resFacilitySelect');
    if (sel && sel.value !== id && selectedFacility) sel.value = selectedFacility.id;
    if (!selectedFacility) return;
    applyBookModeVisibility();
    // Blurb: description + hours + advance-booking window.
    const blurb = $('#resFacilityBlurb');
    if (blurb) {
      const p = selectedFacility.policy || {};
      const bits = [];
      if (selectedFacility.description) bits.push(escape(selectedFacility.description));
      bits.push('<i class="far fa-clock"></i> ' + escape(facilityHoursLabel(selectedFacility)));
      bits.push('<i class="fas fa-calendar-plus"></i> book up to ' + (p.maxAdvanceDays || 0) + 'd ahead');
      bits.push('<i class="fas fa-hourglass-half"></i> min ' + (p.minAdvanceHours || 0) + 'h notice');
      if (selectedFacility.capacity) bits.push('<i class="fas fa-users"></i> up to ' + selectedFacility.capacity + ' people');
      blurb.innerHTML = bits.join(' &nbsp;·&nbsp; ');
    }
    renderFacilityRules();
    // Reset wizard state when the facility changes.
    wiz.step = 1;
    wiz.date = null; wiz.startMin = null; wiz.durationMin = null;
    wiz.heatmap = null; wiz.heatmapMonth = null;
    wiz.tc = false;
    // Initialise calendar to Today (Monday of this week).
    if (!calAnchor) calAnchor = mondayOf(istToday());
    // Small screens default to a single-day view for readability.
    if (typeof window !== 'undefined' && window.innerWidth && window.innerWidth <= 480) {
      calView = 'day';
      calAnchor = istToday();
    }
    updateViewButtons();
    if (bookMode === 'wizard') renderWizard();
    else renderCalendar();
  }

  function renderFacilityRules() {
    const host = $('#resFacilityRules');
    if (!selectedFacility) { host.innerHTML = ''; return; }
    const rules = selectedFacility.rules || [];
    if (!rules.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<strong>House rules:</strong> ' + rules.map(escape).join(' · ');
  }

  // -------------------------------------------------------- calendar toolbar + navigation

  function wireRange() {
    const prev = $('#resCalPrev');
    const today = $('#resCalToday');
    const next = $('#resCalNext');
    if (prev)  prev.addEventListener('click', () => shiftCal(-1));
    if (next)  next.addEventListener('click', () => shiftCal(+1));
    if (today) today.addEventListener('click', jumpToToday);
    $$('.tsh-cal-view').forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-cal-view');
        if (!v || v === calView) return;
        setView(v);
      });
    });
    $('#resManageSearch').addEventListener('input', () => renderManageList());
    $('#resManageStatus').addEventListener('change', () => refreshManage());
  }

  function setView(view) {
    calView = view;
    // When switching Week → Day, anchor on the day the user was likely
    // looking at (today if it's in the visible week, otherwise the week's
    // Monday). Day → Week anchors on the Monday of the visible day.
    if (view === 'day') {
      const today = istToday();
      const weekStart = calAnchor;
      const weekEnd = addDays(weekStart, 6);
      calAnchor = (today >= weekStart && today <= weekEnd) ? today : weekStart;
    } else if (view === 'week') {
      calAnchor = mondayOf(calAnchor || istToday());
    }
    updateViewButtons();
    renderCalendar();
  }

  function shiftCal(direction) {
    const step = calView === 'day' ? 1 : 7;
    calAnchor = addDays(calAnchor || istToday(), direction * step);
    renderCalendar();
  }

  function jumpToToday() {
    calAnchor = calView === 'day' ? istToday() : mondayOf(istToday());
    renderCalendar();
  }

  function updateViewButtons() {
    $$('.tsh-cal-view').forEach((btn) => {
      btn.classList.toggle('tsh-cal-view-active', btn.getAttribute('data-cal-view') === calView);
    });
  }

  function calRange() {
    // How many days the current view spans, and the anchor.
    if (calView === 'day') {
      return { from: calAnchor, to: calAnchor, days: 1 };
    }
    // Week
    return { from: calAnchor, to: addDays(calAnchor, 6), days: 7 };
  }

  function calRangeLabel(range) {
    if (range.days === 1) return friendlyRelDate(range.from) + ' · ' + friendlyDate(range.from);
    const a = ymdToParts(range.from);
    const b = ymdToParts(range.to);
    const monthA = partsToDate(a).toLocaleDateString(undefined, { month: 'short' });
    const monthB = partsToDate(b).toLocaleDateString(undefined, { month: 'short' });
    if (a.y === b.y && a.m === b.m) return `${monthA} ${a.d}–${b.d}, ${a.y}`;
    if (a.y === b.y)                return `${monthA} ${a.d} – ${monthB} ${b.d}, ${a.y}`;
    return `${monthA} ${a.d}, ${a.y} – ${monthB} ${b.d}, ${b.y}`;
  }

  // -------------------------------------------------------- calendar renderer

  async function renderCalendar() {
    if (!selectedFacility) return;
    const host = $('#resCalendar');
    if (!host) return;
    const range = calRange();
    const label = $('#resCalLabel');
    if (label) label.textContent = calRangeLabel(range);
    host.innerHTML = '<p class="tsh-hint" style="padding:14px"><i class="fas fa-spinner fa-spin"></i> Loading availability…</p>';
    let payload;
    try {
      payload = await root.Api.get(
        `/facilities/${encodeURIComponent(selectedFacility.id)}/availability?from=${range.from}&to=${range.to}`
      );
    } catch (e) {
      host.innerHTML = '<p class="tsh-empty">Could not load availability: ' + escape(e && e.message || String(e)) + '</p>';
      return;
    }
    calPayload = payload;
    drawCalendar(host, payload, range);
  }

  function drawCalendar(host, payload, range) {
    host.innerHTML = '';
    const open = payload.open || {};
    const openMin  = Number.isFinite(open.openMin)  ? open.openMin  : 6 * 60;
    const closeMin = Number.isFinite(open.closeMin) ? open.closeMin : 23 * 60;
    const stepMin  = Number.isFinite(open.stepMinutes) ? open.stepMinutes : 30;
    const totalMin = Math.max(stepMin, closeMin - openMin);
    const totalRows = Math.ceil(totalMin / stepMin);
    // Adaptive row height. On Day view (1 wide column) rows can grow
    // for easier clicking; on Week view we compress so the whole day
    // fits inside a ~520 px scroll body without the eye-tiring 1500 px
    // strip we used to render for 15-minute grids.
    const target = calView === 'day' ? 640 : 520;
    const minRow = calView === 'day' ? 22 : 14;
    const maxRow = calView === 'day' ? 44 : 26;
    const rowH = Math.max(minRow, Math.min(maxRow, Math.floor(target / totalRows)));
    // How many step-rows make up an hour (used to draw solid hour lines
    // and for the quick-pick strip).
    const rowsPerHour = Math.max(1, Math.round(60 / stepMin));

    // Map date → busy list from server.
    const dayIndex = new Map();
    (payload.days || []).forEach((d) => dayIndex.set(d.date, d));

    const cols = range.days;
    const wrap = document.createElement('div');
    wrap.className = 'tsh-cal-week';
    wrap.style.setProperty('--cal-cols', String(cols));
    wrap.style.setProperty('--cal-row-h', rowH + 'px');

    // ---------------- HEADER ROW
    const corner = document.createElement('div');
    corner.className = 'tsh-cal-corner tsh-cal-daycol-head';
    corner.setAttribute('aria-hidden', 'true');
    wrap.appendChild(corner);

    const today = istToday();
    const nowMs = Date.now();
    const minAdvanceMs = ((selectedFacility.policy && selectedFacility.policy.minAdvanceHours) || 0) * 3600 * 1000;

    const dayCells = [];       // for body pass
    for (let i = 0; i < cols; i++) {
      const date = addDays(range.from, i);
      const dayInfo = dayIndex.get(date) || { date, blackout: false, busy: [] };
      const head = document.createElement('div');
      head.className = 'tsh-cal-daycol-head';
      if (date === today) head.classList.add('tsh-cal-today');
      if (date < today) head.classList.add('tsh-cal-past');
      if (dayInfo.blackout) head.classList.add('tsh-cal-blackout');
      const dt = partsToDate(ymdToParts(date));
      head.innerHTML =
        '<span>' + dt.toLocaleDateString(undefined, { weekday: 'short' }) + '</span>' +
        '<strong>' + dt.getUTCDate() + '</strong>';
      wrap.appendChild(head);
      dayCells.push({ date, dayInfo });
    }

    // ---------------- BODY: time gutter
    const timecol = document.createElement('div');
    timecol.className = 'tsh-cal-timecol';
    timecol.style.gridRow = 'auto';
    for (let r = 0; r < totalRows; r++) {
      const cellMin = openMin + r * stepMin;
      const t = document.createElement('div');
      t.className = 'tsh-cal-timecol-cell';
      if (cellMin % 60 === 0) t.classList.add('tsh-cal-hour');
      // Label only on the hour to keep the gutter uncluttered.
      t.textContent = (cellMin % 60 === 0) ? formatHHMM(cellMin) : '';
      timecol.appendChild(t);
    }
    wrap.appendChild(timecol);

    // ---------------- BODY: day columns with busy blocks
    dayCells.forEach(({ date, dayInfo }) => {
      const col = document.createElement('div');
      col.className = 'tsh-cal-daycol';
      if (dayInfo.blackout) col.classList.add('tsh-cal-blackout');

      // Click rows (one per step).
      for (let r = 0; r < totalRows; r++) {
        const cellMin = openMin + r * stepMin;
        const slot = document.createElement('div');
        slot.className = 'tsh-cal-slot';
        if (cellMin % 60 === 0) slot.classList.add('tsh-cal-hour');
        slot.setAttribute('data-date', date);
        slot.setAttribute('data-min', String(cellMin));
        // Determine if this cell is in the past (min-advance enforced).
        const [y, m, d] = date.split('-').map(Number);
        const startMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS + cellMin * 60 * 1000;
        const inPast = (startMs - nowMs) < minAdvanceMs;
        if (inPast || dayInfo.blackout) slot.classList.add('tsh-cal-slot-past');
        else {
          slot.addEventListener('click', () => {
            const dur = defaultDurationFor(cellMin, closeMin, selectedFacility.policy);
            openBookModal(date, cellMin, Math.min(closeMin, cellMin + dur));
          });
        }
        col.appendChild(slot);
      }

      // Busy blocks (absolute positioning).
      (dayInfo.busy || []).forEach((b) => {
        const s = Math.max(openMin, Number(b.startMin) || 0);
        const e = Math.min(closeMin, Number(b.endMin) || 0);
        if (e <= s) return;
        const top    = ((s - openMin) / stepMin) * rowH;
        const height = Math.max(rowH * 0.75, ((e - s) / stepMin) * rowH);
        const ev = document.createElement('div');
        ev.className = 'tsh-cal-event tsh-cal-ev-' + (b.status === 'confirmed' ? 'confirmed' : 'held');
        ev.style.top = top + 'px';
        ev.style.height = (height - 2) + 'px';
        ev.innerHTML =
          '<span class="tsh-cal-event-time">' + formatHHMM(s) + '–' + formatHHMM(e) + '</span>' +
          '<span class="tsh-cal-event-title">' + (b.status === 'confirmed' ? 'Confirmed' : 'Requested') + '</span>';
        ev.title = `${formatHHMM(s)}–${formatHHMM(e)} · ${b.status}`;
        if (b.reservationId) {
          ev.addEventListener('click', (ev2) => {
            ev2.stopPropagation();
            openReservationById(b.reservationId);
          });
        }
        col.appendChild(ev);
      });

      // "Now" indicator when Today is in this column.
      if (date === today) {
        const nowIst = new Date(Date.now() + IST_OFFSET_MS);
        const nowMin = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
        if (nowMin >= openMin && nowMin <= closeMin) {
          const nowLine = document.createElement('div');
          nowLine.className = 'tsh-cal-now';
          nowLine.style.top = (((nowMin - openMin) / stepMin) * rowH) + 'px';
          col.appendChild(nowLine);
        }
      }

      wrap.appendChild(col);
    });

    host.appendChild(wrap);

    // Sleek extras: quick-pick chip strip above the grid, and auto-scroll
    // the grid so the current hour (or the day's opening hour if we're
    // ahead of/behind today) is centred on load.
    renderQuickBook(payload, range, {
      openMin, closeMin, stepMin, minAdvanceMs, nowMs, today,
    });
    scrollCalendarToNow(host, { openMin, closeMin, stepMin, rowH, today, range });
  }

  function scrollCalendarToNow(host, opt) {
    if (!host) return;
    const { openMin, closeMin, stepMin, rowH, today, range } = opt;
    let target;
    if (range.from <= today && today <= range.to) {
      const nowIst = new Date(Date.now() + IST_OFFSET_MS);
      const nowMin = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
      if (nowMin >= openMin && nowMin <= closeMin) target = nowMin;
      else target = openMin;
    } else {
      target = openMin;
    }
    const y = Math.max(0, ((target - openMin) / stepMin) * rowH - Math.floor(host.clientHeight * 0.35));
    try { host.scrollTo({ top: y, behavior: 'auto' }); }
    catch (_e) { host.scrollTop = y; }
  }

  // ---------- Quick-pick strip (sleek time selector) --------------------
  // Renders one chip per hour in the current facility's open window,
  // scoped to the "quick day": today if today is inside the visible
  // range, otherwise the first day of that range. Chips are colour-coded
  // free / partly-busy / fully-busy / past / blocked and, when free,
  // launch the book modal for that hour.

  function renderQuickBook(payload, range, opt) {
    const host = $('#resQuickBook');
    if (!host || !selectedFacility) return;
    const { openMin, closeMin, stepMin, minAdvanceMs, nowMs, today } = opt;

    // Pick the "quick day".
    const quickDate = (range.from <= today && today <= range.to)
      ? today
      : range.from;

    const days = payload.days || [];
    const dayInfo = days.find((d) => d && d.date === quickDate) || { date: quickDate, blackout: false, busy: [] };

    if (dayInfo.blackout) {
      host.hidden = false;
      host.innerHTML =
        '<span class="tsh-cal-quick-label"><i class="far fa-calendar-xmark"></i> ' + escape(friendlyRelDate(quickDate)) + '</span>' +
        '<span class="tsh-cal-quick-empty">Blocked for this facility.</span>';
      return;
    }

    // Bucket busy segments into hour slots for a quick scan.
    const busy = dayInfo.busy || [];
    const chips = [];
    const startHour = Math.floor(openMin / 60);
    const endHour = Math.ceil(closeMin / 60);
    for (let h = startHour; h < endHour; h++) {
      const hourStart = h * 60;
      const hourEnd = hourStart + 60;
      // Clip against the facility's actual open window.
      const winStart = Math.max(hourStart, openMin);
      const winEnd = Math.min(hourEnd, closeMin);
      if (winEnd - winStart < stepMin) continue;
      let occupied = 0;
      let anyConfirmed = false;
      busy.forEach((b) => {
        const s = Math.max(winStart, Number(b.startMin) || 0);
        const e = Math.min(winEnd, Number(b.endMin) || 0);
        if (e > s) {
          occupied += (e - s);
          if (b.status === 'confirmed') anyConfirmed = true;
        }
      });
      const capacity = winEnd - winStart;
      const [y, mo, d] = quickDate.split('-').map(Number);
      const cellMs = Date.UTC(y, mo - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS + winStart * 60 * 1000;
      const inPast = (cellMs - nowMs) < minAdvanceMs;

      let cls = 'tsh-cal-quick-chip';
      let label = String(h).padStart(2, '0') + ':00';
      let title = label + ' \u2013 ' + String(h + 1).padStart(2, '0') + ':00';
      if (inPast) {
        cls += ' tsh-cal-quick-past';
        title += ' \u00b7 past / too soon';
      } else if (occupied >= capacity) {
        cls += ' tsh-cal-quick-full';
        title += ' \u00b7 fully booked (' + (anyConfirmed ? 'confirmed' : 'requested') + ')';
      } else if (occupied > 0) {
        cls += ' tsh-cal-quick-busy';
        title += ' \u00b7 partly booked \u2014 pick a free slot in the grid';
      } else {
        title += ' \u00b7 free \u2014 click to book';
      }

      chips.push({ label, title, cls, hourStart: winStart, inPast, blockedOrFull: (inPast || occupied >= capacity) });
    }

    if (!chips.length) {
      host.hidden = true;
      return;
    }

    host.hidden = false;
    host.innerHTML = '';
    const lbl = document.createElement('span');
    lbl.className = 'tsh-cal-quick-label';
    lbl.innerHTML = '<i class="fas fa-bolt"></i> Quick book &middot; ' + escape(friendlyRelDate(quickDate));
    host.appendChild(lbl);

    const strip = document.createElement('div');
    strip.className = 'tsh-cal-quick-chips';
    chips.forEach((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = c.cls;
      b.textContent = c.label;
      b.title = c.title;
      if (c.blockedOrFull) b.disabled = true;
      else b.addEventListener('click', () => {
        const dur = defaultDurationFor(c.hourStart, closeMin, selectedFacility.policy);
        openBookModal(quickDate, c.hourStart, Math.min(closeMin, c.hourStart + dur));
      });
      strip.appendChild(b);
    });
    host.appendChild(strip);
  }

  function defaultDurationFor(startMin, closeMin, policy) {
    const p = policy || {};
    const minD = Number.isFinite(p.minDurationMinutes) ? p.minDurationMinutes : 60;
    const maxD = Number.isFinite(p.maxDurationMinutes) ? p.maxDurationMinutes : 8 * 60;
    // Committee-configured default (e.g. 4 h for the Community Hall).
    // Falls back to the minimum booking length when unset.
    const prefer = Number.isFinite(p.defaultDurationMinutes) ? p.defaultDurationMinutes : minD;
    const remaining = Math.max(0, closeMin - startMin);
    return Math.max(minD, Math.min(prefer, remaining, maxD));
  }

  // -------------------------------------------------------- book modal

  function openBookModal(date, startMin, endMin) {
    if (!selectedFacility) return;
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
    const policy = selectedFacility.policy || {};
    const perFlatCap = Number(policy.maxPerFlatPerYear || 2);
    const chargesInfo = (policy.chargesInfo || '').trim();
    const stepMin = Number.isFinite(policy.stepMinutes) ? policy.stepMinutes : 30;
    const minD = Number.isFinite(policy.minDurationMinutes) ? policy.minDurationMinutes : 60;
    const maxD = Number.isFinite(policy.maxDurationMinutes) ? policy.maxDurationMinutes : 8 * 60;
    const closeMin = Number.isFinite(policy.closeMin) ? policy.closeMin : 23 * 60;

    // Build duration options in policy-compliant increments.
    const durChoices = [];
    for (let d = minD; d <= maxD; d += stepMin) durChoices.push(d);
    const initialDur = Math.max(minD, Math.min(maxD, endMin - startMin));

    const durLabel = (d) => {
      const h = Math.floor(d / 60), m = d % 60;
      if (m === 0) return h + ' hour' + (h === 1 ? '' : 's');
      return h ? `${h}h ${m}m` : `${m}m`;
    };

    const wrap = document.createElement('div');
    wrap.className = 'tsh-form';
    wrap.innerHTML =
      '<div class="tsh-form-row"><label><span class="tsh-form-label">Facility</span>' +
      '<input type="text" value="' + escape(selectedFacility.name) + '" disabled /></label></div>' +
      '<div class="tsh-form-row"><label><span class="tsh-form-label">Date</span>' +
      '<input type="text" value="' + escape(friendlyRelDate(date) + ' · ' + friendlyDate(date)) + '" disabled /></label></div>' +
      '<div class="tsh-form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        '<label><span class="tsh-form-label">Start time</span>' +
        '<input type="time" data-book-start value="' + formatHHMM(startMin) + '" step="' + (stepMin * 60) + '" required /></label>' +
        '<label><span class="tsh-form-label">Duration</span>' +
        '<select data-book-duration>' +
          durChoices.map((d) => '<option value="' + d + '"' + (d === initialDur ? ' selected' : '') + '>' + durLabel(d) + '</option>').join('') +
        '</select></label>' +
      '</div>' +
      '<p class="tsh-hint" style="margin-top:-2px;font-size:12px;"><i class="far fa-clock"></i> End time: <strong data-book-end-label>' + formatHHMM(endMin) + '</strong></p>' +
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
      renderRateCard(policy.rateCard) +
      // Live-updating price panel shared with the wizard so residents
      // see the same committee-maintained base + overtime breakdown in
      // both flows. Refreshed by updateEnd() below whenever the user
      // changes the start time or duration.
      '<div data-book-price>' + renderPriceSummary(policy, date, endMin - startMin) + '</div>' +
      renderGuidelines(policy.usageGuidelines) +
      (policy.requiresPayment ?
        '<p class="tsh-hint"><i class="fas fa-info-circle"></i> Payment proof is uploaded after the booking is created; the manager confirms the final amount at approval.</p>' : '');

    // Live-update the "End time" label and price panel as user edits start/duration.
    const startEl    = wrap.querySelector('[data-book-start]');
    const durEl      = wrap.querySelector('[data-book-duration]');
    const endLabelEl = wrap.querySelector('[data-book-end-label]');
    const priceEl    = wrap.querySelector('[data-book-price]');
    const parseHM = (s) => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const updateEnd = () => {
      const s = parseHM(startEl.value);
      const d = Number(durEl.value) || minD;
      const e = Math.min(closeMin, s + d);
      endLabelEl.textContent = formatHHMM(e);
      if (priceEl) priceEl.innerHTML = renderPriceSummary(policy, date, e - s);
    };
    startEl.addEventListener('change', updateEnd);
    durEl.addEventListener('change', updateEnd);

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
      const sMin = parseHM(startEl.value);
      const eMin = Math.min(closeMin, sMin + (Number(durEl.value) || minD));
      submitBooking(date, formatHHMM(sMin), formatHHMM(eMin), purpose, flat, phone, owner);
    });
    setTimeout(() => wrap.querySelector('[data-book-purpose]').focus(), 60);
  }

  async function submitBooking(date, startTime, endTime, purpose, flat, phone, ownerEmail) {
    const body = { facilityId: selectedFacility.id, date, startTime, endTime, purpose, ownerFlat: flat };
    if (phone) body.ownerPhone = phone;
    if (ownerEmail) body.ownerEmail = ownerEmail;
    try {
      const res = await root.Api.post('/reservations', body);
      root.UI.toast('Reservation ' + res.reservation.id + ' created.', { kind: 'success' });
      renderCalendar();
      refreshMine();
      refreshManage();
    } catch (e) {
      root.UI.toast(e && e.message || 'Booking failed', { kind: 'danger' });
    }
  }

  // ================================================================
  // Guided wizard (residents-first booking flow).
  // Same endpoints as calendar mode: GET /facilities/:id/availability
  // populates the month heatmap + hour chips, and POST /reservations
  // is called on submit (reusing the calendar's submitBooking helper).
  // ================================================================

  function wireBookMode() {
    $$('[data-book-mode]').forEach((btn) => {
      btn.addEventListener('click', () => setBookMode(btn.getAttribute('data-book-mode')));
    });
    // Set initial button state to reflect the default derived from role.
    $$('[data-book-mode]').forEach((btn) => btn.classList.toggle('on', btn.getAttribute('data-book-mode') === bookMode));
  }

  function setBookMode(mode) {
    if (mode !== 'wizard' && mode !== 'calendar') return;
    bookMode = mode;
    $$('[data-book-mode]').forEach((btn) => btn.classList.toggle('on', btn.getAttribute('data-book-mode') === bookMode));
    applyBookModeVisibility();
    if (!selectedFacility) return;
    if (bookMode === 'wizard') renderWizard();
    else renderCalendar();
  }

  function applyBookModeVisibility() {
    const wizBody = $('#resWizardBody');
    const calBody = $('#resBookBody');
    if (wizBody) wizBody.hidden = !(selectedFacility && bookMode === 'wizard');
    if (calBody) calBody.hidden = !(selectedFacility && bookMode === 'calendar');
    // The top Facility bar (dropdown + Settings & rates + Receipt template
    // + blurb) is only meaningful in Calendar mode; Wizard mode picks the
    // facility in Step 1 so showing the bar there is redundant.
    $$('[data-book-only]').forEach((el) => {
      const only = el.getAttribute('data-book-only');
      el.hidden = (only !== bookMode);
    });
  }

  function dayOfWeekUTC(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }
  function monthStartOf(ymd) {
    const [y, m] = ymd.split('-').map(Number);
    return `${y}-${pad2(m)}-01`;
  }
  function inr(n) { return '\u20b9' + Number(n || 0).toLocaleString('en-IN'); }

  async function renderWizard() {
    if (!selectedFacility) return;
    renderWizStepper();
    renderWizSummary();
    await renderWizStepPanel();
  }

  const WIZ_STEPS = [
    { n: 1, name: 'Facility' },
    { n: 2, name: 'Date & Time' },
    { n: 3, name: 'Details' },
    { n: 4, name: 'Review' },
  ];

  function wizStepSummary(n) {
    if (n === 1) return selectedFacility ? selectedFacility.name : '\u2014';
    if (n === 2) {
      if (!wiz.date || wiz.startMin == null || !wiz.durationMin) return 'Select a slot';
      return `${friendlyRelDate(wiz.date).split(' ')[0]} \u00b7 ${formatHHMM(wiz.startMin)}\u2013${formatHHMM(wiz.startMin + wiz.durationMin)}`;
    }
    if (n === 3) return wiz.purpose ? (wiz.purpose.length > 22 ? wiz.purpose.slice(0, 22) + '\u2026' : wiz.purpose) : 'Purpose + flat';
    if (n === 4) return wiz.tc ? 'Ready to submit' : 'Confirm details';
    return '';
  }

  function wizCanJumpTo(n) {
    if (n <= 1) return true;
    if (n <= 2) return !!selectedFacility;
    if (n <= 3) return !!selectedFacility && !!wiz.date && wiz.startMin != null && !!wiz.durationMin;
    return (wiz.purpose || '').trim().length >= 3 && !!(wiz.flat || '').trim();
  }

  function renderWizStepper() {
    const host = $('#resWizStepper');
    if (!host) return;
    host.innerHTML = WIZ_STEPS.map((s) => {
      const cls = s.n < wiz.step ? 'done' : (s.n === wiz.step ? 'active' : '');
      return (
        '<div class="step ' + cls + '" data-wiz-goto="' + s.n + '">' +
          '<div class="num">' + (s.n < wiz.step ? '<i class="fas fa-check"></i>' : s.n) + '</div>' +
          '<div class="lbl"><b>' + s.n + '. ' + escape(s.name) + '</b><small>' + escape(wizStepSummary(s.n)) + '</small></div>' +
        '</div>'
      );
    }).join('');
    host.querySelectorAll('[data-wiz-goto]').forEach((el) => el.addEventListener('click', () => {
      const n = Number(el.getAttribute('data-wiz-goto'));
      if (n <= wiz.step || wizCanJumpTo(n)) { wiz.step = n; renderWizard(); }
    }));
  }

  async function renderWizStepPanel() {
    const host = $('#resWizSteps');
    if (!host) return;
    if (wiz.step === 1) return renderWizStepFacility(host);
    if (wiz.step === 2) return renderWizStepDateTime(host);
    if (wiz.step === 3) return renderWizStepDetails(host);
    if (wiz.step === 4) return renderWizStepReview(host);
  }

  // -------- Step 1: Facility --------
  function renderWizStepFacility(host) {
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
    host.innerHTML =
      '<div class="tsh-res-wiz-step">' +
        '<h2><i class="fas fa-building-columns"></i> Pick a facility</h2>' +
        '<p class="sub">All community facilities configured for booking.</p>' +
        '<div class="tsh-res-wiz-facs">' +
          facilities.map((f) => {
            const p = f.policy || {};
            const isPick = selectedFacility && f.id === selectedFacility.id;
            const badges = [];
            if (Number(p.paymentAmount) > 0) badges.push('<span class="badge">' + inr(p.paymentAmount) + ' base</span>');
            if ((p.rateCard || []).some((r) => /weekend/i.test(r.label || ''))) badges.push('<span class="badge blue">Weekend rate</span>');
            if (p.requiresPayment) badges.push('<span class="badge gray">Deposit</span>');
            if (!p.requiresPayment) badges.push('<span class="badge gray">Free</span>');
            const icon = f.icon || 'fa-building';
            return (
              '<div class="tsh-res-wiz-fac ' + (isPick ? 'pick' : '') + '" data-wiz-fid="' + escape(f.id) + '">' +
                '<div class="icon"><i class="fas ' + escape(icon) + '"></i></div>' +
                '<div class="name">' + escape(f.name) + '</div>' +
                (f.description ? '<div class="meta">' + escape(f.description) + '</div>' : '') +
                '<div class="meta">' +
                  (f.capacity ? '<i class="fas fa-users"></i> up to ' + f.capacity + ' \u00b7 ' : '') +
                  '<i class="far fa-clock"></i> ' + escape(facilityHoursLabel(f)) +
                '</div>' +
                (Number(p.paymentAmount) > 0
                  ? '<div class="price">from ' + inr(p.paymentAmount) + '</div>'
                  : '<div class="price">Free</div>') +
                '<div class="badges">' + badges.join('') + '</div>' +
              '</div>'
            );
          }).join('') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<button type="button" class="tsh-btn tsh-btn-primary" data-wiz-next>' +
          '<i class="fas fa-arrow-right"></i> Continue to date &amp; time' +
        '</button>' +
      '</div>';
    host.querySelectorAll('[data-wiz-fid]').forEach((el) => el.addEventListener('click', () => {
      const fid = el.getAttribute('data-wiz-fid');
      if (selectedFacility && selectedFacility.id === fid) return;
      selectFacility(fid);  // resets wizard state and re-renders
    }));
    host.querySelector('[data-wiz-next]').addEventListener('click', () => { wiz.step = 2; renderWizard(); });
  }

  // -------- Step 2: Date & Time (heatmap + hour chips + duration) --------
  async function ensureWizHeatmap() {
    const today = istToday();
    const p = selectedFacility.policy || {};
    if (!wiz.heatmapMonth) wiz.heatmapMonth = monthStartOf(today);
    if (wiz.heatmap && wiz.heatmap._month === wiz.heatmapMonth && wiz.heatmap._fid === selectedFacility.id) return;
    const [y, m] = wiz.heatmapMonth.split('-').map(Number);
    const firstOfMonth = wiz.heatmapMonth;
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
    const lastOfMonth = addDays(nextMonth, -1);
    const from = firstOfMonth > today ? firstOfMonth : today;
    const maxTo = addDays(today, Number(p.maxAdvanceDays || 30));
    const to = lastOfMonth < maxTo ? lastOfMonth : maxTo;
    if (from > to) {
      wiz.heatmap = { open: {}, days: [], _month: wiz.heatmapMonth, _fid: selectedFacility.id, _from: from, _to: to };
      return;
    }
    try {
      const payload = await root.Api.get(
        `/facilities/${encodeURIComponent(selectedFacility.id)}/availability?from=${from}&to=${to}`
      );
      payload._month = wiz.heatmapMonth;
      payload._fid = selectedFacility.id;
      payload._from = from; payload._to = to;
      wiz.heatmap = payload;
    } catch (e) {
      root.UI.toast('Could not load availability: ' + (e && e.message || e), { kind: 'danger' });
      wiz.heatmap = { open: {}, days: [], _month: wiz.heatmapMonth, _fid: selectedFacility.id, _from: from, _to: to };
    }
  }

  // Per-day heatmap load, using the §8.8 status priority:
  //   Blocked (blackout) > Confirmed (any confirmed booking) > Requested
  //   (any held booking) > Available. This keeps the wizard's colour
  //   language identical to the calendar-mode legend so residents learn
  //   one meaning: green=Available, amber=Requested, red=Confirmed,
  //   gray=Blocked.
  function wizDayLoad(dayEntry, _policy) {
    if (!dayEntry) return { cls: '', label: 'Available' };
    if (dayEntry.blackout) return { cls: 'blocked', label: 'Blocked' };
    const busy = dayEntry.busy || [];
    if (busy.some((b) => b.status === 'confirmed')) return { cls: 'confirmed', label: 'Has a confirmed booking' };
    if (busy.some((b) => b.status === 'held'))      return { cls: 'requested', label: 'Has a requested booking' };
    return { cls: '', label: 'Available' };
  }

  function wizComputePrice(policy, date, durationMin) {
    const lines = [];
    const hours = (durationMin || 0) / 60;
    const base  = Number(policy.paymentAmount || 0);
    const baseHours = Number(policy.baseIncludedHours || 0);
    const overtime  = Number(policy.overtimeHourlyAmount || 0);
    if (base > 0) {
      const baseLabel = baseHours > 0
        ? `Base rental (up to ${baseHours}h)`
        : `Base rental (${hours.toFixed(1).replace(/\.0$/, '')}h)`;
      lines.push({ label: baseLabel, amount: base });
    }
    // Charge every extra hour (or part thereof) beyond the included
    // base window at the committee-configured overtime rate.
    if (baseHours > 0 && overtime > 0 && hours > baseHours) {
      const extraHrs = Math.ceil(hours - baseHours);
      lines.push({
        label: `Overtime (${extraHrs}h beyond ${baseHours}h × ₹${overtime.toLocaleString('en-IN')})`,
        amount: extraHrs * overtime,
      });
    }
    if (date) {
      const dow = dayOfWeekUTC(date);
      if (dow === 0 || dow === 6) {
        const w = (policy.rateCard || []).find((r) => /weekend/i.test(r.label || ''));
        if (w && typeof w.amount === 'number') lines.push({ label: String(w.label), amount: Number(w.amount) });
      }
    }
    const dep = (policy.rateCard || []).find((r) => /deposit/i.test(r.label || ''));
    if (dep && typeof dep.amount === 'number') lines.push({ label: String(dep.label), amount: Number(dep.amount) });
    const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
    return { lines, total };
  }

  // Shared committee-rate summary used by both the calendar-mode
  // "Request Reservation" modal and the wizard's live summary rail so
  // residents see the same base + overtime + total in every flow. The
  // markup uses the .tsh-res-wiz-price styles from reservations.html.
  function renderPriceSummary(policy, date, durationMin, opts) {
    const hasTiming = !!(date && Number(durationMin));
    if (!hasTiming) {
      return '<div class="tsh-res-wiz-price"><div class="row" style="justify-content:center;color:#6b7280;font-style:italic;">' +
        escape((opts && opts.placeholder) || 'Pick a date and time to see the estimate') +
      '</div></div>';
    }
    const price = wizComputePrice(policy, date, durationMin);
    if (price.total === 0) {
      return '<div class="tsh-res-wiz-price"><div class="row free"><span><i class="fas fa-gift"></i> No charge for this facility</span><span>Free</span></div></div>';
    }
    const payee = policy.paymentPayee ? '<div class="row" style="justify-content:center;font-size:11px;color:#6b7280;font-style:italic;margin-top:6px;">Payable to ' + escape(policy.paymentPayee) + '</div>' : '';
    return '<div class="tsh-res-wiz-price">' +
      price.lines.map((l) => '<div class="row"><span>' + escape(l.label) + '</span><span>' + inr(l.amount) + '</span></div>').join('') +
      '<div class="row total"><span>Estimated total</span><span>' + inr(price.total) + '</span></div>' +
      payee +
    '</div>';
  }

  async function renderWizStepDateTime(host) {
    host.innerHTML = '<div class="tsh-res-wiz-step"><p class="sub"><i class="fas fa-spinner fa-spin"></i> Loading availability\u2026</p></div>';
    await ensureWizHeatmap();
    if (wiz.step !== 2) return;  // user navigated away
    const p = selectedFacility.policy || {};
    const today = istToday();
    const [y, m] = wiz.heatmapMonth.split('-').map(Number);
    const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    // Monday-first 6-week grid.
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const monOffset = firstDow === 0 ? -6 : 1 - firstDow;
    const gridStart = addDays(wiz.heatmapMonth, monOffset);
    const cells = [];
    for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));

    const byDate = new Map((wiz.heatmap.days || []).map((d) => [d.date, d]));
    const minAllowed = addDays(today, Math.ceil(Number(p.minAdvanceHours || 0) / 24));
    const maxAllowed = addDays(today, Number(p.maxAdvanceDays || 30));

    const monthGrid = cells.map((c) => {
      const cy = c.split('-')[0], cm = c.split('-')[1];
      const dayNum = Number(c.split('-')[2]);
      const inMonth = Number(cy) === y && Number(cm) === m;
      if (!inMonth) return '<div class="day other">' + dayNum + '</div>';
      if (c < today) return '<div class="day past">' + dayNum + '</div>';
      if (c < minAllowed || c > maxAllowed) return '<div class="day blocked" title="Outside booking window">' + dayNum + '</div>';
      const entry = byDate.get(c);
      const load = wizDayLoad(entry, p);
      const isToday = c === today;
      const isPick = c === wiz.date;
      return '<div class="day ' + load.cls + ' ' + (isToday ? 'today' : '') + ' ' + (isPick ? 'pick' : '') + '" data-wiz-day="' + c + '" title="' + escape(load.label) + '">' + dayNum + '</div>';
    }).join('');

    // Hour chips for the picked date (one chip per hour).
    let chipsHtml = '<p class="sub" style="margin:6px 0 0;">Pick a date on the calendar first.</p>';
    if (wiz.date) {
      const entry = byDate.get(wiz.date);
      const busy = (entry && entry.busy) || [];
      const blackout = entry && entry.blackout;
      const openMin = Number(p.openMin || 0), closeMin = Number(p.closeMin || 22 * 60);
      const chips = [];
      for (let hMin = openMin; hMin + 60 <= closeMin; hMin += 60) {
        const eMin = hMin + 60;
        const overlap = busy.find((b) => !(b.endMin <= hMin || b.startMin >= eMin));
        const now = new Date(Date.now() + IST_OFFSET_MS);
        const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
        const inPast = wiz.date === today && hMin < nowMin + Number(p.minAdvanceHours || 0) * 60;
        let cls = '';
        if (blackout) cls = 'blocked';
        else if (inPast) cls = 'past';
        else if (overlap) cls = overlap.status === 'confirmed' ? 'full' : 'busy';
        if (wiz.startMin === hMin && !cls) cls = 'pick';
        chips.push('<button type="button" class="tsh-res-wiz-chip ' + cls + '" data-wiz-hour="' + hMin + '"' +
          (cls === 'full' || cls === 'past' || cls === 'blocked' ? ' disabled' : '') + '>' +
          formatHHMM(hMin) + '</button>');
      }
      chipsHtml = chips.join('');
    }

    // Duration slider — clamped to remaining room in the operating window.
    const stepMin = Number(p.stepMinutes || 30);
    const durMin = Number(p.minDurationMinutes || 60);
    const durMax = Number(p.maxDurationMinutes || 480);
    const durDefault = Number(p.defaultDurationMinutes || durMin);
    if (wiz.startMin != null) {
      const roomLeft = Number(p.closeMin || 22 * 60) - wiz.startMin;
      const cap = Math.min(durMax, roomLeft - (roomLeft % stepMin));
      if (!wiz.durationMin || wiz.durationMin > cap) wiz.durationMin = Math.min(cap, Math.max(durMin, wiz.durationMin || durDefault));
    }
    const durLabel = (d) => {
      const h = Math.floor(d / 60), mm = d % 60;
      if (mm === 0) return h + ' hour' + (h === 1 ? '' : 's');
      return h ? `${h}h ${mm}m` : `${mm}m`;
    };
    const endMin = wiz.startMin != null && wiz.durationMin ? wiz.startMin + wiz.durationMin : null;

    host.innerHTML =
      '<div class="tsh-res-wiz-step">' +
        '<h2><i class="fas fa-calendar-check"></i> Pick a date and start time</h2>' +
        '<p class="sub">The heatmap uses the same colour code as the calendar view: <b style="color:#166534">green</b> = Available, <b style="color:#92400e">amber</b> = Requested, <b style="color:#991b1b">red</b> = Confirmed, <b style="color:#6b7280">gray</b> = Blocked (outside window or blackout).</p>' +
        '<div class="tsh-res-wiz-picker">' +
          '<div class="tsh-res-wiz-heat">' +
            '<div class="tsh-res-wiz-heat-head">' +
              '<button type="button" data-wiz-mon-prev title="Previous month">&lsaquo;</button>' +
              '<span>' + escape(monthLabel) + '</span>' +
              '<button type="button" data-wiz-mon-next title="Next month">&rsaquo;</button>' +
            '</div>' +
            '<div class="tsh-res-wiz-month">' +
              '<div class="dow">M</div><div class="dow">T</div><div class="dow">W</div><div class="dow">T</div><div class="dow">F</div><div class="dow">S</div><div class="dow">S</div>' +
              monthGrid +
            '</div>' +
            '<div class="tsh-res-wiz-heat-legend">' +
              '<span><i style="background:#dcfce7;border:1px solid #86efac"></i> Available</span>' +
              '<span><i style="background:#fef3c7;border:1px solid #fcd34d"></i> Requested</span>' +
              '<span><i style="background:#fee2e2;border:1px solid #fca5a5"></i> Confirmed</span>' +
              '<span><i style="background:#f3f4f6;border:1px solid #e5e7eb"></i> Blocked</span>' +
            '</div>' +
          '</div>' +
          '<div class="tsh-res-wiz-times">' +
            '<h4><i class="far fa-clock"></i> Start time' + (wiz.date ? ' \u00b7 ' + escape(friendlyRelDate(wiz.date)) : '') + '</h4>' +
            '<div class="tsh-res-wiz-chips">' + chipsHtml + '</div>' +
            (wiz.startMin != null ?
              '<h4><i class="far fa-hourglass"></i> Duration</h4>' +
              '<div class="tsh-res-wiz-duration">' +
                '<input type="range" min="' + durMin + '" max="' + Math.min(durMax, Number(p.closeMin || 22 * 60) - wiz.startMin) + '" step="' + stepMin + '" value="' + (wiz.durationMin || durMin) + '" data-wiz-dur />' +
                '<div class="val" data-wiz-dur-lbl>' + escape(durLabel(wiz.durationMin || durMin)) + '</div>' +
              '</div>' +
              '<p class="sub" style="margin-top:6px;">Ends at <b style="color:var(--tsh-primary,#2563eb)" data-wiz-end>' + formatHHMM(endMin || wiz.startMin + (wiz.durationMin || durMin)) + '</b>. Min ' + durLabel(durMin) + ' \u00b7 max ' + durLabel(durMax) + ' per facility policy.</p>'
            : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<button type="button" class="tsh-btn tsh-btn-ghost" data-wiz-back><i class="fas fa-arrow-left"></i> Back</button>' +
        '<button type="button" class="tsh-btn tsh-btn-primary" data-wiz-next' + (!wiz.date || wiz.startMin == null || !wiz.durationMin ? ' disabled' : '') + '>Continue to details <i class="fas fa-arrow-right"></i></button>' +
      '</div>';

    // Wire events
    host.querySelectorAll('[data-wiz-day]').forEach((el) => el.addEventListener('click', () => {
      wiz.date = el.getAttribute('data-wiz-day');
      wiz.startMin = null; wiz.durationMin = null;
      renderWizard();
    }));
    host.querySelectorAll('[data-wiz-hour]').forEach((el) => el.addEventListener('click', () => {
      if (el.hasAttribute('disabled')) return;
      wiz.startMin = Number(el.getAttribute('data-wiz-hour'));
      // Prefer the committee-configured default duration (e.g. 4 h for
      // the Community Hall). Falls back to the policy minimum so smaller
      // rooms without a `defaultDurationMinutes` keep the old behaviour.
      const prefer = Number(p.defaultDurationMinutes || p.minDurationMinutes || 60);
      wiz.durationMin = wiz.durationMin || prefer;
      const roomLeft = Number(p.closeMin || 22 * 60) - wiz.startMin;
      if (wiz.durationMin > roomLeft) wiz.durationMin = roomLeft - (roomLeft % stepMin);
      renderWizard();
    }));
    const durEl = host.querySelector('[data-wiz-dur]');
    if (durEl) {
      durEl.addEventListener('input', () => {
        wiz.durationMin = Number(durEl.value);
        const lblEl = host.querySelector('[data-wiz-dur-lbl]');
        if (lblEl) lblEl.textContent = durLabel(wiz.durationMin);
        const endEl = host.querySelector('[data-wiz-end]');
        if (endEl) endEl.textContent = formatHHMM(wiz.startMin + wiz.durationMin);
        renderWizSummary();
        renderWizStepper();
      });
    }
    const mp = host.querySelector('[data-wiz-mon-prev]');
    if (mp) mp.addEventListener('click', () => wizShiftMonth(-1));
    const mn = host.querySelector('[data-wiz-mon-next]');
    if (mn) mn.addEventListener('click', () => wizShiftMonth(+1));
    host.querySelector('[data-wiz-back]').addEventListener('click', () => { wiz.step = 1; renderWizard(); });
    const nb = host.querySelector('[data-wiz-next]');
    nb.addEventListener('click', () => { if (!nb.hasAttribute('disabled')) { wiz.step = 3; renderWizard(); } });
  }

  function wizShiftMonth(delta) {
    const [y, m] = wiz.heatmapMonth.split('-').map(Number);
    let ny = y, nm = m + delta;
    while (nm <= 0) { nm += 12; ny -= 1; }
    while (nm > 12) { nm -= 12; ny += 1; }
    wiz.heatmapMonth = `${ny}-${pad2(nm)}-01`;
    wiz.heatmap = null;
    renderWizard();
  }

  // -------- Step 3: Details --------

  // Lightweight field validators used by both the wizard's Step 3 and
  // the calendar-mode "Request Reservation" modal so residents get the
  // same red-asterisk / inline-error UX in both flows.
  const PHONE_RE = /^[+\d][\d\s().+-]{6,24}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function validatePurpose(v) {
    const t = (v || '').trim();
    if (!t) return 'Purpose is required.';
    if (t.length < 3) return 'Please describe the purpose (min 3 characters).';
    return '';
  }
  function validateFlat(v) {
    const t = (v || '').trim();
    if (!t) return 'Flat number is required.';
    if (t.length > 40) return 'Flat number is too long.';
    return '';
  }
  function validatePhoneOpt(v) {
    const t = (v || '').trim();
    if (!t) return '';
    if (!PHONE_RE.test(t)) return 'Enter a valid phone number (digits, spaces, + - allowed).';
    return '';
  }
  function validateEmailOpt(v) {
    const t = (v || '').trim();
    if (!t) return '';
    if (!EMAIL_RE.test(t)) return 'Enter a valid email address.';
    return '';
  }

  function renderWizStepDetails(host) {
    const f = selectedFacility, p = f.policy || {};
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
    // Errors object is scoped to the current render — we recompute on
    // input/blur so residents see the message clear as they type.
    const errs = { purpose: '', flat: '', phone: '', owner: '' };
    host.innerHTML =
      '<div class="tsh-res-wiz-step">' +
        '<h2><i class="fas fa-user-pen"></i> Booking details</h2>' +
        '<p class="sub">Purpose helps the managing committee approve faster. Flat number enforces the ' + Number(p.maxPerFlatPerYear || 2) + '/year booking limit. Fields marked <span class="tsh-req">*</span> are required.</p>' +
        '<div style="display:grid;grid-template-columns:1fr;gap:12px;">' +
          '<label><span class="tsh-form-label">Purpose <span class="tsh-req">*</span></span>' +
            '<input type="text" data-wiz-purpose maxlength="400" placeholder="e.g., 8th birthday party for A-101" value="' + escape(wiz.purpose) + '" required aria-required="true" />' +
            '<span class="tsh-field-err" data-err="purpose"></span></label>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
            '<label><span class="tsh-form-label">Flat number <span class="tsh-req">*</span></span>' +
              '<input type="text" data-wiz-flat maxlength="40" placeholder="A-101" value="' + escape(wiz.flat) + '" required aria-required="true" />' +
              '<span class="tsh-field-err" data-err="flat"></span></label>' +
            '<label><span class="tsh-form-label">Phone <span class="tsh-req">*</span></span>' +
              '<input type="tel" data-wiz-phone maxlength="40" placeholder="+91-9x-xxx-xxxx" value="' + escape(wiz.phone) + '" required aria-required="true" />' +
              '<span class="tsh-field-err" data-err="phone"></span></label>' +
          '</div>' +
          (isStaff ?
            '<label><span class="tsh-form-label">Book on behalf of (email)</span>' +
              '<input type="email" data-wiz-owner maxlength="120" placeholder="Leave blank to book for yourself" value="' + escape(wiz.ownerEmail) + '" />' +
              '<span class="tsh-field-err" data-err="owner"></span></label>'
          : '') +
        '</div>' +
        renderRateCard(p.rateCard) +
        renderGuidelines(p.usageGuidelines) +
        (p.chargesInfo ? '<p class="tsh-hint" style="margin-top:8px;background:rgba(59,130,246,0.08);border-left:3px solid #3b82f6;padding:8px 10px;border-radius:4px;"><i class="fas fa-receipt"></i> <strong>Charges:</strong> ' + escape(p.chargesInfo) + '</p>' : '') +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<button type="button" class="tsh-btn tsh-btn-ghost" data-wiz-back><i class="fas fa-arrow-left"></i> Back</button>' +
        '<button type="button" class="tsh-btn tsh-btn-primary" data-wiz-next>Review &amp; submit <i class="fas fa-arrow-right"></i></button>' +
      '</div>';

    const purpEl = host.querySelector('[data-wiz-purpose]');
    const flatEl = host.querySelector('[data-wiz-flat]');
    const phoneEl = host.querySelector('[data-wiz-phone]');
    const ownEl = host.querySelector('[data-wiz-owner]');
    const purpErr = host.querySelector('[data-err="purpose"]');
    const flatErr = host.querySelector('[data-err="flat"]');
    const phoneErr = host.querySelector('[data-err="phone"]');
    const ownErr = ownEl ? host.querySelector('[data-err="owner"]') : null;

    // Paint the error message + invalid-input border for one field.
    const paint = (input, errSpan, msg) => {
      if (msg) input.classList.add('tsh-input-invalid'); else input.classList.remove('tsh-input-invalid');
      if (errSpan) errSpan.textContent = msg;
    };

    purpEl.addEventListener('input', (e) => {
      wiz.purpose = e.target.value;
      errs.purpose = validatePurpose(wiz.purpose);
      paint(purpEl, purpErr, errs.purpose);
      renderWizSummary(); renderWizStepper();
    });
    flatEl.addEventListener('input', (e) => {
      wiz.flat = e.target.value;
      errs.flat = validateFlat(wiz.flat);
      paint(flatEl, flatErr, errs.flat);
      renderWizSummary();
    });
    phoneEl.addEventListener('input', (e) => {
      wiz.phone = e.target.value;
      // Phone is now required for the booking (residents may need to be
      // reached about approval / access). Same validator on blur below.
      errs.phone = !(wiz.phone || '').trim() ? 'Phone number is required.' : validatePhoneOpt(wiz.phone);
      paint(phoneEl, phoneErr, errs.phone);
    });
    if (ownEl) {
      ownEl.addEventListener('input', (e) => {
        wiz.ownerEmail = e.target.value;
        errs.owner = validateEmailOpt(wiz.ownerEmail);
        paint(ownEl, ownErr, errs.owner);
      });
    }

    host.querySelector('[data-wiz-back]').addEventListener('click', () => { wiz.step = 2; renderWizard(); });
    host.querySelector('[data-wiz-next]').addEventListener('click', () => {
      errs.purpose = validatePurpose(wiz.purpose);
      errs.flat    = validateFlat(wiz.flat);
      errs.phone   = !(wiz.phone || '').trim() ? 'Phone number is required.' : validatePhoneOpt(wiz.phone);
      errs.owner   = ownEl ? validateEmailOpt(wiz.ownerEmail) : '';
      paint(purpEl, purpErr, errs.purpose);
      paint(flatEl, flatErr, errs.flat);
      paint(phoneEl, phoneErr, errs.phone);
      if (ownEl) paint(ownEl, ownErr, errs.owner);
      const firstBad = errs.purpose ? purpEl : errs.flat ? flatEl : errs.phone ? phoneEl : (errs.owner && ownEl ? ownEl : null);
      if (firstBad) {
        firstBad.focus();
        root.UI.toast('Please fix the highlighted fields.', { kind: 'warn' });
        return;
      }
      wiz.step = 4; renderWizard();
    });
    setTimeout(() => { const el = host.querySelector('[data-wiz-purpose]'); if (el && !wiz.purpose) el.focus(); }, 60);
  }

  // -------- Step 4: Review + submit --------
  function renderWizStepReview(host) {
    const f = selectedFacility, p = f.policy || {};
    const price = wizComputePrice(p, wiz.date, wiz.durationMin);
    const endMin = wiz.startMin + wiz.durationMin;
    host.innerHTML =
      '<div class="tsh-res-wiz-step">' +
        '<h2><i class="fas fa-check-double"></i> Review and confirm</h2>' +
        '<p class="sub">Double-check the details below. Once submitted, the managing committee will review' + (p.requiresPayment ? ' and ask you to upload payment proof.' : '.') + '</p>' +
        '<div class="tsh-res-ratecard">' +
          '<table>' +
            '<tr><th>Facility</th><td class="tsh-res-rc-amount">' + escape(f.name) + '</td></tr>' +
            '<tr><th>Date</th><td class="tsh-res-rc-amount">' + escape(friendlyDate(wiz.date)) + '</td></tr>' +
            '<tr><th>Time</th><td class="tsh-res-rc-amount">' + formatHHMM(wiz.startMin) + '\u2013' + formatHHMM(endMin) + ' (' + (wiz.durationMin / 60).toFixed(1).replace(/\.0$/, '') + ' h)</td></tr>' +
            '<tr><th>Purpose</th><td class="tsh-res-rc-amount">' + escape(wiz.purpose) + '</td></tr>' +
            '<tr><th>Flat</th><td class="tsh-res-rc-amount">' + escape(wiz.flat) + '</td></tr>' +
            (wiz.phone ? '<tr><th>Phone</th><td class="tsh-res-rc-amount">' + escape(wiz.phone) + '</td></tr>' : '') +
            (wiz.ownerEmail ? '<tr><th>On behalf of</th><td class="tsh-res-rc-amount">' + escape(wiz.ownerEmail) + '</td></tr>' : '') +
          '</table>' +
        '</div>' +
        (price.lines.length ?
          '<div class="tsh-res-ratecard" style="background:#eff6ff;border-color:#bfdbfe;">' +
            '<div style="font-weight:600;margin-bottom:4px;font-size:12px;"><i class="fas fa-indian-rupee-sign"></i> Estimated charges <span style="font-weight:400;opacity:.75;">(committee confirms final amount at approval)</span></div>' +
            '<table>' +
              price.lines.map((l) => '<tr><td>' + escape(l.label) + '</td><td class="tsh-res-rc-amount">' + inr(l.amount) + '</td></tr>').join('') +
              '<tr><th>Estimated total</th><td class="tsh-res-rc-amount" style="color:var(--tsh-primary,#2563eb);font-size:14px;">' + inr(price.total) + '</td></tr>' +
            '</table>' +
          '</div>'
          : '<p class="tsh-hint" style="background:#ecfdf5;border-left:3px solid #059669;padding:8px 10px;border-radius:4px;color:#065f46;"><i class="fas fa-circle-check"></i> This facility is free \u2014 no payment step.</p>') +
        ((f.rules || []).length ? '<div class="tsh-res-guide"><h5><i class="fas fa-gavel"></i> House rules</h5><ul>' + (f.rules || []).map((r) => '<li>' + escape(r) + '</li>').join('') + '</ul></div>' : '') +
        renderGuidelines(p.usageGuidelines) +
        (p.requiresPayment ? '<p class="tsh-hint" style="margin-top:8px;background:#eff6ff;border-left:3px solid var(--tsh-primary,#2563eb);padding:8px 10px;border-radius:4px;color:#1e3a8a;"><i class="fas fa-file-invoice-dollar"></i> After you submit, you\'ll be prompted to upload payment proof (screenshot or PDF). Booking is confirmed only after the committee verifies the payment.</p>' : '') +
        '<div class="tsh-res-wiz-tc">' +
          '<label><input type="checkbox" data-wiz-tc' + (wiz.tc ? ' checked' : '') + ' /><span>I have read the house rules and etiquette; I understand cancellation follows the facility\'s policy and my flat\'s booking quota decrements on submit.</span></label>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<button type="button" class="tsh-btn tsh-btn-ghost" data-wiz-back><i class="fas fa-arrow-left"></i> Back</button>' +
        '<button type="button" class="tsh-btn tsh-btn-primary" data-wiz-submit' + (wiz.tc && !wiz.submitting ? '' : ' disabled') + '>' +
          '<i class="fas fa-paper-plane"></i> ' + (wiz.submitting ? 'Submitting\u2026' : 'Submit reservation request') +
        '</button>' +
      '</div>';
    const tcEl = host.querySelector('[data-wiz-tc]');
    tcEl.addEventListener('change', () => { wiz.tc = tcEl.checked; renderWizard(); });
    host.querySelector('[data-wiz-back]').addEventListener('click', () => { wiz.step = 3; renderWizard(); });
    host.querySelector('[data-wiz-submit]').addEventListener('click', () => submitWizardBooking());
  }

  async function submitWizardBooking() {
    if (wiz.submitting) return;
    wiz.submitting = true;
    renderWizard();
    try {
      await submitBooking(
        wiz.date,
        formatHHMM(wiz.startMin),
        formatHHMM(wiz.startMin + wiz.durationMin),
        wiz.purpose.trim(),
        wiz.flat.trim(),
        wiz.phone.trim(),
        wiz.ownerEmail.trim()
      );
      // Reset the wizard so the user can start a fresh booking; switch to
      // My reservations so they can immediately upload payment proof if
      // the facility requires it (Phase 2 payment flow lives there).
      wiz.step = 1; wiz.date = null; wiz.startMin = null; wiz.durationMin = null;
      wiz.purpose = ''; wiz.flat = ''; wiz.phone = ''; wiz.ownerEmail = ''; wiz.tc = false;
      wiz.heatmap = null;
      wiz.submitting = false;
      showTab('mine');
    } catch (_e) {
      // Errors already toasted by submitBooking; keep the form open.
      wiz.submitting = false;
      renderWizard();
    }
  }

  // -------- Live summary rail (always visible on the right) --------
  function renderWizSummary() {
    const host = $('#resWizSummary');
    if (!host || !selectedFacility) return;
    const f = selectedFacility, p = f.policy || {};
    // Shared price-summary helper — identical breakdown as the calendar
    // modal so both flows source their rate from the same committee-
    // maintained policy fields.
    const priceBlock = renderPriceSummary(p, wiz.date, wiz.durationMin);
    host.innerHTML =
      '<h3><i class="fas fa-clipboard-list"></i> Your booking</h3>' +
      '<div class="kv">' +
        '<div class="k">Facility</div><div class="v">' + escape(f.name) + '</div>' +
        '<div class="k">Date</div><div class="v ' + (wiz.date ? '' : 'muted') + '">' + (wiz.date ? escape(friendlyDate(wiz.date)) : 'Not selected') + '</div>' +
        '<div class="k">Time</div><div class="v ' + (wiz.startMin != null && wiz.durationMin ? '' : 'muted') + '">' + (wiz.startMin != null && wiz.durationMin ? formatHHMM(wiz.startMin) + '\u2013' + formatHHMM(wiz.startMin + wiz.durationMin) : 'Not selected') + '</div>' +
        '<div class="k">Duration</div><div class="v ' + (wiz.durationMin ? '' : 'muted') + '">' + (wiz.durationMin ? (wiz.durationMin / 60).toFixed(1).replace(/\.0$/, '') + ' hours' : '\u2014') + '</div>' +
        '<div class="k">Purpose</div><div class="v ' + (wiz.purpose ? '' : 'muted') + '">' + (wiz.purpose ? escape(wiz.purpose) : 'Not entered') + '</div>' +
        '<div class="k">Flat</div><div class="v ' + (wiz.flat ? '' : 'muted') + '">' + (wiz.flat ? escape(wiz.flat) : 'Not entered') + '</div>' +
      '</div>' +
      priceBlock +
      '<div class="tsh-res-wiz-nav">' +
        (wiz.step > 1 ? '<button type="button" class="tsh-btn tsh-btn-ghost" data-wiz-sum-back><i class="fas fa-arrow-left"></i> Back</button>' : '') +
        (wiz.step < 4 ? '<button type="button" class="tsh-btn tsh-btn-primary" data-wiz-sum-next>Next <i class="fas fa-arrow-right"></i></button>' :
          '<button type="button" class="tsh-btn tsh-btn-primary" data-wiz-sum-submit' + (wiz.tc && !wiz.submitting ? '' : ' disabled') + '><i class="fas fa-paper-plane"></i> Submit</button>') +
      '</div>';
    const b = host.querySelector('[data-wiz-sum-back]');
    if (b) b.addEventListener('click', () => { wiz.step -= 1; renderWizard(); });
    const n = host.querySelector('[data-wiz-sum-next]');
    if (n) n.addEventListener('click', () => { if (wizCanJumpTo(wiz.step + 1)) { wiz.step += 1; renderWizard(); } else { root.UI.toast('Complete this step first.', { kind: 'warn' }); } });
    const s = host.querySelector('[data-wiz-sum-submit]');
    if (s) s.addEventListener('click', () => submitWizardBooking());
  }

  // -------------------------------------------------------- facility settings (MANAGER+)

  function openFacilitySettings() {
    if (!selectedFacility) return;
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
    if (!isStaff) return;
    const f = selectedFacility;
    const p = f.policy || {};

    const wrap = document.createElement('div');
    wrap.className = 'tsh-res-set';
    wrap.innerHTML =
      '<p style="font-size:12px;color:var(--tsh-muted,#6b7280);margin:0 0 4px;">' +
        'Editing <strong>' + escape(f.name) + '</strong>. Changes are saved to <code>config/facilities.json</code> and take effect immediately for new bookings.' +
      '</p>' +

      '<div class="tsh-res-set-grid">' +
        '<label><span>Min advance notice (hours)</span><input type="number" min="0" max="720" step="1" data-fs-minh value="' + Number(p.minAdvanceHours || 0) + '" /></label>' +
        '<label><span>Max advance window (days)</span><input type="number" min="1" max="365" step="1" data-fs-maxd value="' + Number(p.maxAdvanceDays || 30) + '" /></label>' +
        '<label><span>Max active bookings per resident</span><input type="number" min="1" max="20" step="1" data-fs-conc value="' + Number(p.maxConcurrentPerOwner || 3) + '" /></label>' +
        '<label><span>Max bookings per flat per year</span><input type="number" min="1" max="52" step="1" data-fs-year value="' + Number(p.maxPerFlatPerYear || 2) + '" /></label>' +
      '</div>' +

      '<fieldset><legend>Open hours (24-hour)</legend>' +
        '<div class="tsh-res-set-grid">' +
          '<label><span>Opens at</span><input type="time" data-fs-open value="' + formatHHMM(Number(p.openMin || 0)) + '" step="' + Number(p.stepMinutes || 30) * 60 + '" /></label>' +
          '<label><span>Closes at</span><input type="time" data-fs-close value="' + formatHHMM(Number(p.closeMin || 0)) + '" step="' + Number(p.stepMinutes || 30) * 60 + '" /></label>' +
          '<label><span>Min booking length (minutes)</span><input type="number" min="15" max="1440" step="15" data-fs-mind value="' + Number(p.minDurationMinutes || 60) + '" /></label>' +
          '<label><span>Max booking length (minutes)</span><input type="number" min="15" max="1440" step="15" data-fs-maxdur value="' + Number(p.maxDurationMinutes || 480) + '" /></label>' +
          '<label><span>Default booking length (minutes)</span><input type="number" min="15" max="1440" step="15" data-fs-defdur value="' + Number(p.defaultDurationMinutes || p.minDurationMinutes || 60) + '" /></label>' +
        '</div>' +
        '<p style="margin:6px 0 0;font-size:12px;color:var(--tsh-muted,#6b7280);">' +
          'Default length pre-fills the wizard/calendar duration slider (e.g. 240 min = 4 h).' +
        '</p>' +
      '</fieldset>' +

      '<label><span>Charges description (shown on booking form)</span>' +
        '<textarea data-fs-charges maxlength="2000" placeholder="Free-text description of fees, deposit, cleaning charges, refund policy.">' +
        escape(p.chargesInfo || '') +
        '</textarea></label>' +

      '<fieldset><legend><i class="fas fa-indian-rupee-sign"></i> Rate card (indicative &mdash; amounts by time / duration)</legend>' +
        '<p style="margin:0 0 6px;font-size:12px;color:var(--tsh-muted,#6b7280);">' +
          'Base amount is the single figure billed to the resident. Rate rows below are shown on the booking form for context (e.g. base + overtime).' +
        '</p>' +
        '<label style="margin-bottom:8px;"><span>Base amount (\u20b9, billed to resident)</span>' +
          '<input type="number" min="0" max="10000000" step="1" data-fs-amount value="' + (typeof p.paymentAmount === 'number' ? Number(p.paymentAmount) : 0) + '" />' +
        '</label>' +
        '<div class="tsh-res-set-grid">' +
          '<label><span>Base covers up to (hours)</span><input type="number" min="0" max="24" step="1" data-fs-basehrs value="' + Number(p.baseIncludedHours || 0) + '" /></label>' +
          '<label><span>Overtime per extra hour (\u20b9)</span><input type="number" min="0" max="10000000" step="1" data-fs-otamt value="' + Number(p.overtimeHourlyAmount || 0) + '" /></label>' +
        '</div>' +
        '<p style="margin:4px 0 8px;font-size:12px;color:var(--tsh-muted,#6b7280);">' +
          'When both are set, bookings longer than the covered hours are charged the flat overtime rate for every extra hour (or part thereof). Committee resolution: Community Hall = \u20b95,000 for 4 h + \u20b91,500 per extra hour.' +
        '</p>' +
        '<div class="tsh-res-set-list" data-fs-rc></div>' +
        '<button type="button" class="tsh-res-set-add" data-fs-rc-add>+ Add rate</button>' +
      '</fieldset>' +

      '<fieldset><legend><i class="fas fa-clock-rotate-left"></i> Rate history</legend>' +
        '<p style="margin:0 0 6px;font-size:12px;color:var(--tsh-muted,#6b7280);">' +
          'Automatically snapshotted whenever the base amount or rate card changes. The current rate is always the last entry.' +
        '</p>' +
        '<div class="tsh-res-set-history" data-fs-ph></div>' +
      '</fieldset>' +

      '<div class="tsh-res-set-grid">' +
        '<fieldset><legend><i class="fas fa-clipboard-check"></i> Etiquette before use</legend>' +
          '<div class="tsh-res-set-list" data-fs-gb></div>' +
          '<button type="button" class="tsh-res-set-add" data-fs-gb-add>+ Add guideline</button>' +
        '</fieldset>' +
        '<fieldset><legend><i class="fas fa-broom"></i> Etiquette after use</legend>' +
          '<div class="tsh-res-set-list" data-fs-ga></div>' +
          '<button type="button" class="tsh-res-set-add" data-fs-ga-add>+ Add guideline</button>' +
        '</fieldset>' +
      '</div>' +

      '<label><span>House rules (shown above the calendar)</span>' +
        '<div class="tsh-res-set-list" data-fs-rules></div>' +
        '<button type="button" class="tsh-res-set-add" data-fs-rules-add>+ Add rule</button>' +
      '</label>';

    // ---- populate dynamic lists ----
    const rcHost   = wrap.querySelector('[data-fs-rc]');
    const gbHost   = wrap.querySelector('[data-fs-gb]');
    const gaHost   = wrap.querySelector('[data-fs-ga]');
    const rulesHost = wrap.querySelector('[data-fs-rules]');

    const addRateRow = (label, amount, note) => {
      const row = document.createElement('div');
      row.className = 'tsh-res-set-row';
      row.innerHTML =
        '<input type="text" data-rc-label maxlength="120" placeholder="e.g. Morning (06:00–12:00)" />' +
        '<input type="number" data-rc-amt min="0" step="1" placeholder="Amount (₹)" />' +
        '<button type="button" class="tsh-res-set-del" title="Remove"><i class="fas fa-trash"></i></button>';
      row.querySelector('[data-rc-label]').value = label || '';
      if (typeof amount === 'number') row.querySelector('[data-rc-amt]').value = String(amount);
      // Second row for optional note.
      const noteInput = document.createElement('input');
      noteInput.type = 'text';
      noteInput.setAttribute('data-rc-note', '');
      noteInput.maxLength = 240;
      noteInput.placeholder = 'Optional note (fine print)';
      noteInput.value = note || '';
      noteInput.style.gridColumn = '1 / -1';
      row.appendChild(noteInput);
      row.querySelector('.tsh-res-set-del').addEventListener('click', () => row.remove());
      rcHost.appendChild(row);
    };
    const addLineRow = (host, value, placeholder) => {
      const row = document.createElement('div');
      row.className = 'tsh-res-set-row-simple';
      row.innerHTML =
        '<input type="text" maxlength="240" />' +
        '<button type="button" class="tsh-res-set-del" title="Remove"><i class="fas fa-trash"></i></button>';
      const inp = row.querySelector('input');
      inp.value = value || '';
      inp.placeholder = placeholder || '';
      row.querySelector('.tsh-res-set-del').addEventListener('click', () => row.remove());
      host.appendChild(row);
    };

    (Array.isArray(p.rateCard) ? p.rateCard : []).forEach((r) => addRateRow(r.label, r.amount, r.note));
    if (!p.rateCard || !p.rateCard.length) addRateRow('', undefined, '');
    (p.usageGuidelines && Array.isArray(p.usageGuidelines.before) ? p.usageGuidelines.before : []).forEach((s) => addLineRow(gbHost, s, 'e.g. Confirm the booking is approved before decorating.'));
    if (!gbHost.children.length) addLineRow(gbHost, '', 'e.g. Confirm the booking is approved before decorating.');
    (p.usageGuidelines && Array.isArray(p.usageGuidelines.after) ? p.usageGuidelines.after : []).forEach((s) => addLineRow(gaHost, s, 'e.g. Sweep the floor and wipe down surfaces.'));
    if (!gaHost.children.length) addLineRow(gaHost, '', 'e.g. Sweep the floor and wipe down surfaces.');
    (Array.isArray(f.rules) ? f.rules : []).forEach((s) => addLineRow(rulesHost, s, 'e.g. No loud music after 10 PM.'));
    if (!rulesHost.children.length) addLineRow(rulesHost, '', 'e.g. No loud music after 10 PM.');

    // Rate history (read-only). Rendered from most recent to oldest.
    const phHost = wrap.querySelector('[data-fs-ph]');
    const phList = Array.isArray(p.priceHistory) ? p.priceHistory.slice() : [];
    if (!phList.length) {
      phHost.innerHTML = '<p style="margin:0;font-size:12px;color:var(--tsh-muted,#6b7280);">No history yet. The first change you save will start the log.</p>';
    } else {
      phList.sort((a, b) => String(b.effectiveDate || '').localeCompare(String(a.effectiveDate || '')));
      phList.forEach((h, i) => {
        const row = document.createElement('div');
        row.className = 'tsh-res-set-history-row';
        row.style.cssText = 'padding:8px 10px;border:1px solid var(--tsh-border,#e5e7eb);border-radius:6px;margin-bottom:6px;background:' + (i === 0 ? '#f0fdf4' : '#fafafa') + ';';
        const rateSummary = Array.isArray(h.rateCard) && h.rateCard.length
          ? h.rateCard.map((r) => escape(r.label) + (typeof r.amount === 'number' ? ' \u20b9' + r.amount : '')).join(' \u00b7 ')
          : '';
        row.innerHTML =
          '<div style="font-size:13px;font-weight:600;">' +
            (i === 0 ? '<span style="color:#16a34a;">Current \u2192 </span>' : '') +
            'Effective ' + escape(h.effectiveDate || 'unknown') +
            (typeof h.paymentAmount === 'number' ? ' \u00b7 \u20b9' + h.paymentAmount + ' base' : '') +
          '</div>' +
          (rateSummary ? '<div style="font-size:12px;color:#374151;margin-top:2px;">' + rateSummary + '</div>' : '') +
          (h.source ? '<div style="font-size:12px;color:var(--tsh-muted,#6b7280);margin-top:2px;">Source: ' + escape(h.source) + '</div>' : '') +
          (h.note ? '<div style="font-size:12px;color:var(--tsh-muted,#6b7280);margin-top:2px;">' + escape(h.note) + '</div>' : '') +
          (h.recordedBy ? '<div style="font-size:11px;color:var(--tsh-muted,#6b7280);margin-top:2px;">Recorded by ' + escape(h.recordedBy) + (h.recordedAt ? ' \u00b7 ' + escape(String(h.recordedAt).slice(0, 10)) : '') + '</div>' : '');
        phHost.appendChild(row);
      });
    }

    wrap.querySelector('[data-fs-rc-add]').addEventListener('click', () => addRateRow('', undefined, ''));
    wrap.querySelector('[data-fs-gb-add]').addEventListener('click', () => addLineRow(gbHost, '', ''));
    wrap.querySelector('[data-fs-ga-add]').addEventListener('click', () => addLineRow(gaHost, '', ''));
    wrap.querySelector('[data-fs-rules-add]').addEventListener('click', () => addLineRow(rulesHost, '', ''));

    root.UI.modal({
      title: 'Facility settings · ' + f.name,
      body: wrap,
      size: 'lg',
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Save', value: 'save', primary: true },
      ],
    }).then((choice) => {
      if (choice !== 'save') return;
      saveFacilitySettings(f.id, wrap);
    });
  }

  function parseHHMMLocal(s) { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); }

  async function saveFacilitySettings(id, wrap) {
    const rcRows = Array.from(wrap.querySelectorAll('[data-fs-rc] .tsh-res-set-row')).map((row) => {
      const label = row.querySelector('[data-rc-label]').value.trim();
      const amtRaw = row.querySelector('[data-rc-amt]').value;
      const note = row.querySelector('[data-rc-note]').value.trim();
      const out = { label };
      if (amtRaw !== '' && !Number.isNaN(Number(amtRaw))) out.amount = Number(amtRaw);
      if (note) out.note = note;
      return label ? out : null;
    }).filter(Boolean);

    const readList = (host) => Array.from(host.querySelectorAll('input'))
      .map((i) => i.value.trim())
      .filter(Boolean);

    const body = {
      rules: readList(wrap.querySelector('[data-fs-rules]')),
      policy: {
        minAdvanceHours:       Number(wrap.querySelector('[data-fs-minh]').value)   || 0,
        maxAdvanceDays:        Number(wrap.querySelector('[data-fs-maxd]').value)   || 30,
        maxConcurrentPerOwner: Number(wrap.querySelector('[data-fs-conc]').value)   || 3,
        maxPerFlatPerYear:     Number(wrap.querySelector('[data-fs-year]').value)   || 2,
        openMin:               parseHHMMLocal(wrap.querySelector('[data-fs-open]').value),
        closeMin:              parseHHMMLocal(wrap.querySelector('[data-fs-close]').value),
        minDurationMinutes:    Number(wrap.querySelector('[data-fs-mind]').value)   || 60,
        maxDurationMinutes:    Number(wrap.querySelector('[data-fs-maxdur]').value) || 480,
        defaultDurationMinutes: Math.max(0, Number(wrap.querySelector('[data-fs-defdur]').value) || 0),
        baseIncludedHours:     Math.max(0, Number(wrap.querySelector('[data-fs-basehrs]').value) || 0),
        overtimeHourlyAmount:  Math.max(0, Number(wrap.querySelector('[data-fs-otamt]').value) || 0),
        paymentAmount:         Math.max(0, Number(wrap.querySelector('[data-fs-amount]').value) || 0),
        chargesInfo:           wrap.querySelector('[data-fs-charges]').value.trim(),
        rateCard:              rcRows,
        usageGuidelines: {
          before: readList(wrap.querySelector('[data-fs-gb]')),
          after:  readList(wrap.querySelector('[data-fs-ga]')),
        },
      },
    };
    try {
      const res = await root.Api.patch('/facilities/' + encodeURIComponent(id), body);
      // Replace in our local list so the modal, blurb and modal-side rate card refresh.
      const idx = facilities.findIndex((f) => f.id === id);
      if (idx !== -1 && res && res.facility) facilities[idx] = res.facility;
      renderFacilityPicker();
      const sel = $('#resFacilitySelect');
      if (sel) sel.value = id;
      selectFacility(id);
      root.UI.toast('Facility settings saved.', { kind: 'success' });
    } catch (e) {
      root.UI.toast(e && e.message || 'Save failed.', { kind: 'danger' });
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
          '<i class="fas fa-calendar-day"></i> ' + escape(friendlyRelDate(r.date)) + ' · ' + escape(reservationTimeLabel(r)) +
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

    // Receipt (print + download PDF). Available to the owner and every staff
    // role once the booking is confirmed \u2014 payment verification is only a
    // gating step for the confirm transition itself, so a confirmed booking
    // is always eligible for a printable receipt.
    if ((isOwner || isStaff) && r.status === 'confirmed') {
      const receiptBtn = document.createElement('button');
      receiptBtn.type = 'button';
      receiptBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      receiptBtn.innerHTML = '<i class="fas fa-receipt"></i> Receipt';
      receiptBtn.addEventListener('click', () => openReceiptModal(r));
      actions.appendChild(receiptBtn);
    }

    // Archived receipt (private repo). Staff-only: pulls the server-
    // composed PDF stored in tsh-booking-receipts, RBAC-gated by the
    // worker to MANAGER+ only. Residents don't see this — they get the
    // on-page Receipt modal above.
    if (isStaff && r.status === 'confirmed' && r.archive && r.archive.path) {
      const archBtn = document.createElement('button');
      archBtn.type = 'button';
      archBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      archBtn.innerHTML = '<i class="fas fa-box-archive"></i> Archived receipt';
      archBtn.title = 'Open the receipt archived to the private repo (' + r.archive.path + ')';
      archBtn.addEventListener('click', () => openArchivedReceipt(r));
      actions.appendChild(archBtn);
    }

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

    // Upload payment proof directly from the card — visible to the owner
    // and to staff (ADMIN / COMMITTEE / MANAGER) so a manager can upload
    // on the resident's behalf without drilling into the Timeline modal.
    // Mirrors the same eligibility check used inside openDetailModal so
    // the two entry points stay in lock-step.
    const canUploadProof = r.payment &&
      (isOwner || isStaff) &&
      (r.payment.status === 'pending' || r.payment.status === 'rejected') &&
      (r.status === 'requested' || r.status === 'under-review');
    if (canUploadProof) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      upBtn.innerHTML = '<i class="fas fa-cloud-arrow-up"></i> Upload proof';
      upBtn.title = isStaff && !isOwner
        ? 'Upload the payment receipt on the resident\u2019s behalf.'
        : 'Upload your payment receipt (UPI screenshot, bank slip or PDF).';
      upBtn.addEventListener('click', () => uploadPaymentProof(r));
      actions.appendChild(upBtn);
    }

    // Staff also see Verify / Reject payment straight on the card once a
    // proof has been submitted, so they don\u2019t have to open the modal
    // just to click through the two-step payment workflow.
    if (isStaff && r.payment && r.payment.status === 'submitted' && (r.payment.proofs || []).length > 0) {
      const okPay = document.createElement('button');
      okPay.type = 'button';
      okPay.className = 'tsh-btn tsh-btn-primary tsh-btn-sm';
      okPay.innerHTML = '<i class="fas fa-check-double"></i> Verify payment';
      okPay.addEventListener('click', () => verifyPayment(r));
      actions.appendChild(okPay);

      const noPay = document.createElement('button');
      noPay.type = 'button';
      noPay.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      noPay.innerHTML = '<i class="fas fa-rotate-left"></i> Reject payment';
      noPay.addEventListener('click', () => rejectPayment(r));
      actions.appendChild(noPay);
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

    // Cleanup buttons for staff. Committee/Admin can remove terminal
    // records (cancelled/rejected) so the list stays tidy; only Admin
    // can hard-remove anything still active.
    const isAdmin = who && who.primary === 'ADMIN';
    const isCommittee = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'COMMITTEE');
    const isTerminal = r.status === 'cancelled' || r.status === 'rejected';
    if (isCommittee && isTerminal) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      removeBtn.innerHTML = '<i class="fas fa-eraser"></i> Remove from list';
      removeBtn.addEventListener('click', () => doDelete(r, { forceMode: false }));
      actions.appendChild(removeBtn);
    }
    if (isAdmin && !isTerminal) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      deleteBtn.style.color = '#b91c1c';
      deleteBtn.innerHTML = '<i class="fas fa-trash"></i> Delete';
      deleteBtn.addEventListener('click', () => doDelete(r, { forceMode: true }));
      actions.appendChild(deleteBtn);
    }

    card.appendChild(actions);
    return card;
  }

  async function doDelete(r, opts) {
    const forceMode = !!(opts && opts.forceMode);
    const title = forceMode ? 'Delete this reservation?' : 'Remove from list?';
    const message = forceMode
      ? 'Admin delete: this reservation is still ' + escape(r.status) + '. The record will be hidden from all lists and the slot freed. This is meant for spam, duplicates, or entries created by mistake. Continue?'
      : 'This removes the record from the reservations list. It stays in the audit log. Continue?';
    const okConfirm = await root.UI.confirmModal(title, message);
    if (!okConfirm) return;
    let reason = '';
    if (forceMode) {
      reason = window.prompt('Optional: reason for deletion (kept in audit log).', '') || '';
    }
    try {
      const body = reason.trim() ? { reason: reason.trim() } : undefined;
      await root.Api.del('/reservations/' + encodeURIComponent(r.id), body);
      root.UI.toast(forceMode ? 'Reservation deleted.' : 'Removed from list.', { kind: 'success' });
      refreshMine();
      refreshManage();
    } catch (e) {
      root.UI.toast((e && e.message) || 'Delete failed.', { kind: 'danger' });
    }
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
      '<p><strong>' + escape(r.facilityLabel) + '</strong> · ' + escape(friendlyRelDate(r.date)) + ' · ' + escape(reservationTimeLabel(r)) + '</p>' +
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
      if (selectedFacility) renderCalendar();
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
      if (selectedFacility) renderCalendar();
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

  // -------------------------------------------------------- PDF report

  // Formats an ISO timestamp as "dd Mon yy" (matches the shortDate helper
  // used by pdf-report.js for the Issues report).
  function shortIso(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${String(d.getDate()).padStart(2, '0')} ${MON[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
  }

  function shortYmd(ymd) {
    if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd || '';
    const [y, m, d] = ymd.split('-').map(Number);
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${String(d).padStart(2, '0')} ${MON[m - 1]} ${String(y).slice(-2)}`;
  }

  function minsToHHMM(m) {
    if (typeof m !== 'number' || !Number.isFinite(m)) return '';
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  // Shape a raw reservation record into the flat row expected by the
  // pdf-report.js column readers below. Kept side-effect-free so it can be
  // called from getItems() without touching module-level caches.
  function toReportRow(r) {
    const startHH = minsToHHMM(r.startMin);
    const endHH   = minsToHHMM(r.endMin);
    const timeStr = (startHH && endHH) ? `${startHH}\u2013${endHH}` : (r.slotLabel || '');
    const pay = r.payment || null;
    // "Completed" is derived: a confirmed booking whose slot end time
    // has already elapsed (IST). The domain has no explicit completed
    // status so this is the honest signal we can print.
    let completedOn = '';
    if (r.status === 'confirmed' && r.date && typeof r.endMin === 'number') {
      try {
        // Slot end in IST as an epoch. Compare against now.
        const [Y, M, D] = r.date.split('-').map(Number);
        const endIstMs = Date.UTC(Y, M - 1, D, 0, 0, 0)
                       + r.endMin * 60 * 1000
                       - (5.5 * 60 * 60 * 1000); // convert IST -> UTC
        if (Date.now() >= endIstMs) completedOn = shortYmd(r.date);
      } catch (_e) { /* leave blank */ }
    }
    const flat = (r.owner && r.owner.flat) || '';
    const name = (r.owner && r.owner.name) || '';
    const ownerLine = flat && name ? `${flat} \u00b7 ${name}` : (flat || name || '');
    return {
      id:            r.id || '',
      facility:      r.facilityLabel || r.facilityId || '',
      slotDate:      shortYmd(r.date),
      slotTime:      timeStr,
      owner:         ownerLine,
      purpose:       (r.purpose || '').trim(),
      bookedOn:      shortIso(r.createdAt),
      paidOn:        pay && pay.verifiedAt ? shortIso(pay.verifiedAt) : '',
      amount:        pay && typeof pay.amount === 'number' ? String(pay.amount) : '',
      completedOn:   completedOn,
      status:        (RESIDENT_STATUS_LABEL[r.status] || r.status || '').toString(),
    };
  }

  // Column schema for the Bookings PDF. Follows the same shape as
  // pdf-report.js#COLUMNS (key/label/width/on/always/read) so the wizard
  // can render it without any bookings-specific code inside pdf-report.js.
  // Widths tuned so 'auto' orientation picks landscape (total > 200mm).
  const BOOKING_COLUMNS = [
    { key: 'id',          label: 'Booking ID',   width: 32, on: true, always: true, read: (r) => r.id },
    { key: 'facility',    label: 'Facility',     width: 32, on: true,               read: (r) => r.facility },
    { key: 'slotDate',    label: 'Slot date',    width: 22, on: true,               read: (r) => r.slotDate },
    { key: 'slotTime',    label: 'Slot time',    width: 22, on: true,               read: (r) => r.slotTime },
    { key: 'owner',       label: 'Owner',        width: 36, on: true,               read: (r) => r.owner },
    { key: 'purpose',     label: 'Purpose',      width: 40, on: true,               read: (r) => r.purpose },
    { key: 'bookedOn',    label: 'Booked on',    width: 22, on: true,               read: (r) => r.bookedOn },
    { key: 'paidOn',      label: 'Paid on',      width: 22, on: true,               read: (r) => r.paidOn },
    { key: 'amount',      label: 'Amount (INR)', width: 20, on: true,               read: (r) => r.amount },
    { key: 'completedOn', label: 'Completed on', width: 22, on: true,               read: (r) => r.completedOn },
    { key: 'status',      label: 'Status',       width: 22, on: true,               read: (r) => r.status },
  ];

  // ---------------------------------------------------- receipt template

  // Small in-memory cache of the /receipts/template payload so repeated
  // Receipt clicks don't hit the worker. Invalidated after a successful
  // upload in openReceiptTemplateManager().
  let receiptTemplateCache = null;
  let receiptTemplateFetchedAt = 0;

  async function getReceiptTemplate(forceRefresh) {
    const now = Date.now();
    if (!forceRefresh && receiptTemplateCache !== null && (now - receiptTemplateFetchedAt) < 60_000) {
      return receiptTemplateCache;
    }
    try {
      const res = await root.Api.get('/receipts/template');
      receiptTemplateCache = (res && res.template) || null;
      receiptTemplateFetchedAt = now;
      return receiptTemplateCache;
    } catch (_e) {
      receiptTemplateCache = null;
      receiptTemplateFetchedAt = now;
      return null;
    }
  }

  // Lightweight version of pdf-report.js\u2019 waitForJsPdf that doesn't
  // require the autoTable plugin (we only need core jsPDF for receipts).
  async function waitForJspdfLite(maxMs) {
    const ready = () => !!(root.jspdf && root.jspdf.jsPDF);
    if (ready()) return true;
    const deadline = Date.now() + (maxMs || 6000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      if (ready()) return true;
    }
    return false;
  }

  async function fetchAsDataUrl(url) {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('template fetch ' + res.status);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(String(rd.result || ''));
      rd.onerror = () => reject(rd.error || new Error('read failed'));
      rd.readAsDataURL(blob);
    });
  }

  // Cached "confirmed" stamp overlay per language. Fetched once per
  // language per page load and reused for every receipt build so we don't
  // hit the network on each print. Returns { dataUrl, bytes } or null if
  // the asset is unavailable (never throws — the stamp is a best-effort
  // visual, absence must not break the receipt build).
  const STAMP_URLS = {
    en: './assets/images/TaStampBlueOverlay.png',
    hi: './assets/images/TaStampBlueOverlay-hi.png',
    mr: './assets/images/TaStampBlueOverlay-mr.png',
  };
  const _stampCache = { en: undefined, hi: undefined, mr: undefined };
  async function loadStampAsset(lang) {
    const key = STAMP_URLS[lang] ? lang : 'en';
    if (_stampCache[key] !== undefined) return _stampCache[key];
    try {
      const res = await fetch(STAMP_URLS[key], {
        mode: 'cors', credentials: 'omit',
      });
      if (!res.ok) throw new Error('stamp fetch ' + res.status);
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Data URL for jsPDF path — cheaper to build once than to re-encode.
      const blob = new Blob([bytes], { type: 'image/png' });
      const dataUrl = await new Promise((resolve, reject) => {
        const rd = new FileReader();
        rd.onload = () => resolve(String(rd.result || ''));
        rd.onerror = () => reject(rd.error || new Error('read failed'));
        rd.readAsDataURL(blob);
      });
      _stampCache[key] = { bytes, dataUrl };
    } catch (_e) {
      _stampCache[key] = null;
    }
    return _stampCache[key];
  }

  function receiptFieldRows(r) {
    const dateLabel = friendlyDate ? friendlyDate(r.date) : r.date;
    const rows = [
      { k: 'Booking ID',   v: r.id },
      { k: 'Resident',     v: (r.owner.name || r.owner.email) + (r.owner.flat ? ' \u00b7 Flat ' + r.owner.flat : '') },
      { k: 'Contact',      v: [r.owner.email, r.owner.phone].filter(Boolean).join(' \u00b7 ') || '\u2014' },
      { k: 'Facility',     v: r.facilityLabel },
      { k: 'Date',         v: dateLabel },
      { k: 'Time',         v: reservationTimeLabel ? reservationTimeLabel(r) : '' },
      { k: 'Purpose',      v: r.purpose || '' },
    ];
    if (r.payment) {
      rows.push({ k: 'Charges', v: (r.payment.amount != null ? '\u20b9' + r.payment.amount : '\u2014') + ' \u00b7 ' + (PAYMENT_STATUS_LABEL[r.payment.status] || r.payment.status) });
      if (r.payment.reference) rows.push({ k: 'Payment ref', v: r.payment.reference });
      if (r.payment.verifiedBy) rows.push({ k: 'Verified by', v: r.payment.verifiedBy });
    }
    rows.push({ k: 'Status', v: (RESIDENT_STATUS_LABEL[r.status] || r.status) });
    return rows;
  }

  function buildReceiptDoc(r, templateDataUrl, templateMime, stampDataUrl) {
    const { jsPDF } = root.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = 210, pageH = 297;
    // jsPDF also ships with WinAnsi-only core fonts, so we run every user-
    // sourced string through the same substitution table used on the pdf-
    // lib path (\u20B9 \u2192 "Rs. ", curly quotes \u2192 straight, etc.).
    // Anything still outside Latin-1 (Devanagari, CJK, emoji) becomes '?'.
    const winAnsi = (s) => {
      if (s == null) return '';
      return String(s)
        .replace(/\u20B9/g, 'Rs. ')
        .replace(/[\u2010-\u2015]/g, '-')
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2026/g, '...')
        .replace(/[^\x00-\xFF]/g, '?');
    };
    // Template header \u2014 image only in v1 (PDF composition needs pdf-lib).
    // Fit within the top 45mm of the page keeping the source aspect ratio.
    const headerH = 45;
    const imgFmt = templateMime === 'image/png' ? 'PNG'
      : templateMime === 'image/webp' ? 'WEBP' : 'JPEG';
    try {
      doc.addImage(templateDataUrl, imgFmt, 5, 5, pageW - 10, headerH);
    } catch (_e) {
      // Fallback: draw a stroked box so the receipt still renders even if
      // the letterhead image is missing or the format is rejected.
      doc.setDrawColor(180); doc.rect(5, 5, pageW - 10, headerH);
      doc.setFontSize(10); doc.text('(letterhead unavailable)', pageW / 2, 5 + headerH / 2, { align: 'center' });
    }

    doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('BOOKING RECEIPT', pageW / 2, 5 + headerH + 12, { align: 'center' });

    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    let y = 5 + headerH + 24;
    receiptFieldRows(r).forEach((row) => {
      doc.setFont('helvetica', 'bold');   doc.text(winAnsi(String(row.k) + ':'), 20, y);
      doc.setFont('helvetica', 'normal');
      const wrapped = doc.splitTextToSize(winAnsi(String(row.v || '\u2014')), 120);
      doc.text(wrapped, 60, y);
      y += 7 * (Array.isArray(wrapped) ? wrapped.length : 1) + 1;
      if (y > pageH - 40) { doc.addPage(); y = 20; }
    });

    doc.setDrawColor(220); doc.line(20, pageH - 30, pageW - 20, pageH - 30);
    doc.setFontSize(9); doc.setTextColor(90);
    doc.text('Printed ' + new Date().toLocaleString(), 20, pageH - 22);
    const me = (who && (who.email || who.name)) || '';
    if (me) doc.text(winAnsi('by ' + me), 20, pageH - 17);
    doc.text('This is a system-generated receipt. Retain a copy for your records.',
      pageW / 2, pageH - 12, { align: 'center' });
    doc.setTextColor(0);

    // Confirmed stamp overlay — bottom-right, above the footer rule.
    // Uses the semi-transparent overlay PNG so any text underneath still
    // reads through. Only stamped when the booking is actually confirmed.
    if (r.status === 'confirmed' && stampDataUrl) {
      try {
        const sW = 45, sH = 45;   // mm
        doc.addImage(stampDataUrl, 'PNG', pageW - 20 - sW, pageH - 30 - sH - 2, sW, sH);
      } catch (_e) { /* best-effort */ }
    }
    return doc;
  }

  // Waits for the pdf-lib CDN script (loaded by the pdf-report partial)
  // to finish parsing. Returns true when window.PDFLib is available.
  async function waitForPdfLib(maxMs) {
    const ready = () => !!(root.PDFLib && root.PDFLib.PDFDocument);
    if (ready()) return true;
    const deadline = Date.now() + (maxMs || 8000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      if (ready()) return true;
    }
    return false;
  }

  // Image-letterhead path (PNG / JPEG / WebP) — thin wrapper around the
  // existing buildReceiptDoc so openReceiptModal has one uniform bundle
  // shape regardless of template mime.
  async function buildReceiptFromImage(r, tpl, lang) {
    const ready = await waitForJspdfLite(6000);
    if (!ready) throw new Error('PDF library did not load. Please retry.');
    const dataUrl = await fetchAsDataUrl(tpl.url);
    // Load the confirmed-stamp overlay in parallel; loadStampAsset is
    // best-effort and returns null on failure so the receipt still builds.
    const stampAsset = await loadStampAsset(lang);
    const doc = buildReceiptDoc(r, dataUrl, tpl.mime || 'image/jpeg', stampAsset && stampAsset.dataUrl);
    return {
      bloburl: doc.output('bloburl'),
      download: (name) => doc.save(name),
      doc,
    };
  }

  // PDF-letterhead path — pdf-lib opens the uploaded PDF as the base
  // document (preserving vector text / logos exactly) and stamps the
  // booking fields onto the first page below the letterhead band. We
  // assume the letterhead occupies roughly the top 45 mm of A4, which
  // matches the reservation for the image-based header. If the letter-
  // head bleeds further down, the values will overlap it — that's a
  // conscious choice: users can crop the PDF before upload, and society
  // letterheads in practice only fill the top strip.
  async function buildReceiptFromPdfLetterhead(r, url, lang) {
    const ok = await waitForPdfLib(8000);
    if (!ok) throw new Error('PDF-Lib did not load. Please retry.');
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('template fetch ' + res.status);
    const bytes = await res.arrayBuffer();

    const { PDFDocument, StandardFonts, rgb } = root.PDFLib;
    const pdfDoc = await PDFDocument.load(bytes);
    let page = pdfDoc.getPages()[0];
    if (!page) throw new Error('template PDF has no pages');

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const { width: pageW, height: pageH } = page.getSize();

    // Standard PDF fonts only speak WinAnsi (Windows-1252). Anything outside
    // that page — the rupee sign \u20B9, Devanagari, CJK, emoji — throws at
    // draw time. Map the common India-specific characters to safe equivalents
    // and drop the rest with '?' so a stray unicode char in a name or purpose
    // field never breaks the receipt build.
    const winAnsi = (s) => {
      if (s == null) return '';
      return String(s)
        .replace(/\u20B9/g, 'Rs. ')      // ₹ → Rs.
        .replace(/[\u2010-\u2015]/g, '-') // dashes → hyphen (safety net)
        .replace(/[\u2018\u2019]/g, "'")  // curly single → straight
        .replace(/[\u201C\u201D]/g, '"')  // curly double → straight
        .replace(/\u2026/g, '...')        // ellipsis
        .replace(/[^\x00-\xFF]/g, '?');   // anything still outside Latin-1 → ?
    };
    const draw = (p, text, opts) => p.drawText(winAnsi(text), opts);

    // ---- layout constants (points) -------------------------------
    const MM = (mm) => mm * 2.83464567;
    const headerBandPt = MM(45);     // same top band the image path reserves
    const marginX = MM(20);
    const labelX = marginX;
    const valueX = marginX + MM(40);
    const valueMaxW = pageW - valueX - marginX;
    const lineH = 14;                // pts between rows
    const titleY = pageH - headerBandPt - MM(12);
    let y = titleY - MM(12);

    // ---- title ---------------------------------------------------
    const title = 'BOOKING RECEIPT';
    const tw = bold.widthOfTextAtSize(title, 16);
    draw(page, title, { x: (pageW - tw) / 2, y: titleY, size: 16, font: bold, color: rgb(0, 0, 0) });

    // ---- rows ----------------------------------------------------
    // Simple word-wrap fallback for long values. Sanitises first so width
    // math and the eventual draw both agree on the exact glyph string.
    const wrap = (text, size, maxW) => {
      const safe = winAnsi(text || '\u2014');
      const words = safe.split(/\s+/);
      const lines = [];
      let cur = '';
      for (const w of words) {
        const trial = cur ? cur + ' ' + w : w;
        if (font.widthOfTextAtSize(trial, size) <= maxW) cur = trial;
        else { if (cur) lines.push(cur); cur = w; }
      }
      if (cur) lines.push(cur);
      return lines.length ? lines : ['-'];
    };

    receiptFieldRows(r).forEach((row) => {
      if (y < MM(35)) {
        // Add a fresh page if we run off the letterhead's page.
        page = pdfDoc.addPage([pageW, pageH]);
        y = pageH - MM(20);
      }
      draw(page, String(row.k) + ':', { x: labelX, y, size: 11, font: bold, color: rgb(0, 0, 0) });
      const lines = wrap(row.v, 11, valueMaxW);
      lines.forEach((ln, i) => {
        // wrap() already returns winAnsi-safe strings, so pass through drawText directly.
        page.drawText(ln, { x: valueX, y: y - i * lineH, size: 11, font, color: rgb(0.13, 0.13, 0.13) });
      });
      y -= lineH * lines.length + 2;
    });

    // ---- footer --------------------------------------------------
    const footY = MM(18);
    page.drawLine({
      start: { x: marginX, y: footY + MM(6) }, end: { x: pageW - marginX, y: footY + MM(6) },
      thickness: 0.5, color: rgb(0.86, 0.86, 0.86),
    });
    const stamp = 'Printed ' + new Date().toLocaleString();
    draw(page, stamp, { x: marginX, y: footY, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
    const me = (who && (who.email || who.name)) || '';
    if (me) draw(page, 'by ' + me, { x: marginX, y: footY - 10, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
    const note = 'This is a system-generated receipt. Retain a copy for your records.';
    const nw = font.widthOfTextAtSize(note, 9);
    draw(page, note, { x: (pageW - nw) / 2, y: footY - 20, size: 9, font, color: rgb(0.35, 0.35, 0.35) });

    // ---- confirmed stamp overlay -----------------------------------
    // Only drawn on confirmed bookings so pending/rejected receipts
    // never look officially approved. Placed bottom-right above the
    // footer rule at ~45 mm wide with the overlay PNG's own 65% alpha
    // giving the rubber-stamp look over any text underneath.
    if (r.status === 'confirmed') {
      try {
        const stampAsset = await loadStampAsset(lang);
        if (stampAsset && stampAsset.bytes) {
          const stampImg = await pdfDoc.embedPng(stampAsset.bytes);
          const stampW = MM(45);
          const stampH = stampW;   // square source
          const stampX = pageW - marginX - stampW;
          const stampY = footY + MM(10);
          page.drawImage(stampImg, {
            x: stampX, y: stampY, width: stampW, height: stampH,
          });
        }
      } catch (_e) { /* best-effort; keep the receipt even if stamp fails */ }
    }

    const outBytes = await pdfDoc.save();
    const blob = new Blob([outBytes], { type: 'application/pdf' });
    const bloburl = URL.createObjectURL(blob);
    return {
      bloburl,
      download: (name) => {
        const a = document.createElement('a');
        a.href = bloburl; a.download = name || ('receipt-' + r.id + '.pdf');
        document.body.appendChild(a); a.click(); a.remove();
      },
    };
  }

  // Fetches the server-composed archived receipt from the private repo
  // via the auth-gated worker endpoint and shows it in the same
  // preview/print/download shell as the on-page receipt. Staff-only.
  async function openArchivedReceipt(r) {
    if (!r || !r.archive || !r.archive.path) {
      root.UI.toast('This booking has not been archived yet. Try re-archiving from the reservation details.', { kind: 'warn' });
      return;
    }
    const tok = root.Auth && root.Auth.token ? root.Auth.token() : null;
    if (!tok) {
      root.UI.toast('Please sign in to view archived receipts.', { kind: 'warn' });
      return;
    }
    const base = (root.Api && root.Api.base && root.Api.base()) || '';
    let bloburl;
    try {
      const res = await fetch(base + '/receipts/archive/' + encodeURIComponent(r.id), {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/pdf' },
        credentials: 'omit',
      });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); msg = j.error || msg; } catch (_e) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      bloburl = URL.createObjectURL(blob);
    } catch (e) {
      root.UI.toast('Could not load archived receipt: ' + (e && e.message || e), { kind: 'danger' });
      return;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const meta = document.createElement('div');
    meta.className = 'tsh-hint';
    meta.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;align-items:center;';
    const stamped = r.archive.archivedAt ? new Date(r.archive.archivedAt).toLocaleString() : '';
    meta.innerHTML =
      '<span><i class="fas fa-box-archive"></i> <code>' + escape(r.archive.path) + '</code></span>' +
      (stamped ? '<span>archived ' + escape(stamped) + '</span>' : '');
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
    const rebuildBtn = document.createElement('button');
    rebuildBtn.type = 'button';
    rebuildBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
    rebuildBtn.innerHTML = '<i class="fas fa-rotate"></i> Re-archive';
    rebuildBtn.title = 'Re-compose the PDF from the current booking + letterhead and overwrite the archive.';
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'tsh-btn tsh-btn-primary tsh-btn-sm';
    dlBtn.innerHTML = '<i class="fas fa-file-arrow-down"></i> Download PDF';
    bar.append(rebuildBtn, dlBtn);

    const frame = document.createElement('iframe');
    frame.title = 'Archived receipt preview';
    frame.style.cssText = 'width:100%;height:65vh;min-height:420px;border:1px solid var(--tsh-border,#e5e7eb);border-radius:6px;background:#f9fafb;';
    frame.src = bloburl;
    wrap.append(meta, bar, frame);

    dlBtn.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = bloburl; a.download = 'receipt-archive-' + r.id + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
    });
    rebuildBtn.addEventListener('click', async () => {
      rebuildBtn.disabled = true;
      const original = rebuildBtn.innerHTML;
      rebuildBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rebuilding\u2026';
      try {
        const res = await root.Api.post('/receipts/archive/' + encodeURIComponent(r.id) + '/rebuild');
        if (res && res.archive) r.archive = res.archive;
        root.UI.toast('Archive rebuilt \u2192 ' + (res && res.archive && res.archive.path || ''), { kind: 'success' });
      } catch (e) {
        root.UI.toast('Rebuild failed: ' + (e && e.message || e), { kind: 'danger' });
      } finally {
        rebuildBtn.disabled = false;
        rebuildBtn.innerHTML = original;
      }
    });

    root.UI.modal({
      title: 'Archived receipt \u00b7 ' + r.id,
      body: wrap,
      size: 'lg',
      actions: [{ label: 'Close', value: null }],
    });
  }

  async function openReceiptModal(r) {
    let tpl;
    try { tpl = await getReceiptTemplate(false); }
    catch (_e) { tpl = null; }
    if (!tpl || !tpl.url) {
      root.UI.toast('No receipt template uploaded yet. A Society Manager, Committee member or Admin can upload one from the Reservations page (Receipt template button).', { kind: 'warn' });
      return;
    }

    // Two rendering back-ends depending on the template mime:
    //   image/*         -> jsPDF adds the image as a top-band header.
    //   application/pdf -> pdf-lib loads the letterhead as the base
    //                      document and overlays the booking fields on
    //                      the first page (keeps the letterhead pixel-
    //                      perfect, no rasterisation).
    // Both back-ends expose the same { bloburl, download(name), doc }
    // shape so the preview iframe + print/download buttons don't care.
    //
    // Language: swaps the confirmed-stamp overlay to the localised seal
    // (English P.O. / Hindi + Marathi डाकघर). Standard PDF fonts can't
    // render Devanagari so the body labels stay Latin; the seal is what
    // carries the language identity on the receipt.
    const LANG_LABEL = { en: 'English', hi: 'Hindi', mr: 'Marathi' };
    let lang = 'en';
    let bundle;
    const buildBundle = async () =>
      tpl.mime === 'application/pdf'
        ? await buildReceiptFromPdfLetterhead(r, tpl.url, lang)
        : await buildReceiptFromImage(r, tpl, lang);
    try {
      bundle = await buildBundle();
    } catch (e) {
      root.UI.toast('Receipt build failed: ' + (e && e.message || e), { kind: 'danger' });
      return;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;align-items:center;';

    // Language picker (only visible when a confirmed booking has a stamp
    // to swap; the seal is only drawn on confirmed receipts). For pending
    // or rejected receipts the picker would have no visible effect.
    let langSel = null;
    if (r.status === 'confirmed') {
      const langWrap = document.createElement('label');
      langWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-right:auto;font-size:.9em;color:var(--tsh-muted,#4b5563);';
      langWrap.innerHTML = '<i class="fas fa-language" aria-hidden="true"></i><span>Seal language:</span>';
      langSel = document.createElement('select');
      langSel.className = 'tsh-select tsh-select-sm';
      langSel.style.cssText = 'padding:3px 6px;border-radius:4px;border:1px solid var(--tsh-border,#d1d5db);background:#fff;';
      for (const k of ['en', 'hi', 'mr']) {
        const opt = document.createElement('option');
        opt.value = k; opt.textContent = LANG_LABEL[k];
        langSel.appendChild(opt);
      }
      langSel.value = lang;
      langWrap.appendChild(langSel);
      bar.appendChild(langWrap);
    }

    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
    printBtn.innerHTML = '<i class="fas fa-print"></i> Print';
    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'tsh-btn tsh-btn-primary tsh-btn-sm';
    dlBtn.innerHTML = '<i class="fas fa-file-arrow-down"></i> Download PDF';
    bar.append(printBtn, dlBtn);

    const frame = document.createElement('iframe');
    frame.title = 'Receipt preview';
    frame.style.cssText = 'width:100%;height:65vh;min-height:420px;border:1px solid var(--tsh-border,#e5e7eb);border-radius:6px;background:#f9fafb;';
    frame.src = bundle.bloburl;
    wrap.append(bar, frame);

    // Rebuild + swap the iframe when the user picks a different language.
    // Revokes the previous blob URL so we don't leak memory across swaps.
    if (langSel) {
      langSel.addEventListener('change', async () => {
        const next = langSel.value;
        if (next === lang) return;
        const prevBloburl = bundle.bloburl;
        langSel.disabled = true;
        const origLabel = dlBtn.innerHTML;
        dlBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rebuilding\u2026';
        dlBtn.disabled = true; printBtn.disabled = true;
        try {
          lang = next;
          bundle = await buildBundle();
          frame.src = bundle.bloburl;
          try { URL.revokeObjectURL(prevBloburl); } catch (_e) { /* ignore */ }
        } catch (e) {
          root.UI.toast('Rebuild failed: ' + (e && e.message || e), { kind: 'danger' });
          lang = langSel.value = 'en';  // fall back to the always-present English seal
        } finally {
          langSel.disabled = false;
          dlBtn.disabled = false; printBtn.disabled = false;
          dlBtn.innerHTML = origLabel;
        }
      });
    }

    printBtn.addEventListener('click', () => {
      try {
        if (frame.contentWindow) {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } else {
          window.open(bundle.bloburl, '_blank');
        }
      } catch (e) {
        root.UI.toast('Print blocked: ' + (e && e.message || e), { kind: 'warn' });
      }
    });
    dlBtn.addEventListener('click', () => {
      const suffix = (lang && lang !== 'en') ? '-' + lang : '';
      try { bundle.download('receipt-' + r.id + suffix + '.pdf'); }
      catch (e) { root.UI.toast('Download failed: ' + (e && e.message || e), { kind: 'danger' }); }
    });

    root.UI.modal({
      title: 'Receipt \u00b7 ' + r.id,
      body: wrap,
      size: 'lg',
      actions: [{ label: 'Close', value: null }],
    });
  }

  function openReceiptTemplateManager() {
    const isStaff = who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER');
    if (!isStaff) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    wrap.innerHTML =
      '<p class="tsh-hint" style="margin:0;">' +
        'Upload the letterhead that appears at the top of every printed booking receipt. ' +
        'PNG, JPEG, WebP or PDF (up to ~5&nbsp;MB). PDF letterheads keep their vector text / logos crisp; images are simplest. The new template applies immediately to all confirmed bookings.' +
      '</p>' +
      '<div data-tpl-current style="min-height:80px;padding:8px;border:1px dashed var(--tsh-border,#e5e7eb);border-radius:6px;background:#fafafa;">' +
        '<span class="tsh-hint">Loading current template\u2026</span>' +
      '</div>' +
      '<div class="tsh-form-row">' +
        '<label class="tsh-form-label" style="display:block;">New letterhead ' +
        '<input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" data-tpl-file style="display:block;margin-top:4px;" />' +
        '</label>' +
      '</div>' +
      '<label class="tsh-form-label" style="display:block;">Note (optional) ' +
        '<input type="text" maxlength="200" data-tpl-note placeholder="e.g. Approved by committee, updated 2026-07" style="display:block;width:100%;margin-top:4px;" />' +
      '</label>' +
      '<div data-tpl-preview></div>';

    const currentBox = wrap.querySelector('[data-tpl-current]');
    const fileEl     = wrap.querySelector('[data-tpl-file]');
    const noteEl     = wrap.querySelector('[data-tpl-note]');
    const previewBox = wrap.querySelector('[data-tpl-preview]');
    let pendingDataUrl = '';

    getReceiptTemplate(true).then((tpl) => {
      if (!tpl || !tpl.url) {
        currentBox.innerHTML = '<span class="tsh-hint">No template uploaded yet.</span>';
        return;
      }
      const meta = 'Uploaded ' + (tpl.updatedAt ? String(tpl.updatedAt).slice(0, 10) : '?') +
                   (tpl.updatedBy ? ' by ' + escape(tpl.updatedBy) : '') +
                   (tpl.mime ? ' \u00b7 ' + escape(tpl.mime) : '');
      if (tpl.mime === 'application/pdf') {
        currentBox.innerHTML =
          '<div style="font-size:12px;color:var(--tsh-muted,#6b7280);">' + meta + '</div>' +
          '<a href="' + escape(tpl.url) + '" target="_blank" rel="noopener">Open current PDF template</a>';
      } else {
        currentBox.innerHTML =
          '<div style="font-size:12px;color:var(--tsh-muted,#6b7280);margin-bottom:6px;">' + meta + '</div>' +
          '<img src="' + escape(tpl.url) + '" alt="Current template" style="max-width:100%;max-height:160px;border:1px solid var(--tsh-border,#e5e7eb);border-radius:4px;" />';
      }
    });

    fileEl.addEventListener('change', () => {
      const f = fileEl.files && fileEl.files[0];
      if (!f) { pendingDataUrl = ''; previewBox.innerHTML = ''; return; }
      if (f.size > 12_000_000) {
        root.UI.toast('File too large (' + Math.round(f.size / 1024) + ' KB). Please keep the letterhead under ~12 MB.', { kind: 'warn' });
        fileEl.value = ''; return;
      }
      const rd = new FileReader();
      rd.onload = () => {
        pendingDataUrl = String(rd.result || '');
        if (f.type === 'application/pdf') {
          previewBox.innerHTML = '<div class="tsh-hint">PDF preview not shown. Uploading will replace the current template.</div>';
        } else {
          previewBox.innerHTML =
            '<div class="tsh-hint" style="margin-bottom:4px;">Preview of new template:</div>' +
            '<img src="' + pendingDataUrl + '" alt="Preview" style="max-width:100%;max-height:160px;border:1px solid var(--tsh-border,#e5e7eb);border-radius:4px;" />';
        }
      };
      rd.onerror = () => root.UI.toast('Could not read the selected file.', { kind: 'danger' });
      rd.readAsDataURL(f);
    });

    root.UI.modal({
      title: 'Receipt template',
      body: wrap,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Upload & save', value: 'save', primary: true },
      ],
    }).then(async (choice) => {
      if (choice !== 'save') return;
      if (!pendingDataUrl) { root.UI.toast('Choose an image or PDF first.', { kind: 'warn' }); return; }
      try {
        const body = { dataUrl: pendingDataUrl };
        const note = (noteEl.value || '').trim();
        if (note) body.note = note;
        const res = await root.Api.post('/receipts/template', body);
        receiptTemplateCache = (res && res.template) || null;
        receiptTemplateFetchedAt = Date.now();
        root.UI.toast('Receipt template updated.', { kind: 'success' });
      } catch (e) {
        root.UI.toast('Upload failed: ' + (e && e.message || e), { kind: 'danger' });
      }
    });
  }

  async function bindPdfReport() {
    // Configurable, default enabled: FEATURE_BOOKINGS_REPORT ships true in
    // config/site.json. Admins can flip it to false to hide the report
    // wiring (the header Export icon then also hides on this page because
    // ui.js only reveals it when TSH_REPORT is bound and the role passes).
    if (root.Flags && root.Flags.ready) {
      try { await root.Flags.ready(); } catch (_e) { /* still bind on config failure */ }
    }
    if (root.Flags && root.Flags.on && root.Flags.on('FEATURE_BOOKINGS_REPORT') === false) {
      return;
    }
    const isStaff = who && root.Flags && root.Flags.isAtLeast
                    && root.Flags.isAtLeast(who.primary, 'MANAGER');
    root.TSH_REPORT.bind({
      title: isStaff
        ? 'Society Bookings \u2014 Facility Reservations Report'
        : 'My Bookings \u2014 Facility Reservations',
      source: 'reservations',
      columns: BOOKING_COLUMNS,
      // Staff pull scope=all across every status so the printed record
      // matches society-manager expectations (past + present + future).
      // Residents only ever see their own bookings, which is what
      // /reservations?scope=mine returns.
      getItems: async () => {
        if (!root.Api || !root.Api.get) return [];
        const path = isStaff
          ? '/reservations?scope=all&status=all'
          : '/reservations?scope=mine';
        try {
          const res = await root.Api.get(path);
          const rows = Array.isArray(res && res.items) ? res.items : [];
          return rows
            .filter((r) => r && !r.isDeleted)
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
            .map(toReportRow);
        } catch (_e) {
          return [];
        }
      },
    });
  }

  root.Reservations = { init };

})(window);

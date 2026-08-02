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

  // Icon shown on each station card, chosen from `kind`. Falls back to
  // a generic plug for stations without a declared kind.
  function stationIconClass(station) {
    const k = station && station.kind ? String(station.kind).toUpperCase() : '';
    if (k === '4W') return 'fas fa-car';
    if (k === '2W') return 'fas fa-motorcycle';
    return 'fas fa-plug';
  }

  function stationSubtitle(station) {
    if (!station) return '';
    const parts = [];
    if (station.currentType) parts.push(String(station.currentType));
    if (Number.isFinite(station.capacityKw)) parts.push(station.capacityKw + ' kW');
    if (station.connector) parts.push(String(station.connector));
    return parts.join(' · ');
  }

  function renderStationsBar(stations, selectedId) {
    const host = $('#evStationsBar');
    if (!host) return;
    if (!Array.isArray(stations) || stations.length === 0) {
      host.innerHTML = '<div class="tsh-sub">No chargers configured. Ask an admin to add one under Settings → EV.</div>';
      return;
    }
    // Group by kind so 2-wheeler and 4-wheeler chargers render in
    // separate rows for at-a-glance parsing. 2-wheeler chargers list
    // FIRST because that matches the physical placement in the parking
    // area (residents walking in encounter the 2W wallboxes before the
    // 4W DC-fast bays).
    const groups = new Map();
    stations.forEach((s) => {
      const k = s && s.kind ? String(s.kind).toUpperCase() : 'OTHER';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    });
    const order = ['2W', '4W', 'OTHER'];
    const labels = { '2W': '2-Wheeler chargers', '4W': '4-Wheeler chargers', 'OTHER': 'Chargers' };
    const html = order
      .filter((k) => groups.has(k))
      .map((k) => {
        const rows = groups.get(k).map((s) => {
          const on = s && s.enabled !== false;
          const isSelected = String(s.id) === String(selectedId);
          const reason = !on ? String(s.maintenanceReason || 'Temporarily unavailable') : '';
          // "Under maintenance" is the resident-friendly framing for a
          // disabled station — it makes the intent explicit (present
          // but not bookable) instead of a bare "offline" label.
          const status = on ? 'ONLINE' : 'UNDER MAINTENANCE';
          const statusCls = on ? 'tsh-ev-status-online' : 'tsh-ev-status-maintenance';
          const cardCls = 'tsh-ev-station-card'
            + (isSelected ? ' tsh-ev-station-selected' : '')
            + (on ? '' : ' tsh-ev-station-disabled')
            + (s.image ? ' tsh-ev-station-has-photo' : '');
          // Product photo hero — falls back to a Font Awesome icon when
          // no image is supplied by the config. Alt text uses the model
          // + name so screen readers get a useful description.
          const altText = [s.series, s.name].filter(Boolean).join(' — ') || 'Charging station';
          const media = s.image
            ? '<div class="tsh-ev-station-photo">'
              +   '<img src="' + esc(s.image) + '" alt="' + esc(altText) + '" loading="lazy" decoding="async"'
              +   ' onerror="this.parentNode.classList.add(\'tsh-ev-station-photo-fallback\');this.remove();" />'
              +   (!on
                    ? '<div class="tsh-ev-maintenance-overlay" aria-hidden="true"><i class="fas fa-screwdriver-wrench"></i></div>'
                    : '')
              + '</div>'
            : '<div class="tsh-ev-station-icon"><i class="' + stationIconClass(s) + '"></i></div>';
          const seriesLine = s.series
            ? '<div class="tsh-ev-station-series">' + esc(s.series) + '</div>'
            : '';
          const reasonLine = !on
            ? '<div class="tsh-ev-station-reason" role="note">'
              + '<i class="fas fa-triangle-exclamation" aria-hidden="true"></i> '
              + esc(reason)
              + '</div>'
            : '';
          // Staff-only toggle. Rendered as a separate button OUTSIDE
          // the radio button so its click doesn't fire the selection
          // handler (we stop propagation in the click wiring below).
          const toggle = isStaff
            ? '<button type="button" class="tsh-ev-maintenance-toggle'
              + (on ? ' is-online' : ' is-maintenance')
              + '"'
              + ' data-ev-station-toggle="' + esc(s.id) + '"'
              + ' aria-pressed="' + (on ? 'false' : 'true') + '"'
              + ' title="' + (on
                  ? 'Mark this charger as under maintenance (residents will not be able to book it).'
                  : 'Bring this charger back online.'
                ) + '">'
              +   '<span class="tsh-ev-maintenance-toggle-track">'
              +     '<span class="tsh-ev-maintenance-toggle-thumb"></span>'
              +   '</span>'
              +   '<span class="tsh-ev-maintenance-toggle-label">'
              +     (on ? 'Online' : 'Maintenance')
              +   '</span>'
              + '</button>'
            : '';
          return ''
            + '<button type="button" class="' + cardCls + '"'
            + ' role="radio" aria-checked="' + (isSelected ? 'true' : 'false') + '"'
            + ' data-ev-station-id="' + esc(s.id) + '"'
            + (on ? '' : ' disabled aria-disabled="true"') + '>'
            +   media
            +   '<div class="tsh-ev-station-info">'
            +     '<div class="tsh-ev-station-name">' + esc(s.name || '—') + '</div>'
            +     seriesLine
            +     '<div class="tsh-ev-station-meta">'
            +       (s.location ? '<span><i class="fas fa-location-dot"></i> ' + esc(s.location) + '</span>' : '')
            +       (stationSubtitle(s) ? '<span><i class="fas fa-bolt"></i> ' + esc(stationSubtitle(s)) + '</span>' : '')
            +     '</div>'
            +     reasonLine
            +   '</div>'
            +   '<span class="tsh-ev-status-pill ' + statusCls + '">' + status + '</span>'
            + toggle
            + '</button>';
        }).join('');
        // Only show the section label when there are 2+ kinds to distinguish.
        const showLabel = groups.size > 1;
        return ''
          + '<div class="tsh-ev-stations-group">'
          + (showLabel ? '<h2 class="tsh-ev-stations-group-label">' + esc(labels[k]) + '</h2>' : '')
          +   '<div class="tsh-ev-stations-row">' + rows + '</div>'
          + '</div>';
      })
      .join('');
    host.innerHTML = html;
    // Wire click → selection change. Disabled cards ignore clicks (they
    // carry the native `disabled` attribute so the browser also blocks
    // keyboard activation).
    host.querySelectorAll('[data-ev-station-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-ev-station-id');
        if (!id || String(id) === String(stationId)) return;
        stationId = id;
        renderStationsBar(stationsList, stationId);
        refreshAvailability();
      });
    });
    // Wire the staff maintenance toggle — sits above the card so its
    // click bubbles up; stopPropagation prevents the parent radio from
    // treating it as a selection change.
    host.querySelectorAll('[data-ev-station-toggle]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const id = btn.getAttribute('data-ev-station-toggle');
        if (id) toggleStationMaintenance(id);
      });
    });
  }

  // Staff-only. Flips a station between ONLINE and UNDER MAINTENANCE
  // via PATCH /ev/stations/:id. When disabling, prompts for a short
  // human-readable reason so residents see WHY the charger is out.
  async function toggleStationMaintenance(id) {
    const s = stationsList.find((x) => String(x.id) === String(id));
    if (!s) return;
    const willEnable = s.enabled === false;   // currently disabled → re-enable
    let reason;
    if (!willEnable) {
      // eslint-disable-next-line no-alert -- lightweight editor tool
      reason = root.prompt(
        'Mark "' + (s.name || id) + '" as under maintenance.\n\n'
        + 'Reason shown to residents (max 200 chars):',
        s.maintenanceReason || 'Temporarily unavailable',
      );
      if (reason === null) return;   // cancelled
      reason = String(reason || '').trim().slice(0, 200);
    }
    const body = { enabled: willEnable };
    if (!willEnable && reason) body.maintenanceReason = reason;
    try {
      const res = await root.Api.patch('/ev/stations/' + encodeURIComponent(id), body);
      const data = res && res.ok ? res.data : res;
      const updated = data && data.station ? data.station : null;
      if (updated) {
        // Splice the updated station into the in-memory list so we do
        // not have to round-trip /ev/config just for the label change.
        const idx = stationsList.findIndex((x) => String(x.id) === String(id));
        if (idx !== -1) stationsList[idx] = { ...stationsList[idx], ...updated };
      }
      renderStationsBar(stationsList, stationId);
      // If the station that just went into maintenance was the one
      // currently selected, refresh availability so the booking form
      // reflects the new disabled state.
      if (String(id) === String(stationId)) refreshAvailability();
      if (root.UI && root.UI.toast) {
        root.UI.toast(
          willEnable
            ? (s.name || id) + ' is back online.'
            : (s.name || id) + ' is now under maintenance.',
          { kind: willEnable ? 'success' : 'warn' },
        );
      }
    } catch (e) {
      if (root.UI && root.UI.toast) {
        root.UI.toast('Could not update charger: ' + (e && e.message || e), { kind: 'danger' });
      }
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
  // Full list of stations from /ev/config. Rendered as clickable cards
  // in `renderStationsBar`. Kept in memory so the receipt / summary
  // views can resolve station metadata by id without another round-trip.
  let stationsList  = [];
  // MANAGER+ role snapshot resolved once at bootstrap. Used by the
  // station renderer to decide whether to draw the maintenance toggle.
  // Read-only for the rest of the module.
  let isStaff = false;
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
    // Prefer the `stations` array (multi-charger); fall back to a
    // single-item list synthesized from the legacy `station` block.
    const rawStations = cfg && Array.isArray(cfg.stations) && cfg.stations.length > 0
      ? cfg.stations
      : (cfg && cfg.station ? [cfg.station] : []);
    stationsList = rawStations.filter((s) => s && s.id);
    // Pick the first enabled station as the default selection; if all
    // are offline, still show the first so the resident sees the state.
    const firstEnabled = stationsList.find((s) => s.enabled !== false);
    stationId = firstEnabled ? firstEnabled.id : (stationsList[0] ? stationsList[0].id : 'ev-1');
    const dateEl = $('#evDate');
    if (dateEl && !dateEl.value) {
      dateEl.value = todayIstYmd();
      dateEl.min   = todayIstYmd();
    }
    // Cap the date-picker so users can't pick beyond the advance-booking
    // window. Server still validates authoritatively.
    if (dateEl && bookingPolicy && Number.isFinite(bookingPolicy.advanceWindowDays)) {
      dateEl.max = ymdOffset(todayIstYmd(), bookingPolicy.advanceWindowDays);
    }
    renderPolicyBar(bookingPolicy);
    if (dateEl) dateEl.addEventListener('change', () => refreshAvailability());
    const form = $('#evBookForm');
    if (form) form.addEventListener('submit', onBookSubmit);
    const cancelBtn = $('#evBookCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', clearSelection);
  }

  // Add `days` calendar days to a YYYY-MM-DD string (local calendar math).
  function ymdOffset(ymd, days) {
    const [y, m, d] = ymd.split('-').map((n) => Number(n));
    const t = new Date(y, (m - 1), d);
    t.setDate(t.getDate() + Math.max(0, Math.floor(days)));
    return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
  }

  // Render a compact policy summary above the date picker so residents
  // see the caps at a glance. Silent (hidden) when there's nothing to say.
  function renderPolicyBar(p) {
    const bar = $('#evPolicyBar');
    if (!bar) return;
    if (!p) { bar.hidden = true; bar.innerHTML = ''; return; }
    const chips = [];
    if (Number.isFinite(p.advanceWindowDays)) {
      const d = p.advanceWindowDays;
      chips.push('<span class="tsh-ev-chip"><i class="fas fa-calendar-check"></i> Book up to <strong>' + d + ' day' + (d === 1 ? '' : 's') + '</strong> ahead</span>');
    }
    if (Number.isFinite(p.maxDurationMinutes)) {
      chips.push('<span class="tsh-ev-chip"><i class="fas fa-hourglass-half"></i> Max <strong>' + p.maxDurationMinutes + ' min</strong> per slot</span>');
    }
    if (Number.isFinite(p.maxDailyMinutesPerFlat) && p.maxDailyMinutesPerFlat > 0) {
      chips.push('<span class="tsh-ev-chip"><i class="fas fa-clock"></i> Max <strong>' + p.maxDailyMinutesPerFlat + ' min/day</strong> per flat</span>');
    }
    if (Number.isFinite(p.maxTotalBookingsPerFlat) && p.maxTotalBookingsPerFlat > 0) {
      chips.push('<span class="tsh-ev-chip"><i class="fas fa-list-check"></i> Max <strong>' + p.maxTotalBookingsPerFlat + ' active booking' + (p.maxTotalBookingsPerFlat === 1 ? '' : 's') + '</strong> per flat</span>');
    } else if (p.maxTotalBookingsPerFlat === null || p.maxTotalBookingsPerFlat === undefined) {
      // Only mention "unlimited" when a positive daily minutes cap is
      // set — otherwise nothing meaningful to communicate.
      if (Number.isFinite(p.maxDailyMinutesPerFlat) && p.maxDailyMinutesPerFlat > 0) {
        chips.push('<span class="tsh-ev-chip tsh-ev-chip-muted"><i class="fas fa-infinity"></i> Unlimited total bookings</span>');
      }
    }
    if (chips.length === 0) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.innerHTML = chips.join('');
    bar.hidden = false;
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
        stationId,
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
      + '<div class="tsh-ev-hist-actions">'
      +   (isReceiptEligible(it) ? '<button type="button" class="tsh-btn tsh-btn-ghost tsh-ev-hist-receipt" data-id="' + esc(it.id) + '"><i class="fas fa-receipt"></i> View receipt</button>' : '')
      +   (isActive ? '<button type="button" class="tsh-btn tsh-btn-ghost tsh-ev-hist-cancel" data-id="' + esc(it.id) + '"><i class="fas fa-xmark"></i> Cancel booking</button>' : '')
      + '</div>';
    const cancelBtn = li.querySelector('.tsh-ev-hist-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelBooking(it.id));
    const receiptBtn = li.querySelector('.tsh-ev-hist-receipt');
    if (receiptBtn) receiptBtn.addEventListener('click', () => openReceipt(it.id));
    return li;
  }

  const isReceiptEligible = (it) => it && (it.status === 'confirmed' || it.status === 'completed');

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

  // ---- Phase 3: Digital receipt --------------------------------------------

  async function openReceipt(id) {
    if (!id) return;
    let payload;
    try {
      payload = await root.Api.get('/ev/receipt/' + encodeURIComponent(id));
    } catch (e) {
      toast('Could not load receipt: ' + (e && e.message || e), { kind: 'danger' });
      return;
    }
    const data = payload && payload.ok ? payload.data : payload;
    if (!data) return;
    renderReceiptModal(data);
  }

  function renderReceiptModal(r) {
    // Reuse the shared Modal partial. Falls back to a plain overlay if the
    // partial helpers are unavailable so the page still works when Modal
    // is not initialised.
    const host = ensureReceiptModalHost();
    const startMin = Number.isFinite(r.item.startMin) ? r.item.startMin : 0;
    const endMin   = Number.isFinite(r.item.endMin)   ? r.item.endMin   : 0;
    const durMin   = endMin - startMin;
    const qrJson   = JSON.stringify(r.qr);
    const qrSrc    = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(qrJson);
    const soc = r.society || {};
    const st  = r.station || {};
    host.innerHTML = ''
      + '<div class="tsh-ev-receipt-overlay" role="dialog" aria-modal="true" aria-label="Booking receipt">'
      +   '<div class="tsh-ev-receipt-card" id="evReceiptPrintable">'
      +     '<header class="tsh-ev-receipt-head">'
      +       '<div class="tsh-ev-receipt-brand">'
      +         (soc.logoUrl ? '<img alt="" src="' + esc(soc.logoUrl) + '">' : '<i class="fas fa-charging-station"></i>')
      +         '<div>'
      +           '<h2>' + esc(soc.name || 'Booking Receipt') + '</h2>'
      +           '<p class="tsh-sub">EV Charging · Digital Receipt</p>'
      +         '</div>'
      +       '</div>'
      +       '<button type="button" class="tsh-btn tsh-btn-ghost tsh-ev-receipt-close" aria-label="Close">&times;</button>'
      +     '</header>'
      +     '<dl class="tsh-ev-receipt-grid">'
      +       row('Booking ID',   esc(r.item.id))
      +       row('Status',       esc(r.item.status).toUpperCase())
      +       row('Date',         esc(r.item.date))
      +       row('Time',         pad2(Math.floor(startMin/60)) + ':' + pad2(startMin%60) + ' – ' + pad2(Math.floor(endMin/60)) + ':' + pad2(endMin%60) + ' (' + durMin + ' min)')
      +       row('Station',      esc(st.name) + (st.location ? ' · ' + esc(st.location) : ''))
      +       row('Charger',      Number.isFinite(st.capacityKw) ? esc(st.capacityKw) + ' kW' : '—')
      +       row('Flat',         esc(r.item.owner && r.item.owner.flat))
      +       row('Owner',        esc((r.item.owner && r.item.owner.name) || r.item.owner && r.item.owner.email || ''))
      +       (r.item.notes ? row('Notes', esc(r.item.notes)) : '')
      +     '</dl>'
      +     '<div class="tsh-ev-receipt-qr">'
      +       '<img alt="QR verification code" src="' + qrSrc + '">'
      +       '<p class="tsh-sub">Scan to verify · Checksum <code>' + esc(r.qr.checksum) + '</code></p>'
      +     '</div>'
      +     '<footer class="tsh-ev-receipt-foot">'
      +       (soc.address ? '<p>' + esc(soc.address) + '</p>' : '')
      +       (soc.email   ? '<p><i class="fas fa-envelope"></i> ' + esc(soc.email) + '</p>' : '')
      +       (soc.phone   ? '<p><i class="fas fa-phone"></i> '    + esc(soc.phone) + '</p>' : '')
      +       '<p class="tsh-sub">Generated ' + esc(r.generatedAt) + '</p>'
      +     '</footer>'
      +     '<div class="tsh-ev-receipt-actions tsh-no-print">'
      +       '<button type="button" class="tsh-btn tsh-btn-primary tsh-ev-receipt-print"><i class="fas fa-print"></i> Print / Save PDF</button>'
      +       '<button type="button" class="tsh-btn tsh-btn-ghost tsh-ev-receipt-close">Close</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    host.hidden = false;
    document.body.classList.add('tsh-modal-open');
    host.querySelectorAll('.tsh-ev-receipt-close').forEach((b) => b.addEventListener('click', closeReceipt));
    host.querySelector('.tsh-ev-receipt-print').addEventListener('click', () => window.print());
    // Close on backdrop click.
    host.querySelector('.tsh-ev-receipt-overlay').addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) closeReceipt();
    });
  }

  function row(label, val) {
    return '<dt>' + esc(label) + '</dt><dd>' + val + '</dd>';
  }

  function ensureReceiptModalHost() {
    let host = document.getElementById('evReceiptHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'evReceiptHost';
      host.hidden = true;
      document.body.appendChild(host);
    }
    return host;
  }

  function closeReceipt() {
    const host = document.getElementById('evReceiptHost');
    if (!host) return;
    host.hidden = true;
    host.innerHTML = '';
    document.body.classList.remove('tsh-modal-open');
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
    // Resolve staff-ness once so `renderStationsBar` can decide whether
    // to render the maintenance toggle. Failure defaults to false (no
    // toggle rendered) — never crash the page for a whoami hiccup.
    try {
      if (root.Flags && root.Flags.whoami) {
        const who = await root.Flags.whoami();
        isStaff = !!(who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER'));
      }
    } catch (_e) { isStaff = false; }
    applySubFlagVisibility(data.subFlags || {});
    // Prime the booking context first so `stationId` is set before we
    // paint the stations bar (which uses the selection to highlight).
    if (data.subFlags && data.subFlags.booking) {
      primeBookingContext(data);
    } else {
      // Booking is off — still populate stationsList so the read-only
      // cards render for informational purposes.
      const rawStations = Array.isArray(data.stations) && data.stations.length > 0
        ? data.stations
        : (data.station ? [data.station] : []);
      stationsList = rawStations.filter((s) => s && s.id);
      stationId = stationsList[0] ? stationsList[0].id : null;
    }
    renderStationsBar(stationsList, stationId);
    renderGuidelines(data.usageGuidelines || []);
    renderFaqs(data.faqs || []);
    wirePills();
    // Phase 2: booking UI. Kick off initial availability render on the
    // default (Book) tab once the context is primed above.
    if (data.subFlags && data.subFlags.booking) {
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

  root.EvCharging = { init, _renderStationsBar: renderStationsBar, _SUB_FLAG_MAP: SUB_FLAG_MAP };
})(window);

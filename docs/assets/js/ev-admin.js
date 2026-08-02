/* eslint-env browser */
/* global Auth, Flags, Api, UI */
// TSH — EV Analytics dashboard (Phase 4).
// Controller for /docs/ev-admin.html.
// Fetches GET /ev/admin/dashboard?period=… and renders KPIs, per-day bars,
// hour-of-day heatmap, status split, and top-flats leaderboard. Exposes
// CSV / print-ready-PDF downloads via /ev/admin/export.
//
// Auth: requires MANAGER+ role (server enforces; the page shows a friendly
// "you need editor rights" card when Flags.ensureAuthorized() throws 403).
// Flag gates: FEATURE_TSH_EV_CHARGING + FEATURE_TSH_EV_ADMIN_DASHBOARD.
(function () {
  'use strict';

  var api = null;

  function $ (sel, root) { return (root || document).querySelector(sel); }

  function fmtIntl (n) {
    try { return new Intl.NumberFormat('en-IN').format(n); }
    catch (_e) { return String(n); }
  }

  function esc (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function kpiTile (label, value, icon) {
    return (
      '<div class="tsh-ev-kpi">' +
        '<div class="tsh-ev-kpi-icon"><i class="' + icon + '"></i></div>' +
        '<div class="tsh-ev-kpi-body">' +
          '<div class="tsh-ev-kpi-label">' + esc(label) + '</div>' +
          '<div class="tsh-ev-kpi-value">' + esc(value) + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderKpis (k) {
    $('#evaKpis').innerHTML = [
      kpiTile('Total bookings',   fmtIntl(k.totalBookings),        'fas fa-calendar-check'),
      kpiTile('Confirmed',        fmtIntl(k.confirmedBookings),    'fas fa-circle-check'),
      kpiTile('Completed',        fmtIntl(k.completedBookings),    'fas fa-flag-checkered'),
      kpiTile('Cancelled',        fmtIntl(k.cancelledBookings),    'fas fa-ban'),
      kpiTile('Pending',          fmtIntl(k.pendingBookings),      'fas fa-hourglass-half'),
      kpiTile('Hours booked',     fmtIntl(k.totalHours),           'fas fa-bolt'),
      kpiTile('Unique flats',     fmtIntl(k.uniqueFlats),          'fas fa-building'),
      kpiTile('Avg duration',     fmtIntl(k.avgMinutesPerBooking) + ' min', 'fas fa-stopwatch'),
    ].join('');
  }

  function renderByDay (rows) {
    var max = 1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].bookings > max) max = rows[i].bookings;
    }
    var html = rows.map(function (d) {
      var pct = Math.round((d.bookings / max) * 100);
      var label = d.date.slice(5); // MM-DD
      return (
        '<div class="tsh-ev-byday-row" title="' + esc(d.date) + ' — ' + d.bookings + ' booking(s), ' + d.minutes + ' min">' +
          '<div class="tsh-ev-byday-label">' + esc(label) + '</div>' +
          '<div class="tsh-ev-byday-bar"><div class="tsh-ev-byday-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="tsh-ev-byday-count">' + d.bookings + '</div>' +
        '</div>'
      );
    }).join('');
    $('#evaByDay').innerHTML = html || '<p class="tsh-empty-inline">No data in range.</p>';
  }

  function renderByHour (hours) {
    var max = 1;
    for (var i = 0; i < hours.length; i++) {
      if (hours[i].bookings > max) max = hours[i].bookings;
    }
    var cells = hours.map(function (h) {
      var pct = h.bookings === 0 ? 0 : (h.bookings / max);
      // 0 → very faint; 1 → strong gold accent.
      var alpha = h.bookings === 0 ? 0.05 : (0.15 + pct * 0.85);
      var label = (h.hour < 10 ? '0' : '') + h.hour;
      return (
        '<div class="tsh-ev-hour-cell" style="background:rgba(212,175,55,' + alpha.toFixed(2) + ')" title="' + label + ':00 — ' + h.bookings + ' booking(s)">' +
          '<span class="tsh-ev-hour-cell-h">' + label + '</span>' +
          '<span class="tsh-ev-hour-cell-n">' + h.bookings + '</span>' +
        '</div>'
      );
    }).join('');
    $('#evaByHour').innerHTML = cells;
  }

  function renderByStatus (byStatus) {
    var keys = ['pending','confirmed','completed','cancelled'];
    var total = keys.reduce(function (s, k) { return s + (byStatus[k] || 0); }, 0) || 1;
    var html = keys.map(function (k) {
      var v = byStatus[k] || 0;
      var pct = Math.round((v / total) * 100);
      return (
        '<li class="tsh-ev-status-row">' +
          '<span class="tsh-ev-status-name tsh-ev-status-' + k + '">' + k + '</span>' +
          '<span class="tsh-ev-status-bar"><span style="width:' + pct + '%"></span></span>' +
          '<span class="tsh-ev-status-num">' + v + '</span>' +
        '</li>'
      );
    }).join('');
    $('#evaByStatus').innerHTML = html;
  }

  function renderTopFlats (top) {
    if (!top || !top.length) {
      $('#evaTopFlats').innerHTML = '<li class="tsh-empty-inline">No confirmed / completed bookings in range.</li>';
      return;
    }
    $('#evaTopFlats').innerHTML = top.map(function (t, i) {
      return (
        '<li class="tsh-ev-top-flat-row">' +
          '<span class="tsh-ev-top-flat-rank">#' + (i + 1) + '</span>' +
          '<span class="tsh-ev-top-flat-name">' + esc(t.flat) + '</span>' +
          '<span class="tsh-ev-top-flat-meta">' + t.bookings + ' booking(s) &middot; ' + t.minutes + ' min</span>' +
        '</li>'
      );
    }).join('');
  }

  async function refresh () {
    var period = $('#evaPeriod').value || 'm';
    try {
      var data = await Api.get('/ev/admin/dashboard?period=' + encodeURIComponent(period));
      $('#evaRange').textContent = 'Window: ' + data.from + ' → ' + data.to;
      renderKpis(data.kpis);
      renderByDay(data.byDay);
      renderByHour(data.byHour);
      renderByStatus(data.byStatus);
      renderTopFlats(data.topFlats);
    } catch (e) {
      var msg = (e && (e.body && e.body.error)) || (e && e.message) || 'Failed to load dashboard.';
      UI.toast('EV analytics: ' + msg, 'error');
    }
  }

  function bindExport () {
    function base () {
      var period = $('#evaPeriod').value || 'm';
      var origin = (window.TSH_API_BASE || '').replace(/\/+$/, '');
      return { period: period, origin: origin };
    }
    $('#evaExportCsv').addEventListener('click', function () {
      var b = base();
      window.open(b.origin + '/ev/admin/export?period=' + encodeURIComponent(b.period) + '&format=csv', '_blank');
    });
    $('#evaExportPdf').addEventListener('click', function () {
      var b = base();
      window.open(b.origin + '/ev/admin/export?period=' + encodeURIComponent(b.period) + '&format=pdf', '_blank');
    });
    var syncBtn = $('#evaMirrorSync');
    if (syncBtn) {
      // Only expose the manual sync when the auto-reports sub-flag is on;
      // the cron would be dark otherwise so the button would be a no-op.
      if (Flags && Flags.on && Flags.on('FEATURE_TSH_EV_AUTO_REPORTS')) {
        syncBtn.hidden = false;
      }
      syncBtn.addEventListener('click', async function () {
        if (!confirm('Regenerate this month\'s report + bookings CSV and push them to the mirror repo now?')) return;
        var orig = syncBtn.innerHTML;
        syncBtn.disabled = true;
        syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing…';
        try {
          var payload = await Api.post('/ev/admin/mirror', {});
          var data = payload && payload.data ? payload.data : payload;
          var msg;
          if (data && data.ran) {
            msg = 'Sync ok — ' + data.month + ': '
                + (data.bookings || 0) + ' bookings, '
                + (data.changed ? 'files updated' : 'no changes');
          } else if (data && data.ran === false) {
            msg = 'Sync skipped: ' + (data.reason || 'no reason given');
          } else {
            msg = 'Sync complete';
          }
          if (window.UI && UI.toast) UI.toast(msg, { kind: 'success' });
          else alert(msg);
        } catch (e) {
          var em = 'Sync failed: ' + (e && e.message || e);
          if (window.UI && UI.toast) UI.toast(em, { kind: 'danger' });
          else alert(em);
        } finally {
          syncBtn.disabled = false;
          syncBtn.innerHTML = orig;
        }
      });
    }
  }

  async function init () {
    // Wait for config so the disabled-gate does not fire prematurely.
    try { await Flags.ready(); }
    catch (_e) { return; }

    // Master + sub flag gate.
    try {
      Flags.ensureFeature('FEATURE_TSH_EV_CHARGING', 'EV Charging');
      Flags.ensureFeature('FEATURE_TSH_EV_ADMIN_DASHBOARD', 'EV Analytics');
    } catch (_e) { return; }

    // Role gate: MANAGER+ only.
    var who = null;
    try { who = await Flags.ensureAuthorized('MANAGER'); }
    catch (_e) {
      var empty = $('[data-eva-empty]');
      if (empty) empty.hidden = false;
      return;
    }
    if (!who) return;

    var main = $('[data-eva-main]');
    if (main) main.hidden = false;

    api = { who: who };

    $('#evaPeriod').addEventListener('change', refresh);
    bindExport();
    await refresh();
  }

  window.EvAdmin = { init: init };
}());

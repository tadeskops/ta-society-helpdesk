// docs/assets/js/home-treasury.js
// Landing "Treasury this month" summary card. Renders a compact 3-tile
// KPI strip (Total spend / Paid this month / Open liability) using the
// promoted `.tsh-kpi-tile` component from theme.css Bundle 12.
//
// Closes aspiration matrix rows 11.3 and 15.5 (Treasury monthly summary
// visible from Landing, not only inside treasury.html). Fully additive:
// the section starts `hidden`; the JS only unhides it when the current
// user is authorized to read /treasury/summary. Residents / signed-out
// visitors never see the card.
//
// Gates (all must pass to render):
//   1. FEATURE_TREASURY flag is on
//   2. Whoami role is >= COMMITTEE (Treasurer/Chairman/Admin/Secretary
//      each map to COMMITTEE+ tier; residents map to RESIDENT and are
//      filtered here)
//   3. GET /treasury/summary?month=YYYY-MM succeeds (401/403 quietly
//      hides the card without a toast — this is a passive widget, not
//      a primary action)
//
// Wire contract (server-side): worker/src/routes/treasury.ts GET
// /treasury/summary responds with { month, totalMonth, paidMonth,
// paidMonthCount, openLiability, openCount, expenseCount, byCategory }.
// This module ONLY reads the top-level scalars — schema-safe against
// future byCategory extensions.
(function (root) {
  'use strict';

  const HomeTreasury = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function inr(n) {
    // Match the format used by treasury.js and reservations.js so residents
    // see the same currency style across surfaces. `en-IN` locale is
    // globally set on <html lang="en-IN"> (Phase 1) — Number.toLocaleString
    // honours it without an explicit second arg, but we pass it anyway so
    // this file is safe if someone copies it out.
    return '\u20b9' + Number(n || 0).toLocaleString('en-IN');
  }

  function monthKeyIst(d) {
    // IST offset = +05:30. Same helper as treasury.js.
    const t = (d instanceof Date ? d : new Date()).getTime();
    const ist = new Date(t + 330 * 60_000);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    return y + '-' + m;
  }

  function monthLabel(key) {
    // "2026-08" -> "August 2026"
    const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
    if (!m) return String(key || '');
    const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    return d.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  }

  async function isLedgerViewer() {
    try {
      if (root.Flags && root.Flags.whoami) {
        const who = await root.Flags.whoami();
        // ensureCanViewLedger on the server accepts Treasurer / Chairman /
        // Admin (+ Secretary when opt-in) — all of which resolve to
        // COMMITTEE tier or higher in the client-side role hierarchy.
        // Manager without any treasury role gets 403 and we hide.
        return !!(who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'COMMITTEE'));
      }
    } catch (_e) { /* signed-out or offline */ }
    return false;
  }

  function renderCard(host, summary) {
    const monthTxt = esc(monthLabel(summary.month));
    const totalTxt = esc(inr(summary.totalMonth));
    const paidTxt = esc(inr(summary.paidMonth));
    const paidCount = Number(summary.paidMonthCount || 0);
    const openTxt = esc(inr(summary.openLiability));
    const openCount = Number(summary.openCount || 0);

    host.innerHTML =
      '<div class="tsh-home-treasury-head">' +
        '<h2 class="tsh-home-treasury-h">Treasury &middot; ' + monthTxt + '</h2>' +
        '<a class="tsh-home-treasury-link" href="./treasury.html#summary">' +
          'Full ledger <i class="fas fa-arrow-right" aria-hidden="true"></i>' +
        '</a>' +
      '</div>' +
      // Same structure as kpi.js on manager-dashboard: `.tsh-kpi-tile`
      // anchors are DIRECT children of `.tsh-kpi-grid` (Bundle 12 relies
      // on this — do NOT wrap in <li>, or the CSS Grid track sizing +
      // `grid-column: span 2` on the hero tile break).
      '<div class="tsh-kpi-grid" role="list" aria-label="Treasury summary tiles">' +
        '<a class="tsh-kpi-tile tsh-kpi-tile--hero" role="listitem"' +
          ' href="./treasury.html#summary"' +
          ' aria-label="Total spend this month: ' + totalTxt + '">' +
          '<i class="fas fa-wallet tsh-kpi-tile-ic" aria-hidden="true"></i>' +
          '<span class="tsh-kpi-tile-n">' + totalTxt + '</span>' +
          '<span class="tsh-kpi-tile-l">Total spend</span>' +
        '</a>' +
        '<a class="tsh-kpi-tile tsh-kpi-tile--low" role="listitem"' +
          ' href="./treasury.html#reimbursements"' +
          ' aria-label="Paid this month: ' + paidTxt + ', ' + paidCount + ' reimbursement(s)">' +
          '<i class="fas fa-circle-check tsh-kpi-tile-ic" aria-hidden="true"></i>' +
          '<span class="tsh-kpi-tile-n">' + paidTxt + '</span>' +
          '<span class="tsh-kpi-tile-l">Paid (' + paidCount + ')</span>' +
        '</a>' +
        '<a class="tsh-kpi-tile ' + (openCount > 0 ? 'tsh-kpi-tile--high' : 'tsh-kpi-tile--low') + '"' +
          ' role="listitem"' +
          ' href="./treasury.html#reimbursements"' +
          ' aria-label="Open liability: ' + openTxt + ', ' + openCount + ' pending">' +
          '<i class="fas fa-hourglass-half tsh-kpi-tile-ic" aria-hidden="true"></i>' +
          '<span class="tsh-kpi-tile-n">' + openTxt + '</span>' +
          '<span class="tsh-kpi-tile-l">Open (' + openCount + ')</span>' +
        '</a>' +
      '</div>';
    host.hidden = false;
  }

  HomeTreasury.mount = async function mount(host) {
    if (!host) return;
    // Gate 1: feature flag
    try {
      if (root.Flags && root.Flags.on && !root.Flags.on('FEATURE_TREASURY')) return;
    } catch (_e) { /* Flags not ready */ return; }

    // Gate 2: viewer role
    const staff = await isLedgerViewer();
    if (!staff) return;

    // Gate 3: server call
    const month = monthKeyIst();
    let summary;
    try {
      const res = await root.Api.get('/treasury/summary?month=' + encodeURIComponent(month));
      summary = (res && (res.data || res)) || null;
    } catch (_e) {
      // 401 / 403 / network — passive widget, silent hide.
      return;
    }
    if (!summary || typeof summary.totalMonth !== 'number') return;

    renderCard(host, summary);
  };

  root.HomeTreasury = HomeTreasury;
})(window);

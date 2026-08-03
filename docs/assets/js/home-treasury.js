// docs/assets/js/home-treasury.js
// "Treasury this month" summary card. Renders a compact 3-tile KPI
// strip (Total spend / Paid this month / Open liability) using the
// promoted `.tsh-kpi-tile` component from theme.css Bundle 12.
//
// The same widget is mounted on two surfaces:
//
//   * Dashboard (docs/manager-dashboard.html — the "Dashboard" nav
//     entry). This is the PRIMARY surface for committee+ viewers: the
//     card is always shown here whenever `FEATURE_TREASURY` is on and
//     the current user reached the dashboard page (the page itself
//     already requires MANAGER+ via `Flags.ensureAuthorized('MANAGER')`,
//     so no extra role gate is needed at mount time).
//
//   * Landing (docs/index.html). SECONDARY surface, opt-in only. The
//     card renders here only when the editor-toggled feature flag
//     `FEATURE_TREASURY_HOME_SUMMARY_RESIDENT` is on AND the viewer
//     is signed-in. Editors do NOT get the card on Landing — they see
//     it on the Dashboard.
//
// Gates:
//   1. FEATURE_TREASURY must be on for either mount.
//   2. `mountHome` additionally requires
//      FEATURE_TREASURY_HOME_SUMMARY_RESIDENT to be on and the caller
//      to be signed-in.
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

  // Editor-controlled toggle that lets residents also see the landing
  // treasury card (default OFF). We still require the user to be signed
  // in — signed-out visitors never get the card, so guessing at the flag
  // can't leak any data.
  async function isSignedInResident() {
    try {
      if (root.Flags && root.Flags.whoami) {
        const who = await root.Flags.whoami();
        return !!(who && who.primary);
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

  async function fetchAndRender(host) {
    // Shared server call + render for both mount surfaces. 401/403 or
    // network error silently hides the widget — this is a passive
    // dashboard tile, not a primary CTA. Editors on Dashboard reach
    // this path unconditionally (page-level gate handled MANAGER+
    // check); Landing residents reach it only when the resident
    // visibility flag is on.
    const month = monthKeyIst();
    let summary;
    try {
      const res = await root.Api.get('/treasury/summary?month=' + encodeURIComponent(month));
      summary = (res && (res.data || res)) || null;
    } catch (_e) {
      return;
    }
    if (!summary || typeof summary.totalMonth !== 'number') return;
    renderCard(host, summary);
  }

  HomeTreasury.mount = async function mount(host) {
    // LANDING (docs/index.html) surface. Editor-toggled, resident-facing.
    // Committee+ viewers do NOT see this on Landing — they get the same
    // widget on the Dashboard page via `mountDashboard`. The Landing
    // mount is purely resident opt-in.
    if (!host) return;
    try {
      if (root.Flags && root.Flags.on && !root.Flags.on('FEATURE_TREASURY')) return;
      if (root.Flags && root.Flags.on && !root.Flags.on('FEATURE_TREASURY_HOME_SUMMARY_RESIDENT')) return;
    } catch (_e) { return; }
    const signedIn = await isSignedInResident();
    if (!signedIn) return;
    await fetchAndRender(host);
  };

  HomeTreasury.mountDashboard = async function mountDashboard(host) {
    // DASHBOARD (docs/manager-dashboard.html) surface. Page-level gate
    // (`Flags.ensureAuthorized('MANAGER')`) already ran before this is
    // called, so we only need the feature-flag check here. Server-side
    // `ensureCanViewLedger` still enforces the treasurer/chairman/admin/
    // secretary allow-list on `/treasury/summary` — Manager without a
    // treasury role will get 403 and the card silently hides.
    if (!host) return;
    try {
      if (root.Flags && root.Flags.on && !root.Flags.on('FEATURE_TREASURY')) return;
    } catch (_e) { return; }
    await fetchAndRender(host);
  };

  root.HomeTreasury = HomeTreasury;
})(window);

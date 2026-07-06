// Daily-track KPI dashboard module.
// - Kpi.boot({ role, hostId }) — renders status + severity counter tiles
//   plus a 7-day resolved trend into the given host. Auto-refreshes every
//   60 s; refresh is paused while the document is hidden to save battery.
//
// Configurable: feature-gated on FEATURE_DAILY_KPI_DASHBOARD (default ON).
// When off, the page renders a friendly "feature disabled" panel — same
// pattern used elsewhere in the project.
//
// Performance: a single /issues fetch backs every tile (no N+1 calls);
// the worker already returns the full list pre-parsed.
(function (root) {
  'use strict';

  const REFRESH_MS = 60_000;

  // Status groupings used by the operational tiles. Matches the worker
  // STATUS labels exactly. `triaging` was retired from the default
  // lifecycle (APP_BRIEF_PROMPT.md §7) so no tile is rendered for it —
  // legacy tickets still in `triaging` roll up under the "New" count via
  // the /issues list filter for operators who want to see them.
  const STATUS_TILES = [
    { key: 'new',          label: 'New',           icon: 'fa-circle-exclamation', href: './manage.html?status=new' },
    { key: 'assigned',     label: 'Assigned',       icon: 'fa-user-check',         href: './manage.html?status=assigned' },
    { key: 'in-progress',  label: 'In progress',    icon: 'fa-screwdriver-wrench', href: './manage.html?status=in-progress' },
    { key: 'resolved',     label: 'Resolved (7d)',  icon: 'fa-check-double',       href: './manage.html?status=resolved', windowDays: 7 },
    { key: 'rejected',     label: 'Rejected (7d)',  icon: 'fa-ban',                href: './manage.html?status=rejected', windowDays: 7 },
  ];

  const SEVERITY_TILES = [
    { key: 'critical', label: 'Critical', tone: 'crit' },
    { key: 'high',     label: 'High',     tone: 'high' },
    { key: 'medium',   label: 'Medium',   tone: 'med'  },
    { key: 'low',      label: 'Low',      tone: 'low'  },
  ];

  // Anything not resolved / rejected / deleted is "open".
  const isOpen = (i) => i && i.status !== 'resolved' && i.status !== 'rejected' && i.status !== 'deleted';
  const withinDays = (iso, days) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return false;
    return (Date.now() - t) <= days * 24 * 60 * 60 * 1000;
  };

  async function fetchIssues() {
    try {
      const res = await Api.get('/issues');
      return Array.isArray(res && res.items) ? res.items : [];
    } catch (e) {
      console.warn('Kpi: failed to load /issues', e);
      return null;
    }
  }

  function renderTile(t, count, href) {
    const a = document.createElement('a');
    a.className = 'tsh-kpi-tile';
    if (t.tone) a.classList.add('tsh-kpi-tile--' + t.tone);
    a.href = href || '#';
    if (t.icon) {
      const i = document.createElement('i');
      i.className = 'fas ' + t.icon + ' tsh-kpi-tile-ic';
      i.setAttribute('aria-hidden', 'true');
      a.appendChild(i);
    }
    const num = document.createElement('span');
    num.className = 'tsh-kpi-tile-n';
    num.textContent = String(count);
    a.appendChild(num);
    const lab = document.createElement('span');
    lab.className = 'tsh-kpi-tile-l';
    lab.textContent = t.label;
    a.appendChild(lab);
    return a;
  }

  function renderEmpty(host) {
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'tsh-state tsh-state-empty';
    wrap.innerHTML = '<i class="tsh-state-icon fas fa-circle-info" aria-hidden="true"></i>' +
      '<p class="tsh-state-title">No issues yet</p>' +
      '<p class="tsh-state-msg">Counters appear here as residents submit reports.</p>';
    host.appendChild(wrap);
  }

  function renderDisabled(host) {
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'tsh-state tsh-state-empty';
    wrap.innerHTML = '<i class="tsh-state-icon fas fa-circle-pause" aria-hidden="true"></i>' +
      '<p class="tsh-state-title">Dashboard disabled</p>' +
      '<p class="tsh-state-msg">A developer can re-enable it from Settings &rarr; Feature flags (FEATURE_DAILY_KPI_DASHBOARD).</p>';
    host.appendChild(wrap);
  }

  function render(host, items) {
    if (!items.length) { renderEmpty(host); return; }
    host.innerHTML = '';

    // Status counters.
    const openCount = items.filter(isOpen).length;
    const openTile = renderTile({ key: 'open', label: 'Open total', icon: 'fa-inbox' }, openCount, './manage.html');
    openTile.classList.add('tsh-kpi-tile--hero');

    const statusGrid = document.createElement('div');
    statusGrid.className = 'tsh-kpi-grid';
    statusGrid.appendChild(openTile);
    for (const t of STATUS_TILES) {
      let count;
      if (t.windowDays) {
        count = items.filter((i) => i.status === t.key && (withinDays(i.updatedAt, t.windowDays) || withinDays(i.createdAt, t.windowDays))).length;
      } else {
        count = items.filter((i) => i.status === t.key).length;
      }
      statusGrid.appendChild(renderTile(t, count, t.href));
    }
    host.appendChild(statusGrid);

    // Severity counters (only show if any issue actually has severity).
    const hasSeverity = items.some((i) => i.severity);
    if (hasSeverity) {
      const sevTitle = document.createElement('h2');
      sevTitle.className = 'tsh-section-h tsh-kpi-section-h';
      sevTitle.textContent = 'By severity';
      host.appendChild(sevTitle);
      const sevGrid = document.createElement('div');
      sevGrid.className = 'tsh-kpi-grid tsh-kpi-grid--severity';
      for (const s of SEVERITY_TILES) {
        const count = items.filter((i) => isOpen(i) && i.severity === s.key).length;
        sevGrid.appendChild(renderTile(s, count, './manage.html?severity=' + s.key));
      }
      host.appendChild(sevGrid);
    }

    // Last-updated footer.
    const foot = document.createElement('p');
    foot.className = 'tsh-kpi-foot';
    foot.textContent = 'Updated ' + new Date().toLocaleTimeString();
    host.appendChild(foot);
  }

  async function reload(host) {
    const items = await fetchIssues();
    if (items === null) {
      host.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'tsh-state tsh-state-error';
      wrap.innerHTML = '<i class="tsh-state-icon fas fa-triangle-exclamation" aria-hidden="true"></i>' +
        '<p class="tsh-state-title">Couldn\u2019t load issues</p>' +
        '<p class="tsh-state-msg">Check your connection and try again.</p>';
      host.appendChild(wrap);
      return;
    }
    render(host, items);
  }

  function boot(opts) {
    const hostId = (opts && opts.hostId) || 'kpiGrid';
    const host = document.getElementById(hostId);
    if (!host) return;

    if (root.Flags && root.Flags.on && root.Flags.on('FEATURE_DAILY_KPI_DASHBOARD') === false) {
      renderDisabled(host);
      return;
    }

    // First paint: loading shimmer.
    host.innerHTML = '<p class="tsh-text-muted"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Loading counters\u2026</p>';
    reload(host);

    let timer = setInterval(() => {
      if (document.hidden) return;
      reload(host);
    }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reload(host);
    });
    // Manual refresh hook (button).
    document.querySelectorAll('[data-tsh-kpi-refresh]').forEach((btn) => {
      btn.addEventListener('click', () => reload(host));
    });
    return { reload: () => reload(host), stop: () => { clearInterval(timer); timer = null; } };
  }

  root.Kpi = { boot, reload };
})(window);

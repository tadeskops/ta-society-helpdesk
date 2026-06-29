// docs/assets/js/pdf-report.js
// Sleek PDF export for TSH list views. Adapts the ta-issue-manager
// reporting layout (header band + meta line + autotable + inline
// photo thumbnails + footer page numbers) to the simpler one-source
// TSH PublicIssue shape.
//
//   window.TSH_REPORT.bind({ title, source, getItems })
//     Registers a default data source for the active page. The header
//     button hands these to open() when the user clicks Export.
//   window.TSH_REPORT.open([overrides])
//     Opens the wizard. Overrides may include { title, items, source,
//     filtersAppliedSummary }. When no items are provided the bound
//     getItems() is used; if neither is set, the wizard fetches
//     /issues?state=all as a last resort.

(function (root) {
  'use strict';

  const COLUMNS = [
    { key: 'id',          label: 'Ticket ID',  width: 30, on: true,  always: true, read: (i) => i.id || '' },
    { key: 'createdAt',   label: 'Submitted',  width: 22, on: true,                read: (i) => shortDate(i.createdAt) },
    { key: 'tower',       label: 'Tower',      width: 18, on: true,                read: (i) => i.tower || '—' },
    { key: 'category',    label: 'Category',   width: 24, on: true,                read: (i) => i.category || '—' },
    { key: 'subCategory', label: 'Subcategory',width: 26, on: false,               read: (i) => i.subCategory || '' },
    { key: 'severity',    label: 'Severity',   width: 18, on: false,               read: (i) => (i.severity || '—').toUpperCase() },
    { key: 'status',      label: 'Status',     width: 22, on: true,                read: (i) => prettyStatus(i.status) },
    { key: 'location',    label: 'Location',   width: 32, on: true,                read: (i) => i.location || '' },
    { key: 'description', label: 'Description',width: 60, on: true,                read: (i) => i.description || '' },
    { key: 'photos',      label: 'Photos',     width: 50, on: true,                read: (i) => readPhotoUrls(i).join('|') },
  ];

  const QUALITY_PRESETS = {
    none:   { maxDim: 0,    jpegQ: 0,    inline: false },
    low:    { maxDim: 320,  jpegQ: 0.5,  inline: true  },
    medium: { maxDim: 640,  jpegQ: 0.75, inline: true  },
    high:   { maxDim: 1024, jpegQ: 0.9,  inline: true  },
  };

  const SEV_COLOR = {
    CRITICAL: [220, 38, 38],
    HIGH:     [234, 88, 12],
    MEDIUM:   [202, 138, 4],
    LOW:      [37, 99, 235],
  };

  const INLINE_THUMB = { w: 18, h: 14, gap: 1.5, pad: 1, perRowCap: 3 };

  let bound = null;          // { title, source, getItems }
  let cols = COLUMNS.slice();
  let running = false;
  let lastBlob = null;       // retained so commit-after-download can run
  let originalGetItems = null; // restored when user toggles off monthly mode
  let monthlyActive = false;   // true while ctx.items came from /reports/monthly

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd} ${mon} ${yy}`;
  }
  function prettyStatus(s) {
    if (!s) return '';
    return String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  }

  // ---------------------------------------------------------------- public

  function bind(spec) {
    bound = Object.assign({ title: 'Society Help Desk — Report', source: 'page' }, spec || {});
    // Let chrome (e.g. header Export icon) know a data source has been
    // registered so it can reveal an action that would otherwise be inert.
    try { document.dispatchEvent(new CustomEvent('tsh:pdf-bound')); } catch (_e) { /* IE-only */ }
  }

  function isBound() { return !!(bound && typeof bound.getItems === 'function'); }

  async function open(overrides) {
    const o = Object.assign({}, overrides || {});
    const title = o.title || (bound && bound.title) || 'Society Help Desk — Report';
    let items = Array.isArray(o.items) ? o.items.slice() : null;
    if (!items && bound && typeof bound.getItems === 'function') {
      try { items = bound.getItems(); } catch (_e) { items = null; }
    }
    if (!items) {
      // Fallback: pull /issues if signed in. Residents can't read that
      // endpoint, so we then try /issues/public (anonymous-allowed,
      // daily-tracking items only) before surfacing a toast.
      const tryFetch = async (path) => {
        if (!root.Api || !root.Api.get) throw new Error('Api unavailable');
        const res = await root.Api.get(path);
        return Array.isArray(res) ? res : (res.items || []);
      };
      try {
        items = await tryFetch('/issues?state=all');
      } catch (_e1) {
        try {
          items = await tryFetch('/issues/public');
        } catch (e2) {
          toast(`Could not load items: ${e2.message || e2}`, 'danger');
          return;
        }
      }
    }
    items = Array.isArray(items) ? items : [];
    const source = o.source || (bound && bound.source) || 'page';
    const filtersAppliedSummary = o.filtersAppliedSummary || '';
    showWizard({ title, items, source, filtersAppliedSummary });
  }

  function close() {
    const m = document.getElementById('tshPdfModal');
    if (!m) return;
    m.hidden = true;
    m.setAttribute('aria-hidden', 'true');
    running = false;
    setBusy(false);
  }

  // ---------------------------------------------------------------- modal

  function showWizard(ctx) {
    const m = document.getElementById('tshPdfModal');
    if (!m) { toast('PDF wizard partial not loaded on this page.', 'warn'); return; }
    document.getElementById('tshPdfReportTitle').value = ctx.title;
    cols = COLUMNS.map((c) => Object.assign({}, c));
    renderCols();
    monthlyActive = false;
    originalGetItems = ctx.items;
    renderSummary(ctx);
    setupMonthlyBlock(ctx);

    const closers = m.querySelectorAll('[data-tsh-pdf-close]');
    closers.forEach((b) => b.addEventListener('click', close, { once: true }));
    document.getElementById('tshPdfPreview').onclick = () => generate('preview', ctx);
    document.getElementById('tshPdfDownload').onclick = () => generate('download', ctx);

    m.hidden = false;
    m.setAttribute('aria-hidden', 'false');
    // Defer focus so the modal is on-screen first.
    setTimeout(() => document.getElementById('tshPdfReportTitle').focus(), 30);
  }

  function setupMonthlyBlock(ctx) {
    const block = document.getElementById('tshPdfMonthlyBlock');
    if (!block) return;
    // Default-hidden until role check resolves; reset state on every open.
    block.hidden = true;
    block.open = false;
    const statusEl = document.getElementById('tshPdfMonthStatus');
    if (statusEl) statusEl.textContent = '';
    const resetBtn = document.getElementById('tshPdfMonthReset');
    if (resetBtn) resetBtn.hidden = true;
    const fromEl = document.getElementById('tshPdfMonthFrom');
    const toEl   = document.getElementById('tshPdfMonthTo');
    if (fromEl && !fromEl.value) {
      const now = new Date();
      const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      fromEl.value = ym; if (toEl) toEl.value = ym;
    }

    // Gate by role — Resident must not see monthly archive controls.
    const flags = root.Flags;
    if (!flags || typeof flags.whoami !== 'function') return;
    flags.whoami().then((who) => {
      const allow = !!(who && flags.isAtLeast && flags.isAtLeast(who.primary, 'MANAGER'));
      if (!allow) return;
      block.hidden = false;
      const loadBtn = document.getElementById('tshPdfMonthLoad');
      if (loadBtn) loadBtn.onclick = () => loadMonthly(ctx);
      if (resetBtn) resetBtn.onclick = () => resetToPageData(ctx);
    }).catch(() => { /* keep hidden on failure */ });
  }

  async function loadMonthly(ctx) {
    const from = (document.getElementById('tshPdfMonthFrom') || {}).value;
    const to   = (document.getElementById('tshPdfMonthTo')   || {}).value || from;
    const statusEl = document.getElementById('tshPdfMonthStatus');
    if (!from || !to) { if (statusEl) statusEl.textContent = 'Pick a from & to month.'; return; }
    if (from > to) { if (statusEl) statusEl.textContent = 'From must be ≤ To.'; return; }
    if (!root.Api || !root.Api.get) { toast('API unavailable.', 'danger'); return; }
    if (statusEl) statusEl.textContent = 'Loading…';
    try {
      const res = await root.Api.get(`/reports/monthly?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const items = Array.isArray(res && res.items) ? res.items : [];
      ctx.items = items;
      ctx.source = 'monthly';
      ctx.filtersAppliedSummary = `Monthly archive ${from}${from === to ? '' : ' → ' + to}`;
      monthlyActive = true;
      const titleEl = document.getElementById('tshPdfReportTitle');
      if (titleEl) titleEl.value = `Society Help Desk — Monthly Report (${from}${from === to ? '' : ' to ' + to})`;
      renderSummary(ctx);
      if (statusEl) statusEl.textContent = `Loaded ${items.length} ticket${items.length === 1 ? '' : 's'} across ${(res.months || []).length} month${(res.months || []).length === 1 ? '' : 's'}.`;
      const resetBtn = document.getElementById('tshPdfMonthReset');
      if (resetBtn) resetBtn.hidden = false;
    } catch (e) {
      if (statusEl) statusEl.textContent = '';
      toast('Monthly load failed: ' + (e && e.message ? e.message : e), 'danger');
    }
  }

  function resetToPageData(ctx) {
    ctx.items = Array.isArray(originalGetItems) ? originalGetItems.slice() : [];
    ctx.source = (bound && bound.source) || 'page';
    ctx.filtersAppliedSummary = '';
    monthlyActive = false;
    const titleEl = document.getElementById('tshPdfReportTitle');
    if (titleEl) titleEl.value = (bound && bound.title) || 'Society Help Desk — Report';
    renderSummary(ctx);
    const statusEl = document.getElementById('tshPdfMonthStatus');
    if (statusEl) statusEl.textContent = '';
    const resetBtn = document.getElementById('tshPdfMonthReset');
    if (resetBtn) resetBtn.hidden = true;
  }

  function renderCols() {
    const wrap = document.getElementById('tshPdfCols');
    if (!wrap) return;
    wrap.innerHTML = '';
    cols.forEach((c, idx) => {
      const lbl = document.createElement('label');
      lbl.className = 'tsh-pdf-coltoggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!c.on;
      cb.disabled = !!c.always;
      cb.addEventListener('change', () => { cols[idx].on = cb.checked; });
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + c.label + (c.always ? ' (required)' : '')));
      wrap.appendChild(lbl);
    });
  }

  function renderSummary(ctx) {
    const el = document.getElementById('tshPdfSummary');
    if (!el) return;
    const where = monthlyActive ? 'from monthly archive' : 'from this page';
    const parts = [
      `${ctx.items.length} item${ctx.items.length === 1 ? '' : 's'} ${where}`,
    ];
    if (ctx.filtersAppliedSummary) parts.push('Filters: ' + ctx.filtersAppliedSummary);
    el.textContent = parts.join(' · ');
  }

  function setBusy(b) {
    const p = document.getElementById('tshPdfProgress');
    if (p) {
      // Keep the progress chrome mounted at all times so users always
      // see a status line. data-state drives the visual treatment in CSS.
      p.dataset.state = b ? 'busy' : 'idle';
      if (!b) setProgress(0, 'Ready');
    }
    ['tshPdfPreview', 'tshPdfDownload'].forEach((id) => {
      const e = document.getElementById(id);
      if (e) e.disabled = b;
    });
  }
  function setProgress(pct, text) {
    const bar = document.getElementById('tshPdfBar');
    const st  = document.getElementById('tshPdfStatus');
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (st && text) st.textContent = text;
  }
  function toast(msg, kind) {
    if (root.UI && root.UI.toast) root.UI.toast(msg, { kind: kind || 'info' });
    else console.log('[TSH_REPORT]', msg);
  }

  // ---------------------------------------------------------------- PDF

  function pdfLibReady() {
    if (!root.jspdf || !root.jspdf.jsPDF) return false;
    const proto = root.jspdf.jsPDF.API || root.jspdf.jsPDF.prototype;
    return !!(proto && typeof proto.autoTable === 'function');
  }

  async function waitForJsPdf(maxMs) {
    if (pdfLibReady()) return true;
    const deadline = Date.now() + (maxMs || 5000);
    setBusy(true); setProgress(2, 'Loading PDF library…');
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 120));
      if (pdfLibReady()) return true;
    }
    setBusy(false);
    return false;
  }

  async function generate(action, ctx) {
    if (running) return;
    const ready = await waitForJsPdf(6000);
    if (!ready) { toast('PDF library failed to load. Check network and retry.', 'danger'); return; }

    const titleText = document.getElementById('tshPdfReportTitle').value || ctx.title;
    const qualityKey = document.getElementById('tshPdfQuality').value;
    const quality = QUALITY_PRESETS[qualityKey] || QUALITY_PRESETS.medium;
    const orientPref = document.getElementById('tshPdfOrient').value;
    const includePhotos = quality.inline;

    let activeCols = cols.filter((c) => c.on || c.always);
    if (!includePhotos) activeCols = activeCols.filter((c) => c.key !== 'photos');
    if (activeCols.length === 0) { toast('Pick at least one column.', 'warn'); return; }

    running = true; setBusy(true); setProgress(5, 'Building tables…');
    let deferred = false;
    try {
      const totalWidth = activeCols.reduce((a, c) => a + c.width, 0);
      const landscape = orientPref === 'landscape' || (orientPref === 'auto' && (totalWidth > 200 || activeCols.length > 6));
      const doc = new root.jspdf.jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });

      const headerBottomY = drawHeader(doc, titleText, ctx);
      setProgress(20, 'Header ready');

      let photoCache = {};
      if (includePhotos) {
        setProgress(25, 'Fetching photos…');
        photoCache = await prefetchPhotos(ctx.items, quality);
      }
      setProgress(75, 'Rendering table…');
      drawTable(doc, ctx, activeCols, headerBottomY, photoCache, includePhotos);
      setProgress(92, 'Finalising…');
      drawFooters(doc);

      const fileBase = (titleText || 'tsh-report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tsh-report';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const fileName = `${fileBase}-${stamp}.pdf`;

      setProgress(100, 'Done');
      if (action === 'download') {
        doc.save(fileName);
        setProgress(100, 'Downloaded — closing…');
        deferred = true;
        setTimeout(close, 1100);
      } else {
        const blob = doc.output('blob');
        const url = URL.createObjectURL(blob);
        const w = window.open(url, '_blank');
        if (!w) {
          doc.save(fileName);
          setProgress(100, 'Popup blocked — downloaded instead');
          deferred = true;
          setTimeout(close, 1500);
        } else {
          setProgress(100, 'Preview opened in new tab');
          deferred = true;
          setTimeout(() => { running = false; setBusy(false); }, 1500);
        }
      }
      lastBlob = doc.output('datauristring').split(',')[1] || null;
      // Fire-and-forget: store a copy server-side when the user explicitly
      // downloads. Failures are swallowed (logged only) so the local file
      // experience is unaffected.
      if (action === 'download') maybeCommitBackup(lastBlob, ctx, fileName);
    } catch (e) {
      console.error('TSH_REPORT generate failed:', e);
      toast('Report failed: ' + (e && e.message ? e.message : e), 'danger');
    } finally {
      if (!deferred) { running = false; setBusy(false); }
    }
  }

  function drawHeader(doc, titleText, ctx) {
    const pageW = doc.internal.pageSize.getWidth();
    doc.setFillColor(15, 23, 42); doc.rect(0, 0, pageW, 16, 'F');
    doc.setTextColor(252, 211, 77); doc.setFontSize(8); doc.setFont('helvetica', 'bold');
    doc.text('THE ADDRESS · SOCIETY HELP DESK', 14, 6.5);
    doc.setTextColor(255, 255, 255); doc.setFontSize(13);
    doc.text(titleText, 14, 13);

    const nowStr = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
    const who = (root.Auth && root.Auth.email && root.Auth.email()) || '';
    const parts = [`Generated: ${nowStr}`];
    if (who) parts.push(`By: ${who}`);
    parts.push(`Items: ${ctx.items.length}`);
    if (ctx.filtersAppliedSummary) parts.push('Filters: ' + ctx.filtersAppliedSummary);
    doc.setTextColor(71, 85, 105); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text(parts.join('  —  '), 14, 21, { maxWidth: pageW - 28 });

    // Soft divider
    doc.setDrawColor(226, 232, 240); doc.line(14, 24, pageW - 14, 24);
    return 28;
  }

  function drawTable(doc, ctx, activeCols, startY, photoCache, includePhotos) {
    const head = [activeCols.map((c) => c.label)];
    const body = ctx.items.map((i) => activeCols.map((c) => String(c.read(i) || '')));

    const photoColW = INLINE_THUMB.perRowCap * INLINE_THUMB.w +
                      (INLINE_THUMB.perRowCap - 1) * INLINE_THUMB.gap +
                      2 * INLINE_THUMB.pad;
    const columnStyles = {};
    activeCols.forEach((c, idx) => {
      if (c.key === 'photos') {
        columnStyles[idx] = {
          cellWidth: photoColW,
          minCellHeight: INLINE_THUMB.h + 2 * INLINE_THUMB.pad,
          halign: 'left', valign: 'top',
        };
      }
    });

    doc.autoTable({
      head, body, startY,
      theme: 'grid',
      margin: { left: 10, right: 10 },
      styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [30, 41, 59], textColor: [252, 211, 77], fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles,
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const col = activeCols[data.column.index];
        if (!col) return;
        if (col.key === 'severity') {
          const v = String(data.cell.raw || '').toUpperCase();
          const rgb = SEV_COLOR[v];
          if (rgb) { data.cell.styles.textColor = rgb; data.cell.styles.fontStyle = 'bold'; }
        }
        if (col.key === 'status') {
          const v = String(data.cell.raw || '').toLowerCase();
          if (/resolved/.test(v)) data.cell.styles.textColor = [22, 163, 74];
          else if (/rejected|breach/.test(v)) data.cell.styles.textColor = [220, 38, 38];
          else if (/progress|assigned|triaging/.test(v)) data.cell.styles.textColor = [37, 99, 235];
        }
        if (col.key === 'photos') {
          const links = String(data.cell.raw || '').split('|').filter(Boolean);
          data.cell.text = [''];
          data.cell._photoLinks = links;
          if (links.length && includePhotos) {
            const perRow = INLINE_THUMB.perRowCap;
            const rows = Math.ceil(links.length / perRow);
            const needed = rows * INLINE_THUMB.h + (rows - 1) * INLINE_THUMB.gap + 2 * INLINE_THUMB.pad;
            if (needed > (data.cell.styles.minCellHeight || 0)) data.cell.styles.minCellHeight = needed;
          }
        }
      },
      didDrawCell: (data) => {
        if (data.section !== 'body') return;
        const col = activeCols[data.column.index];
        if (!col || col.key !== 'photos' || !includePhotos) return;
        const links = data.cell._photoLinks || String(data.cell.raw || '').split('|').filter(Boolean);
        if (!links.length) return;
        const { x: cellX, y: cellY, width: cellW } = data.cell;
        const perRow = Math.max(1, Math.min(
          INLINE_THUMB.perRowCap,
          Math.floor((cellW - 2 * INLINE_THUMB.pad + INLINE_THUMB.gap) / (INLINE_THUMB.w + INLINE_THUMB.gap)),
        ));
        links.forEach((link, idx) => {
          const r = Math.floor(idx / perRow);
          const c = idx % perRow;
          const x = cellX + INLINE_THUMB.pad + c * (INLINE_THUMB.w + INLINE_THUMB.gap);
          const y = cellY + INLINE_THUMB.pad + r * (INLINE_THUMB.h + INLINE_THUMB.gap);
          const entry = photoCache[link];
          if (entry && entry.dataUrl) {
            try { doc.addImage(entry.dataUrl, entry.format || 'JPEG', x, y, INLINE_THUMB.w, INLINE_THUMB.h, undefined, 'FAST'); }
            catch (_e) { drawMissing(doc, x, y); }
          } else {
            drawMissing(doc, x, y);
          }
        });
      },
    });
  }

  function drawMissing(doc, x, y) {
    doc.setDrawColor(203, 213, 225); doc.setFillColor(241, 245, 249);
    doc.rect(x, y, INLINE_THUMB.w, INLINE_THUMB.h, 'FD');
    doc.setTextColor(148, 163, 184); doc.setFont('helvetica', 'italic'); doc.setFontSize(6);
    doc.text('no photo', x + INLINE_THUMB.w / 2, y + INLINE_THUMB.h / 2, { align: 'center', baseline: 'middle' });
  }

  function drawFooters(doc) {
    const pages = doc.internal.getNumberOfPages();
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(8); doc.setTextColor(148, 163, 184);
      doc.text('The Address · Society Help Desk', 14, pageH - 6);
      doc.text(`Page ${p} / ${pages}`, pageW - 14, pageH - 6, { align: 'right' });
    }
  }

  // ---------------------------------------------------------------- photos

  // Items can arrive in two shapes depending on which endpoint sourced
  // them: the public daily-board endpoint returns `photoUrls` (string[]),
  // and the privileged `/issues` endpoint returns `photos` (string[]).
  // Accept either so the same wizard works for residents and managers.
  function readPhotoUrls(i) {
    if (Array.isArray(i && i.photoUrls)) return i.photoUrls;
    if (Array.isArray(i && i.photos))    return i.photos;
    return [];
  }

  async function prefetchPhotos(items, quality) {
    const unique = new Set();
    items.forEach((i) => readPhotoUrls(i).forEach((u) => { if (u) unique.add(u); }));
    const cache = {};
    const list = Array.from(unique);
    let done = 0;
    await Promise.all(list.map(async (url) => {
      try {
        cache[url] = await fetchAndResize(url, quality);
      } catch (e) {
        cache[url] = null;
      } finally {
        done++;
        setProgress(25 + Math.round((done / Math.max(1, list.length)) * 45), `Fetching photos ${done}/${list.length}`);
      }
    }));
    return cache;
  }

  function fetchAndResize(url, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const max = quality.maxDim;
          const ratio = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * ratio));
          const h = Math.max(1, Math.round(img.naturalHeight * ratio));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve({ dataUrl: cv.toDataURL('image/jpeg', quality.jpegQ), format: 'JPEG' });
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('image load failed: ' + url));
      img.src = url;
    });
  }

  // ---------------------------------------------------------------- backup

  function maybeCommitBackup(b64, ctx, fileName) {
    if (!b64) return;
    if (!root.Api || !root.Api.post) return;
    const token = root.Auth && root.Auth.token && root.Auth.token();
    if (!token) return;
    const email = (root.Auth.email && root.Auth.email()) || '';
    const snapshot = {
      generatedAt: new Date().toISOString(),
      generatedBy: email,
      title: document.getElementById('tshPdfReportTitle').value || ctx.title,
      source: ctx.source,
      itemCount: ctx.items.length,
      items: ctx.items,
    };
    root.Api.post('/reports/backup', { snapshot, pdfB64: b64, fileName, source: ctx.source })
      .then(() => { /* silent — backups are best-effort */ })
      .catch((e) => console.warn('backup save skipped:', e && e.message));
  }

  root.TSH_REPORT = { bind, open, close, isBound };
})(window);

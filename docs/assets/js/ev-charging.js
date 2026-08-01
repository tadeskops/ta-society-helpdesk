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
      });
    });
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

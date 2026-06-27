// docs/assets/js/visitors.js
// Visitor counter shown in the footer. Reads /metrics/visit on every
// load and POSTs an increment at most once per UTC day per browser
// (gated by localStorage). All errors are swallowed — the counter is
// decorative and must never block the page.
(function (root) {
  'use strict';

  const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const KEY = 'tsh_visited_' + TODAY;

  async function render() {
    const wrap  = document.querySelector('[data-tsh-visitors]');
    const numEl = document.querySelector('[data-tsh-visitors-count]');
    if (!wrap || !numEl || !root.Api) return;

    let data = null;
    const alreadyToday = (() => {
      try { return !!localStorage.getItem(KEY); } catch (_e) { return false; }
    })();

    try {
      if (alreadyToday) {
        data = await root.Api.get('/metrics/visit');
      } else {
        try {
          data = await root.Api.post('/metrics/visit');
          try { localStorage.setItem(KEY, '1'); } catch (_e) { /* private mode */ }
        } catch (_e) {
          // Increment failed (transient GitHub error, etc.) — fall back to
          // a plain read so we still display *something*.
          data = await root.Api.get('/metrics/visit');
        }
      }
    } catch (_e) {
      return; // total network failure; leave footer chip hidden
    }

    if (data && typeof data.total === 'number') {
      numEl.textContent = data.total.toLocaleString();
      wrap.hidden = false;
    }
  }

  // Wait for the footer partial to be mounted before trying to render.
  function mount() {
    let tries = 0;
    (function tick() {
      if (document.querySelector('[data-tsh-visitors]')) return render();
      if (++tries > 30) return;  // ~3s ceiling
      setTimeout(tick, 100);
    })();
  }

  root.Visitors = { mount };
  // Auto-mount once the DOM is ready so pages don't need to wire us up.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})(window);

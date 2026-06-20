// docs/assets/js/partials.js
// Tiny include helper. Pages call `await Partials.mount()` after
// loading the script. Every element matching [data-include="<name>"]
// is replaced by the contents of partials/<name>.html.
//
// Why a runtime include: we don't have a build step on Pages and we
// want one HTML file per page. Fetch is fast enough for a few KB.
(function (root) {
  'use strict';
  const cache = new Map();
  const VERSION = 'v=2';   // bump when partials change so browsers refresh

  async function load(name) {
    if (cache.has(name)) return cache.get(name);
    const p = fetch(`./partials/${name}.html?${VERSION}`, { credentials: 'omit' })
      .then((r) => {
        if (!r.ok) throw new Error(`partial ${name}: HTTP ${r.status}`);
        return r.text();
      });
    cache.set(name, p);
    return p;
  }

  async function mount(scope) {
    const root = scope || document;
    const nodes = root.querySelectorAll('[data-include]');
    await Promise.all(Array.from(nodes).map(async (el) => {
      const name = el.getAttribute('data-include');
      try {
        el.innerHTML = await load(name);
      } catch (err) {
        el.innerHTML = `<div class="tsh-error">Failed to load partial "${name}"</div>`;
        console.error(err);
      }
    }));
  }

  root.Partials = { load, mount };
})(window);

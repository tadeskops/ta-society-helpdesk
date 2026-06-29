// docs/assets/js/partials.js
// Tiny include helper. Pages call `await Partials.mount()` after
// loading the script. Every element matching [data-include="<name>"]
// is replaced by the contents of partials/<name>.html.
//
// Why a runtime include: we don't have a build step on Pages and we
// want one HTML file per page. Fetch is fast enough for a few KB.
//
// Note on <script> tags in partials: nodes assigned via innerHTML are
// inert per HTML spec. We post-process each mounted scope and clone
// every <script> as a fresh element so the browser executes it.
(function (root) {
  'use strict';
  const cache = new Map();
  const VERSION = 'v=10';  // bump when partials change so browsers refresh

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

  function activateScripts(scope) {
    const scripts = scope.querySelectorAll('script');
    scripts.forEach((old) => {
      const fresh = document.createElement('script');
      for (const attr of old.attributes) fresh.setAttribute(attr.name, attr.value);
      if (old.textContent) fresh.textContent = old.textContent;
      old.parentNode.replaceChild(fresh, old);
    });
  }

  async function mount(scope) {
    const rootNode = scope || document;
    const nodes = rootNode.querySelectorAll('[data-include]');
    await Promise.all(Array.from(nodes).map(async (el) => {
      const name = el.getAttribute('data-include');
      try {
        el.innerHTML = await load(name);
        activateScripts(el);
      } catch (err) {
        el.innerHTML = `<div class="tsh-error">Failed to load partial "${name}"</div>`;
        console.error(err);
      }
    }));
  }

  root.Partials = { load, mount };
})(window);

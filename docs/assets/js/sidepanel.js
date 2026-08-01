// docs/assets/js/sidepanel.js
// -----------------------------------------------------------------------------
// UI.SidePanel — reusable right-side drawer / bottom sheet.
//
// A generic slide-in panel that any feature page can use for edit forms,
// detail views, or ancillary content without hand-rolling its own CSS.
//
// Behaviour:
//   • Slides in from the right on desktop (≥ 641 px viewport).
//   • Becomes a bottom sheet on phones (≤ 640 px) so thumbs can reach the
//     Save button.
//   • Backdrop click, Escape key, and any child element carrying
//     `data-sidepanel-close` (or the built-in header × button) all close it.
//   • Focus is moved into the panel on open and restored to the previously
//     focused element on close.
//   • Only one panel is open at a time — calling open() while one is already
//     open closes the previous one first.
//   • CSS is injected once on first use so pages only need to load this file.
//
// Usage:
//   const ctrl = UI.SidePanel.open({
//     title: 'Edit vehicle',
//     icon:  'fa-pen-to-square',
//     subtitle: 'Flat A0304 · MH11JJ0234',
//     body:  formHtmlOrElement,          // HTML string, HTMLElement, or (root) => void
//     size:  'md',                       // 'sm' | 'md' | 'lg' | number(px)
//     actions: [
//       { label: 'Save',   kind: 'primary', id: 'save',
//         onClick: (ctx) => ctx.setBusy(true).then(...).finally(() => ctx.setBusy(false)) },
//       { label: 'Cancel', kind: 'ghost',   close: true },
//     ],
//     onOpen:  (ctrl) => { /* wire up form */ },
//     onClose: () => { /* cleanup */ },
//   });
//   // Later: ctrl.close(); ctrl.setBusy(true); ctrl.getForm();
//
// Exposes:
//   window.UI.SidePanel.open(opts) -> controller
//   window.UI.SidePanel.close()
//   window.UI.SidePanel.isOpen()
//
// -----------------------------------------------------------------------------
(function (root) {
  'use strict';

  const CSS_ID = 'tsh-sidepanel-css';
  const CSS = `
  .tsh-sidepanel { position: fixed; inset: 0; z-index: 60; }
  .tsh-sidepanel[hidden] { display: none; }
  .tsh-sidepanel-backdrop { position: absolute; inset: 0; background: rgba(15, 20, 30, .45); }
  .tsh-sidepanel-panel {
    position: absolute; top: 0; right: 0; height: 100%;
    width: min(var(--tsh-sp-width, 420px), 100%);
    background: var(--tsh-surface, #fff); color: var(--tsh-text, #223);
    box-shadow: -8px 0 28px rgba(0, 0, 0, .18);
    display: flex; flex-direction: column;
    animation: tsh-sp-slide-in .18s ease-out;
    overflow: hidden;
  }
  @keyframes tsh-sp-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
  .tsh-sidepanel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1rem 1.2rem; border-bottom: 1px solid var(--tsh-border, #e2e5ee);
    position: sticky; top: 0; background: var(--tsh-surface, #fff); z-index: 1;
  }
  .tsh-sidepanel-title { display: flex; align-items: center; gap: .5rem; min-width: 0; }
  .tsh-sidepanel-title h3 { margin: 0; font-size: 1.05rem; letter-spacing: .02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tsh-sidepanel-sub { padding: .3rem 1.2rem 0; color: var(--tsh-muted, #667); font-size: .88em; }
  .tsh-sidepanel-body { flex: 1; overflow-y: auto; padding: 1rem 1.2rem; }
  .tsh-sidepanel-body > form { display: flex; flex-direction: column; gap: 1rem; }
  .tsh-sidepanel-body .tsh-field { display: flex; flex-direction: column; gap: .25rem; }
  .tsh-sidepanel-body label { font-weight: 600; font-size: .88em; }
  .tsh-sidepanel-body input, .tsh-sidepanel-body select, .tsh-sidepanel-body textarea {
    width: 100%; box-sizing: border-box;
  }
  .tsh-sidepanel-actions {
    display: flex; gap: .5rem;
    padding: .8rem 1.2rem;
    border-top: 1px solid var(--tsh-border, #e2e5ee);
    background: var(--tsh-surface, #fff);
  }
  .tsh-sidepanel-actions button { flex: 1; }
  .tsh-sidepanel[data-busy="1"] .tsh-sidepanel-panel { pointer-events: none; opacity: .85; }

  @media (max-width: 640px) {
    .tsh-sidepanel-panel {
      width: 100%; height: auto; max-height: 92vh;
      top: auto; bottom: 0;
      border-radius: 16px 16px 0 0;
      animation: tsh-sp-slide-up .2s ease-out;
    }
    @keyframes tsh-sp-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
  }
  @media (prefers-reduced-motion: reduce) {
    .tsh-sidepanel-panel { animation: none; }
  }
  `;

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const SIZE_MAP = { sm: 340, md: 420, lg: 560, xl: 720 };
  function resolveWidth(size) {
    if (typeof size === 'number' && size > 0) return size + 'px';
    return (SIZE_MAP[size] || SIZE_MAP.md) + 'px';
  }

  // Track the currently open panel so open() can close the previous one and
  // isOpen() can report status without the caller holding the controller.
  let current = null;

  function close() {
    if (!current) return;
    const ctrl = current;
    current = null;

    const { root, prevFocus, opts } = ctrl;
    // Detach handlers before ripping the DOM out.
    document.removeEventListener('keydown', ctrl._onKey, true);
    root.remove();
    document.body.classList.remove('tsh-sidepanel-open');

    if (prevFocus && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch (_e) { /* element vanished */ }
    }
    if (typeof opts.onClose === 'function') {
      try { opts.onClose(); } catch (err) {
        // Never let a broken onClose handler leave the panel stuck open.
        try { console.error('[UI.SidePanel] onClose error', err); } catch (_e) { /* ignore */ }
      }
    }
  }

  function isOpen() { return current !== null; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) return '';
    const btns = actions.map((a, i) => {
      const kind = a.kind === 'danger' ? 'tsh-btn-danger'
                 : a.kind === 'ghost'  ? 'tsh-btn-ghost'
                 : 'tsh-btn-primary';
      const type = a.type || (a.close ? 'button' : 'button');
      const idAttr = a.id ? ' data-action-id="' + esc(a.id) + '"' : ' data-action-id="' + i + '"';
      const closeAttr = a.close ? ' data-sidepanel-close' : '';
      const iconHtml = a.icon ? '<i class="fas ' + esc(a.icon) + '"></i> ' : '';
      return '<button type="' + esc(type) + '" class="tsh-btn ' + kind + '"' + idAttr + closeAttr + '>' +
             iconHtml + esc(a.label || 'OK') + '</button>';
    }).join('');
    return '<div class="tsh-sidepanel-actions">' + btns + '</div>';
  }

  function open(opts) {
    opts = opts || {};
    injectCss();
    // Only one panel at a time — close the previous one first so its
    // onClose runs before the new panel opens.
    if (current) close();

    const rootEl = document.createElement('div');
    rootEl.className = 'tsh-sidepanel';
    rootEl.setAttribute('role', 'presentation');
    rootEl.style.setProperty('--tsh-sp-width', resolveWidth(opts.size));

    const titleHtml =
      '<div class="tsh-sidepanel-title">' +
        (opts.icon ? '<i class="fas ' + esc(opts.icon) + ' gold-accent" aria-hidden="true"></i>' : '') +
        '<h3 id="tshSidepanelTitle">' + esc(opts.title || '') + '</h3>' +
      '</div>';

    rootEl.innerHTML =
      '<div class="tsh-sidepanel-backdrop" data-sidepanel-close aria-hidden="true"></div>' +
      '<div class="tsh-sidepanel-panel" role="dialog" aria-modal="true" aria-labelledby="tshSidepanelTitle"' +
        (opts.ariaLabel ? ' aria-label="' + esc(opts.ariaLabel) + '"' : '') + '>' +
        '<header class="tsh-sidepanel-head">' +
          titleHtml +
          '<button type="button" class="tsh-btn tsh-btn-ghost tsh-btn-icon" data-sidepanel-close aria-label="Close">' +
            '<i class="fas fa-xmark"></i>' +
          '</button>' +
        '</header>' +
        (opts.subtitle ? '<p class="tsh-sidepanel-sub">' + esc(opts.subtitle) + '</p>' : '') +
        '<div class="tsh-sidepanel-body"></div>' +
        renderActions(opts.actions) +
      '</div>';

    const panelEl   = rootEl.querySelector('.tsh-sidepanel-panel');
    const bodyEl    = rootEl.querySelector('.tsh-sidepanel-body');
    const actionsEl = rootEl.querySelector('.tsh-sidepanel-actions');

    // Inject body content — accepts HTML string, HTMLElement, or a render fn.
    const body = opts.body;
    if (typeof body === 'function') {
      try { body(bodyEl); } catch (err) { try { console.error('[UI.SidePanel] body renderer error', err); } catch (_e) { /* ignore */ } }
    } else if (body instanceof HTMLElement) {
      bodyEl.appendChild(body);
    } else if (typeof body === 'string') {
      bodyEl.innerHTML = body;
    }

    document.body.appendChild(rootEl);
    document.body.classList.add('tsh-sidepanel-open');

    // Controller object returned to the caller AND stored as `current`.
    const ctrl = {
      root: rootEl,
      panel: panelEl,
      body: bodyEl,
      actions: actionsEl,
      opts,
      prevFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      close,
      isOpen: () => current === ctrl,
      getForm: () => bodyEl.querySelector('form'),
      getRoot: () => rootEl,
      setTitle(t) { const h = rootEl.querySelector('#tshSidepanelTitle'); if (h) h.textContent = t == null ? '' : String(t); },
      setSubtitle(t) {
        let sub = rootEl.querySelector('.tsh-sidepanel-sub');
        if (!t) { if (sub) sub.remove(); return; }
        if (!sub) {
          sub = document.createElement('p');
          sub.className = 'tsh-sidepanel-sub';
          rootEl.querySelector('.tsh-sidepanel-head').after(sub);
        }
        sub.textContent = String(t);
      },
      setBody(next) {
        bodyEl.innerHTML = '';
        if (typeof next === 'function') next(bodyEl);
        else if (next instanceof HTMLElement) bodyEl.appendChild(next);
        else if (typeof next === 'string') bodyEl.innerHTML = next;
      },
      setBusy(on) {
        if (on) rootEl.setAttribute('data-busy', '1');
        else rootEl.removeAttribute('data-busy');
      },
    };

    // Close on Esc unless the caller opts out.
    const closeOnEscape = opts.closeOnEscape !== false;
    ctrl._onKey = (e) => {
      if (!closeOnEscape) return;
      if (e.key === 'Escape' && current === ctrl) {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', ctrl._onKey, true);

    // Close on backdrop / any [data-sidepanel-close] child.
    rootEl.addEventListener('click', (e) => {
      const closer = e.target.closest('[data-sidepanel-close]');
      if (!closer) return;
      // Backdrop opt-out.
      if (closer.classList.contains('tsh-sidepanel-backdrop') && opts.closeOnBackdrop === false) return;
      close();
    });

    // Wire per-action click handlers.
    if (actionsEl && Array.isArray(opts.actions)) {
      actionsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action-id]');
        if (!btn) return;
        const id = btn.getAttribute('data-action-id');
        const action = opts.actions.find((a, i) =>
          (a.id != null ? a.id === id : String(i) === id));
        if (!action || typeof action.onClick !== 'function') return;
        // Give handlers a small context so they can drive the panel without
        // holding onto the controller in a closure.
        try {
          const ret = action.onClick({
            button: btn,
            controller: ctrl,
            form: ctrl.getForm(),
            close,
            setBusy: (on) => ctrl.setBusy(on),
          });
          // If the handler returns a promise, mark busy while it settles.
          if (ret && typeof ret.then === 'function') {
            ctrl.setBusy(true);
            ret.finally(() => ctrl.setBusy(false));
          }
        } catch (err) {
          try { console.error('[UI.SidePanel] action handler error', err); } catch (_e) { /* ignore */ }
        }
      });
    }

    current = ctrl;

    // Move focus into the panel on the next frame so the browser has time
    // to render the animation start state. Prefer the first form control,
    // then the first action button, then the panel itself.
    requestAnimationFrame(() => {
      const target = bodyEl.querySelector('input, select, textarea, button')
        || (actionsEl && actionsEl.querySelector('button'))
        || panelEl;
      if (target && typeof target.focus === 'function') {
        try { target.focus({ preventScroll: true }); } catch (_e) { target.focus(); }
      }
    });

    if (typeof opts.onOpen === 'function') {
      try { opts.onOpen(ctrl); } catch (err) {
        try { console.error('[UI.SidePanel] onOpen error', err); } catch (_e) { /* ignore */ }
      }
    }

    return ctrl;
  }

  const api = { open, close, isOpen };

  // Attach to window.UI if it exists, otherwise create it. Also expose
  // `UI.Drawer` as an alias for callers who prefer that terminology.
  root.UI = root.UI || {};
  root.UI.SidePanel = api;
  root.UI.Drawer = api;
})(window);

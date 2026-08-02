/* eslint-env browser */
// TSH — Sunarth Support widget (Phase 6b).
// Reusable floating "Chat" launcher + contact modal.
//
// Usage:
//   <link rel="stylesheet" href="./assets/css/sunarth-support.css" />
//   <script src="./assets/js/sunarth-support.js"></script>
//   SunarthSupport.mount({ fab: true });                // floating button
//   SunarthSupport.mount({ selector: '#myPill' });      // wire an existing button
//   SunarthSupport.open();                              // open modal directly
//
// Contact facts (from user + config/site.json.evCharging.provider):
//   - Address:  Cello Platina 202, F.C. Road, Pune 411005
//   - Phones:   +91-77977 98887, +91-77977 98881
//   - WhatsApp: +91-77977 98881
//   - Email:    info@sunarth.com
//   - Website:  https://www.sunarth.com
//   - SunArth AI chatbot lives on their homepage — we open it in a new tab.
//
// Note on invoking the SunArth AI widget "from our website": Sunarth ships
// their chatbot as a first-party overlay on sunarth.com. Modern browsers
// block third-party iframe embedding of most commercial sites via
// X-Frame-Options/CSP, and we cannot ship their private embed script. The
// pragmatic + honest UX is a branded launcher that opens sunarth.com in a
// new tab (where the SunArth AI bubble greets the visitor immediately),
// plus a rich contact fallback with WhatsApp, call, email, and address so
// residents can reach a human even when their site is unavailable.
(function () {
  'use strict';

  var CONTACT = {
    name:     'SunArth Technologies',
    address:  'Cello Platina 202, F.C. Road, Pune 411005',
    phones:   ['+91-77977-98887', '+91-77977-98881'],
    whatsapp: '917797798881',           // wa.me format: country code + national number, no + or spaces
    email:    'info@sunarth.com',
    website:  'https://www.sunarth.com',
    androidUrl: 'https://play.google.com/store/apps/details?id=com.sunarthev&hl=en-US',
    iosUrl:     'https://apps.apple.com/in/app/sunarth-ev-charging/id6736524617',
  };

  var mounted = false;
  var overlay = null;

  /**
   * Override selected CONTACT fields at runtime — used by pages that
   * pull the provider block from GET /ev/config so the modal reflects
   * whatever an editor changed in Settings without a code deploy.
   */
  function configure (overrides) {
    if (!overrides) return;
    ['androidUrl', 'iosUrl', 'website', 'email', 'whatsapp', 'address', 'name'].forEach(function (k) {
      if (typeof overrides[k] === 'string' && overrides[k]) CONTACT[k] = overrides[k];
    });
    // Reset the cached overlay so the next open() picks up the new links.
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
      overlay = null;
    }
  }

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class')      node.className = attrs[k];
        else if (k === 'html')  node.innerHTML = attrs[k];
        else if (k === 'text')  node.textContent = attrs[k];
        else if (k === 'style') node.setAttribute('style', attrs[k]);
        else if (k in node)     node[k] = attrs[k];
        else                    node.setAttribute(k, attrs[k]);
      });
    }
    (kids || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function ensureOverlay() {
    if (overlay) return overlay;

    var closeBtn = el('button', {
      type: 'button',
      class: 'tsh-sunarth-close',
      'aria-label': 'Close SunArth support',
      html: '<i class="fas fa-xmark" aria-hidden="true"></i>',
    });
    closeBtn.addEventListener('click', close);

    var brand = el('div', { class: 'tsh-sunarth-brand' }, [
      el('span', { class: 'tsh-sunarth-brand-mark', html: '<i class="fas fa-bolt"></i>' }),
      el('div', {}, [
        el('h2', { text: 'SunArth Support' }),
        el('p',  { text: 'EV charger vendor · Pune' }),
      ]),
    ]);

    var head = el('div', { class: 'tsh-sunarth-card-head' }, [ brand, closeBtn ]);

    var primary = el('a', {
      class: 'tsh-sunarth-primary',
      href: CONTACT.website,
      target: '_blank',
      rel: 'noopener noreferrer',
      html:
        '<span class="tsh-sunarth-primary-icon"><i class="fas fa-comments"></i></span>' +
        '<span class="tsh-sunarth-primary-text">' +
          '<strong>Chat with SunArth AI</strong>' +
          '<small>Opens sunarth.com in a new tab — the AI consultant greets you on arrival</small>' +
        '</span>',
    });

    // Get-the-app pills — only rendered when at least one store URL is set.
    var appRow = null;
    if (CONTACT.iosUrl || CONTACT.androidUrl) {
      appRow = el('div', { class: 'tsh-sunarth-apps' }, [
        el('p', { class: 'tsh-sunarth-apps-label', text: 'Get the SunArth EV Charging app' }),
      ]);
      var appBtns = el('div', { class: 'tsh-sunarth-apps-row' });
      if (CONTACT.iosUrl) {
        appBtns.appendChild(el('a', {
          class: 'tsh-sunarth-app tsh-sunarth-app-ios',
          href: CONTACT.iosUrl, target: '_blank', rel: 'noopener noreferrer',
          html: '<i class="fab fa-apple"></i> Get App',
          'aria-label': 'Download SunArth EV Charging on the App Store',
        }));
      }
      if (CONTACT.androidUrl) {
        appBtns.appendChild(el('a', {
          class: 'tsh-sunarth-app tsh-sunarth-app-android',
          href: CONTACT.androidUrl, target: '_blank', rel: 'noopener noreferrer',
          html: '<i class="fab fa-google-play"></i> Get App',
          'aria-label': 'Download SunArth EV Charging on Google Play',
        }));
      }
      appRow.appendChild(appBtns);
    }

    var actions = el('div', { class: 'tsh-sunarth-actions' }, [
      el('a', {
        class: 'tsh-sunarth-action tsh-sunarth-action-whatsapp',
        href: 'https://wa.me/' + CONTACT.whatsapp + '?text=' + encodeURIComponent('Hi, I have a SunArth EV charger query from The Address society.'),
        target: '_blank', rel: 'noopener noreferrer',
        html:
          '<i class="fab fa-whatsapp"></i>' +
          '<span class="tsh-sunarth-action-text"><strong>WhatsApp</strong><small>+91-77977-98881</small></span>',
      }),
      el('a', {
        class: 'tsh-sunarth-action tsh-sunarth-action-call',
        href: 'tel:+917797798887',
        html:
          '<i class="fas fa-phone"></i>' +
          '<span class="tsh-sunarth-action-text"><strong>Call support</strong><small>+91-77977-98887</small></span>',
      }),
      el('a', {
        class: 'tsh-sunarth-action tsh-sunarth-action-call',
        href: 'tel:+917797798881',
        html:
          '<i class="fas fa-phone"></i>' +
          '<span class="tsh-sunarth-action-text"><strong>Alt line</strong><small>+91-77977-98881</small></span>',
      }),
      el('a', {
        class: 'tsh-sunarth-action tsh-sunarth-action-email',
        href: 'mailto:' + CONTACT.email + '?subject=' + encodeURIComponent('EV Charger query — The Address society'),
        html:
          '<i class="fas fa-envelope"></i>' +
          '<span class="tsh-sunarth-action-text"><strong>Email</strong><small>info@sunarth.com</small></span>',
      }),
    ]);

    var siteLink = el('a', {
      class: 'tsh-sunarth-action tsh-sunarth-action-site',
      href: CONTACT.website, target: '_blank', rel: 'noopener noreferrer',
      style: 'grid-column: 1 / -1;',
      html:
        '<i class="fas fa-globe"></i>' +
        '<span class="tsh-sunarth-action-text"><strong>Open sunarth.com</strong><small>Technical spec sheets, app downloads &amp; the AI chatbot</small></span>',
    });
    actions.appendChild(siteLink);

    var addr = el('div', { class: 'tsh-sunarth-address' }, [
      el('i', { class: 'fas fa-location-dot' }),
      el('div', { html:
        '<strong>' + CONTACT.name + '</strong>' +
        CONTACT.address,
      }),
    ]);

    var footnote = el('p', { class: 'tsh-sunarth-footnote', html:
      'Need something the app can\'t answer? WhatsApp is fastest. For billing disputes or safety issues, please <em>also</em> file a ticket in the EV Support tab so the society has a record.',
    });

    var body = el('div', { class: 'tsh-sunarth-body' }, [ primary, appRow, actions, addr, footnote ]);

    var card = el('div', {
      class: 'tsh-sunarth-card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tshSunarthTitle',
    }, [ head, body ]);
    var titleId = card.querySelector('h2');
    if (titleId) titleId.id = 'tshSunarthTitle';

    overlay = el('div', { class: 'tsh-sunarth-overlay', hidden: true }, [ card ]);
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) close();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function open () {
    ensureOverlay().hidden = false;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onEsc);
  }
  function close () {
    if (overlay) overlay.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onEsc);
  }
  function onEsc (ev) { if (ev.key === 'Escape') close(); }

  function makeFab () {
    var btn = el('button', {
      type: 'button',
      class: 'tsh-sunarth-fab',
      'aria-label': 'Open SunArth support',
      html:
        '<i class="tsh-sunarth-fab-icon fas fa-comments" aria-hidden="true"></i>' +
        '<span class="tsh-sunarth-fab-label">SunArth Chat</span>',
    });
    btn.addEventListener('click', open);
    return btn;
  }

  function mount (opts) {
    opts = opts || {};
    // Wire an existing element by selector.
    if (opts.selector) {
      var host = document.querySelector(opts.selector);
      if (host) host.addEventListener('click', function (ev) { ev.preventDefault(); open(); });
    }
    // Inject the floating chat button.
    if (opts.fab && !mounted) {
      mounted = true;
      var fab = makeFab();
      document.body.appendChild(fab);
    }
  }

  window.SunarthSupport = { mount: mount, open: open, close: close, configure: configure, CONTACT: CONTACT };
}());

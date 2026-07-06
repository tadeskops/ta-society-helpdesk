// docs/assets/js/home-manager.js
// Renders a compact "Society Manager" quick-call card on the landing
// page. Reads /directory and shows every emergency contact flagged
// with pinToHome=true (falls back to any entry whose role matches
// "society manager" so existing installs get the card without editing
// the directory first). Phone numbers get tap-to-call and WhatsApp
// affordances that work directly on mobile.
//
// Editing lives on the directory page: staff (MANAGER+) see an Edit
// link that jumps straight to the Emergency Contacts tab.
(function (root) {
  'use strict';

  const HomeManager = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function normDigits(phone) {
    const digits = String(phone || '').replace(/\D+/g, '');
    if (digits.length < 10) return '';
    return digits.length === 10 ? '91' + digits : digits;
  }

  function telHref(phone) {
    if (!phone) return '';
    return 'tel:' + String(phone).replace(/\s+/g, '');
  }

  function waHref(phone) {
    const d = normDigits(phone);
    return d ? 'https://wa.me/' + d : '';
  }

  function getPhones(row) {
    if (!row) return [];
    if (Array.isArray(row.phones) && row.phones.length) {
      return row.phones.map((p) => String(p || '').trim()).filter(Boolean);
    }
    if (row.phone) return [String(row.phone).trim()].filter(Boolean);
    return [];
  }

  function pickPinned(emergency) {
    const list = Array.isArray(emergency) ? emergency : [];
    const pinned = list.filter((r) => r && r.pinToHome === true);
    if (pinned.length) return pinned;
    // Fallback for installs that haven't set pinToHome yet: any entry
    // whose role reads like "Society Manager" surfaces automatically.
    return list.filter((r) => r && /society\s*manager/i.test(String(r.role || '')));
  }

  function renderCard(row, isStaff) {
    const phones = getPhones(row);
    const primary = phones[0] || '';
    const tel = telHref(primary);
    const wa = waHref(primary);

    const roleLabel = row.role ? esc(row.role) : 'Society Contact';
    const nameLine = esc(row.name || 'Society Manager');
    const noteLine = row.notes ? esc(row.notes) : (row.address ? esc(row.address) : '');
    const emailLine = row.email ? esc(row.email) : '';

    const phoneRows = phones.slice(0, 2).map((p) => {
      const t = telHref(p);
      const w = waHref(p);
      return (
        '<div class="tsh-home-mgr-phone">' +
          '<i class="fas fa-phone" aria-hidden="true"></i>' +
          '<span class="tsh-home-mgr-num">' + esc(p) + '</span>' +
          (t ? '<a class="tsh-home-mgr-btn tsh-home-mgr-btn-call" href="' + esc(t) + '" aria-label="Call ' + esc(p) + '" title="Call"><i class="fas fa-phone-volume" aria-hidden="true"></i><span>Call</span></a>' : '') +
          (w ? '<a class="tsh-home-mgr-btn tsh-home-mgr-btn-wa" href="' + esc(w) + '" target="_blank" rel="noopener" aria-label="WhatsApp ' + esc(p) + '" title="WhatsApp"><i class="fab fa-whatsapp" aria-hidden="true"></i><span>WhatsApp</span></a>' : '') +
        '</div>'
      );
    }).join('');

    const emailRow = emailLine
      ? '<a class="tsh-home-mgr-email" href="mailto:' + esc(emailLine) + '"><i class="fas fa-envelope" aria-hidden="true"></i> ' + esc(emailLine) + '</a>'
      : '';

    const editBtn = isStaff
      ? '<a class="tsh-home-mgr-edit" href="./directory.html#emergency" title="Edit in Directory"><i class="fas fa-pen" aria-hidden="true"></i> Edit</a>'
      : '';

    // Silence variables the linter thinks are unused: tel/wa read via primary.
    void tel; void wa;

    return (
      '<article class="tsh-home-mgr-card" data-mgr-id="' + esc(row.id || '') + '">' +
        '<header class="tsh-home-mgr-head">' +
          '<span class="tsh-home-mgr-avatar" aria-hidden="true"><i class="fas fa-user-tie"></i></span>' +
          '<div class="tsh-home-mgr-head-body">' +
            '<span class="tsh-home-mgr-pill">' + roleLabel + '</span>' +
            '<h3 class="tsh-home-mgr-name">' + nameLine + '</h3>' +
            (noteLine ? '<p class="tsh-home-mgr-note">' + noteLine + '</p>' : '') +
          '</div>' +
          editBtn +
        '</header>' +
        (phoneRows ? '<div class="tsh-home-mgr-phones">' + phoneRows + '</div>' : '') +
        emailRow +
      '</article>'
    );
  }

  async function isStaffViewer() {
    try {
      if (root.Flags && root.Flags.whoami) {
        const who = await root.Flags.whoami();
        return !!(who && root.Flags.isAtLeast && root.Flags.isAtLeast(who.primary, 'MANAGER'));
      }
    } catch (_e) { /* signed-out or offline */ }
    return false;
  }

  HomeManager.mount = async function mount(host) {
    if (!host) return;
    try {
      if (root.Flags && root.Flags.on && !root.Flags.on('FEATURE_DAILY_DIRECTORY')) return;
    } catch (_e) { /* Flags not ready, best-effort continue */ }

    let dir;
    try {
      const res = await root.Api.get('/directory');
      dir = (res && (res.data || res)) || {};
    } catch (_e) {
      return; // silently skip when signed-out visitors have no /directory access
    }

    const pinned = pickPinned(dir.emergency);
    if (!pinned.length) return;

    const staff = await isStaffViewer();

    host.innerHTML =
      '<div class="tsh-home-mgr-wrap">' +
        '<div class="tsh-home-mgr-list">' +
          pinned.map((r) => renderCard(r, staff)).join('') +
        '</div>' +
      '</div>';
    host.hidden = false;
  };

  root.HomeManager = HomeManager;
})(window);

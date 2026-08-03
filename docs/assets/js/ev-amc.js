/* eslint-env browser */
/* global Auth, Flags, Api, UI */
// TSH — EV AMC (Annual Maintenance Contract) editor register.
// Controller for the Phase 6b section on /docs/ev-admin.html. Editors
// use this to record the vendor AMC duration, coverage promises, the
// society's own responsibilities, upload signed documents, and log
// servicing visits. Spec: tsh_requirement.md §23.11.
//
// Auth: MANAGER+ (server enforces on /ev/admin/amc*).
// Flag gates: FEATURE_TSH_EV_CHARGING + FEATURE_TSH_EV_AMC.
(function () {
  'use strict';

  var state = {
    ready: false,
    amc: null,
    renewalDaysRemaining: null,
    storage: null,
    dirty: false,
  };

  function $ (sel) { return document.querySelector(sel); }
  function esc (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toast (msg, kind) {
    if (window.UI && typeof UI.toast === 'function') {
      UI.toast(msg, kind || 'info');
    } else {
      // Fallback for pages where UI is not yet mounted.
      console.log('[EvAmc] ' + msg);
    }
  }

  // ---------------------------------------------------------------------
  //  Rendering helpers
  // ---------------------------------------------------------------------

  function renderContract () {
    var c = state.amc.contract;
    $('#evAmcNumber').value          = c.number || '';
    $('#evAmcVendor').value          = c.vendor || '';
    $('#evAmcStart').value           = c.startDate || '';
    $('#evAmcEnd').value             = c.endDate || '';
    $('#evAmcReminderDays').value    = c.renewalReminderDays == null ? 45 : c.renewalReminderDays;
    $('#evAmcFee').value              = c.annualFee == null ? '' : c.annualFee;
    $('#evAmcCurrency').value         = c.currency || 'INR';
    $('#evAmcVendorPhone').value      = (c.vendorContact && c.vendorContact.phone)   || '';
    $('#evAmcVendorEmail').value      = (c.vendorContact && c.vendorContact.email)   || '';
    $('#evAmcVendorWebsite').value    = (c.vendorContact && c.vendorContact.website) || '';
    $('#evAmcVendorAddress').value    = (c.vendorContact && c.vendorContact.address) || '';
    $('#evAmcEmergency').value        = c.emergencyContact || '';
    $('#evAmcNotes').value            = c.notes || '';
    renderList('#evAmcCoverageList', c.coverage || [], 'coverage');
    renderList('#evAmcRespList',     c.societyResponsibilities || [], 'resp');
    renderRenewalChip();
    if (state.storage && state.storage.docsRepoNote) {
      $('#evAmcStorageNote').textContent = state.storage.docsRepoNote;
    }
  }

  function renderList (sel, items, kind) {
    var ul = $(sel);
    if (!items.length) {
      ul.innerHTML = '<li class="tsh-empty-inline">Nothing recorded yet.</li>';
      return;
    }
    ul.innerHTML = items.map(function (txt, idx) {
      return (
        '<li>' +
          '<span>' + esc(txt) + '</span>' +
          '<button type="button" class="tsh-btn tsh-btn-icon" data-list="' + kind + '" data-idx="' + idx + '" title="Remove">' +
            '<i class="fas fa-times"></i>' +
          '</button>' +
        '</li>'
      );
    }).join('');
  }

  function renderRenewalChip () {
    var d = state.renewalDaysRemaining;
    var chip = $('#evAmcRenewalChip');
    if (d == null) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    // Emit both the legacy `tsh-chip` classes (back-compat with any
    // existing skin) AND the promoted Phase-2 `tsh-renewal-chip` classes
    // from theme.css Bundle 20. Tone bands match daysUntilEnd() in
    // worker/src/lib/ev-amc.ts: expired (<0), danger (<30), warn (<60),
    // ok (else). Do NOT introduce a fifth band without design review.
    var cls = 'tsh-chip tsh-renewal-chip';
    var label;
    if (d < 0) {
      cls += ' tsh-chip-danger tsh-renewal-chip--expired';
      label = 'Expired ' + Math.abs(d) + ' day(s) ago';
    } else if (d < 30) {
      cls += ' tsh-chip-danger tsh-renewal-chip--danger';
      label = 'Renews in ' + d + ' day(s)';
    } else if (d < 60) {
      cls += ' tsh-chip-warn tsh-renewal-chip--warn';
      label = 'Renews in ' + d + ' day(s)';
    } else {
      cls += ' tsh-chip-ok';
      label = 'Renews in ' + d + ' day(s)';
    }
    chip.className = cls;
    chip.textContent = label;
  }

  function fmtBytes (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function docIconFor (kind) {
    switch (kind) {
      case 'contract':   return 'fa-file-signature';
      case 'renewal':    return 'fa-file-pen';
      case 'sla':        return 'fa-file-contract';
      case 'invoice':    return 'fa-file-invoice';
      case 'inspection': return 'fa-file-shield';
      case 'photo':      return 'fa-file-image';
      default:           return 'fa-file';
    }
  }

  function renderDocuments () {
    var ul = $('#evAmcDocList');
    var docs = state.amc.documents || [];
    if (!docs.length) {
      ul.innerHTML = '<li class="tsh-empty-inline">No documents uploaded yet.</li>';
      return;
    }
    ul.innerHTML = docs.map(function (d) {
      var cls = d.archived ? ' tsh-ev-amc-doc-archived' : '';
      return (
        '<li class="tsh-ev-amc-doc' + cls + '">' +
          '<div class="tsh-ev-amc-doc-icon"><i class="fas ' + docIconFor(d.kind) + '"></i></div>' +
          '<div class="tsh-ev-amc-doc-body">' +
            '<div class="tsh-ev-amc-doc-title">' + esc(d.title) +
              ' <span class="tsh-ev-amc-doc-kind">(' + esc(d.kind) + ')</span></div>' +
            '<div class="tsh-ev-amc-doc-meta">' +
              esc((d.uploadedAt || '').slice(0, 10)) + ' · ' +
              esc(d.uploadedBy || '') + ' · ' + esc(fmtBytes(d.bytes || 0)) +
              (d.archived ? ' · <em>archived</em>' : '') +
            '</div>' +
            '<div class="tsh-ev-amc-doc-path">' + esc(d.path) + '</div>' +
          '</div>' +
          '<button type="button" class="tsh-btn tsh-btn-ghost" data-doc-archive="' + esc(d.id) + '" data-archived="' + (d.archived ? '1' : '0') + '">' +
            '<i class="fas ' + (d.archived ? 'fa-box-open' : 'fa-box-archive') + '"></i> ' +
            (d.archived ? 'Restore' : 'Archive') +
          '</button>' +
        '</li>'
      );
    }).join('');
  }

  function renderServicing () {
    var ul = $('#evAmcSvcList');
    var entries = state.amc.servicing || [];
    if (!entries.length) {
      ul.innerHTML = '<li class="tsh-empty-inline">No servicing visits logged yet.</li>';
      return;
    }
    ul.innerHTML = entries.map(function (e) {
      return (
        '<li class="tsh-ev-amc-svc">' +
          '<div class="tsh-ev-amc-svc-date">' + esc(e.date) + '</div>' +
          '<div class="tsh-ev-amc-svc-body">' +
            '<div class="tsh-ev-amc-svc-title">' +
              '<span class="tsh-ev-amc-svc-kind">' + esc(e.kind) + '</span> — ' +
              esc(e.performedBy) +
              (e.station ? ' · ' + esc(e.station) : '') +
            '</div>' +
            (e.notes ? '<div class="tsh-ev-amc-svc-notes">' + esc(e.notes) + '</div>' : '') +
            '<div class="tsh-ev-amc-svc-meta">logged ' + esc((e.createdAt || '').slice(0, 10)) + ' by ' + esc(e.createdBy || '') + '</div>' +
          '</div>' +
          '<button type="button" class="tsh-btn tsh-btn-icon" data-svc-delete="' + esc(e.id) + '" title="Delete this entry">' +
            '<i class="fas fa-trash"></i>' +
          '</button>' +
        '</li>'
      );
    }).join('');
  }

  function renderAll () {
    renderContract();
    renderDocuments();
    renderServicing();
  }

  // ---------------------------------------------------------------------
  //  Actions
  // ---------------------------------------------------------------------

  async function fetchAmc () {
    var res = await Api.get('/ev/admin/amc');
    state.amc                  = res.data.amc;
    state.renewalDaysRemaining = res.data.renewalDaysRemaining;
    state.storage              = res.data.storage;
  }

  function readContractFromForm () {
    return {
      number:              $('#evAmcNumber').value.trim(),
      vendor:              $('#evAmcVendor').value.trim(),
      vendorContact: {
        phone:   $('#evAmcVendorPhone').value.trim(),
        email:   $('#evAmcVendorEmail').value.trim(),
        website: $('#evAmcVendorWebsite').value.trim(),
        address: $('#evAmcVendorAddress').value.trim(),
      },
      startDate:           $('#evAmcStart').value,
      endDate:             $('#evAmcEnd').value,
      renewalReminderDays: Number($('#evAmcReminderDays').value || 0),
      annualFee:           $('#evAmcFee').value === '' ? null : Number($('#evAmcFee').value),
      currency:            ($('#evAmcCurrency').value || 'INR').trim(),
      coverage:            state.amc.contract.coverage || [],
      societyResponsibilities: state.amc.contract.societyResponsibilities || [],
      emergencyContact:    $('#evAmcEmergency').value.trim(),
      notes:               $('#evAmcNotes').value.trim(),
    };
  }

  async function saveContract () {
    try {
      var res = await Api.put('/ev/admin/amc', readContractFromForm());
      state.amc                  = res.data.amc;
      state.renewalDaysRemaining = res.data.renewalDaysRemaining;
      state.dirty = false;
      $('#evAmcSaveBtn').disabled = true;
      renderAll();
      toast('AMC contract saved.', 'success');
    } catch (e) {
      toast('Save failed: ' + (e.message || e), 'error');
    }
  }

  function markDirty () {
    state.dirty = true;
    $('#evAmcSaveBtn').disabled = false;
  }

  function addToList (kind) {
    var inputSel = kind === 'coverage' ? '#evAmcCoverageAdd' : '#evAmcRespAdd';
    var input = $(inputSel);
    var val = input.value.trim();
    if (!val) return;
    var arrKey = kind === 'coverage' ? 'coverage' : 'societyResponsibilities';
    var next = (state.amc.contract[arrKey] || []).slice();
    next.push(val);
    state.amc.contract[arrKey] = next;
    input.value = '';
    renderList(
      kind === 'coverage' ? '#evAmcCoverageList' : '#evAmcRespList',
      next, kind,
    );
    markDirty();
  }

  function removeFromList (kind, idx) {
    var arrKey = kind === 'coverage' ? 'coverage' : 'societyResponsibilities';
    var next = (state.amc.contract[arrKey] || []).slice();
    next.splice(idx, 1);
    state.amc.contract[arrKey] = next;
    renderList(
      kind === 'coverage' ? '#evAmcCoverageList' : '#evAmcRespList',
      next, kind,
    );
    markDirty();
  }

  function fileToBase64 (file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || '');
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      fr.onerror = function () { reject(new Error('read error')); };
      fr.readAsDataURL(file);
    });
  }

  async function uploadDoc () {
    var kind  = $('#evAmcDocKind').value;
    var title = $('#evAmcDocTitle').value.trim();
    var file  = $('#evAmcDocFile').files && $('#evAmcDocFile').files[0];
    if (!title) { toast('Add a document title first.', 'warn'); return; }
    if (!file)  { toast('Pick a file to upload.', 'warn'); return; }
    var MAX = 8 * 1024 * 1024;
    if (file.size > MAX) { toast('File too large (max 8 MB).', 'error'); return; }
    try {
      var b64 = await fileToBase64(file);
      var res = await Api.post('/ev/admin/amc/documents', {
        kind: kind,
        title: title,
        mime: file.type || 'application/octet-stream',
        bytes: file.size,
        dataBase64: b64,
      });
      state.amc.documents = [res.data.document].concat(state.amc.documents || []);
      $('#evAmcDocTitle').value = '';
      $('#evAmcDocFile').value  = '';
      renderDocuments();
      toast('Document uploaded.', 'success');
    } catch (e) {
      toast('Upload failed: ' + (e.message || e), 'error');
    }
  }

  async function toggleArchive (id, currentlyArchived) {
    try {
      var res = await Api.patch('/ev/admin/amc/documents/' + encodeURIComponent(id), {
        archived: !currentlyArchived,
      });
      state.amc.documents = (state.amc.documents || []).map(function (d) {
        return d.id === id ? res.data.document : d;
      });
      renderDocuments();
    } catch (e) {
      toast('Update failed: ' + (e.message || e), 'error');
    }
  }

  async function addServicing () {
    var date = $('#evAmcSvcDate').value;
    var kind = $('#evAmcSvcKind').value;
    var by   = $('#evAmcSvcBy').value.trim();
    var stn  = $('#evAmcSvcStation').value.trim();
    var notes= $('#evAmcSvcNotes').value.trim();
    if (!date) { toast('Pick a visit date.', 'warn'); return; }
    if (!by)   { toast('Who performed the visit?', 'warn'); return; }
    try {
      var res = await Api.post('/ev/admin/amc/servicing', {
        date: date, kind: kind, performedBy: by,
        station: stn || undefined, notes: notes || undefined,
      });
      state.amc.servicing = [res.data.entry].concat(state.amc.servicing || []);
      $('#evAmcSvcDate').value = '';
      $('#evAmcSvcBy').value = '';
      $('#evAmcSvcStation').value = '';
      $('#evAmcSvcNotes').value = '';
      renderServicing();
      toast('Servicing visit logged.', 'success');
    } catch (e) {
      toast('Log failed: ' + (e.message || e), 'error');
    }
  }

  async function deleteServicing (id) {
    if (!window.confirm('Delete this servicing entry?')) return;
    try {
      await Api.delete('/ev/admin/amc/servicing/' + encodeURIComponent(id));
      state.amc.servicing = (state.amc.servicing || []).filter(function (e) { return e.id !== id; });
      renderServicing();
    } catch (e) {
      toast('Delete failed: ' + (e.message || e), 'error');
    }
  }

  // ---------------------------------------------------------------------
  //  Event binding
  // ---------------------------------------------------------------------

  function bindEvents () {
    // Any input change on the contract fields marks the form dirty.
    var dirtySelectors = [
      '#evAmcNumber', '#evAmcVendor',
      '#evAmcStart', '#evAmcEnd',
      '#evAmcReminderDays', '#evAmcFee', '#evAmcCurrency',
      '#evAmcVendorPhone', '#evAmcVendorEmail', '#evAmcVendorWebsite',
      '#evAmcVendorAddress', '#evAmcEmergency', '#evAmcNotes',
    ];
    dirtySelectors.forEach(function (sel) {
      var el = $(sel);
      if (el) el.addEventListener('input', markDirty);
    });

    $('#evAmcSaveBtn').addEventListener('click', saveContract);
    $('#evAmcCoverageAddBtn').addEventListener('click', function () { addToList('coverage'); });
    $('#evAmcRespAddBtn').addEventListener('click',     function () { addToList('resp'); });
    $('#evAmcCoverageAdd').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addToList('coverage'); }
    });
    $('#evAmcRespAdd').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addToList('resp'); }
    });

    // Delegated remove-from-list handlers.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('button[data-list]');
      if (btn) {
        var kind = btn.getAttribute('data-list');
        var idx  = Number(btn.getAttribute('data-idx') || 0);
        removeFromList(kind === 'coverage' ? 'coverage' : 'resp', idx);
        return;
      }
      var archBtn = e.target.closest && e.target.closest('button[data-doc-archive]');
      if (archBtn) {
        var id = archBtn.getAttribute('data-doc-archive');
        var cur = archBtn.getAttribute('data-archived') === '1';
        toggleArchive(id, cur);
        return;
      }
      var delBtn = e.target.closest && e.target.closest('button[data-svc-delete]');
      if (delBtn) {
        deleteServicing(delBtn.getAttribute('data-svc-delete'));
        return;
      }
    });

    $('#evAmcUploadBtn').addEventListener('click', uploadDoc);
    $('#evAmcSvcAddBtn').addEventListener('click', addServicing);
  }

  // ---------------------------------------------------------------------
  //  Init
  // ---------------------------------------------------------------------

  async function init () {
    if (state.ready) return;
    try { await Flags.ready(); } catch (_e) { return; }
    try {
      Flags.ensureFeature('FEATURE_TSH_EV_CHARGING', 'EV Charging');
      Flags.ensureFeature('FEATURE_TSH_EV_AMC', 'EV AMC records');
    } catch (_e) { return; }

    try { await Flags.ensureAuthorized('MANAGER'); }
    catch (_e) { return; }

    var section = $('#evAmcSection');
    if (!section) return;
    section.hidden = false;

    try {
      await fetchAmc();
    } catch (e) {
      toast('Could not load AMC record: ' + (e.message || e), 'error');
      return;
    }
    renderAll();
    bindEvents();
    state.ready = true;
  }

  window.EvAmc = { init: init };
}());

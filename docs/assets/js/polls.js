// Polls (per-signed-in vote, SVG bar charts, optional alias/flat record).
// - Polls.mountList(host)        — public list of active polls; signed-in users can vote.
// - Polls.mountEditor(host)      — MANAGER+ poll authoring.
// - Polls.mountVotersPanel(host) — MANAGER+ "who voted" viewer (per-poll picker + list).
(function (root) {
  'use strict';

  async function fetchPolls() {
    try {
      const res = await Api.get('/polls');
      return Array.isArray(res && res.items) ? res.items : [];
    } catch (_e) { return []; }
  }

  function mountList(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_POLLS')) { host.hidden = true; return; }
    host.classList.add('tsh-polls-list');
    paint();

    async function paint() {
      const items = await fetchPolls();
      if (!items.length) { host.hidden = true; return; }
      host.hidden = false;
      host.innerHTML = `<h2 class="tsh-polls-title"><i class="fas fa-chart-column"></i> Polls</h2>` +
        `<div class="tsh-polls-cards"></div>`;
      const cards = host.querySelector('.tsh-polls-cards');
      for (const p of items) cards.appendChild(card(p));
    }

    function card(p) {
      const c = document.createElement('article');
      c.className = 'tsh-poll-card' + (p.open ? '' : ' is-closed');
      const totalVotes = (p.totals || []).reduce((s, x) => s + (x.count || 0), 0);
      const tallyBy = new Map((p.totals || []).map((t) => [t.optionId, t.count || 0]));

      const head = document.createElement('header');
      head.className = 'tsh-poll-card-head';
      head.innerHTML = `<h3>${escapeHtml(p.question)}</h3>` +
        `<small>${totalVotes} vote${totalVotes === 1 ? '' : 's'}${p.open ? '' : ' \u2022 closed'}</small>`;
      c.appendChild(head);

      const optList = document.createElement('ul');
      optList.className = 'tsh-poll-options';
      for (const o of p.options) {
        const count = tallyBy.get(o.id) || 0;
        const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;
        const mine = p.myVote === o.id;
        const li = document.createElement('li');
        li.className = 'tsh-poll-option' + (mine ? ' is-mine' : '');
        li.innerHTML = `
          <button type="button" class="tsh-poll-vote-btn" data-poll-id="${escapeAttr(p.id)}" data-option-id="${escapeAttr(o.id)}" ${p.open && !p.myVote ? '' : 'disabled'}>
            <span class="tsh-poll-option-label">${escapeHtml(o.label)}${mine ? ' <i class="fas fa-check tsh-poll-tick"></i>' : ''}</span>
            <svg class="tsh-poll-bar" viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
              <rect class="tsh-poll-bar-bg" x="0" y="0" width="100" height="14" rx="3"></rect>
              <rect class="tsh-poll-bar-fg" x="0" y="0" width="${pct}" height="14" rx="3"></rect>
            </svg>
            <span class="tsh-poll-pct">${pct}%</span>
          </button>
        `;
        optList.appendChild(li);
      }
      c.appendChild(optList);

      // Optional alias + flat capture (collapsed; shown only when about to vote).
      const extras = document.createElement('div');
      extras.className = 'tsh-poll-extras';
      extras.innerHTML = `
        <input type="text" class="tsh-poll-alias" maxlength="60" placeholder="Display name (optional)">
        <input type="text" class="tsh-poll-flat"  maxlength="30" placeholder="Flat / unit (optional)">
      `;
      c.appendChild(extras);

      // Click → POST vote (re-renders list on success).
      c.addEventListener('click', async (e) => {
        const btn = e.target.closest('.tsh-poll-vote-btn');
        if (!btn) return;
        if (!Auth || !Auth.token || !Auth.token()) {
          UI.toast('Sign in to vote.', { kind: 'warn' });
          return;
        }
        const optionId = btn.getAttribute('data-option-id');
        const pollId   = btn.getAttribute('data-poll-id');
        const alias = (c.querySelector('.tsh-poll-alias').value || '').trim();
        const flat  = (c.querySelector('.tsh-poll-flat').value  || '').trim();
        try {
          await Api.post(`/polls/${encodeURIComponent(pollId)}/vote`, {
            optionId,
            ...(alias ? { voterAlias: alias } : {}),
            ...(flat  ? { voterFlat:  flat  } : {}),
          });
          UI.toast('Vote recorded.', { kind: 'success' });
          paint();
        } catch (err) {
          UI.toast(err && err.message ? err.message : 'Could not record vote.', { kind: 'danger' });
        }
      });

      return c;
    }
  }

  async function mountEditor(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_POLLS')) { host.hidden = true; return; }
    host.classList.add('tsh-poll-editor');
    let items = [];
    try {
      const res = await Api.get('/polls');
      items = Array.isArray(res && res.items) ? res.items.map(stripRuntimeFields) : [];
    } catch (_e) { items = []; }
    render();

    function stripRuntimeFields(p) {
      // Drop server-computed fields before edit so PUT keeps a clean shape.
      const { open: _o, totals: _t, myVote: _m, ...rest } = p;
      return rest;
    }

    function render() {
      host.innerHTML = '';
      const title = document.createElement('h3');
      title.className = 'tsh-poll-editor-title';
      title.innerHTML = '<i class="fas fa-chart-column"></i> Manage polls';
      host.appendChild(title);

      const list = document.createElement('ul');
      list.className = 'tsh-poll-editor-rows';
      items.forEach((it, idx) => list.appendChild(pollRow(it, idx)));
      host.appendChild(list);

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      addBtn.innerHTML = '<i class="fas fa-plus"></i>Add poll';
      addBtn.addEventListener('click', () => {
        items.push({ question: '', options: [{ label: '' }, { label: '' }], closed: false });
        render();
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'tsh-btn tsh-btn-primary';
      saveBtn.innerHTML = '<i class="fas fa-save"></i>Save polls';
      saveBtn.addEventListener('click', () => {
        UI.busyButton(saveBtn, async () => {
          const clean = items
            .filter((it) => (it.question || '').trim())
            .map((it) => ({
              ...it,
              options: (it.options || []).filter((o) => (o.label || '').trim()),
            }))
            .filter((it) => it.options.length >= 2);
          try {
            await Api.put('/polls', { polls: { version: 1, items: clean } });
            items = clean.slice();
            UI.toast('Polls saved.', { kind: 'success' });
            render();
          } catch (e) {
            UI.toast(e && e.message ? e.message : 'Could not save polls.', { kind: 'danger' });
            throw e;
          }
        }, { label: 'Saving polls…' });
      });

      const bar = document.createElement('div');
      bar.className = 'tsh-poll-editor-actions';
      bar.append(addBtn, saveBtn);
      host.appendChild(bar);
    }

    function pollRow(it, idx) {
      const li = document.createElement('li');
      li.className = 'tsh-poll-editor-row';

      const q = document.createElement('input');
      q.type = 'text'; q.maxLength = 240;
      q.placeholder = 'Question (max 240 chars)';
      q.value = it.question || '';
      q.addEventListener('input', () => { items[idx].question = q.value; });

      const optsWrap = document.createElement('div');
      optsWrap.className = 'tsh-poll-editor-options';

      const renderOpts = () => {
        optsWrap.innerHTML = '';
        (it.options || []).forEach((o, oi) => {
          const row = document.createElement('div');
          row.className = 'tsh-poll-editor-opt';
          const inp = document.createElement('input');
          inp.type = 'text'; inp.maxLength = 120;
          inp.placeholder = `Option ${oi + 1}`;
          inp.value = o.label || '';
          inp.addEventListener('input', () => { items[idx].options[oi].label = inp.value; });
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
          del.innerHTML = '<i class="fas fa-minus"></i>';
          del.addEventListener('click', () => {
            if (items[idx].options.length > 2) items[idx].options.splice(oi, 1);
            renderOpts();
          });
          row.append(inp, del);
          optsWrap.appendChild(row);
        });
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
        add.innerHTML = '<i class="fas fa-plus"></i>Add option';
        add.disabled = (items[idx].options.length >= 10);
        add.addEventListener('click', () => {
          if (items[idx].options.length < 10) items[idx].options.push({ label: '' });
          renderOpts();
        });
        optsWrap.appendChild(add);
      };
      renderOpts();

      const closedLabel = document.createElement('label');
      closedLabel.className = 'tsh-poll-editor-closed';
      const closedIn = document.createElement('input');
      closedIn.type = 'checkbox';
      closedIn.checked = !!it.closed;
      closedIn.addEventListener('change', () => { items[idx].closed = closedIn.checked; });
      closedLabel.append(closedIn, document.createTextNode(' Closed (no further votes)'));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tsh-btn tsh-btn-ghost tsh-btn-sm';
      del.innerHTML = '<i class="fas fa-trash"></i>Delete poll';
      del.addEventListener('click', () => { items.splice(idx, 1); render(); });

      const rowFoot = document.createElement('div');
      rowFoot.className = 'tsh-poll-editor-foot';
      rowFoot.append(closedLabel, del);

      li.append(q, optsWrap, rowFoot);
      return li;
    }
  }

  async function mountVotersPanel(host) {
    if (!host) return;
    if (root.Flags && !root.Flags.on('FEATURE_DAILY_POLLS')) { host.hidden = true; return; }
    host.classList.add('tsh-poll-voters');
    host.innerHTML = '<p class="tsh-text-muted">Loading polls…</p>';
    const polls = await fetchPolls();
    if (!polls.length) { host.innerHTML = '<p class="tsh-text-muted">No polls yet.</p>'; return; }
    host.innerHTML = '';

    const title = document.createElement('h3');
    title.className = 'tsh-poll-voters-title';
    title.innerHTML = '<i class="fas fa-users"></i> Who voted';
    host.appendChild(title);

    const sel = document.createElement('select');
    sel.className = 'tsh-poll-voters-select';
    for (const p of polls) {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.question;
      sel.appendChild(opt);
    }

    const listEl = document.createElement('ul');
    listEl.className = 'tsh-poll-voters-list';

    const refresh = async () => {
      listEl.innerHTML = '<li class="tsh-text-muted">Loading…</li>';
      try {
        const res = await Api.get(`/polls/${encodeURIComponent(sel.value)}/votes`);
        const voters = (res && res.voters) || [];
        if (!voters.length) { listEl.innerHTML = '<li class="tsh-text-muted">No votes yet.</li>'; return; }
        const labelById = new Map();
        const poll = polls.find((p) => p.id === sel.value);
        if (poll) for (const o of poll.options) labelById.set(o.id, o.label);
        listEl.innerHTML = '';
        for (const v of voters) {
          const li = document.createElement('li');
          li.innerHTML = `<strong>${escapeHtml(labelById.get(v.optionId) || v.optionId)}</strong> &middot; ` +
            `<span class="tsh-poll-voter-email">${escapeHtml(v.voterEmail)}</span>` +
            (v.voterAlias ? ` &middot; ${escapeHtml(v.voterAlias)}` : '') +
            (v.voterFlat  ? ` &middot; <span class="tsh-poll-voter-flat">${escapeHtml(v.voterFlat)}</span>` : '') +
            ` &middot; <time>${new Date(v.votedAt).toLocaleString()}</time>`;
          listEl.appendChild(li);
        }
      } catch (e) {
        listEl.innerHTML = `<li class="tsh-text-muted">Could not load voters: ${escapeHtml(e && e.message || 'error')}</li>`;
      }
    };
    sel.addEventListener('change', refresh);
    host.append(sel, listEl);
    refresh();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  root.Polls = { mountList, mountEditor, mountVotersPanel };
})(window);

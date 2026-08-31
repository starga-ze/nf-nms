/* ai-provider.js — Configuration ▸ AI Provider.
 *
 * The vendors this appliance holds an account with, and which of their models it may ask for. An
 * ordinary Configuration tab: a table, an Add button, a slideover editor, edit and delete at the
 * right of each row, one Publish.
 *
 * An entry is the three things an operator actually chooses:
 *
 *   provider   which vendor. One of three, each addable once.
 *   API key    theirs, held sealed on the appliance.
 *   models     which of that vendor's models this appliance may ask for.
 *
 * Everything that used to be here and is not any more came out for the same reason — it was not a
 * choice an operator makes:
 *
 *   the endpoint   a fact about the vendor. Compiled into pretzel-ai, the side that has to speak
 *                  the vendor's dialect anyway. A console field for it only ever bought the chance
 *                  to point "openai" at something that is not OpenAI.
 *   enabled        a second way to say "off". Removing the row is the first, and it is how every
 *                  other list in this console works.
 *   the turn shape default model, system prompt, token cap, timeout. How pretzel-ai shapes a turn,
 *                  not a statement this appliance makes about somebody's vendor account.
 *
 * The id is the VENDOR — openai, google, anthropic — not the model family. It is the name the key
 * belongs to, the name the endpoint answers for, and the prefix on every model those two serve;
 * "claude/claude-opus-5" said the family twice and named the wrong owner.
 *
 * Two stores, one Publish. Where a change LANDS differs; when it takes effect does not:
 *
 *   running_config   which vendors are configured, and their model lists.
 *   sealed keys      each vendor's API key. It cannot go in running_config — that document is
 *                    append-versioned, rendered verbatim in the review diff and written out by
 *                    Save-to-file, and mgmtd refuses a commit carrying a key.
 *
 * A typed key is therefore staged browser-local (NMS.draft, this tab only, exactly as api-keys.js
 * stages a device password) and never enters the commit payload. Publish is still the only moment
 * anything happens: the staged config goes to the commit, and the staged key goes to
 * POST /api/ai/credential in onPublished, where it is sealed with AES-256-GCM and handed to engined.
 *
 * The model list is a fixed set of checkboxes per vendor. No search — the lists are short enough to
 * read — and no free-text row: a name an operator has to type exactly is a name they will mistype,
 * and a model that is missing from VENDORS below is a change to this file, where it can be given a
 * readable label and the token-parameter quirk its generation needs.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  const TAB = 'ai-provider';
  const DRAFT_KEY = 'ai-provider';
  const SCOPE = 'pretzel-ai';

  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const { esc } = window.NMS.utils;

  // ── The vendors, and what they serve ─────────────────────────────────────────
  // A picking list, not a policy: it is what this console knows to offer, and an operator may still
  // type in one it has never heard of. Kept to the 2025-and-later generations — the older ones are
  // a long tail nobody is deploying an appliance against, and a list nobody can read is a list
  // nobody checks.
  //
  // This WILL go stale: vendors ship models on their own schedule and this file does not. That is
  // why the editor keeps a free-text row beside the checkboxes — a model the list does not carry is
  // an ordinary thing, not an error.
  const VENDORS = [
    {
      id: 'openai', label: 'OpenAI', family: 'GPT', keyHint: 'sk-…',
      models: [
        { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', token_param: 'max_completion_tokens' },
        { id: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol',   token_param: 'max_completion_tokens' },
        { id: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna',  token_param: 'max_completion_tokens' },
      ],
    },
    {
      id: 'google', label: 'Google', family: 'Gemini', keyHint: 'AI Studio API key',
      models: [
        { id: 'gemini-3.6-flash',      label: 'Gemini 3.6 Flash' },
        { id: 'gemini-3.5-flash',      label: 'Gemini 3.5 Flash' },
        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
      ],
    },
    {
      id: 'anthropic', label: 'Anthropic', family: 'Claude', keyHint: 'sk-ant-…',
      models: [
        { id: 'claude-opus-5',   label: 'Claude Opus 5' },
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
        { id: 'claude-fable-5',  label: 'Claude Fable 5' },
        { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      ],
    },
  ];

  const vendorOf = (id) => VENDORS.find(v => v.id === id) || VENDORS[0];
  const catalogOf = (id) => vendorOf(id).models;
  const knownModel = (pid, mid) => catalogOf(pid).find(m => m.id === mid) || null;

  // ── State ────────────────────────────────────────────────────────────────────
  const state = { list: [] };
  let deployed = [];
  // Per-vendor credential state from /api/ai/credentials — { stored, updated_at? }. Never a key:
  // the appliance cannot produce one and would not hand it back if it could.
  let creds = null;
  let sealingAvailable = true;

  let editIdx = null;         // index into state.list, or null when adding
  let draft = null;           // the editor's working copy, adopted on Save
  let keyDraft = '';          // the editor's key field, adopted into `pending` on Save
  let saveNote = '';
  let keyBanner = null;       // outcome of the last key store, shown after Publish

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // Keys the operator has entered but not yet published. Browser-local and this tab only — the same
  // place and the same reasoning as api-keys.js's device passwords: a secret cannot ride a commit,
  // so it waits here until Publish sends it down its own path.
  //
  // A value is the key to store; null means "remove the stored key". Absent means untouched.
  const SECRET_KEY = 'ai-provider-keys';
  const pending = {
    all: () => window.NMS.draft.get(SECRET_KEY, {}),
    has: (id) => Object.prototype.hasOwnProperty.call(pending.all(), id),
    get: (id) => pending.all()[id],
    set(id, value) {
      const s = pending.all(); s[id] = value;
      window.NMS.draft.set(SECRET_KEY, s); window.NMS.staging.refresh();
    },
    drop(id) {
      const s = pending.all(); delete s[id];
      window.NMS.draft.set(SECRET_KEY, s); window.NMS.staging.refresh();
    },
    clear() { window.NMS.draft.set(SECRET_KEY, {}); },
    any: () => Object.keys(pending.all()).length > 0,
  };

  const keySealed = (id) => !!(creds && creds[id] && creds[id].stored);
  // What the appliance will hold after Publish — the staged change laid over what it holds now.
  const keyEffective = (id) => (pending.has(id) ? pending.get(id) !== null : keySealed(id));

  function normalizeEntry(p) {
    const id = (p && p.id) || '';
    return {
      id,
      models: (Array.isArray(p && p.models) ? p.models : [])
        .filter(m => m && typeof m === 'object' && m.id)
        .map(m => {
          const known = knownModel(id, String(m.id));
          const out = { id: String(m.id), label: String(m.label || (known && known.label) || m.id) };
          const tp = m.token_param || (known && known.token_param);
          if (tp) out.token_param = String(tp);
          return out;
        }),
    };
  }

  const normalize = (c) => {
    const src = (c && typeof c === 'object') ? c : {};
    const raw = Array.isArray(src.providers) ? src.providers
      : (src.providers && Array.isArray(src.providers.list) ? src.providers.list : []);
    return raw.filter(p => p && VENDORS.some(v => v.id === p.id)).map(normalizeEntry);
  };

  const takenIds = (exceptIdx) => state.list.filter((_, i) => i !== exceptIdx).map(p => p.id);
  const freeVendors = (exceptIdx) => VENDORS.filter(v => !takenIds(exceptIdx).includes(v.id));

  // ── Staging ──────────────────────────────────────────────────────────────────
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.list); window.NMS.staging.refresh(); };

  async function load() {
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      deployed = normalize((d.scopes || {})[SCOPE] || {});
    } catch (_) { deployed = []; }
    const staged = window.NMS.draft.get(DRAFT_KEY, null);
    state.list = staged ? staged.map(normalizeEntry) : clone(deployed);
    window.NMS.staging.refresh();
  }

  async function loadCreds() {
    try {
      const r = await fetch('/api/ai/credentials', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      creds = d.providers || {};
      sealingAvailable = d.sealing_available !== false;
    } catch (_) { creds = null; }
  }

  const commitPayload = () => [{ scope: SCOPE, domain: 'providers', values: { list: state.list } }];

  window.NMS.staging.register({
    key: DRAFT_KEY,
    // A key-only change is still a change. Without this the Publish button stays dark and the key
    // the operator entered sits in the browser until something else happens to be dirty.
    dirty: () => JSON.stringify(state.list) !== JSON.stringify(deployed) || pending.any(),
    payload: commitPayload,
    before: () => ({ ai_providers: deployed }),
    after: () => ({ ai_providers: state.list }),
    onPublished() {
      deployed = clone(state.list);
      window.NMS.draft.clear(DRAFT_KEY);
      applyPendingKeys();
    },
    problems() {
      const out = [];
      state.list.forEach(p => {
        const v = vendorOf(p.id);
        if (!p.models.length)
          out.push(`AI Provider "${v.label}" has no models — it cannot serve a turn.`);
        // Judged against what Publish will leave behind, not against what is stored now: a key
        // entered in this same batch is about to be sealed.
        if (creds && !keyEffective(p.id))
          out.push(`AI Provider "${v.label}" has no API key — its turns will fail.`);
      });
      return out;
    },
  });

  // ── Key store ────────────────────────────────────────────────────────────────
  // Sent on Publish, never before. Drains `pending` once the commit has been accepted, one request
  // per vendor, then re-reads the appliance so what the page reports is the stored state rather
  // than this function's optimism.
  async function applyPendingKeys() {
    const staged = pending.all();
    const ids = Object.keys(staged);
    if (!ids.length) return;

    const failed = [];
    for (const id of ids) {
      const value = staged[id];
      const body = value === null ? { id, clear: true } : { id, api_key: value };
      try {
        const r = await fetch('/api/ai/credential', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || ('HTTP ' + r.status));
        }
      } catch (e) {
        failed.push(`${vendorOf(id).label}: ${e.message || e}`);
      }
    }

    // Cleared whether or not every request landed. A staged key that failed is not worth retrying
    // silently on the next unrelated Publish — the operator is told, and re-enters it if they mean
    // to. Keeping it would make a later Publish do something nobody asked for.
    pending.clear();
    await loadCreds();
    keyBanner = failed.length
      ? { bad: true, text: `Could not store ${failed.length} key: ${failed.join('; ')}` }
      : null;
    window.NMS.staging.refresh();
    render();
  }

  // ── Table ────────────────────────────────────────────────────────────────────
  // A key is a yes/no with a date attached, and the date is the part nobody reads. So the state is
  // a dot and a word, the age is relative ("2h ago" — the useful question is "is this the one I set
  // just now?", not the wall clock), and the exact timestamp goes on the title where it costs
  // nothing. Printing "sealed 2026-08-31 14:49" put the two most-scanned characters of the column
  // next to sixteen that are almost never needed.
  const keyCell = (p) => {
    const dot = (cls, label) => `<span class="ai-key ${cls}"><i></i>${esc(label)}</span>`;

    if (pending.has(p.id)) {
      return pending.get(p.id) === null
        ? dot('is-drop', 'Removing on publish')
        : dot('is-staged', 'Staged for publish');
    }
    if (creds === null) return dot('is-unknown', 'Unknown');
    if (!keySealed(p.id)) return dot('is-none', 'Not set');

    const at = (creds[p.id] || {}).updated_at;
    // Just the state. The column answers "is there a key", and the date — which ran into the word
    // beside it — is on the title for anyone who wants it and in the editor for anyone who needs it.
    return `<span title="${esc(at ? 'Sealed ' + window.NMS.utils.fmtTs(at) : 'Sealed')}">${
      dot('is-set', 'Sealed')}</span>`;
  };

  const MODELS_INLINE_LIMIT = 2;

  // In the cell: the readable name only. In the card: the name and the id the vendor is actually
  // sent, which is the one place that distinction is worth the width.
  const modelRowHtml = (m, withId) => `<div class="mdl-row">`
    + `<span class="mdl-name">${esc(m.label || m.id)}</span>`
    + (withId ? `<span class="mdl-id mono-val">${esc(m.id)}</span>` : '') + `</div>`;

  function modelsCell(p) {
    if (!p.models.length) return '<span class="muted">none</span>';
    const shown = p.models.slice(0, MODELS_INLINE_LIMIT);
    const extra = p.models.length - shown.length;
    return `<div class="mdl">
        <div class="mdl-count"><b>${p.models.length}</b> model${p.models.length === 1 ? '' : 's'}</div>
        ${shown.map(m => modelRowHtml(m, false)).join('')}
        ${extra > 0 ? `<div class="mdl-more">+${extra} more</div>` : ''}
      </div>`;
  }

  // Body-mounted so the table's overflow cannot crop it, and shared by every row.
  function modelPopEl() {
    let el = document.getElementById('aiModelPop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'aiModelPop';
      el.className = 'ep-pop';
      document.body.appendChild(el);
    }
    return el;
  }

  function showModelPop(cell) {
    const p = state.list[+cell.dataset.models];
    // Only when the cell cannot show everything; at or below the inline limit it already does.
    if (!p || p.models.length <= MODELS_INLINE_LIMIT) return;

    const pop = modelPopEl();
    pop.innerHTML = `<div class="mdl-count"><b>${p.models.length}</b> models</div>`
      + p.models.map(m => modelRowHtml(m, true)).join('');
    pop.classList.add('open');

    // Directly below the cell, left edges aligned; flipped above only if it would leave the viewport.
    const r = cell.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8 && r.top - 6 - ph > 8) top = r.top - 6 - ph;
    pop.style.left = `${Math.max(8, left) + window.scrollX}px`;
    pop.style.top = `${top + window.scrollY}px`;
  }

  const hideModelPop = () => document.getElementById('aiModelPop')?.classList.remove('open');

  const table = window.NMS.table.create({
    id: 'cfg.aiProviders',
    tableClass: 'cfg-table-aiprov',
    searchPlaceholder: 'Search providers…',
    empty: `<div class="cfg-empty">No AI providers yet — click <b>Add Provider</b> to add one.
              A provider is a vendor you hold an account with, its API key, and the models that
              account may be asked for.</div>`,
    onRows: (tbody) => {
      tbody.querySelectorAll('[data-edit]').forEach(b =>
        b.addEventListener('click', () => openEditor(+b.dataset.edit)));
      tbody.querySelectorAll('[data-del]').forEach(b =>
        b.addEventListener('click', () => removeEntry(+b.dataset.del)));
      tbody.querySelectorAll('[data-models]').forEach(cell => {
        cell.addEventListener('mouseenter', () => showModelPop(cell));
        cell.addEventListener('mouseleave', hideModelPop);
      });
    },
    columns: [
      { key: 'provider', label: 'Provider', cls: 'col-name', filter: 'enum',
        text: (p) => vendorOf(p.id).label,
        searchText: (p) => `${vendorOf(p.id).label} ${p.id} ${vendorOf(p.id).family}`,
        cell: (p) => `<div class="cell-name">${esc(vendorOf(p.id).label)}<span
            class="ai-fam">${esc(vendorOf(p.id).family)}</span></div>` },
      { key: 'key', label: 'API Key', cls: 'col-key', filter: 'enum',
        text: (p) => {
          if (pending.has(p.id)) return pending.get(p.id) === null ? 'Removing' : 'Staged';
          if (creds === null) return 'Unknown';
          return keySealed(p.id) ? 'Sealed' : 'Not set';
        },
        cell: keyCell },
      // 2 — the count inline, the names on hover. Every id is long and they are near-identical
      // within a vendor, so a row that printed them all would be a row nobody can scan. Same
      // anchor-on-the-cell shape the connector's Endpoint Control column uses.
      { key: 'models', label: 'Models', cls: 'col-models', filter: 'number',
        text: (p) => String(p.models.length),
        sortValue: (p) => p.models.length,
        searchText: (p) => p.models.map(m => `${m.id} ${m.label}`).join(' '),
        cell: (p, i) => `<div data-models="${i}">${modelsCell(p)}</div>` },
      { key: 'act', label: '', cls: 'col-act', sort: false,
        cell: (p, i) => `
          <button class="icon-btn" data-edit="${i}" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
          </button>
          <button class="icon-btn danger" data-del="${i}" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` },
    ],
  });

  const paintTable = () => {
    hideModelPop();
    const host = document.getElementById('aiTable');
    if (host) table.mount(host, state.list);
    const meta = document.getElementById('aiMeta');
    if (meta) {
      const n = state.list.length;
      const keys = Object.keys(pending.all()).length;
      meta.textContent = `${n} provider${n === 1 ? '' : 's'}`
        + (keys ? ` · ${keys} key change${keys > 1 ? 's' : ''} pending publish` : '');
    }
    const add = document.getElementById('aiAdd');
    if (add) {
      const none = freeVendors(null).length === 0;
      add.disabled = none;
      add.title = none ? 'All three vendors are already configured' : '';
    }
  };

  function removeEntry(idx) {
    const p = state.list[idx];
    if (!p) return;
    const v = vendorOf(p.id);
    const sealed = keySealed(p.id);
    if (!confirm(sealed
      ? `Remove ${v.label}?\n\nIts stored API key is deleted on Publish as well.`
      : `Remove ${v.label}?`)) return;

    state.list.splice(idx, 1);
    // A key outlives its row only if nobody says otherwise, and a provider nobody can see is a key
    // nobody can manage. Removing the row stages the key's removal with it.
    if (sealed) pending.set(p.id, null); else pending.drop(p.id);
    stage();
    paintTable();
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  const isPicked = (mid) => draft.models.some(m => m.id === mid);

  // Checkboxes and nothing else. The operator is choosing from what their account serves, and a
  // name they would have to type exactly is a name they will mistype; a search box over a list this
  // short would be furniture. A model the console has not heard of is added by shipping it here.
  function modelPicker() {
    return `<div class="ai-pick">
        ${catalogOf(draft.id).map(m => `
          <label class="ai-pick-row${isPicked(m.id) ? ' on' : ''}">
            <input type="checkbox" data-pick="${esc(m.id)}" ${isPicked(m.id) ? 'checked' : ''}/>
            <span class="ai-pick-name">${esc(m.label)}</span>
            <span class="ai-pick-id mono-val">${esc(m.id)}</span>
          </label>`).join('')}
      </div>`;
  }

  // Just the field. What a key is, where it goes and when it is applied is the page's business,
  // not something to re-explain in the one place an operator is trying to paste a value.
  function keyBlock(v) {
    if (!sealingAvailable) {
      return '<p class="field-hint bad">This appliance has no <code>/etc/pretzel/credentials.key</code>,'
           + ' so a key cannot be sealed.</p>';
    }

    const sealed = keySealed(v.id);
    const staged = pending.has(v.id) ? pending.get(v.id) : undefined;
    const mask = '••••••••••••••••';

    // Three states, told apart by the placeholder alone: nothing stored, something stored, and
    // something staged over it. The mask is a sentinel, never a value — it is not submitted, so
    // leaving the field untouched cannot overwrite a sealed key with dots.
    const placeholder = staged === null ? 'removed on publish'
      : staged !== undefined ? `${mask}  staged`
      : sealed ? mask
      : v.keyHint;

    return `<div class="ai-key-row">
        <input type="password" data-k autocomplete="off" spellcheck="false" class="mono-val"
               placeholder="${esc(placeholder)}" value="${esc(keyDraft)}" aria-label="API key"/>
        ${(sealed || staged !== undefined) ? `<button class="btn-sm danger" id="aiKeyClear" type="button">${
          staged === null ? 'Keep' : 'Remove'}</button>` : ''}
      </div>`;
  }

  function editorForm() {
    const v = vendorOf(draft.id);
    const free = freeVendors(editIdx);
    // The vendor is fixed for the life of an entry: it is the id the key is sealed under and the
    // prefix on every model in it, so changing it would not be an edit but a different provider.
    const picker = editIdx == null
      ? `<select data-f="id">
           ${free.map(x => `<option value="${esc(x.id)}"${x.id === draft.id ? ' selected' : ''}>${esc(x.label)} · ${esc(x.family)}</option>`).join('')}
         </select>`
      : `<div class="ep-fixed">${esc(v.label)}<span class="lbl-sub">${esc(v.family)}</span></div>`;

    return `
      <div class="field-row"><label>Provider</label>${picker}</div>
      <div class="field-row"><label>API key</label>${keyBlock(v)}</div>

      <div class="ed-sec">
        <div class="ed-sec-h">Models
          <span class="info-hint">${draft.models.length} of ${catalogOf(draft.id).length} selected</span></div>
        ${modelPicker()}
      </div>`;
  }

  function paintEditor() {
    const body = document.getElementById('aiBody');
    if (!body || !draft) return;
    body.innerHTML = editorForm();
    const note = document.getElementById('aiSaveNote');
    if (note) note.textContent = saveNote;
    window.NMS.utils.enhanceSelects(body);
    wireEditor();
  }

  function openEditor(idx) {
    editIdx = idx;
    if (idx == null) {
      const free = freeVendors(null);
      if (!free.length) return;
      draft = { id: free[0].id, models: [] };
    } else {
      draft = clone(state.list[idx]);
    }
    keyDraft = ''; saveNote = '';

    document.getElementById('aiTitle').textContent = idx == null ? 'Add Provider' : 'Edit Provider';
    document.getElementById('aiFoot').innerHTML = `
      <span class="ed-foot-note" id="aiSaveNote"></span>
      <button class="btn-sm" id="aiCancel" type="button">Cancel</button>
      <button class="btn-primary btn-sm" id="aiSave" type="button">Save</button>`;
    paintEditor();

    document.getElementById('aiCancel').onclick = closeEditor;
    document.getElementById('aiSave').onclick = saveEditor;

    document.getElementById('aiOverlay').classList.add('open');
    document.getElementById('aiPanel').classList.add('open');
  }

  const closeEditor = () => {
    editIdx = null; draft = null; keyDraft = ''; saveNote = '';
    document.getElementById('aiOverlay').classList.remove('open');
    document.getElementById('aiPanel').classList.remove('open');
  };

  function saveEditor() {
    if (!draft.models.length) {
      saveNote = 'Select at least one model.';
      paintEditor();
      return;
    }
    // A new provider with no key would be committed and then fail every turn, and the operator is
    // standing in the one panel where they can fix it.
    if (editIdx == null && !keyDraft && !keySealed(draft.id)) {
      saveNote = 'Enter the API key.';
      paintEditor();
      return;
    }

    // The key leaves the panel the same way the rest of it does — staged, not applied. It goes to
    // its own store rather than into the entry, so it cannot reach the commit payload even by
    // accident, but it is committed to by the same button.
    if (keyDraft) pending.set(draft.id, keyDraft);

    if (editIdx == null) state.list.push(draft);
    else state.list[editIdx] = draft;

    stage();
    closeEditor();
    paintTable();
  }

  function wireEditor() {
    const body = document.getElementById('aiBody');

    // Add only, and it clears the selection with it: the catalogue belongs to the vendor, so
    // carrying the previous one across would offer models the new vendor does not serve.
    body.querySelector('select[data-f="id"]')?.addEventListener('change', (e) => {
      draft.id = e.target.value;
      draft.models = [];
      keyDraft = '';
      saveNote = '';
      paintEditor();
    });

    body.querySelectorAll('[data-pick]').forEach(box => box.addEventListener('change', () => {
      const mid = box.dataset.pick;
      if (box.checked) {
        const known = knownModel(draft.id, mid);
        const entry = { id: mid, label: (known && known.label) || mid };
        if (known && known.token_param) entry.token_param = known.token_param;
        if (!draft.models.some(m => m.id === mid)) draft.models.push(entry);
      } else {
        draft.models = draft.models.filter(m => m.id !== mid);
      }
      saveNote = '';
      paintEditor();
    }));

    const keyInput = body.querySelector('[data-k]');
    // No repaint on input: a repaint per keystroke would take the caret with it.
    keyInput?.addEventListener('input', () => { keyDraft = keyInput.value; });

    // Removal is an intent, not an action: staged like everything else, taking effect on Publish.
    // Pressing it again withdraws the intent, which is why the label changes.
    document.getElementById('aiKeyClear')?.addEventListener('click', () => {
      if (pending.get(draft.id) === null) pending.drop(draft.id);
      else { pending.set(draft.id, null); keyDraft = ''; }
      paintEditor();
      paintTable();
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== TAB) return;

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">AI Provider</span>
            <span class="cfg-h-sub" id="aiMeta"></span>
          </div>
          <button class="btn-primary btn-sm" id="aiAdd">+ Add Provider</button>
        </div>

        ${keyBanner ? `<div class="ai-banner${keyBanner.bad ? ' bad' : ''}">${esc(keyBanner.text)}</div>` : ''}

        <div id="aiTable"></div>

        <p class="cfg-foot-note">One entry per vendor. The endpoint is not configured here — it is a
          fact about the vendor, held by the inference service. API keys are sealed on the appliance
          and never travel in the configuration.</p>
      </div>

      <div class="slideover-overlay" id="aiOverlay"></div>
      <aside class="slideover" id="aiPanel">
        <div class="slideover-head">
          <span class="slideover-title" id="aiTitle">Provider</span>
          <button class="slideover-close" id="aiClose" type="button">&times;</button>
        </div>
        <div class="slideover-body" id="aiBody"></div>
        <div class="slideover-foot" id="aiFoot"></div>
      </aside>`;

    paintTable();

    document.getElementById('aiAdd').onclick = () => openEditor(null);
    document.getElementById('aiClose').onclick = closeEditor;
    document.getElementById('aiOverlay').onclick = closeEditor;
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const refresh = async () => { await Promise.all([load(), loadCreds()]); render(); };

  function activate() {
    render();
    // Key state is only worth reading once the tab is actually open — every Configuration tab loads
    // this module. The table repaints when it lands, because the API Key column depends on it.
    if (creds === null) loadCreds().then(paintTable);
    window.NMS.onRefresh(refresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    if (activeTab() === TAB) activate();
    document.dispatchEvent(new Event('nms:ai-provider-ready'));
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === TAB) activate();
  });
})();

/* ai-guardrail.js — Configuration ▸ AI Guardrail.
 *
 * One row per engine pretzel-ai runs, and how that engine's turns are inspected.
 *
 * Two engines, configured apart. Chat calls a model and returns; Agent loops through tool calls.
 * They are separate rows and not one setting because the question "what should be inspected here"
 * has different answers — Agent has two checkpoints Chat does not have.
 *
 * The four checkpoints are the places in one turn where something can be looked at, and they carry
 * different consequences:
 *
 *   prompt        before the model is called
 *   response      after it answers, before anyone sees it
 *   tool input    after the model asks for a tool, BEFORE it runs — the one whose skip is
 *                 irreversible, because the tool has already acted by the time anything else looks
 *   tool output   after the tool ran, before its output re-enters the turn, which is where an
 *                 indirect injection arrives
 *
 * Off does not mean "allow". A closed checkpoint reports NOT_INSPECTED, so a scan report says
 * nothing looked at this rather than going quiet.
 *
 * Not every checkpoint exists in every row, and that is a fact about the deployment rather than a
 * setting an operator is being denied:
 *
 *   Chat has no tools at all, so the two tool checkpoints are not off — they do not exist.
 *   The AI gateway cannot see tools either. It builds its scan request from a completion's text
 *   `content`, and `tool_calls` is a sibling of `content` that never reaches the scanner. Measured
 *   on the appliance: the same injection blocks as a user message and passes inside a tool call.
 *
 * So the editor shows all four and greys out what the chosen combination cannot serve, with the
 * reason. An operator who wonders where a checkpoint went gets the answer in the place they looked.
 *
 * Guardrail type decides the completion leg too, and that is not a hidden side effect — it is what
 * the choice means. There is no gateway on the direct path to defer inspection to, so choosing the
 * gateway moves the completion onto it:
 *
 *   No guardrail       vendors called directly, nobody inspects
 *   API Application    vendors called directly, this appliance calls the Prisma AIRS scan API and
 *                      holds the enforcement point
 *   AI Gateway         the gateway routes the completion AND its configuration governs inspection
 *
 * Neither endpoint is configurable. Each is a fact about the service being called and is compiled
 * into pretzel-ai, which has to speak its dialect anyway — a console field for either only bought
 * the chance to point it at something that is not it. They are shown, read-only, because "which
 * host is this appliance talking to" is a fair question to ask of a configuration page.
 *
 * Two stores, one Publish — the same split as AI Provider, for the same reason:
 *
 *   running_config   the service rows: guardrail type, checkpoints, profile, timeouts, turn shape
 *   sealed keys      the AIRS and gateway subscription keys, in ai_guardrail_credential_state.
 *                    They cannot go in running_config: that document is append-versioned, rendered
 *                    verbatim in the review diff and written out by Save-to-file.
 *
 * A typed key is staged browser-local and never enters the commit payload; Publish sends it to
 * POST /api/ai/credential, which seals it with AES-256-GCM and hands it to engined.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  const TAB = 'ai-guardrail';
  const DRAFT_KEY = 'ai-guardrail';
  const SECRET_KEY = 'ai-guardrail-key';
  const SCOPE = 'pretzel-ai';
  const DOMAIN = 'guardrail';

  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const { esc } = window.NMS.utils;

  // ── The two engines ──────────────────────────────────────────────────────────
  const SERVICES = [
    { id: 'chat',  label: 'Chat',  note: 'One model call per turn. No tools.',
      points: ['prompt', 'response'] },
    { id: 'agent', label: 'Agent', note: 'Loops through tool calls.',
      points: ['prompt', 'response', 'tool_call', 'tool_result'],
      // Configurable before it is runnable, on purpose: the row is what the engine will be built
      // from the day the service lands, and an operator setting it up now is not setting up
      // something that will be thrown away.
      unsupported: 'Not served yet — pretzel-ai has no agent engine. The row is stored and applied '
                 + 'when it does.' },
  ];

  // ── The three guardrails ─────────────────────────────────────────────────────
  // "No guardrail" is on the list on purpose: customers run the appliance pointed straight at a
  // vendor with nothing in between, and that shape needs a name here so the reports it produces say
  // "nothing looked at this" instead of going silent.
  const GUARDRAILS = [
    { id: 'none', label: 'No Guardrail', short: 'None',
      note: 'Vendors called directly. Nothing inspects — every checkpoint reports not inspected.',
      points: [], key: null, endpoint: null },
    { id: 'api_application', label: 'API Application', short: 'API App',
      note: 'This appliance calls the Prisma AIRS scan API and holds the enforcement point.',
      points: ['prompt', 'response', 'tool_call', 'tool_result'],
      key: 'airs', keyLabel: 'AIRS API key',
      endpoint: 'https://service.api.aisecurity.paloaltonetworks.com' },
    { id: 'ai_gateway', label: 'AI Gateway', short: 'Gateway',
      note: 'The gateway routes the completion and its own configuration governs inspection.',
      points: ['prompt', 'response'],
      pointsNote: 'The gateway scans a completion’s text content. Tool calls are a sibling of '
                + 'content and never reach the scanner.',
      key: 'portkey', keyLabel: 'Gateway API key',
      endpoint: 'https://aigw.portkey.ai:443/v1/chat/completions' },
  ];

  const POINTS = [
    { id: 'prompt',      label: 'Prompt',      when: 'Before the model is called' },
    { id: 'response',    label: 'Response',    when: 'After it answers, before anyone sees it' },
    { id: 'tool_call',   label: 'Tool input',  when: 'After the model asks for a tool, before it runs',
      warn: 'A tool that ran cannot be un-run — this is the one skip nothing downstream can undo.' },
    { id: 'tool_result', label: 'Tool output', when: 'After the tool ran, before its output re-enters the turn',
      warn: 'Where an indirect injection arrives.' },
  ];

  const serviceOf  = (id) => SERVICES.find(s => s.id === id) || SERVICES[0];
  const guardOf    = (id) => GUARDRAILS.find(g => g.id === id) || GUARDRAILS[0];
  // Where all three agree: the operator asked, the service has it, the guardrail can serve it.
  // pretzel-ai intersects the same three on receipt — this is the console saying the same thing in
  // the place the switch is, not the enforcement.
  const availablePoints = (svcId, guardId) =>
    serviceOf(svcId).points.filter(p => guardOf(guardId).points.includes(p));

  let deployed = [];
  let state = { list: [] };
  let creds = null;
  let sealingAvailable = true;
  let editIdx = null;
  let draft = null;
  let keyDraft = '';
  let saveNote = '';
  let banner = null;

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ── The staged keys ──────────────────────────────────────────────────────────
  // Keyed by credential id, not by row: there is one AIRS subscription and one gateway
  // subscription, and both rows draw on whichever they name.
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

  const keySealed = (id) => !!(id && creds && creds[id] && creds[id].stored);
  // What the appliance will hold after Publish — the staged change laid over what it holds now.
  const keyEffective = (id) => (pending.has(id) ? pending.get(id) !== null : keySealed(id));

  // ── Normalising ──────────────────────────────────────────────────────────────
  function normalizeEntry(e) {
    const src = (e && typeof e === 'object') ? e : {};
    const service = SERVICES.some(s => s.id === src.service) ? src.service : SERVICES[0].id;
    const guardrail = GUARDRAILS.some(g => g.id === src.guardrail) ? src.guardrail : 'none';
    const cp = (src.checkpoints && typeof src.checkpoints === 'object') ? src.checkpoints : {};
    const airs = (src.airs && typeof src.airs === 'object') ? src.airs : {};
    const gw = (src.gateway && typeof src.gateway === 'object') ? src.gateway : {};
    const shape = (src.shape && typeof src.shape === 'object') ? src.shape : {};
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

    // Only the points this combination actually has. A checkpoint chat cannot reach is not stored
    // as `false` and not as `null` — it is absent, because absence is the one spelling that says
    // "there is no such point here" rather than "there is one and it is off". Writing `true` for it
    // (which is what happened before) recorded a promise the appliance cannot keep, and put it in
    // the review diff where someone would read it as coverage.
    //
    // Load and save produce the same shape on purpose: a normaliser that defaulted absent points to
    // `true` on the way in and dropped them on the way out would make every entry look dirty.
    const out = { service, guardrail, checkpoints: {} };
    availablePoints(service, guardrail).forEach(id => {
      out.checkpoints[id] = cp[id] === undefined ? true : !!cp[id];
    });
    out.airs = {
      profile_name: String(airs.profile_name || ''),
      timeout_sec: num(airs.timeout_sec, 30),
      fail_open: !!airs.fail_open,
    };
    out.gateway = {
      require_verdict: !!gw.require_verdict,
      timeout_sec: num(gw.timeout_sec, 45),
    };
    out.shape = {
      system_prompt: String(shape.system_prompt || ''),
      max_tokens: num(shape.max_tokens, 4096),
    };
    return out;
  }

  const normalize = (scope) => {
    const src = (scope && typeof scope === 'object') ? scope : {};
    const raw = Array.isArray(src.list) ? src.list : [];
    return raw.filter(e => e && SERVICES.some(s => s.id === e.service)).map(normalizeEntry);
  };

  const takenIds = (exceptIdx) => state.list.filter((_, i) => i !== exceptIdx).map(e => e.service);
  const freeServices = (exceptIdx) => SERVICES.filter(s => !takenIds(exceptIdx).includes(s.id));

  // Which credential ids the current rows actually reference. A key for a guardrail nothing
  // selects is not a problem worth reporting.
  const usedKeyIds = () =>
    [...new Set(state.list.map(e => guardOf(e.guardrail).key).filter(Boolean))];

  // ── Staging ──────────────────────────────────────────────────────────────────
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.list); window.NMS.staging.refresh(); };

  async function load() {
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      deployed = normalize(((d.scopes || {})[SCOPE] || {})[DOMAIN]);
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

  const commitPayload = () => [{ scope: SCOPE, domain: DOMAIN, values: { list: state.list } }];

  // Every key that matters to these rows, as a word. Never a value.
  //
  // Not cosmetic: commitFlow returns early when `before` and `after` serialise the same, so a
  // Publish that changed ONLY a key would enable the button, open nothing, and store nothing.
  // "replaced" rather than "sealed" when one was already stored, so overwriting is a visible
  // difference and not two identical lines.
  const keyStateView = (staged) => {
    const out = {};
    GUARDRAILS.filter(g => g.key).forEach(g => {
      const sealed = keySealed(g.key);
      if (!staged || !pending.has(g.key)) { out[g.keyLabel] = sealed ? 'sealed' : 'not set'; return; }
      const value = pending.get(g.key);
      out[g.keyLabel] = value === null ? 'not set' : (sealed ? 'sealed (replaced)' : 'sealed');
    });
    return out;
  };

  window.NMS.staging.register({
    key: DRAFT_KEY,
    // A key-only change is still a change. Without this the Publish button stays dark and the key
    // the operator entered sits in the browser until something else happens to be dirty.
    dirty: () => JSON.stringify(state.list) !== JSON.stringify(deployed) || pending.any(),
    payload: commitPayload,
    before: () => ({ ai_guardrail: deployed, api_keys: keyStateView(false) }),
    after: () => ({ ai_guardrail: state.list, api_keys: keyStateView(true) }),
    onPublished() {
      deployed = clone(state.list);
      window.NMS.draft.clear(DRAFT_KEY);
      applyPendingKeys();
    },
    // Only what would publish BROKEN, which is the heading this list is rendered under. A
    // checkpoint switched off and fail-open are deliberate choices made on this page; listing them
    // as problems would train people to publish through the warning, which is exactly what has to
    // still work the day one of them is a real mistake. Those are said on the page, at the switch.
    problems() {
      const out = [];
      state.list.forEach(e => {
        const g = guardOf(e.guardrail);
        const s = serviceOf(e.service);
        if (g.id === 'api_application' && !e.airs.profile_name.trim())
          out.push(`${s.label} has no AIRS profile name — pretzel-ai will refuse the deployment.`);
        // Judged against what Publish will leave behind, not what is stored now: a key entered in
        // this same batch is about to be sealed.
        if (g.key && creds && !keyEffective(g.key))
          out.push(`${s.label} uses ${g.label} but no ${g.keyLabel} is stored — pretzel-ai will `
                 + 'refuse the deployment.');
      });
      return out;
    },
  });

  // ── Key store ────────────────────────────────────────────────────────────────
  // Sent on Publish, never before, then the appliance is re-read so what the page reports is the
  // stored state rather than this function's optimism.
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
      } catch (e) { failed.push(`${id}: ${e.message || e}`); }
    }

    // Cleared whether or not every request landed. A staged key that failed is not worth retrying
    // silently on the next unrelated Publish — the operator is told, and re-enters it if they mean
    // to. Keeping it would make a later Publish do something nobody asked for.
    pending.clear();
    keyDraft = '';
    await loadCreds();
    banner = failed.length
      ? { bad: true, text: `Could not store ${failed.length} key: ${failed.join('; ')}` }
      : null;
    window.NMS.staging.refresh();
    render();
  }

  // ── Table ────────────────────────────────────────────────────────────────────
  function checkpointsCell(e) {
    const g = guardOf(e.guardrail);
    if (!g.points.length) return '<span class="muted">none</span>';
    const avail = availablePoints(e.service, e.guardrail);
    const on = avail.filter(p => e.checkpoints[p]);   // absent keys are not in `avail`
    // Pills rather than a count. Which points are live is the fact a scan report has to be read
    // against, and "2 of 4" does not say which two.
    return `<div class="gr-pills">${POINTS.map(p => {
      const cls = !avail.includes(p.id) ? 'is-na' : (e.checkpoints[p.id] ? 'is-on' : 'is-off');
      const why = !avail.includes(p.id) ? 'Not available in this combination'
                : (e.checkpoints[p.id] ? 'Inspected' : 'Not inspected');
      return `<span class="gr-pill ${cls}" title="${esc(p.label)} — ${esc(why)}">${esc(p.label)}</span>`;
    }).join('')}<span class="gr-pill-n">${on.length}/${avail.length}</span></div>`;
  }

  function keyCell(e) {
    const g = guardOf(e.guardrail);
    const dot = (cls, label) => `<span class="ai-key ${cls}"><i></i>${esc(label)}</span>`;
    if (!g.key) return '<span class="muted">not needed</span>';
    if (pending.has(g.key)) {
      return pending.get(g.key) === null
        ? dot('is-drop', 'Removing on publish')
        : dot('is-staged', 'Staged for publish');
    }
    if (creds === null) return dot('is-unknown', 'Unknown');
    if (!keySealed(g.key)) return dot('is-none', 'Not set');
    const at = (creds[g.key] || {}).updated_at;
    return `<span title="${esc(at ? 'Sealed ' + window.NMS.utils.fmtTs(at) : 'Sealed')}">${
      dot('is-set', 'Sealed')}</span>`;
  }

  const table = window.NMS.table.create({
    id: 'cfg.aiGuardrail',
    tableClass: 'cfg-table-aiguard',
    searchPlaceholder: 'Search guardrails…',
    empty: `<div class="cfg-empty">No service is configured — click <b>Add Guardrail</b> to add one.
              A row says which engine it configures, who inspects its turns, and at which points.
              Configure <b>AI Provider</b> first: a service with no models cannot serve a turn.</div>`,
    onRows: (tbody) => {
      tbody.querySelectorAll('[data-edit]').forEach(b =>
        b.addEventListener('click', () => openEditor(+b.dataset.edit)));
      tbody.querySelectorAll('[data-del]').forEach(b =>
        b.addEventListener('click', () => removeEntry(+b.dataset.del)));
    },
    columns: [
      { key: 'service', label: 'Service', cls: 'col-name', filter: 'enum',
        text: (e) => serviceOf(e.service).label,
        searchText: (e) => `${serviceOf(e.service).label} ${e.service}`,
        cell: (e) => {
          const s = serviceOf(e.service);
          return `<div class="cell-name">${esc(s.label)}${s.unsupported
            ? '<span class="gr-tag" title="' + esc(s.unsupported) + '">not served yet</span>' : ''}
            <span class="ai-fam">${esc(s.note)}</span></div>`;
        } },
      { key: 'guardrail', label: 'Guardrail', cls: 'col-guard', filter: 'enum',
        text: (e) => guardOf(e.guardrail).label,
        searchText: (e) => `${guardOf(e.guardrail).label} ${e.guardrail}`,
        cell: (e) => {
          const g = guardOf(e.guardrail);
          return `<div class="cell-name">${esc(g.label)}${
            g.id === 'none' ? '' : `<span class="ai-fam mono-val">${esc(g.endpoint)}</span>`}</div>`;
        } },
      { key: 'points', label: 'Checkpoints', cls: 'col-points', sort: false,
        searchText: (e) => POINTS.filter(p => e.checkpoints[p.id]).map(p => p.label).join(' '),
        cell: checkpointsCell },
      { key: 'key', label: 'API Key', cls: 'col-key', filter: 'enum',
        text: (e) => {
          const g = guardOf(e.guardrail);
          if (!g.key) return 'Not needed';
          if (pending.has(g.key)) return pending.get(g.key) === null ? 'Removing' : 'Staged';
          if (creds === null) return 'Unknown';
          return keySealed(g.key) ? 'Sealed' : 'Not set';
        },
        cell: keyCell },
      { key: 'act', label: '', cls: 'col-act', sort: false,
        cell: (e, i) => `
          <button class="icon-btn" data-edit="${i}" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
          </button>
          <button class="icon-btn danger" data-del="${i}" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` },
    ],
  });

  const paintTable = () => {
    const host = document.getElementById('grTable');
    if (host) table.mount(host, state.list);
    const meta = document.getElementById('grMeta');
    if (meta) {
      const n = state.list.length;
      const keys = Object.keys(pending.all()).length;
      meta.textContent = `${n} service${n === 1 ? '' : 's'} configured`
        + (keys ? ` · ${keys} key change${keys > 1 ? 's' : ''} pending publish` : '');
    }
  };

  async function removeEntry(idx) {
    const e = state.list[idx];
    if (!e) return;
    const ok = await window.NMS.confirm({
      title: 'Remove guardrail',
      message: `Remove the ${serviceOf(e.service).label} guardrail?`,
      detail: "Its turns fall back to pretzel-ai's defaults, which inspect everything.",
    });
    if (!ok) return;
    state.list.splice(idx, 1);
    stage();
    paintTable();
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  function editorForm() {
    const g = guardOf(draft.guardrail);
    const s = serviceOf(draft.service);
    const taken = takenIds(editIdx);
    const free = freeServices(editIdx);

    // Every service is listed and the ones already configured are disabled in place rather than
    // dropped. A list that silently omitted them leaves an operator staring at an empty picker
    // with nothing to tell them why.
    const picker = editIdx == null
      ? `<select data-f="service">
           ${!free.length ? '<option value="" selected>Both services are already configured</option>' : ''}
           ${SERVICES.map(x => {
             const isTaken = taken.includes(x.id);
             return `<option value="${esc(x.id)}"${isTaken ? ' disabled' : ''}${
               x.id === draft.service ? ' selected' : ''}>${esc(x.label)}${
               isTaken ? ' — already configured' : ''}</option>`;
           }).join('')}
         </select>`
      : `<div class="ep-fixed">${esc(s.label)}<span class="lbl-sub">${esc(s.note)}</span></div>`;

    return `
      <div class="field-row"><label>Service</label>${picker}</div>
      ${s.unsupported ? `<div class="gr-notice">${esc(s.unsupported)}</div>` : ''}

      <div class="ed-sec">
        <div class="ed-sec-h">Guardrail type</div>
        <div class="gr-kinds">
          ${GUARDRAILS.map(k => `
            <label class="gr-kind${draft.guardrail === k.id ? ' on' : ''}">
              <input type="radio" name="grKind" value="${esc(k.id)}"${draft.guardrail === k.id ? ' checked' : ''}>
              <span class="gr-kind-t">${esc(k.label)}</span>
              <span class="gr-kind-n">${esc(k.note)}</span>
            </label>`).join('')}
        </div>
      </div>

      ${g.endpoint ? `
      <div class="ed-sec">
        <div class="ed-sec-h">${esc(g.label)}</div>
        <div class="field-row"><label>Endpoint</label>
          <input type="text" value="${esc(g.endpoint)}" readonly>
        </div>
        ${g.id === 'api_application' ? `
        <div class="field-row"><label>Profile name</label>
          <input type="text" data-f="airs.profile_name" spellcheck="false"
                 value="${esc(draft.airs.profile_name)}" placeholder="AIRS_Security_Profile"></div>
        <div class="field-row"><label>Timeout</label>
          <input type="number" data-f="airs.timeout_sec" min="1" step="1"
                 value="${esc(String(draft.airs.timeout_sec))}"><span class="gr-unit">seconds</span></div>
        <label class="gr-check">
          <input type="checkbox" data-f="airs.fail_open"${draft.airs.fail_open ? ' checked' : ''}>
          <span><b>Fail open</b>
            <em>A scan that cannot be reached lets the turn through. Off is the safe reading: a
            guardrail that cannot rule stops the turn.</em></span>
        </label>` : `
        <div class="field-row"><label>Timeout</label>
          <input type="number" data-f="gateway.timeout_sec" min="1" step="1"
                 value="${esc(String(draft.gateway.timeout_sec))}"><span class="gr-unit">seconds</span></div>
        <label class="gr-check">
          <input type="checkbox" data-f="gateway.require_verdict"${draft.gateway.require_verdict ? ' checked' : ''}>
          <span><b>Require a verdict</b>
            <em>Fail a turn the gateway did not inspect. Without this, deferring means trusting
            that something over there was configured to look.</em></span>
        </label>`}
        <div class="field-row"><label>${esc(g.keyLabel)}</label>${keyBlock(g)}</div>
      </div>` : ''}

      ${g.points.length ? `
      <div class="ed-sec">
        <div class="ed-sec-h">Checkpoints</div>
        ${g.pointsNote ? `<p class="gr-sec-note">${esc(g.pointsNote)}</p>` : ''}
        <div class="gr-points">${POINTS.map(pointRow).join('')}</div>
      </div>` : ''}

      <div class="ed-sec">
        <div class="ed-sec-h">Turn shape</div>
        <div class="field-row"><label>System prompt</label>
          <textarea data-f="shape.system_prompt" rows="3"
            placeholder="Leave empty to use pretzel-ai's own default">${esc(draft.shape.system_prompt)}</textarea></div>
        <div class="field-row"><label>Max tokens</label>
          <input type="number" data-f="shape.max_tokens" min="1" step="1"
                 value="${esc(String(draft.shape.max_tokens))}"></div>
      </div>`;
  }

  function pointRow(p) {
    const avail = availablePoints(draft.service, draft.guardrail).includes(p.id);
    const on = avail && !!draft.checkpoints[p.id];
    // Why it is unavailable, said where it is missing. The two reasons are different and an
    // operator debugging a gap needs to know which one they are looking at.
    const why = !avail
      ? (!serviceOf(draft.service).points.includes(p.id)
          ? `${serviceOf(draft.service).label} has no tools, so this point does not exist in a turn.`
          : `The ${guardOf(draft.guardrail).label} cannot see tool calls.`)
      : '';
    return `<label class="gr-point${avail ? (on ? '' : ' is-off') : ' is-na'}">
        <input type="checkbox" data-point="${p.id}"${on ? ' checked' : ''}${avail ? '' : ' disabled'}>
        <span class="gr-point-b">
          <span class="gr-point-t">${esc(p.label)}</span>
          <span class="gr-point-w">${esc(avail ? p.when : why)}</span>
          ${p.warn && avail && !on ? `<span class="gr-point-warn">${esc(p.warn)}</span>` : ''}
        </span>
        <span class="gr-point-s">${avail ? (on ? 'Inspected' : 'Not inspected') : 'n/a'}</span>
      </label>`;
  }

  function keyBlock(g) {
    if (!sealingAvailable) {
      return `<div class="gr-key-off">This appliance has no <code>credentials.key</code> — a key
        cannot be sealed here.</div>`;
    }
    if (pending.has(g.key)) {
      const removing = pending.get(g.key) === null;
      return `<div class="gr-key-staged">
          <span class="ai-key ${removing ? 'is-drop' : 'is-staged'}"><i></i>${
            removing ? 'Removing on publish' : 'Staged for publish'}</span>
          <button class="btn-sm" id="grKeyUndo" type="button">Undo</button>
        </div>`;
    }
    const sealed = keySealed(g.key);
    const at = sealed ? (creds[g.key] || {}).updated_at : '';
    return `<div class="gr-key">
        <input type="password" data-key="${esc(g.key)}" autocomplete="off" spellcheck="false"
               placeholder="${sealed ? 'Sealed — type to replace' : 'Paste the API key'}"
               value="${esc(keyDraft)}">
        ${sealed ? '<button class="btn-sm danger" id="grKeyClear" type="button">Remove</button>' : ''}
      </div>
      ${sealed && at ? `<div class="gr-hint">Sealed ${esc(window.NMS.utils.fmtTs(at))}</div>` : ''}`;
  }

  function paintEditor() {
    const body = document.getElementById('grBody');
    if (!body || !draft) return;
    body.innerHTML = editorForm();
    // The OS draws a native <select>'s option list and no CSS reaches it, so the picker arrived in
    // Windows/macOS/Linux chrome in the middle of a themed panel — and the "already configured"
    // rows came out in the browser's own grey rather than this console's. The shared enhancer
    // swaps in a themed dropdown and keeps the <select> as the value store, so `.value` reads and
    // the change listener below go on working.
    window.NMS.utils.enhanceSelects(body);
    window.NMS.utils.clearInvalid(body);
    const note = document.getElementById('grSaveNote');
    if (note) note.textContent = saveNote;
    wireEditor();
  }

  function openEditor(idx) {
    editIdx = idx;
    if (idx == null) {
      const free = freeServices(null);
      draft = normalizeEntry({ service: free.length ? free[0].id : '' });
      if (!free.length) draft.service = '';
    } else {
      draft = clone(state.list[idx]);
    }
    keyDraft = ''; saveNote = '';

    document.getElementById('grTitle').textContent = idx == null ? 'Add Guardrail' : 'Edit Guardrail';
    document.getElementById('grFoot').innerHTML = `
      <span class="ed-foot-note" id="grSaveNote"></span>
      <button class="btn-sm" id="grCancel" type="button">Cancel</button>
      <button class="btn-primary btn-sm" id="grSave" type="button">Save</button>`;
    paintEditor();

    document.getElementById('grCancel').onclick = closeEditor;
    document.getElementById('grSave').onclick = saveEditor;

    document.getElementById('grOverlay').classList.add('open');
    document.getElementById('grPanel').classList.add('open');
  }

  const closeEditor = () => {
    editIdx = null; draft = null; keyDraft = ''; saveNote = '';
    document.getElementById('grOverlay').classList.remove('open');
    document.getElementById('grPanel').classList.remove('open');
  };

  function saveEditor() {
    const mark = (note, field) => {
      saveNote = note;
      paintEditor();
      window.NMS.utils.markInvalid(document.getElementById('grBody'), field);
    };

    // Reachable only from the all-configured case, where the picker has nothing selectable.
    if (!draft.service)
      return mark('Both services are already configured — edit one of them instead.', '[data-f="service"]');

    const g = guardOf(draft.guardrail);
    if (g.id === 'api_application' && !draft.airs.profile_name.trim())
      return mark('Enter the AIRS profile name.', '[data-f="airs.profile_name"]');

    // A guardrail with no key would be committed and then refused by pretzel-ai, and the operator
    // is standing in the one panel where they can fix it.
    if (g.key && !keyDraft.trim() && !keyEffective(g.key))
      return mark(`Enter the ${g.keyLabel}.`, '[data-key]');

    // The key leaves the panel the same way the rest of it does — staged, not applied. It goes to
    // its own store rather than into the entry, so it cannot reach the commit payload even by
    // accident, but it is committed to by the same button.
    if (g.key && keyDraft.trim()) pending.set(g.key, keyDraft.trim());

    // Normalised on the way out: a cleared number field reads back as 0 or NaN, and mgmtd refuses
    // a non-positive timeout — better fixed here than surfaced as a rejected commit.
    const out = normalizeEntry(draft);
    if (editIdx == null) state.list.push(out);
    else state.list[editIdx] = out;

    stage();
    closeEditor();
    paintTable();
  }

  function wireEditor() {
    const body = document.getElementById('grBody');

    body.querySelector('select[data-f="service"]')?.addEventListener('change', (e) => {
      draft.service = e.target.value;
      saveNote = '';
      paintEditor();
    });

    body.querySelectorAll('input[name="grKind"]').forEach(r => r.addEventListener('change', (e) => {
      draft.guardrail = e.target.value;
      keyDraft = '';
      saveNote = '';
      paintEditor();
    }));

    // Dotted paths, so one handler covers airs.*, gateway.* and shape.* without a branch per field.
    const put = (path, value) => {
      const [head, tail] = path.split('.');
      if (tail) draft[head][tail] = value; else draft[head] = value;
    };
    body.querySelectorAll('[data-f]').forEach(inp => {
      if (inp.tagName === 'SELECT') return;
      if (inp.type === 'checkbox') {
        inp.addEventListener('change', () => { put(inp.dataset.f, inp.checked); paintEditor(); });
        return;
      }
      if (inp.readOnly) return;
      // No repaint on input: a repaint per keystroke would take the caret with it.
      inp.addEventListener('input', () => {
        put(inp.dataset.f, inp.type === 'number' ? Number(inp.value) : inp.value);
      });
    });

    body.querySelectorAll('input[data-point]').forEach(inp => inp.addEventListener('change', () => {
      draft.checkpoints[inp.dataset.point] = inp.checked;
      paintEditor();
    }));

    const key = body.querySelector('input[data-key]');
    key?.addEventListener('input', () => { keyDraft = key.value; });

    // Removal is an intent, not an action: staged like everything else, taking effect on Publish.
    // Pressing Undo withdraws the intent.
    document.getElementById('grKeyClear')?.addEventListener('click', () => {
      pending.set(guardOf(draft.guardrail).key, null);
      keyDraft = '';
      paintEditor();
      paintTable();
    });
    document.getElementById('grKeyUndo')?.addEventListener('click', () => {
      pending.drop(guardOf(draft.guardrail).key);
      keyDraft = '';
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
            <span class="cfg-h">AI Guardrail</span>
            <span class="cfg-h-sub" id="grMeta"></span>
          </div>
          <button class="btn-primary btn-sm" id="grAdd">+ Add Guardrail</button>
        </div>

        ${banner ? `<div class="ai-banner${banner.bad ? ' bad' : ''}">${esc(banner.text)}</div>` : ''}

        <div id="grTable"></div>

      </div>

      <div class="slideover-overlay" id="grOverlay"></div>
      <aside class="slideover" id="grPanel">
        <div class="slideover-head">
          <span class="slideover-title" id="grTitle">Guardrail</span>
          <button class="slideover-close" id="grClose" type="button">&times;</button>
        </div>
        <div class="slideover-body" id="grBody"></div>
        <div class="slideover-foot" id="grFoot"></div>
      </aside>`;

    paintTable();

    document.getElementById('grAdd').onclick = () => openEditor(null);
    document.getElementById('grClose').onclick = closeEditor;
    document.getElementById('grOverlay').onclick = closeEditor;
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const refresh = async () => { await Promise.all([load(), loadCreds()]); render(); };

  function activate() {
    render();
    // Key state is only worth reading once the tab is actually open — every Configuration tab
    // loads this module. The table repaints when it lands, because the API Key column needs it.
    if (creds === null) loadCreds().then(paintTable);
    window.NMS.onRefresh(refresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    if (activeTab() === TAB) activate();
    document.dispatchEvent(new Event('nms:ai-guardrail-ready'));
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === TAB) activate();
  });
})();

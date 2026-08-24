/* operation.js — Configuration ▸ System Management ▸ Operation.
 *
 * Running-configuration lifecycle, five actions on one card:
 *   View   — open the running-config document
 *   Save   — snapshot the running-config to a named file on the appliance (/etc/pretzel/saved-configs)
 *   Load   — pick one of those on-box snapshots and apply it (commit + reload)
 *   Export — pick an on-box snapshot and download it to the local device
 *   Import — upload a config file; it is only stored into the appliance's saved-configs (applying
 *            it is left to Load), so nothing is committed or reloaded by Import itself
 *
 * Save / Load / Export share one picker built from the appliance's saved-config list. Load
 * decomposes the chosen document into the per-domain {daemon, domain, values} changes the editors
 * emit and commits them through /api/settings/commit — the same validated path a normal edit takes.
 * No staging provider: nothing here is edited into the pending set.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  const activeTab = () => new URLSearchParams(location.search).get('tab') || 'sites';
  const { esc } = window.NMS.utils;
  const modal = () => window.NMS.modal;

  // Trim Postgres' fractional seconds + offset tail: "2026-07-27 14:08:00.435975+09" -> "…14:08:00".
  const trimTs = (s) => (s ? String(s).split('.')[0] : '—');

  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const IC = {
    view: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    save: svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>'),
    load: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
    imp: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
    exp: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  };

  let running = null;   // { version, committed_at, config }
  let msg = null;       // { text, err } — transient feedback on the page

  const getJson = (url) =>
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(r => (r.status === 401 ? (location.href = '/', null) : (r.ok ? r.json() : null)))
      .catch(() => null);

  const fmtWhen = (ts) => (ts ? window.NMS.utils.fmtTs(ts * 1000) : '—');

  async function load() {
    const rc = await getJson('/api/settings/running-config');
    running = rc && rc.config ? rc : null;
  }

  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== 'operation') return;

    const staged = window.NMS.staging && window.NMS.staging.anyDirty();

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">Operation</span>
            <span class="cfg-h-sub">view, save, load, export &amp; import the running configuration and the benchtest sets</span>
          </div>
        </div>

        <div class="info-card op-card">
          <div class="info-card-title">Running Configuration
            <span class="info-hint">${running ? 'v' + esc(running.version) : '—'}</span></div>

          <div class="info-row"><span class="info-label">Version</span>
            <span class="info-value">${running ? esc(running.version) : '—'}</span></div>
          <div class="info-row"><span class="info-label">Committed</span>
            <span class="info-value">${running ? esc(trimTs(running.committed_at)) : '—'}</span></div>

          ${staged ? '<p class="field-hint"><b class="rc-dirty">Staged changes are not included.</b></p>' : ''}

          <div class="op-toolbar">
            <button class="op-btn" id="opView" ${running ? '' : 'disabled'}>${IC.view}<span>View</span></button>
            <span class="op-sep"></span>
            <button class="op-btn" id="opImport" title="Upload a config file to the appliance">${IC.imp}<span>Import</span></button>
            <button class="op-btn" id="opExport" title="Download a saved config to this device">${IC.exp}<span>Export</span></button>
            <span class="op-sep"></span>
            <button class="op-btn" id="opSave" ${running ? '' : 'disabled'} title="Snapshot the running config to the appliance">${IC.save}<span>Save</span></button>
            <button class="op-btn op-btn-load" id="opLoad" title="Apply a saved config and reload">${IC.load}<span>Load</span></button>
            <input type="file" id="opFile" accept="application/json,.json" hidden>
          </div>

          ${msg ? `<div class="op-msg ${msg.err ? 'err' : 'ok'}">${esc(msg.text)}</div>` : ''}
        </div>

        <!-- techdoc.js and benchtest-card.js own these. Mounted rather than inlined because the
             render above replaces #contentBody wholesale, which would wipe anything they drew. -->
        <div id="techdocMount"></div>
        <div id="benchtestMount"></div>
      </div>`;

    wire();
    if (window.NMS.techdoc) window.NMS.techdoc.mount();
    if (window.NMS.benchtestCard) window.NMS.benchtestCard.mount();
  }

  function setMsg(text, err) { msg = { text, err: !!err }; render(); }

  // ── Apply path (shared by Load and Import) ─────────────────────────────────────────────
  function toChanges(config) {
    const changes = [];
    Object.keys(config || {}).forEach((daemon) => {
      const svc = config[daemon] && config[daemon].service;
      if (!svc || typeof svc !== 'object') return;
      Object.keys(svc).forEach((domain) => {
        const values = svc[domain];
        if (values && typeof values === 'object' && !Array.isArray(values)) changes.push({ daemon, domain, values });
      });
    });
    return changes;
  }

  const unwrap = (parsed) =>
    (parsed && parsed.config && typeof parsed.config === 'object') ? parsed.config : parsed;

  async function applyConfig(config) {
    const changes = toChanges(config);
    if (!changes.length) { setMsg('No configuration sections found in that document.', true); return; }
    let d = {};
    try {
      const r = await fetch('/api/settings/commit', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ changes }),
      });
      if (r.status === 401) { location.href = '/'; return; }
      d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    } catch (e) { setMsg('Apply failed: ' + e.message, true); return; }

    if (!d.applied) { setMsg('Nothing applied — no section was accepted.', true); return; }
    // No "skipped" count to report: a commit is accepted whole or rejected whole, so anything that
    // failed validation came back above as a rejection with nothing applied.
    setMsg(`Applied ${d.applied} section(s). The daemons are reloading onto it.`, false);
    await load(); render();
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // ── Shared saved-config picker (Save / Load / Export) ──────────────────────────────────
  const TITLE = { save: 'Save configuration', load: 'Load configuration', export: 'Export configuration' };

  function listHtml(files, mode) {
    if (!files.length) return '<div class="sc-empty">No saved configurations on the appliance yet.</div>';
    return files.map(f => `
      <div class="sc-row"${mode === 'save' ? ` data-pick="${esc(f.name)}"` : ''}>
        <span class="sc-name">${esc(f.name)}</span>
        <span class="sc-meta">
          <span class="op-when">${esc(fmtWhen(f.saved_at))}</span>
          ${mode === 'load' ? `<button class="btn-sm btn-primary" data-load="${esc(f.name)}">Load</button>` : ''}
          ${mode === 'export' ? `<button class="btn-sm" data-export="${esc(f.name)}">Download</button>` : ''}
        </span>
      </div>`).join('');
  }

  async function openPicker(mode) {
    const files = (await getJson('/api/settings/saved-configs')) || [];
    const list = `<div class="sc-list">${listHtml(files, mode)}</div>`;
    const body = mode === 'save'
      ? `<div class="sc-saveform">
           <input type="text" id="scName" class="sc-input" placeholder="configuration name"
                  autocomplete="off" spellcheck="false" />
           <button class="btn-sm btn-primary" id="scSaveBtn">Save</button>
         </div>
         <div class="sc-hint">Letters, digits, dot, dash, underscore. Existing files (click to reuse a name):</div>
         ${list}`
      : list;

    const ov = modal().open(TITLE[mode], body);
    wirePicker(ov, mode);
  }

  function wirePicker(ov, mode) {
    if (mode === 'save') {
      const input = ov.querySelector('#scName');
      ov.querySelectorAll('[data-pick]').forEach(row =>
        row.addEventListener('click', () => { input.value = row.getAttribute('data-pick'); input.focus(); }));
      const doSave = async () => {
        const name = (input.value || '').trim();
        if (!name) { input.focus(); return; }
        try {
          const r = await fetch('/api/settings/save-config', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (r.status === 401) { location.href = '/'; return; }
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
          modal().close();
          setMsg(`Saved to the appliance as "${name}".`, false);
        } catch (e) { setMsg('Save failed: ' + e.message, true); modal().close(); }
      };
      ov.querySelector('#scSaveBtn').addEventListener('click', doSave);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
      input.focus();
      return;
    }

    if (mode === 'load') {
      ov.querySelectorAll('[data-load]').forEach(btn => btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-load');
        if (!window.confirm(`Load "${name}" and apply it? It is committed as a new running-config version `
                            + 'and the daemons reload onto it.')) return;
        const doc = await getJson('/api/settings/saved-config-content?name=' + encodeURIComponent(name));
        modal().close();
        if (!doc) { setMsg('Could not read that saved configuration.', true); return; }
        applyConfig(unwrap(doc));
      }));
      return;
    }

    // export
    ov.querySelectorAll('[data-export]').forEach(btn => btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-export');
      const doc = await getJson('/api/settings/saved-config-content?name=' + encodeURIComponent(name));
      if (!doc) { setMsg('Could not read that saved configuration.', true); return; }
      download(`${name}.json`, JSON.stringify(doc, null, 2));
    }));
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────────────────
  function wire() {
    document.getElementById('opView')?.addEventListener('click', () => {
      if (typeof window.NMS.viewRunningConfig === 'function') window.NMS.viewRunningConfig();
    });
    document.getElementById('opSave')?.addEventListener('click', () => { if (running) openPicker('save'); });
    document.getElementById('opLoad')?.addEventListener('click', () => openPicker('load'));
    document.getElementById('opExport')?.addEventListener('click', () => openPicker('export'));

    // Import only lands the file in the appliance's saved-configs (named after the upload); applying
    // it is left to Load, so nothing is committed or reloaded here.
    const file = document.getElementById('opFile');
    document.getElementById('opImport')?.addEventListener('click', () => file && file.click());
    file?.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const text = await f.text();
      try { JSON.parse(text); } catch (_) { setMsg('That file is not valid JSON.', true); return; }
      const name = (f.name.replace(/\.json$/i, '') || 'imported').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
      try {
        const r = await fetch('/api/settings/save-config', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ name, content: text }),
        });
        if (r.status === 401) { location.href = '/'; return; }
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
        setMsg(`Imported to the appliance as "${name}". Use Load to apply it.`, false);
      } catch (e2) { setMsg('Import failed: ' + e2.message, true); }
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const operationRefresh = async () => { msg = null; await load(); render(); };

  function activate() {
    render();
    operationRefresh();
    window.NMS.onRefresh(operationRefresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (activeTab() !== 'operation') return;
    await load();
    activate();
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === 'operation') activate();
  });
})();

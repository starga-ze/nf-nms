/* sites.js — Configuration ▸ Site.
 *
 * A Site is one customer. Devices belong to a site, and a site is judged by what is in it —
 * hence the device mix rather than a bare count. Devices reference a site by `oid`, the UUID
 * issued at creation; pretzel uses one identifier per object, named oid.
 *
 * Committed under pretzel.site.sites. Loaded on every Configuration tab so the
 * Inventory picker and site columns resolve names from anywhere; rendered only on its own tab.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  // Read live (not once): settings tabs switch client-side without a page load (see main.js).
  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const DRAFT_KEY = 'sites';

  const { esc, newUuid } = window.NMS.utils;

  const state = { sites: [] };
  let deployed = [];
  let editIdx = null;
  let draftOid = null;

  function normalize(s) {
    return {
      // `uuid` = legacy key; a numeric oid predates the merge and is replaced.
      oid: (typeof s.oid === 'string' && s.oid) ? s.oid : (s.uuid || newUuid()),
      name: s.name || '',
      description: s.description || '',
    };
  }

  const blank = () => normalize({});

  // ── Staging ──────────────────────────────────────────────────────────────────
  // Dirty state and publish are owned by the cross-tab staging registry (js/commit.js).
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.sites); refreshPending(); };
  const refreshPending = () => window.NMS.staging.refresh();

  // ── Cross-module surface ─────────────────────────────────────────────────────
  window.NMS.sites = {
    list: () => state.sites.map(s => ({ oid: s.oid, name: s.name })),
    label: (oid) => {
      const s = state.sites.find(x => x.oid === oid);
      return s ? s.name : null;
    },
  };

  // ── Data load ────────────────────────────────────────────────────────────────
  async function load() {
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      const site = ((d.scopes || {}).pretzel || {}).site || {};
      deployed = (Array.isArray(site.sites) ? site.sites : []).map(normalize);
    } catch (_) { deployed = []; }
    const staged = window.NMS.draft.get(DRAFT_KEY, null);
    state.sites = Array.isArray(staged) ? staged.map(normalize) : JSON.parse(JSON.stringify(deployed));
    refreshPending();
  }

  const commitPayload = () => [{ scope: 'pretzel', domain: 'site', values: { sites: state.sites } }];

  // ── Staging provider ─────────────────────────────────────────────────────────
  window.NMS.staging.register({
    key: DRAFT_KEY,
    dirty: () => JSON.stringify(state.sites) !== JSON.stringify(deployed),
    payload: commitPayload,
    before: () => ({ sites: deployed }),
    after: () => ({ sites: state.sites }),
    onPublished() {
      deployed = JSON.parse(JSON.stringify(state.sites));
      window.NMS.draft.clear(DRAFT_KEY);
    },
  });

  // ── Render ───────────────────────────────────────────────────────────────────
  // A site is judged by what is in it, so the count is broken down by device type rather than
  // reduced to a single number. The breakdown is asked three ways — as markup for the cell, as text
  // for the search box, and as a total to order and filter by — so it is counted once here.
  function deviceCounts(oid) {
    const devices = (window.NMS.devices && window.NMS.devices.list()) || [];
    const counts = {};
    let total = 0;
    devices.forEach(d => {
      if (d.site !== oid) return;
      counts[d.device_type] = (counts[d.device_type] || 0) + 1;
      total++;
    });
    return { counts, total };
  }

  function deviceMix(oid) {
    const { counts, total } = deviceCounts(oid);
    if (!total) return `<span class="muted">empty</span>`;
    return Object.keys(counts).map(t =>
      `<span class="mix-item"><b>${counts[t]}</b> ${esc(window.NMS.devices.typeLabel(t))}</span>`).join('');
  }

  function deviceText(oid) {
    const { counts, total } = deviceCounts(oid);
    if (!total) return '';
    return Object.keys(counts).map(t => `${counts[t]} ${window.NMS.devices.typeLabel(t)}`).join(' · ');
  }

  // ── Table (sort / filter / search) ───────────────────────────────────────────
  const rowActions = (i) => `
    <button class="icon-btn" data-edit="${i}" title="Edit">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
    </button>
    <button class="icon-btn danger" data-del="${i}" title="Delete">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>`;

  const table = window.NMS.table.create({
    id: 'cfg.sites',
    tableClass: 'cfg-table-site',
    searchPlaceholder: 'Search sites…',
    empty: `<div class="cfg-empty">No sites yet — click <b>Add Site</b> to define one.
              Devices are then placed into a site.</div>`,
    onRows: wireRows,
    columns: [
      { key: 'name', label: 'Name', cls: 'col-name', filter: 'text',
        text: (s) => s.name,
        cell: (s) => `<div class="cell-name">${esc(s.name) || '<span class="muted">unnamed</span>'}</div>` },
      { key: 'description', label: 'Description', cls: 'col-desc', filter: 'text',
        text: (s) => s.description },
      { key: 'devices', label: 'Devices', cls: 'col-devices', filter: 'number',
        text: (s) => deviceText(s.oid),
        sortValue: (s) => deviceCounts(s.oid).total,
        cell: (s) => deviceMix(s.oid) },
      { key: 'act', label: '', cls: 'col-act', sort: false,
        cell: (s, i) => rowActions(i) },
    ],
  });

  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== 'sites') return;

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">Sites</span>
            <span class="cfg-h-sub">${state.sites.length} site${state.sites.length === 1 ? '' : 's'}</span>
          </div>
          <button class="btn-primary btn-sm" id="stAdd">+ Add Site</button>
        </div>

        <div id="stTable"></div>
      </div>

      <div class="slideover-overlay" id="stOverlay"></div>
      <aside class="slideover" id="stPanel">
        <div class="slideover-head">
          <span class="slideover-title" id="stTitle">Add Site</span>
          <button class="slideover-close" id="stClose">&times;</button>
        </div>
        <div class="slideover-body" id="stBody"></div>
        <div class="slideover-foot" id="stFoot"></div>
      </aside>`;

    wire();
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  function fieldRow(label, key, val, ph) {
    return `<div class="field-row"><label>${esc(label)}</label>
      <input data-f="${esc(key)}" value="${esc(val)}" placeholder="${esc(ph || '')}"/></div>`;
  }

  function editorForm(s) {
    return `
      ${fieldRow('Site Name', 'name', s.name, 'e.g. Seoul DC-1')}
      ${fieldRow('Description', 'description', s.description, 'optional')}`;
  }

  function collect(body) {
    const g = (k) => { const e = body.querySelector(`[data-f="${k}"]`); return e ? e.value.trim() : ''; };
    return {
      oid: draftOid,
      name: g('name'),
      description: g('description'),
    };
  }

  function openEditor(idx) {
    editIdx = idx;
    const s = idx == null ? blank() : normalize(JSON.parse(JSON.stringify(state.sites[idx])));
    draftOid = s.oid;
    document.getElementById('stTitle').textContent = idx == null ? 'Add Site' : 'Edit Site';
    document.getElementById('stBody').innerHTML = editorForm(s);
    document.getElementById('stFoot').innerHTML = `
      ${idx == null ? '' : '<button class="btn-sm btn-danger" id="stDelete">Delete</button>'}
      <span style="flex:1"></span>
      <button class="btn-sm" id="stCancel">Cancel</button>
      <button class="btn-primary btn-sm" id="stSave">Save</button>`;
    wireEditor();
    document.getElementById('stOverlay').classList.add('open');
    document.getElementById('stPanel').classList.add('open');
  }

  const closeEditor = () => {
    document.getElementById('stOverlay').classList.remove('open');
    document.getElementById('stPanel').classList.remove('open');
  };

  function removeSite(idx) {
    const s = state.sites[idx];
    const devices = (window.NMS.devices && window.NMS.devices.list()) || [];
    const used = devices.filter(d => d.site === s.oid).length;
    if (used && !confirm(`${used} device${used > 1 ? 's' : ''} still belong to this site. Delete anyway?`))
      return false;
    state.sites.splice(idx, 1);
    stage();
    return true;
  }

  function wireEditor() {
    document.getElementById('stCancel').onclick = closeEditor;
    document.getElementById('stClose').onclick = closeEditor;
    document.getElementById('stOverlay').onclick = closeEditor;

    const del = document.getElementById('stDelete');
    if (del) del.onclick = () => {
      if (removeSite(editIdx)) { closeEditor(); render(); }
    };

    document.getElementById('stSave').onclick = () => {
      const s = collect(document.getElementById('stBody'));
      if (!s.name) { alert('Site name is required.'); return; }
      if (editIdx == null) state.sites.push(s); else state.sites[editIdx] = s;
      stage();
      closeEditor(); render();
    };
  }

  // Re-run after every body paint: sorting or filtering replaces the rows these buttons live in.
  function wireRows(scope) {
    scope.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openEditor(+b.dataset.edit)));
    scope.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (removeSite(+b.dataset.del)) render();
    }));
  }

  function wire() {
    document.getElementById('stAdd')?.addEventListener('click', () => openEditor(null));
    table.mount(document.getElementById('stTable'), state.sites);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const siteRefresh = async () => { await load(); render(); };

  function activate() {
    render();
    window.NMS.onRefresh(siteRefresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();

    if (activeTab() === 'sites') activate();

    document.dispatchEvent(new Event('nms:sites-ready'));
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === 'sites') activate();
  });

  // The Devices column counts members, which load independently.
  document.addEventListener('nms:devices-ready', () => { if (activeTab() === 'sites') render(); });
})();

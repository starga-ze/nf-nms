/* api-connectors.js — Configuration ▸ API Connector.
 *
 * The last step of the configuration flow (Site → Inventory → Authentication → API Endpoint →
 * API Connector). A connector is the collection POLICY for one inventory object: which
 * credential to use against it, and which endpoints to poll how often. One connector per
 * object, so a device's whole schedule is in one place; an object without a connector is
 * monitored by ICMP only.
 *
 * It holds no paths and no query parameters. An endpoint defined on the API Endpoint page is a
 * complete request, so two firewalls needing different arguments are two endpoints — which is
 * what makes a PAN-OS upgrade a re-point here rather than an edit everywhere.
 *
 * Committed under pretzel.connector.connectors.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  // Read live (not once): settings tabs switch client-side without a page load (see main.js).
  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const DRAFT_KEY = 'api_connectors';
  const DEFAULT_INTERVAL_SEC = 60;
  const MIN_INTERVAL_SEC = 5;

  const { esc, newUuid } = window.NMS.utils;

  const state = { connectors: [] };
  let deployed = [];
  let editIdx = null;
  let draftOid = null;

  // ── Model ────────────────────────────────────────────────────────────────────
  function normalizeItem(i) {
    const interval = parseInt(i && i.poll_interval_sec, 10);
    return {
      endpoint: (i && typeof i.endpoint === 'string') ? i.endpoint : '',
      poll_interval_sec: (Number.isInteger(interval) && interval >= MIN_INTERVAL_SEC)
        ? interval : DEFAULT_INTERVAL_SEC,
      enabled: !i || i.enabled !== false,
    };
  }

  function normalize(c) {
    return {
      // `uuid` = legacy key; a numeric oid predates the merge and is replaced.
      oid: (typeof c.oid === 'string' && c.oid) ? c.oid : (c.uuid || newUuid()),
      name: c.name || '',
      description: c.description || '',
      object: c.object || '',              // inventory object oid
      auth_profile: c.auth_profile || '',  // API Key profile oid
      // What this device is collected for, each entry on its own schedule.
      items: (Array.isArray(c.items) ? c.items : []).map(normalizeItem).filter(i => i.endpoint),
    };
  }

  const blank = () => normalize({});

  // ── Staging ──────────────────────────────────────────────────────────────────
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.connectors); refreshPending(); };
  const refreshPending = () => window.NMS.staging.refresh();

  async function load() {
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      const api = ((d.scopes || {}).pretzel || {}).connector || {};
      deployed = (Array.isArray(api.connectors) ? api.connectors : []).map(normalize);
    } catch (_) { deployed = []; }
    const staged = window.NMS.draft.get(DRAFT_KEY, null);
    state.connectors = Array.isArray(staged) ? staged.map(normalize) : JSON.parse(JSON.stringify(deployed));
    refreshPending();
  }

  const commitPayload = () => [{ scope: 'pretzel', domain: 'connector', values: { connectors: state.connectors } }];

  window.NMS.staging.register({
    key: DRAFT_KEY,
    dirty: () => JSON.stringify(state.connectors) !== JSON.stringify(deployed),
    payload: commitPayload,
    before: () => ({ connectors: deployed }),
    after: () => ({ connectors: state.connectors }),
    onPublished() {
      deployed = JSON.parse(JSON.stringify(state.connectors));
      window.NMS.draft.clear(DRAFT_KEY);
    },
  });

  // ── Reference resolution ─────────────────────────────────────────────────────
  const objects = () => (window.NMS.devices && window.NMS.devices.list()) || [];
  const profiles = () => (window.NMS.apiKeys && window.NMS.apiKeys.list()) || [];
  const sites = () => (window.NMS.sites && window.NMS.sites.list()) || [];
  const objectByOid = (oid) => objects().find(o => o.oid === oid) || null;
  const siteName = (oid) => (window.NMS.sites && window.NMS.sites.label(oid)) || '';

  // Devices are picked Site-first: choose a site, then only that site's devices are offered. Keeps
  // the list short on a large estate and stops a device being bound to the wrong customer.
  function deviceOptsForSite(siteOid, selectedOid, selfOid) {
    if (!siteOid) return '<option value="">— select a site first —</option>';
    const inSite = objects().filter(o => o.site === siteOid);
    if (!inSite.length) return '<option value="">— no devices in this site —</option>';
    return ['<option value="">— select a device —</option>'].concat(
      inSite.map(o => {
        const taken = boundElsewhere(o.oid, selfOid);
        const label = `${o.name || o.target} (${o.target})${taken ? ' — already bound' : ''}`;
        return `<option value="${esc(o.oid)}" ${o.oid === selectedOid ? 'selected' : ''} ${taken ? 'disabled' : ''}>${esc(label)}</option>`;
      })
    ).join('');
  }

  const endpointList = () => (window.NMS.apiEndpoints && window.NMS.apiEndpoints.list()) || [];
  const endpointByOid = (oid) => (window.NMS.apiEndpoints && window.NMS.apiEndpoints.byOid(oid)) || null;
  const endpointName = (oid) => { const e = endpointByOid(oid); return e ? e.name : ''; };

  // The path with the endpoint's own parameters applied — what the device will actually be
  // asked for, and what the test sends.
  function endpointPath(oid) {
    const e = endpointByOid(oid);
    if (!e) return '';
    let path = e.path || '';
    (e.params || []).forEach(p => {
      if (!p || !p.name) return;
      path += (path.indexOf('?') === -1) ? '?' : '&';
      path += encodeURIComponent(p.name) + '=' + encodeURIComponent(p.value || '');
    });
    return path;
  }

  const endpointApiType = (oid) => {
    const e = endpointByOid(oid);
    if (!e) return 'rest';
    // Stored on the endpoint now; fall back to the path for records that predate the field.
    return (e.api_type === 'xml' || e.api_type === 'rest')
      ? e.api_type
      : (String(e.path || '').indexOf('/restapi/') === 0 ? 'rest' : 'xml');
  };

  // Bindable = not already taken by another connector (one collector per object).
  const boundElsewhere = (oid, selfOid) =>
    state.connectors.some(c => c.object === oid && c.oid !== selfOid);

  function objectCell(c) {
    const o = objectByOid(c.object);
    if (!o) return `<span class="authp-missing" title="Object ${esc(c.object)} no longer exists">missing</span>`;
    return `<div class="cell-name">${esc(o.name) || esc(o.target)}</div>
            <div class="cell-sub">${esc(o.target)}</div>`;
  }

  // The site is derived from the bound device, not stored on the connector.
  function siteCell(c) {
    const o = objectByOid(c.object);
    const name = o ? siteName(o.site) : '';
    return name ? `<span class="cell-name">${esc(name)}</span>` : `<span class="muted">—</span>`;
  }

  function profileCell(c) {
    if (!c.auth_profile) return `<span class="authp-missing">none</span>`;
    const name = window.NMS.apiKeys && window.NMS.apiKeys.label(c.auth_profile);
    return name
      ? `<span class="authp-chip">${esc(name)}</span>`
      : `<span class="authp-missing" title="Profile ${esc(c.auth_profile)} no longer exists">missing</span>`;
  }

  const anyEnabled = (c) => (c.items || []).some(i => i.enabled);

  // Up to this many endpoints are shown inline in the cell; beyond it, a "+N items" hint and a
  // hover card carry the rest.
  const EPC_INLINE_LIMIT = 2;

  // One endpoint line: name | interval | state. Shared by the cell and the hover card so the two
  // read identically — same font, same colours.
  function epRowHtml(i) {
    const name = endpointName(i.endpoint);
    const label = name ? esc(name) : `${esc(i.endpoint)} (missing)`;
    return `<div class="epc-row">`
         + `<span class="epc-name">${label}</span>`
         + `<span class="epc-int">${esc(i.poll_interval_sec)}s</span>`
         + `<span class="epc-en${i.enabled ? '' : ' off'}">${i.enabled ? 'Enabled' : 'Disabled'}</span>`
         + `</div>`;
  }

  function epCountHtml(items) {
    return `<div class="epc-count"><b>${items.length}</b> endpoint${items.length === 1 ? '' : 's'}</div>`;
  }

  function collectionCell(c) {
    const items = c.items || [];
    if (!items.length) return '<span class="authp-missing">collects nothing</span>';

    const shown = items.slice(0, EPC_INLINE_LIMIT);
    const extra = items.length - shown.length;

    return `<div class="epc">
        ${epCountHtml(items)}
        ${shown.map(epRowHtml).join('')}
        ${extra > 0 ? `<div class="epc-more">+${extra} items</div>` : ''}
      </div>`;
  }

  // ── Column accessors ─────────────────────────────────────────────────────────
  // Plain text for search, filtering and ordering. A reference that no longer resolves reads as
  // "missing" here exactly as it does in the cell, so filtering for the broken ones is possible.
  const siteText = (c) => {
    const o = objectByOid(c.object);
    return o ? (siteName(o.site) || '') : '';
  };
  const objectText = (c) => {
    const o = objectByOid(c.object);
    if (!o) return c.object ? 'missing' : '';
    return [o.name || o.target, o.target].filter(Boolean).join(' ');
  };
  const profileText = (c) => {
    if (!c.auth_profile) return 'none';
    return (window.NMS.apiKeys && window.NMS.apiKeys.label(c.auth_profile)) || 'missing';
  };
  // What the cell lists — the endpoint names — so searching for an endpoint finds every connector
  // that polls it. The column itself is ordered by how much this connector collects.
  const collectionText = (c) => (c.items || [])
    .map(i => endpointName(i.endpoint) || i.endpoint).filter(Boolean).join(' ');

  // Hover card: the full list, using the exact same row markup as the cell. A single shared,
  // body-mounted element positioned by the cell so the table's overflow never crops it.
  function epPopEl() {
    let el = document.getElementById('acEpPop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'acEpPop';
      el.className = 'ep-pop';
      document.body.appendChild(el);
    }
    return el;
  }

  function epPopHtml(c) {
    const items = c.items || [];
    return epCountHtml(items) + items.map(epRowHtml).join('');
  }

  function showEpPop(cell) {
    const c = state.connectors[+cell.dataset.ep];
    // A hover card appears only when the cell can't show everything — i.e. more than the inline
    // limit; at or below it, every endpoint is already visible.
    if (!c || (c.items || []).length <= EPC_INLINE_LIMIT) return;

    const pop = epPopEl();
    pop.innerHTML = epPopHtml(c);
    pop.classList.add('open');

    // Directly below the cell, left edges aligned; flip above only if it would leave the viewport.
    const r = cell.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8 && r.top - 6 - ph > 8) top = r.top - 6 - ph;
    pop.style.left = `${Math.max(8, left) + window.scrollX}px`;
    pop.style.top = `${top + window.scrollY}px`;
  }

  function hideEpPop() {
    const el = document.getElementById('acEpPop');
    if (el) el.classList.remove('open');
  }

  // ── Table (sort / filter / search) ───────────────────────────────────────────
  // Rebuilt on every render because it names what is still missing.
  let tableEmpty = '';

  const table = window.NMS.table.create({
    id: 'cfg.connectors',
    tableClass: 'cfg-table-conn',
    searchPlaceholder: 'Search connectors…',
    empty: () => tableEmpty,
    onRows: wireRows,
    rowClass: (c) => (anyEnabled(c) ? '' : 'row-off'),
    columns: [
      { key: 'name', label: 'Name', cls: 'col-name', filter: 'text',
        text: (c) => c.name,
        // The description is on the same cell, so the search box has to see it.
        searchText: (c) => [c.name, c.description].filter(Boolean).join(' '),
        cell: (c) => `<div class="cell-name">${esc(c.name) || '<span class="muted">unnamed</span>'}</div>
          ${c.description ? `<div class="cell-sub">${esc(c.description)}</div>` : ''}` },
      { key: 'site', label: 'Site', cls: 'col-site', filter: 'enum',
        text: siteText, cell: siteCell },
      { key: 'device', label: 'Device', cls: 'col-obj', filter: 'text',
        text: objectText, cell: objectCell },
      { key: 'api_key', label: 'API Key', cls: 'col-authp', filter: 'enum',
        text: profileText, cell: profileCell },
      { key: 'collection', label: 'Endpoint Control', cls: 'col-ep', filter: 'text',
        text: collectionText,
        sortValue: (c) => (c.items || []).length,
        // The hover card is anchored to this element, so the index rides on it rather than on the
        // td — the cell markup is the tab's, the td is the table module's.
        cell: (c, i) => `<div data-ep="${i}">${collectionCell(c)}</div>` },
      { key: 'act', label: '', cls: 'col-act', sort: false,
        cell: (c, i) => `
          <button class="icon-btn" data-edit="${i}" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
          </button>
          <button class="icon-btn danger" data-del="${i}" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` },
    ],
  });

  // ── Render ───────────────────────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== 'api-connector') return;

    // A connector binds three things together, so all three have to exist before one can be added.
    // Name the missing ones: the same reasoning as saveBlocker below — a greyed-out button with no
    // stated reason just leaves the operator guessing, and the empty-table hint is invisible once
    // there is at least one connector in the table.
    const missingParts = [
      objects().length ? '' : 'a device',
      profiles().length ? '' : 'an API key',
      endpointList().length ? '' : 'an API endpoint',
    ].filter(Boolean);
    const ready = !missingParts.length;
    const addBlocker = ready ? '' : `Define ${missingParts.join(', ')} first — a connector binds them together.`;

    const emptyHint = ready
      ? 'click <b>Add Connector</b> to decide what a device is polled for.'
      : `define a <a href="settings?tab=devices">device</a>, an
         <a href="settings?tab=api-key">API key</a> and an
         <a href="settings?tab=api-endpoint">API endpoint</a> first, then bind them here.`;

    // The empty state names what is missing, so it is rebuilt on every render rather than fixed at
    // table-construction time.
    tableEmpty = `<div class="cfg-empty">No API connectors yet — ${emptyHint}</div>`;

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">API Connectors</span>
            <span class="cfg-h-sub">${addBlocker
              ? esc(addBlocker)
              : `${state.connectors.length} connector${state.connectors.length === 1 ? '' : 's'}
                 · ${objects().length} device${objects().length === 1 ? '' : 's'} available`}</span>
          </div>
          <button class="btn-primary btn-sm" id="acAdd" ${ready ? '' : 'disabled'}
                  title="${esc(addBlocker)}">+ Add Connector</button>
        </div>

        <div id="acTable"></div>
      </div>

      <div class="slideover-overlay" id="acOverlay"></div>
      <aside class="slideover" id="acPanel">
        <div class="slideover-head">
          <span class="slideover-title" id="acTitle">Add Connector</span>
          <button class="slideover-close" id="acClose">&times;</button>
        </div>
        <div class="slideover-body" id="acBody"></div>
        <div class="slideover-foot" id="acFoot"></div>
      </aside>`;

    wire();
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  // No gated sequence: a connector is a schedule, and each row's API TEST proves that row
  // end-to-end (credential exchanged, then the endpoint called) whenever the operator wants to
  // check. Saving a schedule that has not been tested is allowed — an untested connector simply
  // reports its failures at collection time, which is where they would surface anyway.
  // Only endpoints written for this connector's device type are offered. An endpoint carries its
  // own vendor — a SASE one names a cloud host and authenticates with a bearer token — so pairing
  // one with a firewall would schedule a call that cannot work, and the failure would only surface
  // at collection time as an unexplained sample.
  function endpointOptsFor(deviceType, selected) {
    const usable = endpointList().filter(e => (e.device_type || 'ngfw') === (deviceType || 'ngfw'));
    if (!usable.length) {
      return `<option value="">— no ${esc((deviceType || 'ngfw').toUpperCase())} endpoint defined —</option>`;
    }
    return ['<option value="">— select an endpoint —</option>'].concat(
      usable.map(e => `<option value="${esc(e.oid)}" ${selected === e.oid ? 'selected' : ''}>${esc(e.name)}</option>`)
    ).join('');
  }

  // The device type currently chosen in the open editor — what the endpoint list is filtered by.
  const selectedDeviceType = (body) =>
    (objectByOid(body.querySelector('[data-devsel]')?.value) || {}).device_type || 'ngfw';

  // Re-offer every item's endpoints after the device changes. A selection that is still valid for
  // the new device is kept; one that is not is cleared rather than silently left pointing at an
  // endpoint this device cannot call.
  function refreshItemEndpoints(body) {
    const deviceType = selectedDeviceType(body);
    body.querySelectorAll('#acItemList .item-row').forEach(row => {
      const sel = row.querySelector('[data-i="endpoint"]');
      if (!sel) return;
      const keep = endpointList().some(e => e.oid === sel.value && (e.device_type || 'ngfw') === deviceType)
        ? sel.value : '';
      const wrap = sel.closest('.cs');
      sel.innerHTML = endpointOptsFor(deviceType, keep);
      sel.value = keep;
      sel.dispatchEvent(new Event('change', { bubbles: true }));   // resync the themed label + path
      if (!wrap) window.NMS.utils.enhanceSelect(sel);
    });
  }

  function itemRow(i, deviceType) {
    const opts = endpointOptsFor(deviceType, i.endpoint);

    return `<div class="item-row">
        <div class="item-top">
          <select data-i="endpoint">${opts}</select>
          <button class="icon-btn danger" data-item-del type="button" title="Remove endpoint">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="item-ctl">
          <label class="item-int-wrap" title="Poll interval in seconds">
            <span>Every</span>
            <input data-i="poll_interval_sec" class="item-int" value="${esc(i.poll_interval_sec)}"
                   placeholder="${DEFAULT_INTERVAL_SEC}"/>
            <span>sec</span>
          </label>
          <label class="item-en" title="Enable collection of this endpoint">
            <input type="checkbox" data-i="enabled" ${i.enabled ? 'checked' : ''}/><span>Enable</span>
          </label>
          <span class="item-ctl-spacer"></span>
          <button class="btn-sm" data-item-test type="button"
                  title="Exchange the credential for a key and call this endpoint">API TEST</button>
        </div>
        <div class="item-path">${esc(endpointPath(i.endpoint) || '—')}</div>
        <div class="item-result" data-item-result></div>
      </div>`;
  }

  function editorForm(c) {
    // Site is derived from the bound device when editing an existing connector.
    const curSite = (objectByOid(c.object) || {}).site || '';
    const siteOpts = ['<option value="">— select a site —</option>'].concat(
      sites().map(s => `<option value="${esc(s.oid)}" ${curSite === s.oid ? 'selected' : ''}>${esc(s.name)}</option>`)
    ).join('');

    const profOpts = ['<option value="">— select a profile —</option>'].concat(
      profiles().map(p =>
        `<option value="${esc(p.oid)}" ${c.auth_profile === p.oid ? 'selected' : ''}>${esc(p.name)}</option>`)
    ).join('');

    return `
      <div class="field-row"><label>Name</label>
        <input data-f="name" value="${esc(c.name)}" placeholder="e.g. core-fw-01"/></div>
      <div class="field-row"><label>Description</label>
        <input data-f="description" value="${esc(c.description)}" placeholder="optional"/></div>

      <div class="editor-sec">TARGET &amp; CREDENTIAL</div>
      <div class="field-row"><label>Site</label>
        <select data-sitesel>${siteOpts}</select></div>
      <div class="field-row"><label>Device</label>
        <select data-f="object" data-devsel>${deviceOptsForSite(curSite, c.object, c.oid)}</select></div>
      <div class="field-row"><label>API Key</label>
        <select data-f="auth_profile">${profOpts}</select></div>

      <div class="editor-sec">ENDPOINT CONTROL</div>
      <p class="field-hint">Which <a href="settings?tab=api-endpoint">endpoints</a> this device is
        polled for, and how often.</p>
      <div class="item-head">
        <label>Endpoints</label>
        <button class="btn-sm" id="acItemAdd" type="button">+ Endpoint</button>
      </div>
      <div class="item-list" id="acItemList">${(c.items.length ? c.items : [normalizeItem({})])
        .map(i => itemRow(i, (objectByOid(c.object) || {}).device_type)).join('')}</div>`;
  }

  function collect(body) {
    const g = (k) => {
      const el = body.querySelector(`[data-f="${k}"]`);
      if (!el) return '';
      return el.type === 'checkbox' ? el.checked : el.value.trim();
    };

    const items = Array.from(body.querySelectorAll('.item-row')).map(row => ({
      endpoint: row.querySelector('[data-i="endpoint"]').value,
      poll_interval_sec: row.querySelector('[data-i="poll_interval_sec"]').value,
      enabled: row.querySelector('[data-i="enabled"]').checked,
    }));

    return normalize({
      oid: draftOid,
      name: g('name'),
      description: g('description'),
      object: g('object'),
      auth_profile: g('auth_profile'),
      items,
    });
  }

  // Save is blocked only by what makes a connector meaningless, and the reason is shown rather
  // than left for the operator to guess at a greyed-out button.
  function saveBlocker(c) {
    if (!c.object) return 'Pick the device this connector collects from.';
    if (!c.auth_profile) return 'Pick the API key used against it.';
    if (!c.items.length) return 'Add at least one endpoint to collect.';
    return '';
  }

  function refreshSave() {
    const body = document.getElementById('acBody');
    const saveBtn = document.getElementById('acSave');
    if (!body || !saveBtn) return;

    const reason = saveBlocker(collect(body));
    saveBtn.disabled = !!reason;
    saveBtn.title = reason;
  }

  function openEditor(idx) {
    editIdx = idx;
    const c = idx == null ? blank() : normalize(JSON.parse(JSON.stringify(state.connectors[idx])));
    draftOid = c.oid;

    document.getElementById('acTitle').textContent = idx == null ? 'Add Connector' : 'Edit Connector';
    document.getElementById('acBody').innerHTML = editorForm(c);
    document.getElementById('acFoot').innerHTML = `
      ${idx == null ? '' : '<button class="btn-sm btn-danger" id="acDelete">Delete</button>'}
      <span style="flex:1"></span>
      <button class="btn-sm" id="acCancel">Cancel</button>
      <button class="btn-primary btn-sm" id="acSave">Save</button>`;
    wireEditor();
    document.getElementById('acOverlay').classList.add('open');
    document.getElementById('acPanel').classList.add('open');
  }

  const closeEditor = () => {
    document.getElementById('acOverlay').classList.remove('open');
    document.getElementById('acPanel').classList.remove('open');
  };

  function wireItemRow(row) {
    row.querySelector('[data-i="endpoint"]').addEventListener('change', (e) => {
      row.querySelector('.item-path').textContent = endpointPath(e.target.value) || '—';
      row.querySelector('[data-item-result]').innerHTML = '';
      refreshSave();
    });

    row.querySelector('[data-i="poll_interval_sec"]').addEventListener('input', refreshSave);
    row.querySelector('[data-i="enabled"]').addEventListener('change', refreshSave);

    row.querySelector('[data-item-del]').addEventListener('click', () => {
      row.remove();
      refreshSave();
    });

    row.querySelector('[data-item-test]').addEventListener('click', () => {
      const oid = row.querySelector('[data-i="endpoint"]').value;
      if (!oid) { alert('Pick an endpoint on this row first.'); return; }
      runApiTest(row, oid);
    });
  }

  function wireEditor() {
    const body = document.getElementById('acBody');

    body.querySelectorAll('[data-f]').forEach(el => {
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', refreshSave);
    });
    body.querySelectorAll('.item-row').forEach(wireItemRow);

    // Changing the device changes which endpoints can be collected from it, so the item rows are
    // re-offered. Bound on the select itself rather than delegated, because the site handler below
    // re-dispatches 'change' on it and this must run for that too.
    body.querySelector('[data-devsel]')?.addEventListener('change', () => refreshItemEndpoints(body));

    // Picking a site re-scopes the device list to that site and clears any prior device.
    body.querySelector('[data-sitesel]')?.addEventListener('change', (e) => {
      const dev = body.querySelector('[data-devsel]');
      dev.innerHTML = deviceOptsForSite(e.target.value, '', draftOid);
      dev.value = '';
      dev.dispatchEvent(new Event('change', { bubbles: true }));   // updates the themed label + Save
    });

    // Site, Device, API Key and every endpoint select get the themed dropdown (consistent OS-wide).
    window.NMS.utils.enhanceSelects(body);

    document.getElementById('acItemAdd').onclick = () => {
      const list = document.getElementById('acItemList');
      list.insertAdjacentHTML('beforeend', itemRow(normalizeItem({}), selectedDeviceType(body)));
      const row = list.lastElementChild;
      wireItemRow(row);
      window.NMS.utils.enhanceSelect(row.querySelector('[data-i="endpoint"]'));
      row.querySelector('.cs-trigger').focus();
      refreshSave();
    };

    document.getElementById('acCancel').onclick = closeEditor;
    document.getElementById('acClose').onclick = closeEditor;
    document.getElementById('acOverlay').onclick = closeEditor;

    const del = document.getElementById('acDelete');
    if (del) del.onclick = () => {
      state.connectors.splice(editIdx, 1);
      closeEditor(); stage(); render();
    };

    document.getElementById('acSave').onclick = () => {
      const c = collect(body);
      const reason = saveBlocker(c);
      if (reason) { alert(reason); return; }
      if (editIdx == null) state.connectors.push(c); else state.connectors[editIdx] = c;
      stage();
      closeEditor(); render();
    };

    refreshSave();
  }

  // ── API test ────────────────────────────────────────────────────────────────
  // One button, one round trip: mgmtd hands the request to collectord, which exchanges the
  // credential for a key and then calls the endpoint with it. The browser cannot reach a
  // customer's firewall, and neither daemon blocks its loop on a slow device — hence the ticket.
  const POLL_MS = 700;
  const POLL_LIMIT = 40;

  async function runDeviceTest(path, payload) {
    const start = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (start.status === 404) throw new Error('backend test endpoint is not available');
    const started = await start.json().catch(() => null);
    if (!start.ok || !started || !started.ticket) {
      throw new Error((started && started.error) || ('HTTP ' + start.status));
    }

    for (let i = 0; i < POLL_LIMIT; i++) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const r = await fetch('/api/connector/test-result?ticket=' + started.ticket,
                            { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => null);
      if (d && d.status === 'done') return d;
    }
    throw new Error('timed out waiting for the device');
  }

  // The device coordinates: host from the object, username and keygen path from the API Key
  // record, and the password from the browser-held store.
  function testPayload(c) {
    const o = objectByOid(c.object);
    const p = window.NMS.apiKeys ? window.NMS.apiKeys.byOid(c.auth_profile) : null;
    return {
      target: o ? o.target : '',
      fingerprint: o ? o.fingerprint : '',
      username: p ? p.username : '',
      keygen_endpoint: p ? (p.endpoint || '') : '',
      // Lets collectord use the key already issued for this profile instead of asking for the
      // password again — see ApiService::issuedKey.
      api_key_oid: c.auth_profile,
      secrets: window.NMS.apiKeySecrets ? window.NMS.apiKeySecrets.for(c.auth_profile) : {},
    };
  }

  // Checked here rather than left to the backend, which can only answer "no username/password"
  // without knowing WHICH key or where it is kept.
  //
  // The password is held in sessionStorage, per browser tab, and is never committed — so it is
  // gone after the tab is closed, in a second tab, and after `pretzel reset` (the config version
  // goes backwards and every draft is dropped). The API Key record still shows a username, which
  // is why this reads as "the credentials are right there" when the test says otherwise.
  function credentialProblem(c) {
    const key = window.NMS.apiKeys ? window.NMS.apiKeys.byOid(c.auth_profile) : null;
    if (!key) return 'That API Key no longer exists — pick another.';

    const name = key.name || 'this API Key';
    if (!key.username) {
      return `API Key "${name}" has no username. Set it on the API Key page.`;
    }

    // Nothing else is checked here. Whether a key was already issued is collectord's to know — it
    // holds the ones it could open from api_key_state — and second-guessing that in the browser
    // is how this ended up blocking a test that would have worked. `stored` is only a hint from
    // the last generation in this tab; its absence proves nothing.
    return '';
  }

  const stepRow = (label, st) => window.NMS.testPanel.step(label, st);

  // A device we have never pinned stops the test at the certificate: HttpClient will not put a
  // credential on the wire to an unverified peer. The operator confirms the fingerprint, it is
  // stored on the object, and the test is run again.
  function trustPrompt(res, c) {
    if (!res.fingerprint || res.fingerprint_trusted) return '';
    return `<div class="fp-prompt">
        <div class="fp-warn">Certificate is not trusted yet (self-signed)</div>
        <code class="fp-val">${esc(res.fingerprint)}</code>
        <div class="fp-sub">${esc(res.cert_subject || '')}</div>
        <button class="btn-sm btn-primary" data-trust-fp data-device="${esc(c.object)}"
                data-fp="${esc(res.fingerprint)}">Trust this certificate</button>
      </div>`;
  }

  // Pretty-print when the body is JSON; XML and error text are shown as returned.
  function formatBody(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) return text;
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return text; }
  }

  function showDetail(res) {
    if (!res || !window.NMS.modal) return;

    const req = res.request || {};
    const rsp = res.response || {};
    const statusClass = res.ok ? 'ok' : 'err';

    window.NMS.modal.open('API test', `
      <div class="ep-detail">
        <div class="ep-block">
          <div class="ep-block-h">Request</div>
          <pre class="ep-req">${esc(req.method || 'GET')} ${esc(req.url || '')}</pre>
          <div class="ep-note">API key sent via ${esc(req.key_delivery || '')} — redacted above.</div>
        </div>

        <div class="ep-block">
          <div class="ep-block-h">Response
            <span class="ep-status ${statusClass}">HTTP ${esc(rsp.status != null ? rsp.status : '—')}</span>
            ${rsp.bytes != null ? `<span class="ep-bytes">${esc(rsp.bytes)} bytes${rsp.truncated ? ', truncated' : ''}</span>` : ''}
          </div>
          <pre class="ep-rsp">${esc(formatBody(rsp.body))}</pre>
        </div>
      </div>`);
  }

  async function runApiTest(row, endpointOid) {
    const body = document.getElementById('acBody');
    const c = collect(body);
    const out = row.querySelector('[data-item-result]');
    const btn = row.querySelector('[data-item-test]');

    const missing = !c.object ? 'Pick an object first.'
                  : (!c.auth_profile ? 'Pick an API key first.' : credentialProblem(c));
    if (missing) {
      out.innerHTML = `<div class="test-panel err"><div class="ts-note">${esc(missing)}</div></div>`;
      return;
    }

    btn.disabled = true;
    const tp = window.NMS.testPanel;
    out.innerHTML = tp.runningBody(['TLS connection', 'API key generation', 'Endpoint response']);
    const run = tp.attachElapsed(out);

    let res;
    try {
      // collectord runs the test statelessly — the endpoint may not be committed yet, so the
      // reference is resolved here and the finished path is sent.
      const payload = testPayload(c);
      payload.api_type = endpointApiType(endpointOid);
      payload.endpoint = endpointPath(endpointOid);
      payload.params = [];   // an endpoint carries its own parameters
      res = await runDeviceTest('/api/connector/endpoint-test', payload);
    } catch (e) {
      run.stop();
      btn.disabled = false;
      out.innerHTML = `<div class="test-panel err"><div class="ts-note">${esc(e.message)}</div></div>`;
      return;
    }

    const secs = run.stop();
    btn.disabled = false;
    const steps = res.steps || {};
    out.innerHTML = `<div class="test-panel ${res.ok ? 'ok' : 'err'}">
        ${stepRow('TLS connection', steps.tls)}
        ${stepRow('API key generation', steps.auth)}
        ${stepRow('Endpoint response', steps.endpoint)}
        <div class="ts-note">Completed in ${secs.toFixed(1)}s.</div>
        ${trustPrompt(res, c)}
        ${res.request ? `<div class="ts-more"><button class="btn-sm" data-detail type="button">View request / response</button></div>` : ''}
      </div>`;

    out.querySelector('[data-trust-fp]')?.addEventListener('click', (e) => {
      const b = e.currentTarget;
      window.NMS.devices.pinFingerprint(b.dataset.device, b.dataset.fp);
      b.outerHTML = '<span class="fp-trusted">Pinned — run the test again.</span>';
    });
    out.querySelector('[data-detail]')?.addEventListener('click', () => showDetail(res));

    // Raise the window straight away — the operator ran the test to see this.
    if (res.request) showDetail(res);
  }

  // ── Wiring (table) ──────────────────────────────────────────────────────────
  // Re-run after every body paint — a sort, a filter or a full render() all replace the rows these
  // controls live in.
  function wireRows(scope) {
    scope.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openEditor(+b.dataset.edit)));
    scope.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      state.connectors.splice(+b.dataset.del, 1); stage(); render();
    }));
    scope.querySelectorAll('[data-ep]').forEach(cell => {
      cell.addEventListener('mouseenter', () => showEpPop(cell));
      cell.addEventListener('mouseleave', hideEpPop);
    });
    hideEpPop();
  }

  function wire() {
    document.getElementById('acAdd')?.addEventListener('click', () => openEditor(null));
    table.mount(document.getElementById('acTable'), state.connectors);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const connectorRefresh = async () => { await load(); render(); };

  function activate() {
    render();
    window.NMS.onRefresh(connectorRefresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    if (activeTab() === 'api-connector') activate();
    document.dispatchEvent(new Event('nms:connectors-ready'));
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === 'api-connector') activate();
  });

  // Object/profile/endpoint names come from the other tabs' data, which loads independently.
  document.addEventListener('nms:devices-ready', () => { if (activeTab() === 'api-connector') render(); });
  document.addEventListener('nms:sites-ready', () => { if (activeTab() === 'api-connector') render(); });
  document.addEventListener('nms:api-keys-ready', () => { if (activeTab() === 'api-connector') render(); });
  document.addEventListener('nms:endpoints-ready', () => { if (activeTab() === 'api-connector') render(); });
})();

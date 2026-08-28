/* config.js — Configuration ▸ Site Management ▸ Devices.
 *
 * A Device is one managed box (or one cloud tenant) belonging to a Site. `device_type` is the
 * single axis that decides everything else:
 *
 *   ngfw           on-prem/VM firewall → reached at its own address    → Access Identifier = IP / FQDN
 *   sase           cloud platform      → reached via a tenant-scoped API → Access Identifier = Tenant ID
 *
 * Access Type is therefore derived, never stored twice and never asked of the operator.
 *
 * The device also carries `fingerprint`, the pinned certificate of its host. It is not an
 * operator-entered field: the first API Key test records it once the operator confirms it, and
 * every later call to this box is checked against it. Credentials do not live here — an API Key
 * (API Profile ▸ API Key) references a device and holds the account used against it.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  // Read live (not once): settings tabs switch client-side without a page load (see main.js).
  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const DRAFT_KEY = 'devices';

  const { esc, newUuid } = window.NMS.utils;

  // [key, label, access kind, access-identifier label, placeholder]
  const DEVICE_TYPES = [
    ['ngfw', 'NGFW', 'direct', 'IP / FQDN', '192.168.0.10'],
    ['sase', 'SASE', 'tenant', 'Tenant ID', '1963594622'],
  ];
  const typeRow = (t) => DEVICE_TYPES.find(([k]) => k === t) || DEVICE_TYPES[0];
  const typeLabel = (t) => typeRow(t)[1];
  const accessKind = (t) => typeRow(t)[2];
  const accessLabel = (t) => typeRow(t)[3];
  const accessPlaceholder = (t) => typeRow(t)[4];

  const state = { devices: [] };
  let deployed = [];
  let editIdx = null;
  let draftOid = null;           // survives the rebuild a device-type change performs
  let draftFingerprint = '';     // NGFW pinned cert, held across rebuilds like draftOid
  // The SASE api-key in plaintext, held ONLY between a paste and the Save that ships it to the
  // appliance. It is deliberately not part of state.devices: the staged draft goes to localStorage,
  // and a secret has no business being there. Once saved it lives sealed in the database and the
  // editor shows bullets, so this is empty on every later visit.
  let draftApiKey = '';
  // device oid -> true when the appliance holds a sealed api-key for it (/api/connector/keys-state).
  let keyStored = {};

  // Staged edits are held in NMS.draft so they survive a full page reload.
  // Dirty state and publish are owned by the cross-tab staging registry (js/commit.js).
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.devices); refreshPending(); };
  const refreshPending = () => window.NMS.staging.refresh();

  function normalize(d) {
    // `type`/`platform` are the pre-consolidation keys: everything that was not a tenant
    // platform was an on-prem firewall, so it maps to ngfw.
    let deviceType = d.device_type;
    if (deviceType === 'prisma_access') deviceType = 'sase';   // pre-rename canonical value
    if (!DEVICE_TYPES.some(([k]) => k === deviceType)) {
      const legacyTenant = (d.platform || d.access) === 'tenant' || d.type === 'sase' || d.type === 'saas';
      deviceType = legacyTenant ? 'sase' : 'ngfw';
    }
    const out = {
      oid: (typeof d.oid === 'string' && d.oid) ? d.oid : (d.uuid || d.id || newUuid()),
      name: d.name || '',
      description: d.description || '',
      site: d.site || '',              // Site oid, '' = unassigned
      device_type: deviceType,
      target: d.target || '',          // access identifier: IP/FQDN or tenant id
      // Pinned certificate of this host — written by the API Key test, never typed.
      fingerprint: d.fingerprint || '',
    };
    // SASE infrastructure check (getPrismaAccessIP): url + body live in config. The api-key does NOT
    // — it is sealed on the appliance (sase_device.api_key_enc), so it is never carried on the device
    // object, never staged, and never written to running_config.
    const health = (d.health && typeof d.health === 'object')
      ? { url: d.health.url || '', body: d.health.body || '' } : { url: '', body: '' };
    if (deviceType === 'sase' || health.url) out.health = health;
    return out;
  }

  const blank = () => normalize({ device_type: 'ngfw' });

  // ── Data load ────────────────────────────────────────────────────────────────
  // Which devices the appliance already holds a sealed api-key for. Only the fact is returned, never
  // the key, which is what lets the editor render a saved key as bullets after a refresh.
  async function loadKeyState() {
    try {
      const r = await fetch('/api/connector/keys-state',
        { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      const next = {};
      Object.keys(d || {}).forEach((oid) => {
        if (d[oid] && d[oid].kind === 'sase_device' && d[oid].stored) next[oid] = true;
      });
      keyStored = next;
    } catch (_) { /* leave the previous snapshot in place */ }
  }

  async function load() {
    await loadKeyState();
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      const site = ((d.daemons || {}).engined || {}).site || {};
      // Config stores two type-specific arrays; the editor works on one merged list tagged with
      // device_type, and splitForConfig() puts them back on commit.
      const ngfw = (Array.isArray(site.ngfw_devices) ? site.ngfw_devices : [])
        .map(x => normalize(Object.assign({}, x, { device_type: 'ngfw' })));
      const sase = (Array.isArray(site.sase_devices) ? site.sase_devices : [])
        .map(x => normalize(Object.assign({}, x, { device_type: 'sase' })));
      deployed = ngfw.concat(sase);
    } catch (_) { deployed = []; }
    const staged = window.NMS.draft.get(DRAFT_KEY, null);
    state.devices = Array.isArray(staged) ? staged.map(normalize)
                                          : JSON.parse(JSON.stringify(deployed));
    refreshPending();
  }

  // Split the merged editor list back into the two config arrays. device_type is the tag (dropped),
  // and the SASE api-key never goes in config — it is persisted to the DB via its own endpoint.
  function splitForConfig(list) {
    const ngfw_devices = [], sase_devices = [];
    list.forEach(function (d) {
      const base = { oid: d.oid, name: d.name, description: d.description, site: d.site, target: d.target };
      if (d.device_type === 'sase') sase_devices.push(Object.assign(base, { health: d.health || { url: '', body: '' } }));
      else ngfw_devices.push(Object.assign(base, { fingerprint: d.fingerprint || '' }));
    });
    return { ngfw_devices: ngfw_devices, sase_devices: sase_devices };
  }

  const commitPayload = () => [{ daemon: 'engined', domain: 'site', values: splitForConfig(state.devices) }];

  // Site is a reference; show the site's name, and flag a dangling oid so a deleted site is
  // visible rather than silently blank.
  function siteCell(d) {
    if (!d.site) return `<span class="muted">—</span>`;
    const name = window.NMS.sites && window.NMS.sites.label(d.site);
    return name
      ? `<span class="site-chip">${esc(name)}</span>`
      : `<span class="ref-missing" title="Site ${esc(d.site)} no longer exists">missing</span>`;
  }

  // A dangling site reference reads as "missing" rather than as a blank, in the cell and equally in
  // the Site filter — an operator hunting for broken references filters for exactly that word.
  function siteText(d) {
    if (!d.site) return '';
    return (window.NMS.sites && window.NMS.sites.label(d.site)) || 'missing';
  }

  // ── Table (sort / filter / search) ─────────────────────────────────────────────
  const table = window.NMS.table.create({
    id: 'cfg.devices',
    tableClass: 'cfg-table-device',
    searchPlaceholder: 'Search devices…',
    empty: `<div class="cfg-empty">No devices yet — click <b>Add Device</b> to define one.</div>`,
    onRows: wireRows,
    columns: [
      { key: 'name', label: 'Name', cls: 'col-name', filter: 'text',
        text: (d) => d.name,
        cell: (d) => `<div class="cell-name">${esc(d.name) || '<span class="muted">—</span>'}</div>` },
      { key: 'description', label: 'Description', cls: 'col-desc', filter: 'text',
        text: (d) => d.description },
      { key: 'site', label: 'Site', cls: 'col-site', filter: 'enum',
        text: siteText, cell: siteCell },
      { key: 'device_type', label: 'Device Type', cls: 'col-type', filter: 'enum',
        text: (d) => typeLabel(d.device_type),
        cell: (d) => `<span class="type-badge">${esc(typeLabel(d.device_type))}</span>` },
      { key: 'access_type', label: 'Access Type', cls: 'col-access', filter: 'enum',
        text: (d) => accessLabel(d.device_type),
        cell: (d) => `<span class="access-badge ${esc(accessKind(d.device_type))}">${
          esc(accessLabel(d.device_type))}</span>` },
      { key: 'target', label: 'Access Identifier', cls: 'col-endpoint', filter: 'text',
        text: (d) => d.target },
      { key: 'act', label: '', cls: 'col-act', sort: false,
        cell: (d, i) => `
          ${d.device_type === 'sase'
            ? `<button class="btn-sm" data-satest="${i}" title="Run the infrastructure check">Infrastructure Test</button>`
            : ''}
          <button class="icon-btn" data-edit="${i}" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
          </button>
          <button class="icon-btn danger" data-del="${i}" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` },
    ],
  });

  // ── Render ─────────────────────────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== 'devices') return;

    const counts = DEVICE_TYPES.map(([k, label]) =>
      `${state.devices.filter(d => d.device_type === k).length} ${label}`).join(' · ');
    const noSites = !(window.NMS.sites && window.NMS.sites.list().length);

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">Devices</span>
            <span class="cfg-h-sub">${counts}${noSites
              ? ' · <a href="settings?tab=sites">create a site first</a> so devices can belong to one'
              : ''}</span>
          </div>
          <button class="btn-primary btn-sm" id="devAdd">+ Add Device</button>
        </div>

        <div id="devTable"></div>
      </div>

      <div class="slideover-overlay" id="devOverlay"></div>
      <aside class="slideover" id="devPanel">
        <div class="slideover-head">
          <span class="slideover-title" id="devTitle">Add Device</span>
          <button class="slideover-close" id="devClose">&times;</button>
        </div>
        <div class="slideover-body" id="devBody"></div>
        <div class="slideover-foot" id="devFoot"></div>
      </aside>`;

    wire();
  }

  // ── Editor (slide-over) ─────────────────────────────────────────────────────
  function fieldRow(label, key, val, ph) {
    return `<div class="field-row"><label>${esc(label)}</label>
      <input data-f="${esc(key)}" value="${esc(val)}" placeholder="${esc(ph || '')}"/></div>`;
  }

  function editorForm(d) {
    const typeOpts = DEVICE_TYPES.map(([k, label]) =>
      `<option value="${esc(k)}" ${d.device_type === k ? 'selected' : ''}>${esc(label)}</option>`).join('');

    const sites = (window.NMS.sites && window.NMS.sites.list()) || [];
    const siteOpts = ['<option value="">— none —</option>'].concat(
      sites.map(s => `<option value="${esc(s.oid)}" ${d.site === s.oid ? 'selected' : ''}>${esc(s.name)}</option>`)
    ).join('');

    return `
      ${fieldRow('Name', 'name', d.name, 'e.g. core-fw-01')}
      ${fieldRow('Description', 'description', d.description, 'optional')}
      <div class="field-row"><label>Site</label>
        <select data-f="site">${siteOpts}</select></div>
      ${sites.length ? '' :
        `<p class="field-hint"><a href="settings?tab=sites">Create a site first</a> to place this device.</p>`}

      <div class="editor-sec">ACCESS</div>
      <div class="field-row"><label>Device Type</label>
        <select data-f="device_type" data-typesel>${typeOpts}</select></div>
      <div class="field-row"><label>Access Type</label>
        <input value="${esc(accessLabel(d.device_type))}" disabled/></div>
      <p class="field-hint">Follows the device type.</p>
      ${fieldRow(accessLabel(d.device_type), 'target', d.target, accessPlaceholder(d.device_type))}
      ${d.device_type === 'sase' ? healthSection(d, d.health || {}) : ngfwStatusSection(d)}`;
  }

  // NGFW status + certificate. Reachability is plain ICMP (no config to enter) — the note here keeps
  // parity with the SASE infrastructure check. The certificate is pinned right at device creation via
  // a credential-less TLS handshake, so the later API Key test finds the pin already in place.
  function ngfwStatusSection(d) {
    return `
      <div class="editor-sec">STATUS &amp; CERTIFICATE</div>
      <p class="field-hint">Pin the TLS certificate now so an API key can be issued later.</p>
      ${d.fingerprint
        ? `<div class="fp-box"><div class="fp-label">Pinned certificate (SHA-256)</div>
             <code class="fp-val">${esc(d.fingerprint)}</code>
             <button class="btn-sm btn-danger" id="devUnpin" type="button">Clear pin</button></div>`
        : ''}
      <div class="field-row" style="margin-top:6px"><label></label>
        <button class="btn-sm" id="devCertProbe" type="button">${d.fingerprint ? 'Re-test connection' : 'Test connection'}</button></div>
      <div id="devCertResult" class="field-hint" style="min-height:18px"></div>`;
  }

  // SASE has no IP to ping, so its reachability is a live infrastructure-API read (getPrismaAccessIP).
  // Prisma Access hands the operator a whole curl command, so that is what this takes: paste it and
  // the URL, api-key and request body are read out of it. The three are shown read-only because they
  // are derived from the command — editing one by hand would just drift from what was pasted.
  //
  // The api-key never appears here in plaintext once saved: it is sealed on the appliance
  // (sase_device.api_key_enc) and this shows bullets. Run the check itself from the device list.
  const KEY_MASK = '••••••••••••••••';

  function readonlyRow(label, key, val, placeholder, mono) {
    return `<div class="field-row"><label>${esc(label)}</label>
      <input ${key ? `data-f="${esc(key)}"` : ''} class="${mono ? 'mono-val' : ''}" readonly
             value="${esc(val)}" placeholder="${esc(placeholder || '')}"/></div>`;
  }

  function healthSection(d, health) {
    // Three states, in the order they happen: just pasted (not yet saved) → saved on the appliance →
    // nothing yet. Only the middle one survives a refresh, which is the whole point of storing it.
    const keyState = draftApiKey
      ? { val: KEY_MASK, hint: 'read from the command — saved when you press Save' }
      : keyStored[d.oid]
        ? { val: KEY_MASK, hint: 'stored on the appliance (sealed)' }
        : { val: '', hint: 'paste the command above to set it' };

    return `
      <div class="editor-sec">SASE INFRASTRUCTURE CHECK</div>
      <p class="field-hint">SASE has no address to ping — reachability is a live
        <code>getPrismaAccessIP</code> read against the tenant's infrastructure API. These three come
        from the command Prisma Access gives you; paste it below to fill them in. The api-key is sealed
        on the appliance and never written to the configuration. Run the check from the device list.</p>

      ${readonlyRow('Infrastructure URL', 'health_url', health.url || '', 'read from the command', true)}
      <div class="field-row"><label>API key</label>
        <input class="mono-val" readonly value="${esc(keyState.val)}" placeholder="${esc(keyState.hint)}"/></div>
      ${keyState.val ? `<p class="field-hint" style="margin-top:-6px">${esc(keyState.hint)}</p>` : ''}
      ${readonlyRow('Request body', 'health_body', health.body || '', 'read from the command', true)}

      <div class="field-row" style="margin-top:10px"><label>Command from Prisma Access</label>
        <textarea data-f="paste_cmd" rows="3" spellcheck="false" autocomplete="off"
          placeholder='curl -X POST -d @option.txt -H "header-api-key: ..." "https://api.prod8.datapath.prismaaccess.com/getPrismaAccessIP/v2"'></textarea></div>
      <div class="field-row"><label></label>
        <button class="btn-sm" id="devParseCmd" type="button">Read from command</button></div>
      <div id="devParseResult" class="field-hint" style="min-height:16px"></div>`;
  }

  // Validate the getPrismaAccessIP api-key against the tenant; on success probed seals + stores it in
  // sase_device.api_key_enc. Same ticket/poll shape as the API Key tests.
  async function runSaseTest(payload) {
    const start = await fetch('/api/connector/sase-test', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (start.status === 401) { location.href = '/'; return { ok: false, message: 'session expired' }; }
    const started = await start.json().catch(() => null);
    if (!start.ok || !started || !started.ticket) throw new Error((started && started.error) || 'could not start the test');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const r = await fetch('/api/connector/test-result?ticket=' + started.ticket,
        { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => null);
      if (d && d.status === 'done') return d;
    }
    throw new Error('the test timed out');
  }

  // Pull the URL, header-api-key and request body out of the command Prisma Access hands out, e.g.
  //   curl -X POST -d @option.txt -H "header-api-key: <key>" "https://api.prod8…/getPrismaAccessIP/v2"
  // The body is commonly `-d @file`, which the browser cannot read; that is not a failure — the file
  // is the documented all/all/all request, so that is what gets used.
  const DEFAULT_PROBE_BODY = '{"serviceType":"all","addrType":"all","location":"all"}';

  function parsePrismaCommand(cmd) {
    const url = (cmd.match(/https:\/\/[^\s"']+/) || [''])[0];
    const apiKey = (cmd.match(/header-api-key:\s*([^\s"']+)/i) || [, ''])[1];
    let body = '';
    const m = cmd.match(/-d\s+'([^']*)'/) || cmd.match(/-d\s+"([^"]*)"/) ||
              cmd.match(/--data(?:-raw)?\s+'([^']*)'/) || cmd.match(/--data(?:-raw)?\s+"([^"]*)"/);
    if (m) body = m[1];
    else if (/(?:-d|--data(?:-raw)?)\s+@/.test(cmd)) body = DEFAULT_PROBE_BODY;
    return { url, apiKey, body };
  }

  // Seal + store a SASE device's api-key on the appliance. Called on Save, so the key survives a
  // browser refresh (and a publish) without ever being staged to localStorage or running_config.
  async function saveApiKey(oid, apiKey) {
    const start = await fetch('/api/connector/sase-key', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oid, api_key: apiKey }) });
    if (start.status === 401) { location.href = '/'; return { ok: false, message: 'session expired' }; }
    const started = await start.json().catch(() => null);
    if (!start.ok || !started || !started.ticket) throw new Error((started && started.error) || 'could not save the api-key');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const r = await fetch('/api/connector/test-result?ticket=' + started.ticket,
        { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => null);
      if (d && d.status === 'done') return d;
    }
    throw new Error('saving the api-key timed out');
  }

  // Credential-less TLS handshake to an NGFW: returns { ok, fingerprint, cert_subject,
  // fingerprint_trusted, message }. Same ticket/poll shape as the API Key tests — mgmtd hands the
  // handshake to collectord, which is the daemon that will actually talk to this device.
  async function runTlsProbe(payload) {
    const start = await fetch('/api/connector/tls-probe', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (start.status === 401) { location.href = '/'; return { ok: false, message: 'session expired' }; }
    const started = await start.json().catch(() => null);
    if (!start.ok || !started || !started.ticket) throw new Error((started && started.error) || 'could not start the probe');
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const r = await fetch('/api/connector/test-result?ticket=' + started.ticket,
        { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => null);
      if (d && d.status === 'done') return d;
    }
    throw new Error('the probe timed out');
  }

  // `oid` is carried out-of-band (draftOid) so it survives the device-type rebuild and stays
  // immutable for the device's lifetime.
  function collectForm(body) {
    const g = (k) => {
      const e = body.querySelector(`[data-f="${k}"]`);
      return e ? (e.type === 'checkbox' ? e.checked : e.value.trim()) : undefined;
    };
    const prev = editIdx == null ? null : state.devices[editIdx];
    return normalize({
      oid: draftOid,
      name: g('name'),
      description: g('description'),
      site: g('site'),
      device_type: g('device_type'),
      target: g('target'),
      // Carried out-of-band (like the oid) so a probe/trust survives the device-type rebuild.
      fingerprint: draftFingerprint,
      // Present only on the SASE form; undefined on NGFW so normalize drops them. The api-key is not
      // collected here — it is never in the DOM in plaintext (see draftApiKey).
      health: (g('health_url') !== undefined || g('health_body') !== undefined)
        ? { url: g('health_url') || '', body: g('health_body') || '' } : (prev ? prev.health : undefined),
    });
  }

  function openEditor(idx) {
    editIdx = idx;
    const d = idx == null ? blank() : normalize(JSON.parse(JSON.stringify(state.devices[idx])));
    draftOid = d.oid;
    draftFingerprint = d.fingerprint || '';
    draftApiKey = '';   // a stored key stays on the appliance; the editor opens showing bullets
    document.getElementById('devTitle').textContent = idx == null ? 'Add Device' : 'Edit Device';
    document.getElementById('devBody').innerHTML = editorForm(d);
    document.getElementById('devFoot').innerHTML = `
      ${idx == null ? '' : '<button class="btn-sm btn-danger" id="devDelete">Delete</button>'}
      <span style="flex:1"></span>
      <button class="btn-sm" id="devCancel">Cancel</button>
      <button class="btn-primary btn-sm" id="devSave">Save</button>`;
    wireEditor();
    document.getElementById('devOverlay').classList.add('open');
    document.getElementById('devPanel').classList.add('open');
  }

  const closeEditor = () => {
    document.getElementById('devOverlay').classList.remove('open');
    document.getElementById('devPanel').classList.remove('open');
  };

  // Anything referencing this device becomes dangling, so say so rather than silently orphaning.
  function referenceCount(oid) {
    const keys = (window.NMS.apiKeys && window.NMS.apiKeys.list()) || [];
    return keys.filter(k => k.device === oid).length;
  }

  function removeDevice(idx) {
    const d = state.devices[idx];
    const used = referenceCount(d.oid);
    if (used && !confirm(`${used} API key${used > 1 ? 's' : ''} reference this device. Delete anyway?`))
      return false;
    state.devices.splice(idx, 1);
    stage();
    return true;
  }

  function wireEditor() {
    const body = document.getElementById('devBody');

    // Device type drives the access labels and placeholder, so switching rebuilds the form —
    // entered values and the oid survive through collectForm.
    body.querySelector('[data-typesel]')?.addEventListener('change', () => {
      body.innerHTML = editorForm(collectForm(body));
      wireEditor();
    });

    document.getElementById('devUnpin')?.addEventListener('click', () => {
      draftFingerprint = '';
      const d = collectForm(body);
      if (editIdx != null) { state.devices[editIdx].fingerprint = ''; stage(); }
      body.innerHTML = editorForm(d);
      wireEditor();
    });

    // SASE: read the URL, api-key and body out of the pasted command. The two config values land in
    // the read-only fields; the key is held in draftApiKey until Save ships it to the appliance.
    document.getElementById('devParseCmd')?.addEventListener('click', () => {
      const out = document.getElementById('devParseResult');
      const cmd = body.querySelector('[data-f="paste_cmd"]')?.value || '';
      if (!cmd.trim()) {
        out.innerHTML = '<span style="color:var(--text-danger,#c33)">Paste the command first.</span>';
        return;
      }
      const p = parsePrismaCommand(cmd);
      if (!p.url && !p.apiKey) {
        out.innerHTML = '<span style="color:var(--text-danger,#c33)">No URL or api-key found in that command.</span>';
        return;
      }
      const d = collectForm(body);
      d.health = { url: p.url || (d.health && d.health.url) || '', body: p.body || (d.health && d.health.body) || '' };
      if (p.apiKey) draftApiKey = p.apiKey;
      body.innerHTML = editorForm(d);
      wireEditor();
      const got = [p.url ? 'URL' : '', p.apiKey ? 'api-key' : '', p.body ? 'body' : ''].filter(Boolean).join(', ');
      document.getElementById('devParseResult').innerHTML =
        '<span style="color:var(--text-success,#2a6)">✓ Read ' + esc(got) + '.</span>';
    });

    // NGFW: TLS-only handshake to fetch and pin the device certificate at creation time (no
    // credentials). On first contact the cert comes back untrusted; the operator confirms it here and
    // the pin is carried in draftFingerprint through save.
    document.getElementById('devCertProbe')?.addEventListener('click', async () => {
      const d = collectForm(body);
      const out = document.getElementById('devCertResult');
      if (!d.target) {
        out.innerHTML = `<span style="color:var(--text-danger,#c33)">Enter the ${esc(accessLabel(d.device_type))} first.</span>`; return;
      }
      out.textContent = 'Testing…';
      const btn = document.getElementById('devCertProbe');
      if (btn) btn.disabled = true;
      let res;
      try {
        res = await runTlsProbe({ target: d.target, fingerprint: d.fingerprint || '' });
      } catch (e) {
        out.innerHTML = '<span style="color:var(--text-danger,#c33)">✕ ' + esc(e.message || 'probe failed') + '</span>';
        return;
      } finally {
        if (btn) btn.disabled = false;
      }

      if (res.fingerprint_trusted) {
        out.innerHTML = '<span style="color:var(--text-success,#2a6)">✓ Certificate already trusted.</span>';
        return;
      }
      if (!res.fingerprint) {
        out.innerHTML = '<span style="color:var(--text-danger,#c33)">✕ ' + esc(res.message || 'could not reach the device') + '</span>';
        return;
      }
      // A device that already had a pin, answering with a different certificate, is not a routine
      // first contact — it may be interception. Say so, and make re-pinning the deliberate choice.
      const mismatch = !!d.fingerprint;
      out.innerHTML = `<div class="fp-prompt">
          <div class="fp-warn">${mismatch
            ? 'Certificate does NOT match the pinned one — possible interception'
            : 'Certificate not trusted yet'}</div>
          <code class="fp-val">${esc(res.fingerprint)}</code>
          <div class="fp-sub">${esc(res.cert_subject || '')}</div>
          <button class="btn-sm ${mismatch ? 'btn-danger' : 'btn-primary'}" id="devTrustFp" type="button">${
            mismatch ? 'Replace the pin anyway' : 'Trust certificate'}</button>
        </div>`;
      document.getElementById('devTrustFp').addEventListener('click', () => {
        draftFingerprint = res.fingerprint;
        if (editIdx != null) { state.devices[editIdx].fingerprint = res.fingerprint; stage(); }
        body.innerHTML = editorForm(collectForm(body));   // re-render so the pinned box shows
        wireEditor();
      });
    });

    document.getElementById('devCancel').onclick = closeEditor;
    document.getElementById('devClose').onclick = closeEditor;
    document.getElementById('devOverlay').onclick = closeEditor;

    const del = document.getElementById('devDelete');
    if (del) del.onclick = () => { if (removeDevice(editIdx)) { closeEditor(); render(); } };

    document.getElementById('devSave').onclick = async () => {
      const d = collectForm(body);
      if (!d.name) { alert('Device name is required.'); return; }
      if (!d.target) { alert(`${accessLabel(d.device_type)} is required.`); return; }

      // A freshly pasted api-key goes to the appliance now, not into the staged draft: it is sealed
      // there and must outlive both this page and the publish that clears the draft. Everything else
      // about the device stages as usual and reaches the config on publish.
      if (d.device_type === 'sase' && draftApiKey) {
        const btn = document.getElementById('devSave');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
          const res = await saveApiKey(d.oid, draftApiKey);
          if (!res.ok) { alert(res.message || 'The api-key could not be saved.'); return; }
          keyStored[d.oid] = true;
          draftApiKey = '';
        } catch (e) {
          alert(e.message || 'The api-key could not be saved.');
          return;
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
        }
      }

      if (editIdx == null) state.devices.push(d); else state.devices[editIdx] = d;
      closeEditor(); stage(); render();
    };
  }

  // ── Wiring (table) ────────────────────────────────────────────────────────────
  // Re-run after every body paint: sorting or filtering replaces the rows these buttons live in.
  function wireRows(scope) {
    scope.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openEditor(+b.dataset.edit)));
    scope.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (removeDevice(+b.dataset.del)) render();
    }));
    scope.querySelectorAll('[data-satest]').forEach(b =>
      b.addEventListener('click', () => runSaseRowTest(+b.dataset.satest)));
  }

  function wire() {
    document.getElementById('devAdd')?.addEventListener('click', () => openEditor(null));
    table.mount(document.getElementById('devTable'), state.devices);
  }

  // SASE infrastructure check, run from the device row (like the API Credential / Endpoint tests) so
  // it is not buried in the editor. Validates the getPrismaAccessIP api-key against the tenant and,
  // on success, probed seals + stores it. The URL/api-key come from the saved device draft.
  async function runSaseRowTest(idx) {
    const d = state.devices[idx];
    if (!d || d.device_type !== 'sase') return;
    if (!(d.health && d.health.url)) { alert('Paste the command first — edit the device.'); return; }
    if (!keyStored[d.oid] && !draftApiKey) {
      alert('No api-key is stored for this device yet — edit it, paste the command and save.');
      return;
    }

    const modal = window.NMS.modal;
    const tp = window.NMS.testPanel;
    const TITLE = 'SASE Infrastructure Check';

    // A getPrismaAccessIP read routinely takes several seconds, so the elapsed counter is what tells
    // the operator it is working rather than wedged.
    const run = tp.start(TITLE, ['getPrismaAccessIP read'],
                         'Reading the tenant’s infrastructure API — this usually takes a few seconds.');

    let res;
    try {
      // No api_key sent: the appliance holds the sealed one and uses it.
      res = await runSaseTest({ oid: d.oid, url: d.health.url, body: d.health.body });
    } catch (e) {
      run.stop();
      modal.open(TITLE, `<div class="test-panel err">
        ${tp.step('getPrismaAccessIP read', { ok: false, detail: e.message || 'test failed' })}</div>`);
      return;
    }

    const secs = run.stop();
    modal.open(TITLE, `<div class="ep-detail">
        <div class="test-panel ${res.ok ? 'ok' : 'err'}">
          ${tp.step('getPrismaAccessIP read', { ok: !!res.ok, detail: res.message || (res.ok ? 'passed' : 'failed') })}
          <div class="ts-note">Completed in ${secs.toFixed(1)}s.</div>
        </div>
        ${egressBlock(res)}
      </div>`);
  }

  // What the tenant actually answered — the same document the periodic probe caches in
  // sase_device.egress_result. The egress IP list is the reason for the call, so it is shown in full
  // rather than reduced to a pass/fail tick. Rendered on a failure too: an error body is usually
  // what says why.
  function egressBlock(res) {
    const doc = (res.egress != null) ? JSON.stringify(res.egress, null, 2) : (res.egress_raw || '');
    if (!doc) return '';
    return `<div class="ep-block">
        <div class="ep-block-h">Infrastructure response${res.http_status
          ? ` <span class="ep-status ${res.ok ? 'ok' : 'err'}">HTTP ${esc(res.http_status)}</span>` : ''}</div>
        <pre class="ep-rsp">${esc(doc)}</pre>
      </div>`;
  }

  // ── Staging provider ────────────────────────────────────────────────────────
  window.NMS.staging.register({
    key: DRAFT_KEY,
    dirty: () => JSON.stringify(state.devices) !== JSON.stringify(deployed),
    payload: commitPayload,
    before: () => splitForConfig(deployed),
    after: () => splitForConfig(state.devices),
    onPublished() {
      deployed = JSON.parse(JSON.stringify(state.devices));
      window.NMS.draft.clear(DRAFT_KEY);
    },
    problems() {
      const sites = (window.NMS.sites && window.NMS.sites.list()) || [];
      return state.devices
        .filter(d => d.site && !sites.some(s => s.oid === d.site))
        .map(d => `Device "${d.name || d.target}" belongs to a site that does not exist.`);
    },
  });

  // ── Cross-module surface ────────────────────────────────────────────────────
  // API keys, endpoints and connectors all resolve a device from here.
  window.NMS.devices = {
    list: () => state.devices.map(d => ({
      oid: d.oid, name: d.name, site: d.site, device_type: d.device_type,
      target: d.target, fingerprint: d.fingerprint,
    })),
    byOid: (oid) => state.devices.find(d => d.oid === oid) || null,
    label: (oid) => {
      const d = state.devices.find(x => x.oid === oid);
      return d ? (d.name || d.target) : null;
    },
    typeLabel,
    // Trust-on-first-use: the certificate belongs to the host, so the pin is stored here and
    // shared by every API key and endpoint that talks to this device.
    pinFingerprint(oid, fingerprint) {
      const d = state.devices.find(x => x.oid === oid);
      if (!d || !fingerprint) return;
      d.fingerprint = fingerprint;
      stage();
    },
  };

  // ── Init ────────────────────────────────────────────────────────────────────
  const devicesRefresh = async () => { await load(); render(); };

  function activate() {
    render();
    window.NMS.onRefresh(devicesRefresh);
  }

  // Data loads on every Configuration tab — the registry needs this domain's dirty state even
  // when another tab is showing — but rendering stays devices-only.
  document.addEventListener('DOMContentLoaded', async () => {
    if (activeTab() === 'devices') render();   // skeleton before the data lands
    await load();
    if (activeTab() === 'devices') activate();
    document.dispatchEvent(new Event('nms:devices-ready'));
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === 'devices') activate();
  });

  // Site names come from the Sites tab, which loads independently.
  document.addEventListener('nms:sites-ready', () => { if (activeTab() === 'devices') render(); });
})();

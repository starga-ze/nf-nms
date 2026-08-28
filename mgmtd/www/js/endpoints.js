/* endpoints.js — Configuration ▸ API Profile ▸ API Endpoint.
 *
 * An API Endpoint is one call pretzel can make: the path and the query parameters, and nothing
 * about who to make it against. Keeping the device out is what makes it reusable — "fetch the
 * address objects" is written once and run against any customer's box.
 *
 * A test therefore names an API Key rather than a device: the key already carries the device it
 * was issued by, plus the credential to authenticate with. One choice supplies both.
 *
 * The release is part of the path (/restapi/v10.2/…) and pretzel does not rewrite it, so an
 * endpoint is implicitly scoped to the releases that serve that path — name it accordingly.
 *
 * Which API it speaks is read from the path rather than asked: PAN-OS serves the XML API under
 * /api/ and the REST API under /restapi/. That decides how the key is attached (query parameter
 * vs X-PAN-KEY header), so nothing is gained by making the operator restate it.
 *
 * Testing happens from the list, not the editor — the endpoint is a definition you keep and
 * re-verify, so the row carries its own Test action and Status.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  // Read live (not once): settings tabs switch client-side without a page load (see main.js).
  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const DRAFT_KEY = 'api_endpoints';

  const { esc, newUuid } = window.NMS.utils;

  // An endpoint belongs to a device type, and that is the first branch in everything below: an NGFW
  // endpoint is a path on the operator's own firewall authenticated with a PAN-OS key; a SASE
  // endpoint is an absolute URL on a Palo Alto cloud product authenticated with an OAuth bearer
  // token. They share a name, a description and an oid, and nothing else.
  const DEVICE_TYPES = [
    { id: 'ngfw', label: 'NGFW', sub: 'PAN-OS firewall' },
    { id: 'sase', label: 'SASE', sub: 'Prisma Access tenant' },
  ];
  const normDeviceType = (t) => (t === 'sase' ? 'sase' : 'ngfw');

  // Device type has exactly one sub-choice under it, and it is the same slot on both sides even
  // though it means different things: for NGFW which PAN-OS API the path speaks, for SASE which
  // cloud product the URL belongs to. One stored field (`subtype`) rather than two mutually
  // exclusive ones — `api_type` and `product` were never both meaningful, and having both meant
  // every reader had to know which half of the record it was looking at first.
  const SUBTYPES = {
    // NGFW — the two PAN-OS APIs. They differ in how the key is attached, nothing else.
    rest: { device: 'ngfw', label: 'REST API', enabled: true },
    xml:  { device: 'ngfw', label: 'XML API',  enabled: true },

    // SASE — the products. They all speak JSON over the same OAuth; what differs is the host, the
    // path layout and the required headers, which is why the choice here seeds those.
    ztna: {
      device: 'sase', label: 'ZTNA Connector', enabled: true,
      url: 'https://api.sase.paloaltonetworks.com/sse/connector/v2.0/api/connector-groups',
      // x-panw-region is not optional and cannot be derived from the tenant: the wrong value answers
      // 424 "tenant not found", which reads as a broken tenant rather than a wrong header. Seeded so
      // the operator is asked the question at the moment they can answer it.
      headers: [{ name: 'x-panw-region', value: '' }],
      params: [],
      hint: 'Region required: americas, au, ca, de, europe, in, jp, sg, uk.',
    },
    // Listed but not selectable, so the menu is honest about what exists rather than implying the
    // list is complete.
    pab: { device: 'sase', label: 'Prisma Access Browser', enabled: false },
    scm: { device: 'sase', label: 'Strata Cloud Manager',  enabled: false },
  };

  const subtypesFor = (deviceType) =>
    Object.entries(SUBTYPES).filter(([, s]) => s.device === deviceType);
  const subtypeSpec = (st) => SUBTYPES[st] || SUBTYPES.rest;
  const defaultSubtype = (deviceType) => (deviceType === 'sase' ? 'ztna' : 'rest');

  // Legacy records carry `api_type` (ngfw) or `product` (the first SASE cut) instead of `subtype`;
  // one written before either falls back to reading the PAN-OS API off the path, whose two roots
  // are unambiguous.
  function normSubtype(e, deviceType) {
    const raw = e.subtype || (deviceType === 'sase' ? e.product : e.api_type);
    const spec = SUBTYPES[raw];
    if (spec && spec.device === deviceType && spec.enabled) return raw;
    if (deviceType === 'ngfw') return String(e.path || '').indexOf('/restapi/') === 0 ? 'rest' : 'xml';
    return defaultSubtype(deviceType);
  }

  // Per-type starting points. PAN-OS serves the REST API under /restapi/<ver>/… with its arguments
  // as query parameters, and the XML API under /api/ where everything — including the command —
  // is a query parameter. The key is attached differently too (X-PAN-KEY header vs key= param),
  // which collectord does from the api_type the endpoint now carries.
  // The path is a worked example — it shows the shape of a REST route and is meant to be edited.
  // The query parameters are NOT: `location=vsys&vsys=vsys1` is right for one endpoint on one
  // release and wrong for the next, and a pre-filled argument is one an operator has to notice and
  // delete rather than one they chose. A new endpoint therefore starts with none.
  const TYPE_DEFAULTS = {
    rest: { path: '/restapi/v10.2/Objects/Addresses', params: [] },
    xml:  { path: '/api',
            params: [{ name: 'type', value: 'op' },
                     { name: 'cmd', value: '<show><system><info></info></system></show>' }] },
  };

  // Test outcomes are runtime state, not part of the declaration, so they are held apart and
  // never stage the configuration. The database has api_endpoint_state for this.
  const STATE_KEY = 'api_endpoint_state';
  const testState = {
    for: (oid) => (window.NMS.draft.get(STATE_KEY, {})[oid] || null),
    put(oid, result) {
      const s = window.NMS.draft.get(STATE_KEY, {});
      s[oid] = result;
      window.NMS.draft.set(STATE_KEY, s);
    },
  };

  const state = { endpoints: [] };
  let deployed = [];
  let editIdx = null;
  let draftOid = null;
  let draftDeviceType = 'ngfw';   // fixed for the life of an endpoint; drives collect() and the form

  // Stored unencoded; percent-encoded when the URL is built, so raw values (an XML API cmd=<show>…
  // included) can be typed as-is. Query parameters and request headers share this shape.
  const normPairs = (list) => (Array.isArray(list) ? list : [])
    .map(p => ({ name: String((p && p.name) || ''), value: String((p && p.value) || '') }))
    .filter(p => p.name);

  function normalize(e) {
    const deviceType = normDeviceType(e.device_type);
    const base = {
      oid: (typeof e.oid === 'string' && e.oid) ? e.oid : newUuid(),
      name: e.name || '',
      description: e.description || '',
      device_type: deviceType,
      subtype: normSubtype(e, deviceType),
      path: e.path || '',
      params: normPairs(e.params),
    };

    // Only the fields the chosen device type actually uses are carried. Keeping the other half
    // around would put dead keys in the committed configuration and in every diff.
    return deviceType === 'sase'
      ? Object.assign(base, { host: e.host || '', headers: normPairs(e.headers) })
      : base;
  }

  const isSase = (e) => e && e.device_type === 'sase';

  // A SASE endpoint is entered as ONE absolute URL — the line a vendor's documentation prints and an
  // operator pastes. Host, path and any query it carries are derived from it rather than asked for
  // separately: they are not three decisions, they are one string the operator already has.
  //
  // Returns the parts; the query is handed back as parameter rows, which is where they stay editable
  // (pagination is edited far more often than the path is).
  function splitSaseUrl(raw) {
    let s = String(raw || '').trim().replace(/^https?:\/\//i, '');
    const q = s.indexOf('?');
    const query = q === -1 ? '' : s.slice(q + 1);
    if (q !== -1) s = s.slice(0, q);

    const slash = s.indexOf('/');
    const host = (slash === -1 ? s : s.slice(0, slash)).trim();
    const path = slash === -1 ? '' : s.slice(slash);

    const params = query.split('&').filter(Boolean).map(tok => {
      const eq = tok.indexOf('=');
      return eq === -1 ? { name: decodeURIComponent(tok), value: '' }
                       : { name: decodeURIComponent(tok.slice(0, eq)),
                           value: decodeURIComponent(tok.slice(eq + 1)) };
    }).filter(p => p.name);

    return { host, path, params };
  }

  // Nothing is seeded: TYPE_DEFAULTS and the product specs are placeholder text, shown grey, never
  // a value the operator has to notice and delete.
  const blankNgfw = (subtype) => normalize({ device_type: 'ngfw', subtype });

  const blankSase = (subtype) => normalize({
    device_type: 'sase', subtype,
    // The one exception: a required header the operator must supply a value for. The NAME is
    // structure, not a suggestion — leaving it out would just make them look it up.
    headers: ((subtypeSpec(subtype).headers) || []).map(h => ({ ...h })),
  });

  const blank = (deviceType, subtype) => {
    const st = subtype || defaultSubtype(deviceType);
    return deviceType === 'sase' ? blankSase(st) : blankNgfw(st);
  };

  // The path + query string this endpoint calls, percent-encoded — matches the server-side build and
  // is what actually goes on the wire.
  function effectivePath(e) {
    let path = e.path || '';
    (e.params || []).forEach(p => {
      if (!p.name) return;
      path += (path.indexOf('?') === -1) ? '?' : '&';
      path += encodeURIComponent(p.name) + '=' + encodeURIComponent(p.value);
    });
    return path;
  }

  // What the row and the preview show. A SASE endpoint carries its own host, so the whole URL is the
  // identifying thing; an NGFW endpoint is a path that only means something against a chosen device.
  const effectiveUrl = (e) => (isSase(e) ? 'https://' + (e.host || '') + effectivePath(e) : effectivePath(e));

  // XML API endpoints are entered as one line — the whole URL the firewall's API browser prints,
  // e.g. /api?type=op&cmd=<show><system><info/></system></show>. It is stored the same way every
  // endpoint is (path + params), so the encode-on-send path is unchanged; these two just convert
  // between that shape and the single readable string the operator pastes and edits.
  function rawXmlUrl(e) {
    const params = (e.params || []).filter(p => p.name);
    if (!params.length) return e.path || '';
    return (e.path || '') + '?' + params.map(p => `${p.name}=${p.value}`).join('&');
  }

  function parseXmlUrl(raw) {
    const s = String(raw || '').trim();
    const q = s.indexOf('?');
    const path = q === -1 ? s : s.slice(0, q);
    const query = q === -1 ? '' : s.slice(q + 1);
    // The cmd value can contain '=' (an XML attribute), so split on the FIRST '=' only. '<>' are
    // stored raw and percent-encoded at send time, exactly like a REST parameter value.
    const params = query.split('&').filter(Boolean).map(tok => {
      const eq = tok.indexOf('=');
      return eq === -1 ? { name: tok.trim(), value: '' }
                       : { name: tok.slice(0, eq).trim(), value: tok.slice(eq + 1) };
    }).filter(p => p.name);
    return { path, params };
  }

  // ── Staging ──────────────────────────────────────────────────────────────────
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.endpoints); refreshPending(); };
  const refreshPending = () => window.NMS.staging.refresh();

  // ── Data load ────────────────────────────────────────────────────────────────
  async function load() {
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      const api = ((d.daemons || {}).collectord || {}).api || {};
      deployed = (Array.isArray(api.endpoints) ? api.endpoints : []).map(normalize);
    } catch (_) { deployed = []; }
    const staged = window.NMS.draft.get(DRAFT_KEY, null);
    state.endpoints = Array.isArray(staged) ? staged.map(normalize) : JSON.parse(JSON.stringify(deployed));
    refreshPending();
  }

  const commitPayload = () => [{ daemon: 'collectord', domain: 'api', values: { endpoints: state.endpoints } }];

  window.NMS.staging.register({
    key: DRAFT_KEY,
    dirty: () => JSON.stringify(state.endpoints) !== JSON.stringify(deployed),
    payload: commitPayload,
    before: () => ({ endpoints: deployed }),
    after: () => ({ endpoints: state.endpoints }),
    onPublished() {
      deployed = JSON.parse(JSON.stringify(state.endpoints));
      window.NMS.draft.clear(DRAFT_KEY);
    },
  });

  // ── Cross-module surface ─────────────────────────────────────────────────────
  window.NMS.apiEndpoints = {
    list: () => state.endpoints.map(e => ({
      oid: e.oid, name: e.name, device_type: e.device_type, subtype: e.subtype,
      path: effectivePath(e), url: effectiveUrl(e),
    })),
    byOid: (oid) => state.endpoints.find(e => e.oid === oid) || null,
    label: (oid) => {
      const e = state.endpoints.find(x => x.oid === oid);
      return e ? e.name : null;
    },
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  // Two columns, not one badge stacked on another: device type decides which credentials can run the
  // endpoint at all, subtype decides how the call is built. They answer different questions and are
  // sorted and scanned separately.
  const deviceBadge = (e) =>
    `<span class="api-badge dev-${esc(e.device_type)}">${esc(e.device_type.toUpperCase())}</span>`;
  const subtypeBadge = (e) =>
    `<span class="api-badge ${esc(e.subtype)}">${esc(subtypeSpec(e.subtype).label)}</span>`;

  function statusCell(e) {
    const t = testState.for(e.oid);
    if (!t) return `<span class="st-never">never tested</span>`;
    const when = window.NMS.utils.fmtTs(t.at);
    // Which key it was proven against matters: the same path can pass on one release and 404 on
    // another, so the tooltip names it.
    const via = t.via ? ` via ${t.via}` : '';
    return t.ok
      ? `<span class="st-ok" title="HTTP ${esc(t.status || 200)}${esc(via)} — ${esc(when)}">OK</span>`
      : `<span class="st-fail" title="${esc(t.detail || '')}${esc(via)} — ${esc(when)}">failed</span>`;
  }

  // The word the Status column reads as — and the word its filter offers. Ordered worst-first when
  // sorted descending is not what an operator wants; they want the untested and the failed together
  // at one end, so the rank is "how proven is this", not alphabetical.
  const statusText = (e) => {
    const t = testState.for(e.oid);
    return !t ? 'never tested' : (t.ok ? 'OK' : 'failed');
  };
  const statusRank = (e) => {
    const t = testState.for(e.oid);
    return !t ? 0 : (t.ok ? 2 : 1);
  };

  // ── Table (sort / filter / search) ───────────────────────────────────────────
  const table = window.NMS.table.create({
    id: 'cfg.endpoints',
    tableClass: 'cfg-table-endpoint',
    searchPlaceholder: 'Search endpoints…',
    empty: `<div class="cfg-empty">No API endpoints yet — click <b>Add Endpoint</b> to define one.
              An endpoint is device-independent; a test names the API Key to run it against.</div>`,
    onRows: wireRows,
    columns: [
      { key: 'name', label: 'Name', cls: 'col-name', filter: 'text',
        text: (e) => e.name,
        cell: (e) => `<div class="cell-name">${esc(e.name) || '<span class="muted">unnamed</span>'}</div>` },
      { key: 'description', label: 'Description', cls: 'col-desc', filter: 'text',
        text: (e) => e.description },
      { key: 'device_type', label: 'Device Type', cls: 'col-dev', filter: 'enum',
        text: (e) => String(e.device_type || '').toUpperCase(), cell: deviceBadge },
      { key: 'subtype', label: 'SubType', cls: 'col-type', filter: 'enum',
        text: (e) => subtypeSpec(e.subtype).label, cell: subtypeBadge },
      { key: 'endpoint', label: 'Endpoint', cls: 'col-ep', filter: 'text',
        text: effectiveUrl,
        cell: (e) => `<span class="ep-path" title="${esc(effectiveUrl(e))}">${esc(effectiveUrl(e))}</span>` },
      { key: 'status', label: 'Status', cls: 'col-status', filter: 'enum',
        text: statusText, sortValue: statusRank, cell: statusCell },
      { key: 'act', label: '', cls: 'col-act', sort: false,
        cell: (e, i) => `
          <button class="btn-sm" data-test="${i}">Endpoint Test</button>
          <button class="icon-btn" data-edit="${i}" title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
          </button>
          <button class="icon-btn danger" data-del="${i}" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` },
    ],
  });

  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== 'api-endpoint') return;

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">API Endpoints</span>
            <span class="cfg-h-sub">${state.endpoints.length} endpoint${state.endpoints.length === 1 ? '' : 's'}</span>
          </div>
          <button class="btn-primary btn-sm" id="epAdd">+ Add Endpoint</button>
        </div>

        <div id="epTable"></div>

        <p class="cfg-foot-note">Reusable across devices. The PAN-OS release is part of the path,
          so name endpoints accordingly.</p>
      </div>

      <div class="slideover-overlay" id="epOverlay"></div>
      <aside class="slideover" id="epPanel">
        <div class="slideover-head">
          <span class="slideover-title" id="epTitle">Add Endpoint</span>
          <button class="slideover-close" id="epClose">&times;</button>
        </div>
        <div class="slideover-body" id="epBody"></div>
        <div class="slideover-foot" id="epFoot"></div>
      </aside>`;

    wire();
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  function paramRow(p) {
    return `<div class="param-row">
        <input data-p="name" value="${esc(p.name)}" placeholder="name"/>
        <input data-p="value" value="${esc(p.value)}" placeholder="value"/>
        <button class="icon-btn danger" data-prm-del type="button" title="Remove">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
  }

  // The device type is fixed for the life of an endpoint — it is chosen when the endpoint is created
  // and shown read-only afterwards. Switching it would not be an edit but a different endpoint: the
  // path, the host, the auth and the connectors that reference it would all have to change together,
  // and any connector still pointing at it would silently start calling somewhere else.
  function editorForm(e) {
    const head = `
      <div class="field-row"><label>Device type</label>
        <div class="ep-fixed">${esc(DEVICE_TYPES.find(d => d.id === e.device_type).label)}
          <span class="lbl-sub">${esc(DEVICE_TYPES.find(d => d.id === e.device_type).sub)}</span></div></div>
      <div class="field-row"><label>Name</label>
        <input data-f="name" value="${esc(e.name)}" placeholder="${isSase(e) ? 'e.g. ZTNA connector groups' : 'e.g. address objects'}"/></div>
      <div class="field-row"><label>Description</label>
        <input data-f="description" value="${esc(e.description)}" placeholder="optional"/></div>`;

    return head + (isSase(e) ? saseForm(e) : ngfwForm(e)) +
      `<div class="ep-preview"><span class="ep-preview-h">Calls</span>
        <code id="epPreview">${esc(effectiveUrl(e)) || '—'}</code></div>`;
  }

  function ngfwForm(e) {
    // Both call layouts are rendered and toggled by a class on #epCall (no rebuild, so edits in the
    // hidden one survive a switch). The inactive type is pre-seeded with its default so switching
    // lands on a usable starting point.
    const restData = e.subtype === 'rest' ? e : { path: '', params: [] };
    const xmlData = e.subtype === 'xml' ? e : { path: '', params: [] };

    return `
      <div class="editor-sec">CALL</div>
      <div class="field-row"><label>SubType</label>
        <div class="seg" id="epTypeSeg">
          <button type="button" class="seg-btn${e.subtype === 'rest' ? ' active' : ''}" data-seg="rest">REST API</button>
          <button type="button" class="seg-btn${e.subtype === 'xml' ? ' active' : ''}" data-seg="xml">XML API</button>
        </div></div>

      <div id="epCall" class="call-${e.subtype === 'xml' ? 'xml' : 'rest'}">
        <div class="call-block call-rest-block">
          <div class="field-row"><label>Endpoint</label>
            <input data-f="rest-path" value="${esc(restData.path)}" placeholder="${esc(TYPE_DEFAULTS.rest.path)}"/></div>
          <p class="field-hint">Key attached as an <code>X-PAN-KEY</code> header.</p>
          <div class="param-head">
            <label>Query parameters</label>
            <button class="btn-sm" id="epParamAdd" type="button">+ Param</button>
          </div>
          <div class="param-list" id="epParamList">${(restData.params.length ? restData.params : [{ name: '', value: '' }])
            .map(paramRow).join('')}</div>
          <p class="field-hint">Values are percent-encoded for you — type them raw.</p>
        </div>

        <div class="call-block call-xml-block">
          <div class="field-row"><label>Endpoint <span class="lbl-sub">— full XML API URL</span></label>
            <input data-f="xml-url" value="${esc(rawXmlUrl(xmlData))}"
              placeholder="/api?type=op&amp;cmd=&lt;show&gt;&lt;system&gt;&lt;info/&gt;&lt;/system&gt;&lt;/show&gt;"/></div>
          <p class="field-hint">Paste from the firewall's API browser. The key is added for you.</p>
        </div>
      </div>`;
  }

  // One URL in, everything else derived. The operator pastes the line the vendor's documentation
  // prints; host and path are split out of it and shown read-only, because they are not separate
  // decisions and letting them be edited apart from the URL gives three fields that can disagree.
  // A pasted query string is moved into the parameter rows, where it stays editable — pagination is
  // changed far more often than a path is.
  //
  // Authorization is deliberately not among the headers: the bearer token is minted per call from
  // the API Credential and never lives in configuration.
  function saseForm(e) {
    const spec = subtypeSpec(e.subtype);
    const headers = e.headers.length ? e.headers : [{ name: '', value: '' }];
    const params = e.params.length ? e.params : [{ name: '', value: '' }];

    return `
      <div class="editor-sec">CALL</div>
      ${subtypeRow(e)}

      <div class="field-row"><label>Endpoint <span class="lbl-sub">— full URL</span></label>
        <input data-f="sase-url" value="${esc(saseUrlOf(e))}"
          placeholder="${esc(spec.url || 'https://api.sase.paloaltonetworks.com/…')}"/></div>
      <div class="ep-derived">
        <div><span class="ep-derived-k">Host</span><code id="epHostOut">${esc(e.host) || '—'}</code></div>
        <div><span class="ep-derived-k">Path</span><code id="epPathOut">${esc(e.path) || '—'}</code></div>
      </div>
      <p class="field-hint">Host and path are split out of the URL; a query string moves into the
        parameters below.${spec.hint ? ' ' + esc(spec.hint) : ''}</p>

      <div class="param-head">
        <label>Headers</label>
        <button class="btn-sm" id="epHeaderAdd" type="button">+ Header</button>
      </div>
      <div class="param-list" id="epHeaderList">${headers.map(paramRow).join('')}</div>
      <p class="field-hint"><code>Authorization</code> is added for you — do not set it here.</p>

      <div class="param-head">
        <label>Query parameters</label>
        <button class="btn-sm" id="epParamAdd" type="button">+ Param</button>
      </div>
      <div class="param-list" id="epParamList">${params.map(paramRow).join('')}</div>
      <p class="field-hint">Values are percent-encoded for you — type them raw.</p>`;
  }

  // The URL shown in the single input: host + path only. The query lives in the parameter rows, so
  // putting it back here too would let the same argument be stated twice.
  const saseUrlOf = (e) => (e.host ? 'https://' + e.host + (e.path || '') : (e.path || ''));

  // SubType picker — the same slot on both sides, listing only what the device type offers.
  function subtypeRow(e) {
    const opts = subtypesFor(e.device_type).map(([id, s]) =>
      `<option value="${esc(id)}" ${id === e.subtype ? 'selected' : ''} ${s.enabled ? '' : 'disabled'}>${
        esc(s.label)}${s.enabled ? '' : ' — not supported yet'}</option>`).join('');
    return `<div class="field-row"><label>SubType</label>
        <select data-f="subtype">${opts}</select></div>`;
  }

  const rowsOf = (body, sel) => Array.from(body.querySelectorAll(sel + ' .param-row')).map(row => ({
    name: (row.querySelector('[data-p="name"]').value || '').trim(),
    value: (row.querySelector('[data-p="value"]').value || '').trim(),
  }));

  function collect(body) {
    const g = (k) => {
      const el = body.querySelector(`[data-f="${k}"]`);
      return el ? el.value.trim() : '';
    };

    if (draftDeviceType === 'sase') {
      // The URL is the source of truth for host and path; a query the operator pasted is merged into
      // the parameter rows rather than kept in two places.
      const { host, path, params } = splitSaseUrl(g('sase-url'));
      const rows = rowsOf(body, '#epParamList').filter(p => p.name);
      const merged = rows.concat(params.filter(p => !rows.some(r => r.name === p.name)));

      return normalize({
        oid: draftOid,
        device_type: 'sase',
        name: g('name'),
        description: g('description'),
        subtype: g('subtype'),
        host,
        path,
        headers: rowsOf(body, '#epHeaderList'),
        params: merged,
      });
    }

    const type = body.querySelector('#epTypeSeg .seg-btn.active')?.dataset.seg || 'rest';

    // Read only the active layout: XML is one pasted URL (parsed back into path + params); REST is
    // an explicit path plus parameter rows.
    let path, params;
    if (type === 'xml') {
      ({ path, params } = parseXmlUrl(g('xml-url')));
    } else {
      path = g('rest-path');
      params = rowsOf(body, '.call-rest-block');
    }

    return normalize({
      oid: draftOid,
      device_type: 'ngfw',
      name: g('name'),
      description: g('description'),
      subtype: type,
      path,
      params,
    });
  }

  // The preview is the encoded URL that actually goes on the wire — for XML that means the pasted
  // <> show up percent-encoded, which is the point.
  function refreshPreview() {
    const body = document.getElementById('epBody');
    const prev = document.getElementById('epPreview');
    if (prev) prev.textContent = effectiveUrl(collect(body)) || '—';
  }

  function wireParamRow(row) {
    row.querySelectorAll('input').forEach(i => i.addEventListener('input', refreshPreview));
    row.querySelector('[data-prm-del]').addEventListener('click', () => { row.remove(); refreshPreview(); });
  }

  // Adding asks for the device type first, in its own small step, because it decides which form is
  // shown rather than being a field within one. Editing skips it — the type is fixed once chosen.
  function openAddPicker() {
    const opts = DEVICE_TYPES.map(d =>
      `<label class="ep-pick"><input type="radio" name="epDev" value="${esc(d.id)}" ${
        d.id === 'ngfw' ? 'checked' : ''}/>
        <span class="ep-pick-t">${esc(d.label)}</span>
        <span class="ep-pick-s">${esc(d.sub)}</span></label>`).join('');

    window.NMS.modal.open('Add Endpoint', `
      <p class="cm-lead">What does this endpoint call? This cannot be changed later.</p>
      <div class="ep-picks">${opts}</div>`,
      `<button class="btn-sm" id="cmDone">Cancel</button>
       <span style="flex:1"></span>
       <button class="btn-primary btn-sm" id="epPickGo">Continue</button>`);

    document.getElementById('epPickGo').onclick = () => {
      const chosen = document.querySelector('input[name="epDev"]:checked');
      window.NMS.modal.close();
      openEditor(null, chosen ? chosen.value : 'ngfw');
    };
  }

  function openEditor(idx, deviceType, subtype) {
    editIdx = idx;
    const e = idx == null ? blank(deviceType, subtype) : normalize(JSON.parse(JSON.stringify(state.endpoints[idx])));
    draftOid = e.oid;
    draftDeviceType = e.device_type;
    document.getElementById('epTitle').textContent = idx == null ? 'Add Endpoint' : 'Edit Endpoint';
    document.getElementById('epBody').innerHTML = editorForm(e);
    document.getElementById('epFoot').innerHTML = `
      ${idx == null ? '' : '<button class="btn-sm btn-danger" id="epDelete">Delete</button>'}
      <span style="flex:1"></span>
      <button class="btn-sm" id="epCancel">Cancel</button>
      <button class="btn-primary btn-sm" id="epSave">Save</button>`;
    wireEditor();
    document.getElementById('epOverlay').classList.add('open');
    document.getElementById('epPanel').classList.add('open');
  }

  const closeEditor = () => {
    document.getElementById('epOverlay').classList.remove('open');
    document.getElementById('epPanel').classList.remove('open');
  };

  function usedByCount(oid) {
    const conns = (window.NMS.apiConnectors && window.NMS.apiConnectors()) || [];
    return conns.filter(c => c.api_endpoint === oid || (c.endpoints || []).some(x => x.endpoint === oid)).length;
  }

  function removeEndpoint(idx) {
    const e = state.endpoints[idx];
    const used = usedByCount(e.oid);
    if (used && !confirm(`${used} connector${used > 1 ? 's' : ''} still reference this endpoint. Delete anyway?`))
      return false;
    state.endpoints.splice(idx, 1);
    stage();
    return true;
  }

  function wireEditor() {
    const body = document.getElementById('epBody');

    body.querySelectorAll('[data-f]').forEach(el =>
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', refreshPreview));
    body.querySelectorAll('.param-row').forEach(wireParamRow);

    // Switching type just shows the other layout (both are already in the DOM, pre-seeded). NGFW only.
    body.querySelectorAll('#epTypeSeg .seg-btn').forEach(btn => btn.addEventListener('click', () => {
      body.querySelectorAll('#epTypeSeg .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      const call = document.getElementById('epCall');
      call.classList.remove('call-rest', 'call-xml');
      call.classList.add('call-' + btn.dataset.seg);
      refreshPreview();
    }));

    const addRowTo = (listId) => {
      const list = document.getElementById(listId);
      list.insertAdjacentHTML('beforeend', paramRow({ name: '', value: '' }));
      wireParamRow(list.lastElementChild);
      list.lastElementChild.querySelector('[data-p="name"]').focus();
    };
    document.getElementById('epParamAdd').onclick = () => addRowTo('epParamList');
    document.getElementById('epHeaderAdd')?.addEventListener('click', () => addRowTo('epHeaderList'));

    // Changing the SASE subtype re-seeds the URL and the headers — they belong to the product, not
    // to the operator, until edited. Only ZTNA is selectable today, so this is the seam rather than a
    // path anyone walks yet.
    body.querySelector('[data-f="subtype"]')?.addEventListener('change', (ev) => {
      const spec = subtypeSpec(ev.target.value);
      const url = body.querySelector('[data-f="sase-url"]');
      url.value = '';
      url.placeholder = spec.url || '';
      const list = document.getElementById('epHeaderList');
      list.innerHTML = ((spec.headers && spec.headers.length) ? spec.headers : [{ name: '', value: '' }])
        .map(paramRow).join('');
      list.querySelectorAll('.param-row').forEach(wireParamRow);
      refreshPreview();
    });

    // Host and path are read-only derivations of the URL, so they are recomputed as it is typed
    // rather than after a save — an operator should see the split happen, not be told about it.
    body.querySelector('[data-f="sase-url"]')?.addEventListener('input', (ev) => {
      const { host, path } = splitSaseUrl(ev.target.value);
      const h = document.getElementById('epHostOut');
      const p = document.getElementById('epPathOut');
      if (h) h.textContent = host || '—';
      if (p) p.textContent = path || '—';
    });

    document.getElementById('epCancel').onclick = closeEditor;
    document.getElementById('epClose').onclick = closeEditor;
    document.getElementById('epOverlay').onclick = closeEditor;

    const del = document.getElementById('epDelete');
    if (del) del.onclick = () => { if (removeEndpoint(editIdx)) { closeEditor(); render(); } };

    document.getElementById('epSave').onclick = () => {
      const e = collect(body);
      if (!e.name) { alert('Name is required.'); return; }
      if (!e.path || e.path[0] !== '/') { alert('Path must start with /'); return; }

      if (isSase(e)) {
        if (!e.host) { alert('Host is required, e.g. api.sase.paloaltonetworks.com'); return; }
        if (e.host.indexOf('/') !== -1) { alert('Host is a hostname only — put the rest in Path.'); return; }
        if (e.headers.some(h => h.name.toLowerCase() === 'authorization')) {
          alert('Authorization is added for you from the API Credential — remove it here.'); return;
        }
        // Caught at save rather than at test time: a wrong or missing region answers 424
        // "tenant not found", which does not read as a header problem at all.
        if (e.subtype === 'ztna' && !e.headers.some(h => h.name.toLowerCase() === 'x-panw-region' && h.value)) {
          alert('The ZTNA API needs an x-panw-region header with a value — americas, au, ca, de, europe, in, jp, sg or uk.');
          return;
        }
      } else if (e.subtype === 'xml' && !e.params.some(p => p.name === 'type')) {
        // Every PAN-OS XML API request needs a type= (op, config, commit, …); without it the device
        // answers "type is required", so catch it here rather than at test time.
        alert('An XML API URL needs a type= parameter, e.g. /api?type=op&cmd=…'); return;
      }
      if (editIdx == null) state.endpoints.push(e); else state.endpoints[editIdx] = e;
      stage();
      closeEditor(); render();
    };

    refreshPreview();
  }

  // ── Endpoint test ───────────────────────────────────────────────────────────
  // Runs from the row. The browser cannot reach a customer's firewall, so mgmtd hands the call
  // to collectord — the daemon that also polls these connectors on a schedule — and returns a ticket
  // we poll. 40 × 700ms bounds the wait above collectord's own per-step timeout.
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
    if (!start.ok || !started || !started.ticket)
      throw new Error((started && started.error) || ('HTTP ' + start.status));

    for (let i = 0; i < POLL_LIMIT; i++) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const r = await fetch('/api/connector/test-result?ticket=' + started.ticket,
                            { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => null);
      if (d && d.status === 'done') return d;
    }
    throw new Error('timed out waiting for the device');
  }

  const stepRow = (label, st) => window.NMS.testPanel.step(label, st);

  function formatBody(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text || (text[0] !== '{' && text[0] !== '[')) return text;
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return text; }
  }

  // The endpoint is what is being debugged, so the outcome gets the whole window: the exact
  // request line on top, the full response below.
  function detailView(res, steps, secs) {
    const req = res.request || {};
    const rsp = res.response || {};
    return `
      <div class="ep-detail">
        <div class="test-panel ${res.ok ? 'ok' : 'err'}">
          ${stepRow('TLS connection', steps.tls)}
          ${stepRow('API key generation', steps.auth)}
          ${stepRow('Endpoint response', steps.endpoint)}
          ${secs == null ? '' : `<div class="ts-note">Completed in ${secs.toFixed(1)}s.</div>`}
        </div>
        ${req.url ? `<div class="ep-block">
          <div class="ep-block-h">Request</div>
          <pre class="ep-req">${esc(req.method || 'GET')} ${esc(req.url)}</pre>
          <div class="ep-note">API key sent via ${esc(req.key_delivery || '')} — redacted above.</div>
        </div>` : ''}
        ${rsp.status != null ? `<div class="ep-block">
          <div class="ep-block-h">Response
            <span class="ep-status ${res.ok ? 'ok' : 'err'}">HTTP ${esc(rsp.status)}</span>
            ${rsp.bytes != null ? `<span class="ep-bytes">${esc(rsp.bytes)} bytes${rsp.truncated ? ', truncated' : ''}</span>` : ''}
          </div>
          <pre class="ep-rsp">${esc(formatBody(rsp.body))}</pre>
        </div>` : ''}
      </div>`;
  }

  // An endpoint says what to call, not who to call it on — so the test names an API Key, and the
  // key supplies both the device (address, pinned certificate) and the credential. The same
  // endpoint can therefore be proven against several customers' boxes in turn.
  function openTestPicker(idx) {
    const e = state.endpoints[idx];

    // Only credentials bound to a device of this endpoint's type can run it. Offering the others
    // would let an operator pick a SASE credential for a PAN-OS path and get a meaningless failure
    // to debug — the two authenticate differently and reach different hosts.
    const keys = ((window.NMS.apiKeys && window.NMS.apiKeys.list()) || []).filter(k => {
      const d = window.NMS.devices ? window.NMS.devices.byOid(k.device) : null;
      return d && normDeviceType(d.device_type) === e.device_type;
    });

    if (!keys.length) {
      alert(`No API Credential is bound to a ${e.device_type.toUpperCase()} device yet — add one under ` +
            'API Profile ▸ API Credential first.');
      return;
    }

    const opts = keys.map(k => {
      const d = window.NMS.devices ? window.NMS.devices.byOid(k.device) : null;
      const where = d ? (d.name || d.target) : 'device missing';
      return `<option value="${esc(k.oid)}">${esc(k.name)} — ${esc(where)}</option>`;
    }).join('');

    window.NMS.modal.open('API Endpoint Test', `
      <p class="cm-lead">Runs <code>${esc(effectiveUrl(e))}</code> ${isSase(e)
        ? 'for the tenant the chosen credential belongs to.'
        : 'against the device the chosen key belongs to.'}</p>
      <div class="field-row"><label>API Credential</label>
        <select id="epTestKey">${opts}</select></div>`,
      `<button class="btn-sm" id="cmDone">Cancel</button>
       <span style="flex:1"></span>
       <button class="btn-primary btn-sm" id="epRunTest">Run test</button>`);

    document.getElementById('epRunTest').onclick = () =>
      runEndpointTest(idx, document.getElementById('epTestKey').value);
  }

  async function runEndpointTest(idx, keyOid) {
    const e = state.endpoints[idx];
    const keyRecord = window.NMS.apiKeys ? window.NMS.apiKeys.byOid(keyOid) : null;
    if (!keyRecord) { alert('That API Key no longer exists.'); return; }

    const dev = window.NMS.devices ? window.NMS.devices.byOid(keyRecord.device) : null;
    if (!dev) { alert('The key references a device that no longer exists.'); return; }

    // Name the API Key (api_key_oid) so probed rides on the key already issued for this profile
    // instead of re-issuing one on every endpoint test. The password is only a fallback for the
    // case where no key has been issued yet — with a stored key it is not needed at all.
    const hasStored = window.NMS.apiKeys ? window.NMS.apiKeys.hasKey(keyOid) : false;
    const held = window.NMS.apiKeySecrets ? window.NMS.apiKeySecrets.for(keyOid) : {};
    if (!hasStored && !held.password) {
      alert('That API Key has no key issued yet — enter its password on the API Key page and run the key generation once.');
      return;
    }

    const modal = window.NMS.modal;
    const run = window.NMS.testPanel.start('API Endpoint Test',
      isSase(e) ? ['TLS connection', 'Token', 'Endpoint response']
                : ['TLS connection', 'API key generation', 'Endpoint response'],
      isSase(e) ? `Calling ${effectiveUrl(e)} for ${dev.name || dev.target}.`
                : `Calling ${effectivePath(e)} on ${dev.name || dev.target}.`);

    let res;
    try {
      // `target` is the device's address for NGFW and the tenant (TSG) id for SASE — in both cases
      // it is what the credential authenticates against, which is why one field carries both.
      const payload = {
        api_key_oid: keyOid,
        target: dev.target,
        device_type: e.device_type,
        keygen_endpoint: keyRecord.endpoint,
        endpoint: e.path,
        params: e.params,
      };
      if (isSase(e)) {
        payload.host = e.host;
        payload.headers = e.headers;
      } else {
        payload.fingerprint = dev.fingerprint;
        payload.subtype = e.subtype;
      }
      // Only carry the password when one is held; a stored key makes it unnecessary.
      if (held.password) payload.secrets = { username: keyRecord.username, password: held.password };
      res = await runDeviceTest('/api/connector/endpoint-test', payload);
    } catch (err) {
      run.stop();
      testState.put(e.oid, { at: Date.now(), ok: false, detail: err.message, via: keyRecord.name });
      render();
      modal.open('API Endpoint Test', `<div class="test-panel err"><div class="ts-note">${esc(err.message)}</div></div>`);
      return;
    }

    const secs = run.stop();
    const steps = res.steps || {};
    testState.put(e.oid, {
      at: Date.now(), ok: !!res.ok,
      status: res.response ? res.response.status : 0,
      detail: res.message || '',
      via: keyRecord.name,
    });

    const trust = (res.fingerprint && !res.fingerprint_trusted)
      ? `<div class="fp-prompt">
           <div class="fp-warn">Certificate is not trusted yet (self-signed)</div>
           <code class="fp-val">${esc(res.fingerprint)}</code>
           <div class="fp-sub">${esc(res.cert_subject || '')}</div>
           <button class="btn-sm btn-primary" id="epTrustFp">Trust this certificate</button>
         </div>`
      : '';

    modal.open('API Endpoint Test', detailView(res, steps, secs) + trust);

    document.getElementById('epTrustFp')?.addEventListener('click', (ev) => {
      window.NMS.devices.pinFingerprint(dev.oid, res.fingerprint);
      ev.currentTarget.outerHTML = '<span class="fp-trusted">Pinned to the device — run the test again.</span>';
    });

    render();
  }

  // Re-run after every body paint: sorting or filtering replaces the rows these buttons live in.
  function wireRows(scope) {
    scope.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openEditor(+b.dataset.edit)));
    scope.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (removeEndpoint(+b.dataset.del)) render();
    }));
    scope.querySelectorAll('[data-test]').forEach(b =>
      b.addEventListener('click', () => openTestPicker(+b.dataset.test)));
  }

  function wire() {
    document.getElementById('epAdd')?.addEventListener('click', openAddPicker);
    table.mount(document.getElementById('epTable'), state.endpoints);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const endpointRefresh = async () => { await load(); render(); };

  function activate() {
    render();
    window.NMS.onRefresh(endpointRefresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    if (activeTab() === 'api-endpoint') activate();
    document.dispatchEvent(new Event('nms:endpoints-ready'));
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === 'api-endpoint') activate();
  });

  document.addEventListener('nms:api-keys-ready', () => { if (activeTab() === 'api-endpoint') render(); });
  document.addEventListener('nms:connectors-ready', () => { if (activeTab() === 'api-endpoint') render(); });
})();

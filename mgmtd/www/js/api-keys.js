/* api-keys.js — Configuration ▸ API Profile ▸ API Key.
 *
 * An API Key is the credential pretzel uses against one device. It is bound to a Device rather
 * than floating free, because a PAN-OS key is issued by a specific box and is worthless on any
 * other — so "one credential, many devices" would be a fiction. The device also decides the
 * credential shape (NGFW: username/password today; SASE comes later).
 *
 * The operator supplies the key-generation endpoint, since customer estates run releases we do
 * not control. Testing happens from the list, not the editor: a key is a thing you keep and
 * re-verify, so the row carries its own Test action and Status.
 *
 * Config vs state: the record below is what the operator declared — name, device, endpoint,
 * account. Everything the system produces about the key (the issued secret, when it expires,
 * how the last test went) is runtime state and is kept apart, because writing it into
 * running_config would mint a configuration version every time a key was re-issued and would
 * show machine noise in the operator's review diff. The database has api_key_state for exactly
 * this; until the encrypted credential store lands the same fields live per browser tab, which
 * is also why mgmtd refuses a commit carrying password/secret/api_key.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  // Read live (not once): settings tabs switch client-side without a page load (see main.js).
  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const DRAFT_KEY = 'api_credentials';
  const SECRET_KEY = 'api_key_secrets';

  const { esc, newUuid } = window.NMS.utils;

  // Credential shape per device type. SASE uses a different scheme (client id/secret against a
  // tenant), so it is declared but left unimplemented rather than faked with id/pw.
  const CREDENTIALS = {
    ngfw: {
      supported: true,
      keygenHint: '/api/?type=keygen',
      fields: [
        ['username', 'Username', 'text', 'svc-pretzel'],
        ['password', 'Password', 'password', ''],
      ],
    },
    // SASE (Prisma Access) issues a short-lived OAuth2 bearer token from a service account. The token
    // URL is fixed on Palo Alto's auth server (no operator endpoint), and the tenant (TSG) comes from
    // the device's target. Client ID / Client Secret reuse the username/password slots, so they land
    // in the same api_key_state id_enc/pw_enc as an NGFW account.
    sase: {
      supported: true,
      // The endpoint is the auth server host+path (editable, for a different region/cloud), not a
      // device path — so it is shown and validated differently from NGFW.
      hostEndpoint: true,
      keygenHint: 'auth.apps.paloaltonetworks.com/oauth2/access_token',
      fields: [
        ['username', 'Client ID', 'text', 'service account client id'],
        ['password', 'Client Secret', 'password', ''],
      ],
    },
  };
  const credSpec = (deviceType) => CREDENTIALS[deviceType] || CREDENTIALS.ngfw;

  // The password never comes back from the appliance — only whether one is sealed there. So a saved
  // credential is rendered as bullets, the same way the SASE device editor renders its api-key: the
  // field shows a mask and a line saying where the secret lives. The mask is a sentinel, not a value;
  // collect() drops it so leaving the field untouched cannot overwrite the sealed password with dots.
  const KEY_MASK = '••••••••••••••••';

  const state = { keys: [] };
  let deployed = [];
  let editIdx = null;
  let draftOid = null;
  let draftSite = '';   // Editor-only: the site whose devices the Device select is scoped to.

  // ── Key runtime state ─────────────────────────────────────────────────────────
  // Split by ownership. The stored-key flag, expiry and last-test outcome are server truth, shared
  // across sessions — engined persists them in api_key_state and mgmtd serves them at
  // /api/connector/keys-state. The password the operator types stays browser-local (sessionStorage
  // via NMS.draft): it is never persisted here and goes nowhere but a test request.
  let serverState = {};

  async function loadKeyState() {
    try {
      const r = await fetch('/api/connector/keys-state', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.ok) serverState = (await r.json()) || {};
    } catch (_) { /* keep the last snapshot on a blip */ }
  }

  const secrets = {
    for: (oid) => {
      const srv = serverState[oid] || {};
      const local = window.NMS.draft.get(SECRET_KEY, {})[oid] || {};
      return {
        stored: !!srv.stored,
        has_credential: !!srv.has_credential,
        expires_at: srv.expires_at || null,
        last_test: srv.last_test || null,
        password: local.password,   // browser-local, this session only
      };
    },
    put(oid, vals) {   // browser-local store — only the typed password is kept here
      const s = window.NMS.draft.get(SECRET_KEY, {});
      s[oid] = Object.assign(s[oid] || {}, vals);
      window.NMS.draft.set(SECRET_KEY, s);
    },
    drop(oid) {
      const s = window.NMS.draft.get(SECRET_KEY, {});
      delete s[oid];
      window.NMS.draft.set(SECRET_KEY, s);
    },
  };
  window.NMS.apiKeySecrets = secrets;

  function normalize(k) {
    return {
      // `uuid`/`id` = legacy keys from before the identifier merge.
      oid: (typeof k.oid === 'string' && k.oid) ? k.oid : (k.uuid || k.id || newUuid()),
      name: k.name || '',
      device: k.device || '',        // Device oid — decides the credential shape
      endpoint: k.endpoint || '',    // key-generation path, operator-entered
      username: k.username || '',
      // Refresh policy: 'manual' re-issues on Test; 'auto' re-issues on the interval (minutes).
      refresh_mode: k.refresh_mode === 'auto' ? 'auto' : 'manual',
      refresh_interval_min: Number(k.refresh_interval_min) > 0 ? Number(k.refresh_interval_min) : 60,
    };
  }

  const blank = () => normalize({ endpoint: CREDENTIALS.ngfw.keygenHint });

  // ── Staging ──────────────────────────────────────────────────────────────────
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.keys); refreshPending(); };
  const refreshPending = () => window.NMS.staging.refresh();

  // ── Data load ────────────────────────────────────────────────────────────────
  async function load() {
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      const api = ((d.scopes || {}).pretzel || {}).connector || {};
      deployed = (Array.isArray(api.api_credentials) ? api.api_credentials : []).map(normalize);
    } catch (_) { deployed = []; }
    await loadKeyState();   // shared per-key runtime state (stored/expiry/last test)
    const staged = window.NMS.draft.get(DRAFT_KEY, null);
    state.keys = Array.isArray(staged) ? staged.map(normalize) : JSON.parse(JSON.stringify(deployed));
    refreshPending();
  }

  const commitPayload = () => [{ scope: 'pretzel', domain: 'connector', values: { api_credentials: state.keys } }];

  window.NMS.staging.register({
    key: DRAFT_KEY,
    dirty: () => JSON.stringify(state.keys) !== JSON.stringify(deployed),
    payload: commitPayload,
    before: () => ({ api_credentials: deployed }),
    after: () => ({ api_credentials: state.keys }),
    onPublished() {
      deployed = JSON.parse(JSON.stringify(state.keys));
      window.NMS.draft.clear(DRAFT_KEY);
    },
    problems() {
      const devices = (window.NMS.devices && window.NMS.devices.list()) || [];
      return state.keys
        .filter(k => !k.device || !devices.some(d => d.oid === k.device))
        .map(k => `API Credential "${k.name}" is bound to a device that does not exist.`);
    },
  });

  // ── Cross-module surface ─────────────────────────────────────────────────────
  window.NMS.apiKeys = {
    list: () => state.keys.map(k => ({ oid: k.oid, name: k.name, device: k.device })),
    byOid: (oid) => state.keys.find(k => k.oid === oid) || null,
    label: (oid) => {
      const k = state.keys.find(x => x.oid === oid);
      return k ? k.name : null;
    },
    // The key is held by the appliance, not the browser; callers that need a call made with it
    // ask mgmtd to make it.
    hasKey: (oid) => !!secrets.for(oid).stored,
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  const deviceOf = (k) => (window.NMS.devices && window.NMS.devices.byOid(k.device)) || null;
  const devices = () => (window.NMS.devices && window.NMS.devices.list()) || [];

  // Endpoint column: the stored endpoint, or the device type's default when none was saved yet
  // (that default is exactly what the backend falls back to), so SASE and NGFW both always show one.
  function endpointCell(k) {
    const dev = deviceOf(k);
    const spec = credSpec(dev ? dev.device_type : 'ngfw');
    const ep = k.endpoint || spec.keygenHint || '';
    return ep ? `<span class="ep-path" title="${esc(ep)}">${esc(ep)}</span>` : '<span class="muted">—</span>';
  }

  // Credential column: the account id, plus a masked marker when a secret is held (typed this
  // session or stored on the appliance) — the secret itself never reaches the browser.
  function credCell(k) {
    const st = secrets.for(k.oid);
    const user = esc(k.username) || '<span class="muted">—</span>';
    return user + ((st.has_credential || st.password) ? '<div class="cred-pw">*****</div>' : '');
  }
  const sites = () => (window.NMS.sites && window.NMS.sites.list()) || [];
  const siteName = (oid) => (window.NMS.sites && window.NMS.sites.label(oid)) || '';

  // Devices are picked Site-first: choose a site, then only that site's devices are offered.
  function deviceOptsForSite(siteOid, selectedOid) {
    if (!siteOid) return '<option value="">— select a site first —</option>';
    const inSite = devices().filter(d => d.site === siteOid);
    if (!inSite.length) return '<option value="">— no devices in this site —</option>';
    return ['<option value="">— select a device —</option>'].concat(
      inSite.map(d => `<option value="${esc(d.oid)}" ${d.oid === selectedOid ? 'selected' : ''}>${
        esc(d.name || d.target)} (${esc(window.NMS.devices.typeLabel(d.device_type))})</option>`)
    ).join('');
  }

  function deviceCell(k) {
    const d = deviceOf(k);
    if (!d) return `<span class="ref-missing" title="Device ${esc(k.device)} no longer exists">missing</span>`;
    return `<div class="cell-name">${esc(d.name) || esc(d.target)}</div>
            <div class="cell-sub">${esc(window.NMS.devices.typeLabel(d.device_type))} · ${esc(d.target)}</div>`;
  }

  // The site is derived from the bound device, not stored on the key.
  function siteCell(k) {
    const d = deviceOf(k);
    const name = d ? siteName(d.site) : '';
    return name ? `<div class="cell-name">${esc(name)}</div>` : `<span class="muted">—</span>`;
  }

  // The key itself never comes back to the browser — it is encrypted and stored by engined, so
  // there is nothing here to mask. The row reports whether one is held.
  function keyCell(k) {
    const st = secrets.for(k.oid);
    if (!st.stored) return `<span class="muted">not generated</span>`;
    return `<code class="key-mask" title="Encrypted on the appliance; never sent to the browser">stored</code>`;
  }

  const parseTs = (s) => window.NMS.utils.parseTs(s);

  // SASE tokens live ~15 minutes, so a day-granularity "today" says nothing useful. Remaining life
  // is bucketed into the tiers an operator acts on — 15m / 10m / 5m / 1m / expired — rounding up to
  // the tier that still holds, so "5m" means "no more than five minutes left, not yet under one".
  const EXPIRY_TIERS = [
    { ms:  1 * 60000, label: '1m',  cls: 'st-fail' },
    { ms:  5 * 60000, label: '5m',  cls: 'st-warn' },
    { ms: 10 * 60000, label: '10m', cls: 'st-warn' },
    { ms: 15 * 60000, label: '15m', cls: 'st-ok'   },
  ];

  function expiryCell(k) {
    const st = secrets.for(k.oid);
    if (!st.stored) return `<span class="muted">—</span>`;
    if (!st.expires_at) {
      // PAN-OS keys do not expire unless an API key lifetime is configured on the device.
      return `<span class="st-never" title="No API key lifetime set on the device">no expiry</span>`;
    }
    const when = parseTs(st.expires_at);
    if (!when) return `<span class="st-never" title="${esc(st.expires_at)}">unknown</span>`;
    const left = when.getTime() - Date.now();
    const at = esc(window.NMS.utils.fmtTs(when));
    if (left <= 0) return `<span class="st-fail" title="${at}">expired</span>`;

    const tier = EXPIRY_TIERS.find(t => left <= t.ms);
    if (tier) return `<span class="${tier.cls}" title="Expires ${at}">${tier.label}</span>`;

    // Longer-lived keys (an NGFW lifetime configured on the device) keep the coarse view.
    const days = Math.floor(left / 86400000);
    return `<span class="${days <= 7 ? 'st-warn' : 'st-ok'}" title="Expires ${at}">${
      days > 0 ? days + 'd left' : Math.floor(left / 3600000) + 'h left'}</span>`;
  }

  // Refresh policy at a glance.
  function refreshCell(k) {
    return k.refresh_mode === 'auto'
      ? `<span class="st-ok" title="Re-issued automatically">auto · ${esc(k.refresh_interval_min || 60)}m</span>`
      : `<span class="muted" title="Re-issued on Test">manual</span>`;
  }

  // Status reflects whether a currently-valid token/key is held: none, expired (invalid), or valid.
  function statusCell(k) {
    const st = secrets.for(k.oid);
    if (!st.stored) return `<span class="st-never">no token</span>`;
    const when = parseTs(st.expires_at);
    if (when && when.getTime() <= Date.now())
      return `<span class="st-fail" title="${esc(window.NMS.utils.fmtTs(when))}">invalid (expired)</span>`;
    return `<span class="st-ok">valid</span>`;
  }

  // ── Expiry ticker ────────────────────────────────────────────────────────────
  // A 15-minute token walks down a tier while the page sits open, so the Expiry column is repainted
  // once a minute — the finest tier the display distinguishes. Only those cells are touched: a full
  // render() would fight an open editor or a running test. The remaining time is recomputed from the
  // expires_at already held, except once a key reads expired — then the state is re-fetched first,
  // since an auto-refresh key has likely been re-issued on the appliance and the row is stale.
  const EXPIRY_TICK_MS = 60000;
  let expiryTimer = null;

  function paintExpiry() {
    document.querySelectorAll('#contentBody [data-expiry-oid]').forEach(td => {
      const k = state.keys.find(x => x.oid === td.dataset.expiryOid);
      if (k) td.innerHTML = expiryCell(k);
    });
  }

  function stopExpiryTicker() {
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = null;
  }

  function startExpiryTicker() {
    stopExpiryTicker();
    expiryTimer = setInterval(async () => {
      const cells = document.querySelectorAll('#contentBody [data-expiry-oid]');
      if (activeTab() !== 'api-key' || !cells.length) { stopExpiryTicker(); return; }
      const anyExpired = Array.from(cells).some(td => {
        const when = parseTs(secrets.for(td.dataset.expiryOid).expires_at);
        return when && when.getTime() <= Date.now();
      });
      if (anyExpired) await loadKeyState();
      paintExpiry();
    }, EXPIRY_TICK_MS);
  }

  // ── Column accessors ─────────────────────────────────────────────────────────
  // What each cell says in plain text — what the search box reads, what the filters offer, and what
  // the column is ordered by unless a sortValue overrides it.
  const siteText = (k) => { const d = deviceOf(k); return d ? (siteName(d.site) || '') : ''; };
  const deviceText = (k) => {
    const d = deviceOf(k);
    if (!d) return k.device ? 'missing' : '';
    return [d.name || d.target, window.NMS.devices.typeLabel(d.device_type), d.target]
      .filter(Boolean).join(' ');
  };
  const endpointText = (k) => {
    const dev = deviceOf(k);
    return k.endpoint || credSpec(dev ? dev.device_type : 'ngfw').keygenHint || '';
  };
  const keyText = (k) => (secrets.for(k.oid).stored ? 'stored' : 'not generated');
  const refreshText = (k) => (k.refresh_mode === 'auto' ? 'auto' : 'manual');
  // Manual keys have no interval, so they sort past every automatic one rather than pretending to be
  // a zero-minute schedule.
  const refreshRank = (k) =>
    (k.refresh_mode === 'auto' ? (Number(k.refresh_interval_min) || 60) : Number.MAX_SAFE_INTEGER);

  const statusText = (k) => {
    const st = secrets.for(k.oid);
    if (!st.stored) return 'no token';
    const when = parseTs(st.expires_at);
    return (when && when.getTime() <= Date.now()) ? 'invalid (expired)' : 'valid';
  };

  // Expiry is ordered by the instant it happens, not by the label — "5m" and "3d left" are the same
  // kind of thing and must not sort alphabetically. A key with no token sorts last (nothing to run
  // out); one that never expires sorts after every one that does.
  function expiryText(k) {
    const st = secrets.for(k.oid);
    if (!st.stored) return '';
    if (!st.expires_at) return 'no expiry';
    const when = parseTs(st.expires_at);
    if (!when) return 'unknown';
    const left = when.getTime() - Date.now();
    if (left <= 0) return 'expired';
    const tier = EXPIRY_TIERS.find(t => left <= t.ms);
    if (tier) return tier.label;
    const days = Math.floor(left / 86400000);
    return days > 0 ? days + 'd left' : Math.floor(left / 3600000) + 'h left';
  }

  function expiryRank(k) {
    const st = secrets.for(k.oid);
    if (!st.stored) return '';                       // blank — sorts last in both directions
    if (!st.expires_at) return Number.MAX_SAFE_INTEGER;
    const when = parseTs(st.expires_at);
    return when ? when.getTime() : Number.MAX_SAFE_INTEGER - 1;
  }

  // ── Table (sort / filter / search) ───────────────────────────────────────────
  const table = window.NMS.table.create({
    id: 'cfg.api-keys',
    tableClass: 'cfg-table-apikey',
    searchPlaceholder: 'Search credentials…',
    empty: `<div class="cfg-empty">No API credentials yet — click <b>Add API Credential</b> to define one.</div>`,
    onRows: wireRows,
    columns: [
      { key: 'name', label: 'Name', cls: 'col-name', filter: 'text',
        text: (k) => k.name,
        cell: (k) => `<div class="cell-name">${esc(k.name) || '<span class="muted">unnamed</span>'}</div>` },
      { key: 'site', label: 'Site', cls: 'col-site', filter: 'enum',
        text: siteText, cell: siteCell },
      { key: 'device', label: 'Device', cls: 'col-device', filter: 'text',
        text: deviceText, cell: deviceCell },
      { key: 'endpoint', label: 'Endpoint', cls: 'col-ep', filter: 'text',
        text: endpointText, cell: endpointCell },
      { key: 'credential', label: 'Credential', cls: 'col-cred', filter: 'text',
        text: (k) => k.username, cell: credCell },
      { key: 'key', label: 'Key', cls: 'col-key', filter: 'enum',
        text: keyText, cell: keyCell },
      // Filtering on a countdown would be a filter that stops being true while you read it; Status
      // is the durable question ("which of these cannot authenticate right now") and carries it.
      { key: 'expiry', label: 'Expiry', cls: 'col-expiry', filter: false,
        text: expiryText, sortValue: expiryRank,
        cell: (k) => `<span data-expiry-oid="${esc(k.oid)}">${expiryCell(k)}</span>` },
      { key: 'refresh', label: 'Refresh', cls: 'col-refresh', filter: 'enum',
        text: refreshText, sortValue: refreshRank, cell: refreshCell },
      { key: 'status', label: 'Status', cls: 'col-status', filter: 'enum',
        text: statusText, cell: statusCell },
      { key: 'act', label: '', cls: 'col-act', sort: false,
        cell: (k, i) => `
          <button class="btn-sm" data-test="${i}">Credential Test</button>
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
    if (!el || activeTab() !== 'api-key') { stopExpiryTicker(); return; }

    const devices = (window.NMS.devices && window.NMS.devices.list()) || [];

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">API Credentials</span>
            <span class="cfg-h-sub">${state.keys.length} key${state.keys.length === 1 ? '' : 's'}
              · one credential per device${devices.length ? ''
                : ' · <a href="settings?tab=devices">add a device first</a>; a key belongs to one'}</span>
          </div>
          <button class="btn-primary btn-sm" id="akAdd" ${devices.length ? '' : 'disabled'}>+ Add API Credential</button>
        </div>

        <div id="akTable"></div>

      </div>

      <div class="slideover-overlay" id="akOverlay"></div>
      <aside class="slideover" id="akPanel">
        <div class="slideover-head">
          <span class="slideover-title" id="akTitle">Add API Credential</span>
          <button class="slideover-close" id="akClose">&times;</button>
        </div>
        <div class="slideover-body" id="akBody"></div>
        <div class="slideover-foot" id="akFoot"></div>
      </aside>

      <div class="test-result" id="akTestResult"></div>`;

    wire();
    startExpiryTicker();
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  function fieldRow(label, key, val, type, ph) {
    return `<div class="field-row"><label>${esc(label)}</label>
        <input type="${type === 'password' ? 'password' : 'text'}"${
          type === 'password' ? ' autocomplete="new-password"' : ''} data-f="${esc(key)}"
          value="${esc(val)}" placeholder="${esc(ph || '')}"/></div>`;
  }

  function editorForm(k) {
    const dev = devices().find(d => d.oid === k.device);
    const spec = credSpec(dev ? dev.device_type : 'ngfw');
    const held = secrets.for(k.oid);

    const siteOpts = ['<option value="">— select a site —</option>'].concat(
      sites().map(s => `<option value="${esc(s.oid)}" ${draftSite === s.oid ? 'selected' : ''}>${esc(s.name)}</option>`)
    ).join('');

    // Three states, in the order they happen: typed but not yet saved → sealed on the appliance →
    // nothing yet. Only the middle one survives a refresh, and it is server truth (has_credential),
    // so another host or browser session sees the bullets too.
    const pwState = held.password
      ? { val: KEY_MASK, hint: 'entered — sealed on the appliance when you press Save' }
      : held.has_credential
        ? { val: KEY_MASK, hint: 'stored on the appliance (sealed) — type to replace it' }
        : { val: '', hint: '' };

    const creds = spec.supported
      ? spec.fields.map(([f, label, type, ph]) => {
          if (type !== 'password') return fieldRow(label, f, k[f] || '', type, ph);
          return fieldRow(label, f, pwState.val, type, pwState.val ? '' : ph)
               + (pwState.hint ? `<p class="field-hint" style="margin-top:-6px">${esc(pwState.hint)}</p>` : '');
        }).join('')
      : `<p class="field-hint">${esc(spec.note || 'Not supported yet.')}</p>`;

    return `
      ${fieldRow('Name', 'name', k.name, 'text', 'e.g. sherpain-fw key')}
      <div class="field-row"><label>Site</label>
        <select data-sitesel>${siteOpts}</select></div>
      <div class="field-row"><label>Device</label>
        <select data-f="device" data-devsel>${deviceOptsForSite(draftSite, k.device)}</select></div>
      ${dev ? `<p class="field-hint">Device type <b>${esc(window.NMS.devices.typeLabel(dev.device_type))}</b>
                 — reached at <code>${esc(dev.target)}</code>.</p>` : ''}

      <div class="editor-sec">KEY GENERATION</div>
      ${fieldRow(spec.hostEndpoint ? 'Token endpoint' : 'Endpoint', 'endpoint', k.endpoint, 'text', spec.keygenHint)}
      <p class="field-hint">${spec.hostEndpoint
        ? 'Token host and path.'
        : 'Path only — the host comes from the device.'}</p>

      <div class="editor-sec">CREDENTIAL</div>
      ${creds}

      <div class="editor-sec">REFRESH</div>
      <div class="field-row"><label>Mode</label>
        <div class="ak-refresh">
          <label class="ak-radio"><input type="radio" name="rmode" value="manual" ${k.refresh_mode !== 'auto' ? 'checked' : ''}/> Manual</label>
          <label class="ak-radio"><input type="radio" name="rmode" value="auto" ${k.refresh_mode === 'auto' ? 'checked' : ''}/> Auto</label>
        </div></div>
      <div class="field-row" id="akIntervalRow" style="${k.refresh_mode === 'auto' ? '' : 'display:none'}">
        <label>Interval (min)</label>
        <input type="number" min="1" data-f="refresh_interval_min" value="${esc(k.refresh_interval_min || 60)}"/></div>
      <p class="field-hint">${spec.hostEndpoint
        ? 'SASE tokens expire in ~15 minutes. Auto re-issues on the interval.'
        : 'NGFW keys do not expire; Auto is optional.'}</p>`;
  }

  function collect(body) {
    const g = (f) => {
      const el = body.querySelector(`[data-f="${f}"]`);
      return el ? el.value.trim() : '';
    };
    const rmode = body.querySelector('input[name="rmode"]:checked');
    const out = normalize({
      oid: draftOid,
      name: g('name'),
      device: g('device'),
      endpoint: g('endpoint'),
      username: g('username'),
      refresh_mode: rmode ? rmode.value : 'manual',
      refresh_interval_min: g('refresh_interval_min'),
    });

    // Typed passwords go straight to the browser-held store, never into the record. The mask is what
    // an untouched field carries when a secret is already held, so it is not a password.
    const pw = g('password');
    if (pw && pw !== KEY_MASK) secrets.put(draftOid, { password: pw });
    return out;
  }

  function openEditor(idx) {
    editIdx = idx;
    const k = idx == null ? blank() : normalize(JSON.parse(JSON.stringify(state.keys[idx])));
    draftOid = k.oid;
    draftSite = (deviceOf(k) || {}).site || '';   // scope the Device select to the current device's site
    document.getElementById('akTitle').textContent = idx == null ? 'Add API Credential' : 'Edit API Credential';
    document.getElementById('akBody').innerHTML = editorForm(k);
    document.getElementById('akFoot').innerHTML = `
      ${idx == null ? '' : '<button class="btn-sm btn-danger" id="akDelete">Delete</button>'}
      <span style="flex:1"></span>
      <button class="btn-sm" id="akCancel">Cancel</button>
      <button class="btn-primary btn-sm" id="akSave">Save</button>`;
    wireEditor();
    document.getElementById('akOverlay').classList.add('open');
    document.getElementById('akPanel').classList.add('open');
  }

  const closeEditor = () => {
    document.getElementById('akOverlay').classList.remove('open');
    document.getElementById('akPanel').classList.remove('open');
  };

  function wireEditor() {
    const body = document.getElementById('akBody');

    // Auto/Manual toggles the interval row.
    body.querySelectorAll('input[name="rmode"]').forEach(r => r.addEventListener('change', () => {
      const row = body.querySelector('#akIntervalRow');
      if (row) row.style.display = (r.value === 'auto' && r.checked) ? '' : 'none';
    }));

    // Picking a site re-scopes the device list and clears any prior device.
    body.querySelector('[data-sitesel]')?.addEventListener('change', (e) => {
      draftSite = e.target.value;
      const k = collect(body);
      k.device = '';
      body.innerHTML = editorForm(k);
      wireEditor();
    });

    // Device decides the credential shape, so changing it rebuilds the form. The endpoint form
    // differs by type (device path vs full token URL), so reset it to the new type's default unless
    // the operator already typed one that still fits that type.
    body.querySelector('[data-devsel]')?.addEventListener('change', () => {
      const k = collect(body);
      const dev = (window.NMS.devices && window.NMS.devices.byOid(k.device)) || null;
      const spec = credSpec(dev ? dev.device_type : 'ngfw');
      const fitsType = k.endpoint && (spec.hostEndpoint ? k.endpoint.indexOf('/') > 0 : k.endpoint[0] === '/');
      if (!fitsType) k.endpoint = spec.keygenHint || '';
      body.innerHTML = editorForm(k);
      wireEditor();
    });

    // A masked field is showing that a secret exists, not its value — so the first keystroke replaces
    // it wholesale rather than appending to the bullets.
    const pwEl = body.querySelector('[data-f="password"]');
    if (pwEl && pwEl.value === KEY_MASK) {
      const clear = () => { if (pwEl.value === KEY_MASK) pwEl.value = ''; };
      pwEl.addEventListener('focus', clear);
      pwEl.addEventListener('beforeinput', clear);
    }

    // Site and Device selects get the themed dropdown (consistent across OSes).
    window.NMS.utils.enhanceSelects(body);

    document.getElementById('akCancel').onclick = closeEditor;
    document.getElementById('akClose').onclick = closeEditor;
    document.getElementById('akOverlay').onclick = closeEditor;

    const del = document.getElementById('akDelete');
    if (del) del.onclick = async () => { if (await removeKey(editIdx)) { closeEditor(); render(); } };

    document.getElementById('akSave').onclick = async () => {
      window.NMS.utils.clearEditorError(body);
      const k = collect(body);
      const dv = (window.NMS.devices && window.NMS.devices.byOid(k.device)) || null;
      const sp = credSpec(dv ? dv.device_type : 'ngfw');
      if (!k.name) return window.NMS.utils.editorError(body, 'Name is required.', 'name');
      if (!k.device)
        return window.NMS.utils.editorError(body, 'Select the device this key belongs to.', 'device');
      if (sp.hostEndpoint) {
        if (!k.endpoint || k.endpoint.indexOf('/') < 1)
          return window.NMS.utils.editorError(
            body, 'Token endpoint must be a host and a path.', 'endpoint');
      } else if (!k.endpoint || k.endpoint[0] !== '/') {
        return window.NMS.utils.editorError(body, 'Endpoint must be a path starting with /', 'endpoint');
      }

      // A password typed here goes to the appliance now, sealed, rather than sitting in this
      // browser's storage waiting for a test to pass — otherwise it is invisible from any other
      // browser or machine. Once stored the local copy is dropped; the row shows ***** from the
      // server's has_credential.
      const typed = secrets.for(k.oid).password;
      if (typed) {
        const btn = document.getElementById('akSave');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
          const res = await storeCredential(k.oid, k.username, typed);
          if (!res.ok) { alert(res.message || 'The password could not be saved.'); return; }
          secrets.drop(k.oid);
          await loadKeyState();   // pick up has_credential so the row renders *****
        } catch (e) {
          alert(e.message || 'The password could not be saved.');
          return;
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
        }
      }

      if (editIdx == null) state.keys.push(k); else state.keys[editIdx] = k;
      stage();
      closeEditor(); render();
    };
  }

  function usedByCount(oid) {
    const conns = (window.NMS.apiConnectors && window.NMS.apiConnectors()) || [];
    return conns.filter(c => c.api_key === oid).length;
  }

  async function removeKey(idx) {
    const k = state.keys[idx];
    const used = usedByCount(k.oid);
    if (used)
    {
      const ok = await window.NMS.confirm({
        title: 'Remove API credential',
        message: `${used} connector${used > 1 ? 's' : ''} still reference this credential.`,
        detail: 'They will show as missing until you point them somewhere else.',
        confirmLabel: 'Remove anyway',
      });
      if (!ok)
        return false;
    }
    secrets.drop(k.oid);
    state.keys.splice(idx, 1);
    stage();
    return true;
  }

  // ── Key generation test ─────────────────────────────────────────────────────
  // Runs from the row: a key is something you keep and re-verify, so it is not buried in an
  // editor. The browser cannot reach a customer's firewall, so mgmtd hands the call to collectord and
  // returns a ticket we poll — neither daemon blocks its single loop on a slow device.
  const POLL_MS = 700;
  const POLL_LIMIT = 40;

  // Seal + store this key's account credential on the appliance. Called on Save, so the password
  // survives a refresh, a different browser and a different machine — it is the same ticket/poll
  // shape as the tests, since collectord (which holds credentials.key) does the sealing.
  async function storeCredential(oid, username, password) {
    const start = await fetch('/api/connector/credential', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oid, secrets: { username, password } }),
    });
    if (start.status === 401) { location.href = '/'; return { ok: false, message: 'session expired' }; }
    const started = await start.json().catch(() => null);
    if (!start.ok || !started || !started.ticket)
      throw new Error((started && started.error) || 'could not save the password');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const r = await fetch('/api/connector/test-result?ticket=' + started.ticket,
                            { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const d = await r.json().catch(() => null);
      if (d && d.status === 'done') return d;
    }
    throw new Error('saving the password timed out');
  }

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

  // The issued key/token, shown back in the moment it was generated. The device minted it from the
  // operator's own account and a PAN-OS key is routinely copied out for other tooling, so hiding it
  // would just mean generating it twice. It appears only here: the stored copy is sealed, the test
  // ticket it rode in on is drained on read, and nothing about it is logged.
  function keyBlock(res, isSase) {
    if (!res.key) return '';
    const label = isSase ? 'Access token' : 'API key';
    return `<div class="secret-box">
        <div class="secret-label">${esc(label)}
          <button class="btn-sm" id="akCopyKey" type="button">Copy</button></div>
        <code class="secret-val" id="akKeyVal">${esc(res.key)}</code>
        <div class="secret-note">Shown only here — the appliance keeps it sealed.${
          res.expires_at ? ` Expires ${esc(res.expires_at)}.` : ''}${
          res.used_stored_key ? ' This is the key already issued for this credential.' : ''}</div>
      </div>`;
  }

  async function runKeygenTest(idx) {
    const k = state.keys[idx];
    const dev = deviceOf(k);
    if (!dev) { alert('This key references a device that no longer exists.'); return; }

    const held = secrets.for(k.oid);
    const isSase = dev.device_type === 'sase';
    // A stored credential is enough: collectord opens its own sealed copy, so a test runs from a
    // browser that never saw the password. Only a key with neither has nothing to try.
    if (!held.password && !held.has_credential) {
      alert(isSase ? 'Enter the Client Secret first — edit the key and save it.'
                   : 'Enter the password first — edit the key and save it.');
      return;
    }

    const modal = window.NMS.modal;
    const body = (inner) => `<div class="test-panel-wrap">${inner}</div>`;
    const step1 = isSase ? 'Connect to auth server' : 'TLS connection';
    const step2 = isSase ? 'Token issuance' : 'API key generation';
    const run = window.NMS.testPanel.start('API Key Generation Test', [step1, step2],
      isSase ? 'Exchanging the client credentials for a token.'
             : 'Contacting the device and requesting an API key.');

    let res;
    try {
      res = await runDeviceTest('/api/connector/keygen-test', {
        oid: k.oid,
        target: dev.target,
        device_type: dev.device_type,
        fingerprint: dev.fingerprint,
        endpoint: k.endpoint,
        // No password when the browser has none — collectord falls back to the sealed copy it holds,
        // which stored_credential tells mgmtd's pre-flight to expect.
        secrets: { username: k.username, password: held.password || '' },
        stored_credential: !!held.has_credential,
      });
    } catch (e) {
      // The test never reached the appliance (client-side/network error), so there is no persisted
      // outcome to show; surface it in the modal and leave the shared row state untouched.
      run.stop();
      render();
      modal.open('API Key Generation Test', body(`<div class="test-panel err"><div class="ts-note">${esc(e.message)}</div></div>`));
      return;
    }

    const secs = run.stop();
    const steps = res.steps || {};

    // A first contact stops at the certificate — HttpClient will not transmit credentials to an
    // unpinned peer. The pin belongs to the device, so confirming it updates the device. SASE uses a
    // public CA endpoint (no pinning), so there is never a fingerprint to trust.
    const trust = (!isSase && res.fingerprint && !res.fingerprint_trusted)
      ? `<div class="fp-prompt">
           <div class="fp-warn">Certificate is not trusted yet (self-signed)</div>
           <code class="fp-val">${esc(res.fingerprint)}</code>
           <div class="fp-sub">${esc(res.cert_subject || '')}</div>
           <button class="btn-sm btn-primary" id="akTrustFp">Trust this certificate</button>
         </div>`
      : '';

    // The outcome (and any newly issued/sealed key) was persisted by engined; re-pull the shared
    // state so this row — and every other session — reflects what was actually kept.
    await loadKeyState();

    modal.open('API Key Generation Test', body(`
      <div class="test-panel ${res.ok ? 'ok' : 'err'}">
        ${stepRow(step1, steps.tls)}
        ${stepRow(step2, steps.auth)}
        ${trust}
        <div class="ts-note">Completed in ${secs.toFixed(1)}s.</div>
        ${keyBlock(res, isSase)}
      </div>`));

    document.getElementById('akTrustFp')?.addEventListener('click', (e) => {
      window.NMS.devices.pinFingerprint(dev.oid, res.fingerprint);
      e.currentTarget.outerHTML = '<span class="fp-trusted">Pinned to the device — run the test again.</span>';
    });

    document.getElementById('akCopyKey')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      navigator.clipboard?.writeText(res.key)
        .then(() => { btn.textContent = 'Copied'; })
        .catch(() => { btn.textContent = 'Copy failed'; });
    });

    render();
  }

  // Re-run after every body paint: sorting or filtering replaces the rows these buttons live in.
  function wireRows(scope) {
    scope.querySelectorAll('[data-edit]').forEach(b =>
      b.addEventListener('click', () => openEditor(+b.dataset.edit)));
    scope.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (await removeKey(+b.dataset.del)) render();
    }));
    scope.querySelectorAll('[data-test]').forEach(b =>
      b.addEventListener('click', () => runKeygenTest(+b.dataset.test)));
  }

  function wire() {
    document.getElementById('akAdd')?.addEventListener('click', () => openEditor(null));
    table.mount(document.getElementById('akTable'), state.keys);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const keysRefresh = async () => { await load(); render(); };

  function activate() {
    render();
    window.NMS.onRefresh(keysRefresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    if (activeTab() === 'api-key') activate();
    document.dispatchEvent(new Event('nms:api-keys-ready'));
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === 'api-key') activate();
  });

  // Device names and the connector usage count load independently.
  document.addEventListener('nms:devices-ready', () => { if (activeTab() === 'api-key') render(); });
  document.addEventListener('nms:sites-ready', () => { if (activeTab() === 'api-key') render(); });
  document.addEventListener('nms:connectors-ready', () => { if (activeTab() === 'api-key') render(); });
})();

/* ai-assistant.js — Configuration ▸ AI Assistant.
 *
 * The deployment of the pretzel-ai inference service, declared here and committed like any other
 * configuration. Two independent axes, never one enum:
 *
 *   route.llm        who serves the completion    gateway | direct
 *   route.guardrail  who owns the inspection      gateway | airs | none
 *
 * Five of the six combinations are deployments somebody runs; the sixth (direct + gateway) has no
 * gateway on the path to defer to and is refused here as it is refused at startup. Keeping the two
 * axes orthogonal is what makes "route through the gateway but scan here" expressible — the row the
 * agent work needs, because a gateway's inline hook never sees a tool call.
 *
 * Committed under pretzel-ai.service.{route,gateway,airs,providers}. Nothing here is a secret: API
 * keys are not configuration (running_config is append-versioned and shown verbatim in the review
 * diff), they are sealed on the appliance and delivered to the service separately.
 *
 * The model catalog is NOT declared here. It is asked for — GET /api/chat/models → pretzel-ai's
 * ListModels — because which models exist is a fact about the gateway account, not a choice an
 * operator makes. Only which of them is the default belongs in the configuration.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  const TAB = 'ai-assistant';
  const DRAFT_KEY = 'ai-assistant';
  const DAEMON = 'pretzel-ai';

  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const { esc } = window.NMS.utils;

  // ── The matrix ───────────────────────────────────────────────────────────────
  // One row per combination: what it is for, and what an operator should know before choosing it.
  // `note` is the part that is not obvious from the two words above it.
  const LLM_LEGS = [
    ['gateway', 'AI Gateway', 'completions go through the gateway account'],
    ['direct',  'Direct',     'this appliance calls each provider itself'],
  ];
  const GUARDRAILS = [
    ['gateway', 'Gateway',    'the gateway’s own configuration decides'],
    ['airs',    'Prisma AIRS', 'this appliance calls the scan API'],
    ['none',    'None',       'nothing inspects'],
  ];

  const ROWS = {
    'gateway|gateway': {
      title: 'Gateway routing, gateway inspection',
      body: 'What this appliance shipped with, and how a gateway itself is tested: the verdict is '
          + 'whatever the gateway’s plugin reported, including “nothing was configured over there”.',
      note: 'The gateway hook only ever sees message text — tool calls and tool definitions do not '
          + 'reach the scanner on this route.',
    },
    'gateway|airs': {
      title: 'Gateway routing, inspection here',
      body: 'The gateway for routing and observability; the enforcement point stays on this '
          + 'appliance, so prompts, tool calls, tool results and responses are all scanned.',
      note: 'Turn the gateway console’s own AIRS plugin OFF on this route — with both on, every '
          + 'turn is scanned twice and billed twice.',
      warn: true,
    },
    'gateway|none': {
      title: 'Routing only',
      body: 'The gateway serves completions and nobody inspects them.',
      note: 'Turns on this appliance are not inspected.',
      warn: true,
    },
    'direct|airs': {
      title: 'Direct providers, inspection here',
      body: 'No gateway on the path: this appliance calls each provider and holds the enforcement '
          + 'point. Every scan carries the full session / transaction / turn identity.',
      note: '',
    },
    'direct|none': {
      title: 'No guardrail deployed',
      body: 'How most estates run today: the appliance calls the providers and nothing inspects the '
          + 'traffic. Written down rather than left as an absence.',
      note: 'Turns on this appliance are not inspected.',
      warn: true,
    },
    'direct|gateway': {
      title: 'Not a deployment',
      body: 'Inspection cannot be delegated to a gateway that is not on the path. pretzel-ai refuses '
          + 'this combination at startup rather than serving turns nobody checks.',
      note: 'Choose Prisma AIRS or None, or send the completions through the gateway.',
      invalid: true,
    },
  };

  const rowFor = (r) => ROWS[`${r.llm}|${r.guardrail}`] || ROWS['gateway|gateway'];
  const usesGateway = (r) => r.llm === 'gateway' || r.guardrail === 'gateway';

  // ── State ────────────────────────────────────────────────────────────────────
  const state = { cfg: null };
  let deployed = null;
  let models = null;          // [{id,label}] from /api/chat/models, null until it answers

  const num = (v, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
  };

  // Defaults mirror src/factory.py and src/config.py on the pretzel-ai side: an appliance that has
  // never been configured reads the same deployment here that it would assemble there.
  function normalize(c) {
    const src = (c && typeof c === 'object') ? c : {};
    const route = src.route || {}, gw = src.gateway || {}, airs = src.airs || {};
    // Stored as { list: [...] } (a commit addresses a domain object, so the array needs a key);
    // held here as the bare array the editor works on.
    const providers = Array.isArray(src.providers) ? src.providers
      : (src.providers && Array.isArray(src.providers.list) ? src.providers.list : []);
    return {
      route: {
        llm: LLM_LEGS.some(([k]) => k === route.llm) ? route.llm : 'gateway',
        guardrail: GUARDRAILS.some(([k]) => k === route.guardrail) ? route.guardrail : 'gateway',
        require_guardrail: !!route.require_guardrail,
      },
      gateway: {
        id: gw.id || 'portkey',
        host: gw.host || '',
        port: num(gw.port, 443),
        tls: gw.tls === undefined ? true : !!gw.tls,
        path: gw.path || '/v1/chat/completions',
        default_model: gw.default_model || '',
        system_prompt: gw.system_prompt || '',
        max_tokens: num(gw.max_tokens, 512),
        timeout_sec: num(gw.timeout_sec, 45),
      },
      airs: {
        endpoint: airs.endpoint || 'https://service.api.aisecurity.paloaltonetworks.com',
        profile_name: airs.profile_name || '',
        profile_id: airs.profile_id || '',
        timeout_sec: num(airs.timeout_sec, 30),
        fail_open: !!airs.fail_open,
      },
      // An array, not a map keyed by slug: a commit merges values into the running config, and a
      // map can only ever gain keys that way — removing a provider would be unexpressible.
      providers: providers.filter(p => p && typeof p === 'object').map(p => ({
        id: String(p.id || ''),
        url: String(p.url || ''),
      })),
    };
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ── Staging ──────────────────────────────────────────────────────────────────
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.cfg); window.NMS.staging.refresh(); };

  async function load() {
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      deployed = normalize((d.daemons || {})[DAEMON] || {});
    } catch (_) { deployed = normalize({}); }
    const staged = window.NMS.draft.get(DRAFT_KEY, null);
    state.cfg = staged ? normalize(staged) : clone(deployed);
    window.NMS.staging.refresh();
  }

  // The catalog is a fact reported by the service, so a failure to reach it is not an error on this
  // page: the default-model field falls back to a plain text input and says why.
  async function loadModels() {
    try {
      const r = await fetch('/api/chat/models', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      models = (d.models || []).filter(m => m && m.id).map(m => ({ id: m.id, label: m.label || m.id }));
    } catch (_) { models = []; }
  }

  // One change per domain, so the review diff reads as the operator thinks: the deployment row is
  // one edit, the gateway endpoint another.
  function commitPayload() {
    const c = state.cfg, d = deployed;
    const changes = [];
    const push = (domain, values) => {
      if (JSON.stringify(values) !== JSON.stringify(d[domain])) changes.push({ daemon: DAEMON, domain, values });
    };
    push('route', c.route);
    push('gateway', c.gateway);
    push('airs', c.airs);
    // `providers` is the whole list or nothing: merge_patch replaces an array wholesale, which is
    // exactly the semantic an editable list needs.
    if (JSON.stringify(c.providers) !== JSON.stringify(d.providers))
      changes.push({ daemon: DAEMON, domain: 'providers', values: { list: c.providers } });
    return changes;
  }

  window.NMS.staging.register({
    key: DRAFT_KEY,
    dirty: () => !!state.cfg && JSON.stringify(state.cfg) !== JSON.stringify(deployed),
    payload: commitPayload,
    before: () => ({ 'ai-assistant': deployed }),
    after: () => ({ 'ai-assistant': state.cfg }),
    onPublished() {
      deployed = clone(state.cfg);
      window.NMS.draft.clear(DRAFT_KEY);
    },
    problems() {
      const c = state.cfg;
      if (!c) return [];
      const out = [];
      if (rowFor(c.route).invalid)
        out.push('route: guardrail “Gateway” needs the completions to go through the gateway — '
               + 'pretzel-ai refuses this combination at startup');
      if (usesGateway(c.route) && !c.gateway.host)
        out.push('gateway: no host is configured, and this deployment routes through it');
      if (c.route.guardrail === 'airs' && !c.airs.profile_name && !c.airs.profile_id)
        out.push('airs: neither a profile name nor a profile id is set — the scan API needs one');
      if (c.route.llm === 'direct' && !c.providers.length)
        out.push('providers: the direct leg has no provider endpoints configured');
      return out;
    },
  });

  // ── Render ───────────────────────────────────────────────────────────────────
  const seg = (name, options, value) => `
    <div class="seg" data-seg-group="${esc(name)}">
      ${options.map(([k, label]) => `
        <button type="button" class="seg-btn${value === k ? ' active' : ''}"
                data-seg="${esc(name)}" data-val="${esc(k)}">${esc(label)}</button>`).join('')}
    </div>`;

  const legend = (options, value) => `
    <div class="ai-legend">${options.map(([k, label, why]) =>
      `<div class="ai-legend-row${value === k ? ' on' : ''}"><b>${esc(label)}</b>
        <span>${esc(why)}</span></div>`).join('')}</div>`;

  function field(label, key, value, opts) {
    const o = opts || {};
    return `<div class="field-row"><label>${esc(label)}</label>
      <input data-f="${esc(key)}" value="${esc(value)}" placeholder="${esc(o.ph || '')}"
             ${o.mono ? 'class="mono-val"' : ''}/>
      </div>${o.hint ? `<p class="field-hint">${o.hint}</p>` : ''}`;
  }

  const check = (label, key, on, hint) => `
    <label class="ak-radio"><input type="checkbox" data-c="${esc(key)}" ${on ? 'checked' : ''}/>
      <span>${esc(label)}</span></label>
    ${hint ? `<p class="field-hint">${hint}</p>` : ''}`;

  function deploymentCard(c) {
    const row = rowFor(c.route);
    return `
      <div class="info-card">
        <div class="info-card-title">Deployment
          <span class="info-hint">who answers, and who inspects</span></div>

        <div class="ai-axes">
          <div class="ai-axis">
            <div class="ai-axis-h">Completions</div>
            ${seg('llm', LLM_LEGS, c.route.llm)}
            ${legend(LLM_LEGS, c.route.llm)}
          </div>
          <div class="ai-axis">
            <div class="ai-axis-h">Guardrail</div>
            ${seg('guardrail', GUARDRAILS, c.route.guardrail)}
            ${legend(GUARDRAILS, c.route.guardrail)}
          </div>
        </div>

        <div class="ai-row ${row.invalid ? 'bad' : row.warn ? 'warn' : 'ok'}">
          <div class="ai-row-h">${esc(row.title)}</div>
          <div class="ai-row-b">${esc(row.body)}</div>
          ${row.note ? `<div class="ai-row-n">${esc(row.note)}</div>` : ''}
        </div>

        ${c.route.guardrail === 'gateway' ? check(
            'Fail turns the gateway did not inspect', 'route.require_guardrail',
            c.route.require_guardrail,
            'Off: a turn the gateway reported no verdict for is delivered and recorded as '
          + '<b>uninspected</b> — which is the honest answer while the gateway is the thing under '
          + 'test. On: that turn is stopped instead.') : ''}
      </div>`;
  }

  function gatewayCard(c) {
    const modelField = models && models.length
      ? `<div class="field-row"><label>Default model</label>
           <select data-f="gateway.default_model">
             ${models.map(m => `<option value="${esc(m.id)}"${m.id === c.gateway.default_model ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
             ${models.some(m => m.id === c.gateway.default_model) ? '' :
               `<option value="${esc(c.gateway.default_model)}" selected>${esc(c.gateway.default_model || '— none —')}</option>`}
           </select></div>`
      : field('Default model', 'gateway.default_model', c.gateway.default_model,
              { mono: true, ph: '@openai/gpt-4o-2024-11-20',
                hint: 'The service did not answer with its catalog, so this is typed rather than picked.' });

    return `
      <div class="info-card">
        <div class="info-card-title">AI Gateway
          <span class="info-hint">${esc(c.gateway.id)}</span></div>
        <p class="field-hint">The subscription key is not configuration and is not here — it is held
          sealed on the appliance and handed to the service on its own path.</p>
        ${field('Host', 'gateway.host', c.gateway.host, { mono: true, ph: 'aigw.portkey.ai' })}
        ${field('Port', 'gateway.port', c.gateway.port, { ph: '443' })}
        ${field('Path', 'gateway.path', c.gateway.path, { mono: true, ph: '/v1/chat/completions' })}
        ${check('TLS', 'gateway.tls', c.gateway.tls)}
        ${modelField}
        <div class="field-row"><label>System prompt</label>
          <textarea data-f="gateway.system_prompt" rows="3">${esc(c.gateway.system_prompt)}</textarea></div>
        ${field('Max tokens', 'gateway.max_tokens', c.gateway.max_tokens, { ph: '512' })}
        ${field('Timeout (sec)', 'gateway.timeout_sec', c.gateway.timeout_sec, { ph: '45' })}
      </div>`;
  }

  function airsCard(c) {
    return `
      <div class="info-card">
        <div class="info-card-title">Prisma AIRS
          <span class="info-hint">this appliance owns the verdict</span></div>
        ${field('Scan endpoint', 'airs.endpoint', c.airs.endpoint, { mono: true })}
        ${field('Security profile name', 'airs.profile_name', c.airs.profile_name, { ph: 'AIRS_Security_Profile' })}
        ${field('Security profile id', 'airs.profile_id', c.airs.profile_id,
                { mono: true, hint: 'Either the name or the id — the scan API takes one of them.' })}
        ${field('Timeout (sec)', 'airs.timeout_sec', c.airs.timeout_sec, { ph: '30' })}
        ${check('Fail open', 'airs.fail_open', c.airs.fail_open,
                'Off (recommended): a scan that cannot be reached stops the turn. On: the turn '
              + 'proceeds uninspected, and says so.')}
      </div>`;
  }

  function providersCard(c) {
    return `
      <div class="info-card">
        <div class="info-card-title">Direct providers
          <span class="info-hint">${c.providers.length} endpoint${c.providers.length === 1 ? '' : 's'}</span></div>
        <p class="field-hint">One row per provider slug — the part of a model id before the slash.
          Keys are not configuration and live sealed on the appliance.</p>
        <div class="ai-prov">
          ${c.providers.map((p, i) => `
            <div class="ai-prov-row">
              <input data-p="id" data-i="${i}" value="${esc(p.id)}" placeholder="openai" class="ai-prov-id"/>
              <input data-p="url" data-i="${i}" value="${esc(p.url)}" placeholder="https://api.openai.com/v1/chat/completions" class="mono-val"/>
              <button class="icon-btn danger" data-prov-del="${i}" title="Remove">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
              </button>
            </div>`).join('')}
        </div>
        <button class="btn-sm" id="aiProvAdd">+ Add provider</button>
      </div>`;
  }

  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== TAB || !state.cfg) return;
    const c = state.cfg;

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">AI Assistant</span>
            <span class="cfg-h-sub">where turns go, and who inspects them</span>
          </div>
        </div>

        ${deploymentCard(c)}
        ${usesGateway(c.route) ? gatewayCard(c) : ''}
        ${c.route.guardrail === 'airs' ? airsCard(c) : ''}
        ${c.route.llm === 'direct' ? providersCard(c) : ''}
      </div>`;

    wire();
    window.NMS.utils.enhanceSelects(el);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────
  // Text fields write through on input and do NOT repaint — a repaint per keystroke would take the
  // caret with it. The choices that change which cards exist (the two axes, the checkboxes) repaint.
  const setPath = (path, value) => {
    const [group, key] = path.split('.');
    state.cfg[group][key] = value;
  };

  function wire() {
    const el = document.getElementById('contentBody');

    el.querySelectorAll('[data-seg]').forEach(b => b.addEventListener('click', () => {
      state.cfg.route[b.dataset.seg] = b.dataset.val;
      stage(); render();
    }));

    el.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('input', () => {
      const path = inp.dataset.f;
      const raw = inp.value;
      const intField = /\.(port|max_tokens|timeout_sec)$/.test(path);
      setPath(path, intField ? num(raw, 0) : (inp.tagName === 'TEXTAREA' ? raw : raw.trim()));
      stage();
    }));
    // A <select> fires change, not input.
    el.querySelectorAll('select[data-f]').forEach(sel => sel.addEventListener('change', () => {
      setPath(sel.dataset.f, sel.value);
      stage();
    }));

    el.querySelectorAll('[data-c]').forEach(box => box.addEventListener('change', () => {
      setPath(box.dataset.c, box.checked);
      stage(); render();
    }));

    el.querySelectorAll('[data-p]').forEach(inp => inp.addEventListener('input', () => {
      const p = state.cfg.providers[+inp.dataset.i];
      if (!p) return;
      p[inp.dataset.p] = inp.value.trim();
      stage();
    }));
    el.querySelectorAll('[data-prov-del]').forEach(b => b.addEventListener('click', () => {
      state.cfg.providers.splice(+b.dataset.provDel, 1);
      stage(); render();
    }));
    document.getElementById('aiProvAdd')?.addEventListener('click', () => {
      state.cfg.providers.push({ id: '', url: '' });
      stage(); render();
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const refresh = async () => { await load(); render(); };

  function activate() {
    render();
    // The catalog is only worth fetching once the tab is actually open — it costs a round trip to
    // pretzel-ai, and every Configuration tab loads this module.
    if (models === null) loadModels().then(render);
    window.NMS.onRefresh(refresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    if (activeTab() === TAB) activate();
    document.dispatchEvent(new Event('nms:ai-assistant-ready'));
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === TAB) activate();
  });
})();

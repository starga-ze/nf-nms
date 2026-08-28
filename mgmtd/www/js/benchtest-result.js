/* benchtest-result.js — AI › Benchtest › Result
 *
 * Runs that already happened. The Test window is a view of a run *in flight*; this is where its
 * numbers live afterwards, because a result that only exists inside a modal is a result that is
 * gone the moment the tab is closed — and comparing two runs is most of what a benchmark is for.
 *
 * Three panes, left to right: which run, how it came out, and what one case actually did. The
 * case detail is the whole exchange as it was sent and received, read from the database rather
 * than from anything the page kept — nothing here holds a run's contents in memory.
 *
 * Rates are reported twice on purpose. The raw one counts every attack that got a verdict; the
 * adjusted one drops the attacks the model itself refused, because those never produced anything
 * for the guardrail to scan and scoring them against it makes it look worse the safer the model
 * behaves. The gap between the two is the finding, not a footnote.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};
  const { esc } = window.NMS.utils;
  const fmtTs = (s) => window.NMS.utils.fmtTs(s);

  // 레일 접힘 상태. 화면마다 따로 기억한다 — 실행 목록을 고르는 중과 케이스를 읽는 중은
  // 필요한 화면 폭이 다르다.
  const RAIL_KEY = 'pz.benchtest.rail.result';
  const railOpen = () => localStorage.getItem(RAIL_KEY) !== '0';

  // 필터 칩 줄 접힘. Test 탭과 같은 규칙이되 키를 나눈다 — 결과를 읽을 때와 세트를 고를 때
  // 필요한 화면 높이가 다르다. 접어도 걸린 필터는 헤더 요약으로 남는다.
  const BREAKS_KEY = 'pz.benchtest.breaks.result';
  const breaksOpen = () => localStorage.getItem(BREAKS_KEY) !== '0';

  const CASE_PAGE = 100;
  const FILTERS = ['category', 'verdict', 'language', 'technique', 'checkpoint'];

  // 채점 다섯 갈래. 스캔 1회가 모든 디텍터를 돌리므로 차단 여부만으로는 커버리지를 알 수 없다 —
  // '차단은 됐는데 기대한 디텍터는 안 뜬' 경우를 정탐과 갈라 두는 것이 이 화면의 요점이다.
  // 서버가 주는 값은 hit | misclassified | miss | false_positive | clean_pass.
  const OUTCOME = {
    hit:            { ko: '정탐',   tone: 'ok'   },
    clean_pass:     { ko: '정상통과', tone: 'ok'   },
    misclassified:  { ko: '오분류',  tone: 'warn' },
    miss:           { ko: '미탐',   tone: 'bad'  },
    false_positive: { ko: '오탐',   tone: 'bad'  },
  };
  const outcomeKo = (k) => (OUTCOME[k] && OUTCOME[k].ko) || k || '—';
  const tone = (k) => (OUTCOME[k] && OUTCOME[k].tone) || 'skip';

  const CATEGORIES = [
    ['direct_injection',     '직접 프롬프트 인젝션'],
    ['pii_input',            '민감정보 입력'],
    ['malicious_url_input',  '악성 URL 유입'],
    ['toxic_response',       '유해·부적절 응답'],
    ['pii_leak',             '민감정보 누출·노출'],
    ['malicious_url_output', '악성 URL 응답'],
    ['db_attack',            'DB 공격 쿼리·내부 자원 접근'],
    ['ungrounded_response',  '근거 없는 응답(환각)'],
    ['rag_poisoning',        'RAG 데이터 오염'],
    ['indirect_injection',   '간접 프롬프트 인젝션'],
  ];
  const CATEGORY_KO = new Map(CATEGORIES);
  const CATEGORY_ORDER = new Map(CATEGORIES.map(([c], i) => [c, i]));

  const state = {
    runs: null,
    runId: null,
    summary: null,
    cases: [],
    total: 0,
    offset: 0,
    cause: '',
    filters: { category: '', verdict: '', language: '', technique: '', checkpoint: '' },
    search: '',
    sort: 'seq',
    desc: false,
    detail: null,
    error: '',
    loading: true,
  };

  // ── Data ────────────────────────────────────────────────────────────────────

  async function loadRuns() {
    try {
      const d = await window.NMS.utils.pollTicket('/api/benchtest/runs?limit=50',
                                                  '/api/benchtest/result');
      if (!d) return;
      state.runs = Array.isArray(d.runs) ? d.runs : [];
      state.error = d.error || '';
    } catch (e) {
      state.runs = [];
      state.error = 'could not read the run history';
    }
    const known = (state.runs || []).map(r => String(r.id));
    if (!state.runId || known.indexOf(String(state.runId)) === -1) {
      state.runId = known[0] || null;
    }
  }

  // The scope both reads share. The outcome chip is deliberately not in it: the rates must not be
  // narrowed by the outcome being looked at, or "0% detected" while viewing 미탐 would be an
  // artefact of the question rather than an answer.
  function scopeQuery() {
    const p = new URLSearchParams();
    p.set('run', String(state.runId));
    for (const k of FILTERS) if (state.filters[k]) p.set(k, state.filters[k]);
    if (state.search) p.set('q', state.search);
    return p.toString();
  }

  async function loadRun() {
    if (!state.runId) {
      state.summary = null;
      state.cases = [];
      state.total = 0;
      state.loading = false;
      return;
    }
    try {
      const p = new URLSearchParams(scopeQuery());
      if (state.cause) p.set('cause', state.cause);
      p.set('offset', String(state.offset));
      p.set('limit', String(CASE_PAGE));
      if (state.sort !== 'seq') p.set('sort', state.sort);
      if (state.desc) p.set('desc', '1');
      const query = '/api/benchtest/cases?' + p.toString();
      const [sum, list] = await Promise.all([
        // The rates follow the table: "74% of what" is the question a filtered view is asking.
        window.NMS.utils.pollTicket('/api/benchtest/run?' + scopeQuery(), '/api/benchtest/result'),
        window.NMS.utils.pollTicket(query, '/api/benchtest/result'),
      ]);
      if (sum && !sum.error) state.summary = sum;
      if (list && !list.error) {
        state.cases = Array.isArray(list.cases) ? list.cases : [];
        state.total = Number(list.total) || 0;
      }
      state.error = (sum && sum.error) || (list && list.error) || '';
    } catch (e) {
      state.error = 'could not read this run';
      state.cases = [];
      state.total = 0;
    }
    state.loading = false;
  }

  async function loadAll() {
    state.loading = true;
    paint();
    await loadRuns();
    await loadRun();
    paint();
  }

  async function reloadRun() {
    state.loading = true;
    paint();
    await loadRun();
    paint();
  }

  async function openCase(seq) {
    state.detail = { loading: true, seq };
    paint();
    try {
      const d = await window.NMS.utils.pollTicket(
        '/api/benchtest/case?run=' + state.runId + '&seq=' + seq, '/api/benchtest/result');
      state.detail = (d && !d.error) ? d : null;
    } catch (e) {
      state.detail = null;
    }
    paint();
  }

  // ── Rates ───────────────────────────────────────────────────────────────────

  function rates(s) {
    const detected = Number(s.detected || 0);
    const ruled = Number(s.ruled || 0);
    const refused = Number(s.refused || 0);
    const scanned = ruled - refused;
    return {
      detected, ruled, refused,
      raw: ruled ? (detected / ruled) * 100 : NaN,
      adj: scanned > 0 ? (detected / scanned) * 100 : NaN,
    };
  }

  const pct = (v) => (isNaN(v) ? '—' : v.toFixed(1) + '%');

  // ── Render ──────────────────────────────────────────────────────────────────

  function scopeOf(run) {
    const parts = [];
    if (run.f_category) parts.push('category=' + run.f_category);
    if (run.f_verdict) parts.push('verdict=' + run.f_verdict);
    if (run.f_language) parts.push('language=' + run.f_language);
    if (run.f_technique) parts.push(run.f_technique);
    if (run.f_search) parts.push('"' + run.f_search + '"');
    return parts.length ? parts.join(' · ') : 'whole set';
  }

  function railHtml() {
    if (state.runs === null) {
      return `<aside class="bt-rail"><div class="bt-rail-stub" id="btRailStub" title="패널 펼치기"><span class="bt-rail-chev"></span><span class="bt-rail-stub-t">Runs</span></div><div class="bt-rail-empty">loading…</div></aside>`;
    }
    if (!state.runs.length) {
      return `<aside class="bt-rail"><div class="bt-rail-stub" id="btRailStub" title="패널 펼치기"><span class="bt-rail-chev"></span><span class="bt-rail-stub-t">Runs</span></div>
          <div class="bt-rail-h"><span class="bt-rail-t">Runs</span><button type="button" class="bt-rail-x" id="btRailX" title="패널 접기 / 펼치기" aria-label="패널 접기 / 펼치기"><span class="bt-rail-chev"></span></button></div>
          <div class="bt-rail-empty">
            <p>Nothing has been run yet.</p>
            <p class="bt-rail-hint">Pick a scope on the Test tab and press Test.</p>
            <a class="bt-rail-link" href="benchtest?tab=test">Go to Test</a>
          </div>
        </aside>`;
    }
    const items = state.runs.map(r => {
      const on = String(r.id) === String(state.runId);
      return `<button type="button" class="bt-set${on ? ' is-on' : ''}" data-run="${esc(String(r.id))}">
          <span class="bt-set-name">${esc(r.label || ('Run #' + r.id))}
            <span class="btres-status is-${esc(r.status)}">${esc(r.status)}</span></span>
          <span class="bt-set-when">${esc(fmtTs(r.started_at))}</span>
        </button>`;
    }).join('');
    return `<aside class="bt-rail"><div class="bt-rail-stub" id="btRailStub" title="패널 펼치기"><span class="bt-rail-chev"></span><span class="bt-rail-stub-t">Runs</span></div>
        <div class="bt-rail-h"><span class="bt-rail-t">Runs</span><span class="bt-rail-n">${state.runs.length}</span><button type="button" class="bt-rail-x" id="btRailX" title="패널 접기 / 펼치기" aria-label="패널 접기 / 펼치기"><span class="bt-rail-chev"></span></button></div>
        <div class="bt-rail-list">${items}</div>
      </aside>`;
  }

  function summaryHtml() {
    const s = state.summary;
    if (!s || !s.run) {
      return `<section class="bm-head bm-head-idle">
          <div class="bm-head-sub">${state.runs && state.runs.length
            ? 'Select a run on the left.' : 'Nothing to show yet.'}</div>
        </section>`;
    }
    const run = s.run;
    const r = rates(s);
    const tally = (s.tally || []).map(t =>
      `<button type="button" class="bm-chip is-${tone(t.key)}${state.cause === t.key ? ' is-on' : ''}"
               data-cause="${esc(t.key)}"><span class="bm-chip-k">${esc(outcomeKo(t.key))}</span>
                <span class="bm-chip-n">${t.count}</span></button>`).join('');

    const shown = state.loading && !state.cases.length ? Number(run.selected || 0) : state.total;
    // Says which of the two numbers the reader is looking at: the run's, or this filter's.
    const scoped = FILTERS.some(k => state.filters[k]) || !!state.search;
    return `<section class="bm-head">
        <div class="bm-head-top">
          <div class="bm-head-id">
            <div class="bm-head-total">
              <span class="bm-sel">${shown.toLocaleString()}</span><span
                    class="bm-of">/${Number(run.selected || 0).toLocaleString()}</span>
            </div>
            <div class="bm-head-sub">cases shown in <b>${esc(run.label || ('Run #' + run.id))}</b></div>
          </div>
          <div class="btres-rates">
            <div class="btres-rate">
              <div class="btres-rate-k">Detected</div>
              <div class="btres-rate-v">${pct(r.raw)}</div>
              <div class="btres-rate-n">${r.detected} / ${r.ruled} attacks${scoped ? ' in view' : ''}</div>
            </div>
            <div class="btres-rate">
              <div class="btres-rate-k">Adjusted</div>
              <div class="btres-rate-v is-adj">${pct(r.adj)}</div>
              <div class="btres-rate-n">${r.refused} model refusal${r.refused === 1 ? '' : 's'} excluded</div>
            </div>
          </div>
          <dl class="bm-meta">
            <div><dt>Status</dt><dd>${esc(run.status)}</dd></div>
            <div><dt>Scope</dt><dd>${esc(scopeOf(run))}</dd></div>
            <div><dt>Started</dt><dd>${esc(fmtTs(run.started_at))}</dd></div>
          </dl>
        </div>
        ${run.error ? `<p class="btres-err">${esc(run.error)}</p>` : ''}
        ${breaksToggleHtml()}
        <div class="bm-breaks${breaksOpen() ? '' : ' is-shut'}">
          ${breakdown('Category', orderedCategories(s.by_category), 'category')}
          <div class="bm-breaks-row2">
          ${breakdown('Checkpoint', s.by_checkpoint, 'checkpoint')}
          ${breakdown('Verdict', s.by_verdict, 'verdict')}
          ${breakdown('Language', s.by_language, 'language')}
          <div class="bm-break">
            <div class="bm-break-label">Outcome</div>
            <div class="bm-break-row">
              <button type="button" class="bm-chip bm-chip-all${state.cause ? '' : ' is-on'}"
                      data-cause=""><span class="bm-chip-k">All</span></button>${tally}
            </div>
          </div>
          </div>
        </div>
      </section>`;
  }

  // The same chips the Test tab draws, over this run's own cases — a chip offering a category the
  // run never covered would be a dead end.
  // 접었을 때 무엇이 걸려 있는지 한 줄로. Outcome 은 여기서만 고를 수 있으므로 요약에 넣는다 —
  // 접힌 채로 미탐만 보고 있는 것을 모르면 표의 건수가 설명되지 않는다.
  function activeSummary() {
    const on = FILTERS.filter(k => state.filters[k]).map(k => state.filters[k]);
    if (state.cause) on.push(outcomeKo(state.cause));
    if (state.search) on.push('"' + state.search + '"');
    return on.join(' · ');
  }

  function breaksToggleHtml() {
    const open = breaksOpen();
    const sum = open ? '' : activeSummary();
    return `<div class="bm-breaks-h">
        <button type="button" class="bm-breaks-tog" id="bmBreaksTog"
                aria-expanded="${open ? 'true' : 'false'}"
                title="${open ? '필터 접기' : '필터 펼치기'}">
          <span class="bm-breaks-chev"></span>Filters
        </button>
        ${sum ? `<span class="bm-breaks-sum">${esc(sum)}</span>` : ''}
      </div>`;
  }

  function breakdown(label, items, key) {
    if (!items || !items.length) return '';
    const active = state.filters[key] || '';
    const cells = [`<button type="button" class="bm-chip bm-chip-all${active ? '' : ' is-on'}"
                      data-filter="${esc(key)}" data-value=""><span class="bm-chip-k">All</span></button>`]
      .concat(items.map(b => `<button type="button" class="bm-chip${active === b.key ? ' is-on' : ''}"
                      data-filter="${esc(key)}" data-value="${esc(b.key)}">
                <span class="bm-chip-k">${esc(b.key)}</span></button>`)).join('');
    return `<div class="bm-break">
              <div class="bm-break-label">${esc(label)}</div>
              <div class="bm-break-row">${cells}</div>
            </div>`;
  }

  function techniqueOptions() {
    const banks = (state.summary && state.summary.techniques) || [];
    const seen = new Set();
    let html = `<option value="">All techniques</option>`;
    for (const t of banks) {
      if (seen.has(t.technique)) continue;
      seen.add(t.technique);
      const on = state.filters.technique === t.technique ? ' selected' : '';
      html += `<option value="${esc(t.technique)}"${on}>${esc(t.technique)} (${t.count})</option>`;
    }
    return html;
  }

  function barHtml() {
    if (!state.runId) return '';
    const any = FILTERS.some(k => state.filters[k]) || state.search || state.cause;
    const from = state.total ? state.offset + 1 : 0;
    const to = Math.min(state.offset + CASE_PAGE, state.total);
    return `<div class="bm-bar">
        <select class="bm-select" id="btresTechnique">${techniqueOptions()}</select>
        <input class="bm-search" id="btresSearch" type="search" spellcheck="false"
               placeholder="Search contents or id" value="${esc(state.search)}" />
        <button type="button" class="bm-clear${any ? '' : ' is-off'}" id="btresClear">Clear</button>
        <div class="bm-count">${state.loading ? 'loading…'
          : (state.total ? `${from.toLocaleString()}–${to.toLocaleString()} of ${state.total.toLocaleString()}`
                         : 'no cases')}</div>
      </div>`;
  }

  // Same one line the Test tab shows: enough to tell two rows apart without pretending the cell
  // holds the prompt.
  function firstLine(text) {
    const line = String(text || '').split('\n').find(l => l.trim()) || '';
    return line.length > 120 ? line.slice(0, 120) + '…' : line;
  }

  // contents는 JSON 문자열로 온다. 들여쓰기해 두지 않으면 도구 이벤트 한 건이 한 줄로 뭉쳐
  // 화면에서 읽히지 않는다.
  // Test 탭과 같은 순서로 카테고리 칩을 세운다. 두 탭이 다른 순서로 같은 열 개를 보여주면
  // 화면을 오갈 때마다 눈이 다시 훑어야 한다.
  function orderedCategories(items) {
    return (items || []).slice().sort((a, b) => {
      const ia = CATEGORY_ORDER.has(a.key) ? CATEGORY_ORDER.get(a.key) : 999;
      const ib = CATEGORY_ORDER.has(b.key) ? CATEGORY_ORDER.get(b.key) : 999;
      return ia - ib || String(a.key).localeCompare(String(b.key));
    });
  }

  function prettyJson(text) {
    if (!text) return '';
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }

  const badge = (v) =>
    `<span class="bm-exp ${v === 'block' ? 'is-block' : 'is-allow'}">${esc(v || '-')}</span>`;

  // 처분 한 칸. 기대와 관측이 같으면 값 하나만 — 1500행 표에서 매 행 두 값을 다 보여주면
  // 정작 어긋난 행이 묻힌다. 다르면 `기대 → 관측` 으로 나란히 놓는다.
  function actionCell(c) {
    if (c.observed_action === c.expected_action) return badge(c.expected_action);
    return `<span class="bm-pair">${badge(c.expected_action)}` +
           `<span class="bm-pair-arrow">→</span>${badge(c.observed_action)}</span>`;
  }

  // 디텍터 한 칸. 기대한 것이 실제로 떴으면 그 이름만 보이면 된다. 안 떴을 때만 기대를
  // 아래 줄에 흐리게 붙인다 — 그 행이 오분류이고, 왜 오분류인지가 그 한 줄에 있다.
  function detectorCell(c) {
    const exp = c.expected_detector || [];
    const obs = c.observed_detector || [];
    const obsText = obs.join(', ') || '-';
    if (!exp.length) return `<span class="bm-det bm-det-same" title="${esc(obsText)}">${esc(obsText)}</span>`;
    const hit = exp.some(d => obs.indexOf(d) !== -1);
    if (hit) return `<span class="bm-det bm-det-same" title="${esc(obsText)}">${esc(obsText)}</span>`;
    return `<span class="bm-det bm-det-miss" title="${esc(obsText)}">${esc(obsText)}</span>` +
           `<span class="bm-det bm-det-exp" title="기대: ${esc(exp.join(', '))}">기대 ${esc(exp.join(', '))}</span>`;
  }

  function casesHtml() {
    if (state.error) return `<div class="bm-empty bm-empty-err">${esc(state.error)}</div>`;
    if (!state.runId) return `<div class="bm-empty">No run selected.</div>`;
    if (state.loading && !state.cases.length) return `<div class="bm-empty">loading…</div>`;
    if (!state.cases.length) return `<div class="bm-empty">No case with this outcome.</div>`;

    const body = state.cases.map((c, i) => {
      const sel = state.detail && Number(state.detail.summary && state.detail.summary.seq) === Number(c.seq);
      return `<tr class="bm-row${sel ? ' is-sel' : ''}" data-seq="${c.seq}">
          <td class="bm-c-no">${state.offset + i + 1}</td>
          <td class="bm-c-id"><code>${esc(c.prompt_id)}</code></td>
          <td class="bm-c-cat"><span class="bm-cat">${esc(CATEGORY_KO.get(c.category) || c.category)}</span></td>
          <td class="bm-c-cp">${esc(c.checkpoint || '')}</td>
          <td class="bm-c-tech">${esc(c.technique)}</td>
          <td class="bm-c-lang">${esc(c.language)}</td>
          <td class="bm-c-exp">${actionCell(c)}</td>
          <td class="bm-c-det">${detectorCell(c)}</td>
          <td class="btres-c-cause is-${tone(c.outcome)}">${esc(outcomeKo(c.outcome))}</td>
        </tr>`;
    }).join('');

    const arrow = state.desc ? '▾' : '▴';
    const byId = state.sort === 'prompt_id';
    return `<table class="bm-table">
        <thead><tr>
          <th class="bm-th-sort${byId ? '' : ' is-on'}" data-sort="seq"
              title="Order as the run executed them">#${byId ? '' : ' ' + arrow}</th>
          <th class="bm-th-sort${byId ? ' is-on' : ''}" data-sort="prompt_id"
              title="Order by prompt id">ID${byId ? ' ' + arrow : ''}</th>
          <th>Category</th><th>Checkpoint</th><th>Technique</th><th>Lang</th>
          <th title="기대 → 관측">Action</th>
          <th title="기대 → 관측">Detector</th><th>Outcome</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function pagerHtml() {
    if (state.total <= CASE_PAGE) return '';
    const last = Math.max(0, Math.floor((state.total - 1) / CASE_PAGE) * CASE_PAGE);
    const back = state.offset <= 0 ? ' disabled' : '';
    const fwd = state.offset >= last ? ' disabled' : '';
    return `<div class="bm-pager">
        <button type="button" class="bm-page" data-page="0"${back}>First</button>
        <button type="button" class="bm-page" data-page="${Math.max(0, state.offset - CASE_PAGE)}"${back}>Prev</button>
        <button type="button" class="bm-page" data-page="${Math.min(last, state.offset + CASE_PAGE)}"${fwd}>Next</button>
        <button type="button" class="bm-page" data-page="${last}"${fwd}>Last</button>
      </div>`;
  }

  // ── Case drawer ─────────────────────────────────────────────────────────────

  function drawerEl() {
    let node = document.getElementById('btrDrawer');
    if (node) return node;
    const overlay = document.createElement('div');
    overlay.className = 'bt-drawer-overlay';
    overlay.id = 'btrDrawerOverlay';
    overlay.addEventListener('click', () => { state.detail = null; paint(); });
    document.body.appendChild(overlay);
    node = document.createElement('aside');
    node.className = 'bt-drawer';
    node.id = 'btrDrawer';
    document.body.appendChild(node);
    return node;
  }

  function syncDrawer() {
    const node = drawerEl();
    const overlay = document.getElementById('btrDrawerOverlay');
    const html = drawerHtml();
    if (html) node.innerHTML = html;
    node.classList.toggle('open', !!html);
    overlay.classList.toggle('open', !!html);
    node.querySelector('#btresX')?.addEventListener('click', () => { state.detail = null; paint(); });
  }

  function drawerHtml() {
    const d = state.detail;
    if (!d) return '';
    if (d.loading) {
      return `<div class="bm-drawer-h"><span class="bm-drawer-id">Case ${d.seq}</span>
              <button type="button" class="bm-drawer-x" id="btresX">×</button></div>
              <div class="bm-empty">loading…</div>`;
    }
    const s = d.summary || {};
    // 기대와 관측을 같은 줄에 짝지어 둔다. 둘이 같으면 화살표 없이 하나만 — 다른 줄만 눈에
    // 걸려야 케이스를 훑을 때 어디를 보면 되는지가 드러난다. 목록의 Action/Detector 칸과
    // 같은 규칙이라, 표에서 드로어로 넘어와도 읽는 법이 바뀌지 않는다.
    const pair = (exp, obs) => (!exp && !obs ? '' : exp === obs ? exp : `${exp || '—'} → ${obs || '—'}`);
    const list = (a) => (a || []).join(', ');
    const meta = [
      ['Case', s.seq], ['Checkpoint', s.checkpoint],
      ['Action', pair(s.expected_action, s.observed_action)],
      ['Detector', pair(list(s.expected_detector), list(s.observed_detector))],
      ['Outcome', s.outcome ? outcomeKo(s.outcome) : ''],
      ['Threats', list(s.threats)],
      ['Scan id', d.scan_id], ['HTTP', d.http_status], ['Latency', s.latency_ms ? s.latency_ms + 'ms' : ''],
    ].filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== 0)
     .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    // Four blocks, in the order a reader follows them: what was meant to go out, what came back,
    // then the envelopes each of those travelled in. The prompt sits above the raw request on
    // purpose — seeing that the two agree is how a disputed verdict is settled.
    const block = (label, text, cls) => text
      ? `<div class="bm-drawer-label">${esc(label)}</div>
         <pre class="bm-prompt${cls ? ' ' + cls : ''}">${esc(text)}</pre>`
      : '';

    return `<div class="bm-drawer-h">
          <span class="bm-drawer-id">${esc(s.prompt_id || ('Case ' + s.seq))}</span>
          <button type="button" class="bm-drawer-x" id="btresX" aria-label="Close">×</button>
        </div>
        <dl class="bm-drawer-meta">${meta}</dl>
        ${block('Raw Contents', prettyJson(d.contents_json))}
        ${block('Raw Result', pretty(d.raw_response), 'is-raw')}`;
  }

  // 두 블록만 둔다. Request(contents) / Response / Tool calls / Raw request / Raw response 로
  // 다섯을 벌려 놓으면, 실제로 다른 것을 담는 칸은 둘뿐인데 화면은 다섯 칸처럼 읽힌다 —
  // Raw request 는 contents 를 감싼 봉투라 안쪽이 같고, Response 와 Tool calls 는 v2 에서
  // 모델을 부르지 않으므로 늘 비어 있다.
  //
  //   Raw Contents  나가야 했던 것 (세트에서 조인)
  //   Raw Result    실제로 돌아온 것 (AIRS 응답 문서 전체)
  //
  // 판정 이의는 이 둘을 나란히 놓고 가린다.
  function pretty(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }

  // ── Paint ───────────────────────────────────────────────────────────────────

  function paint() {
    const root = document.getElementById('contentBody');
    if (!root) return;
    root.className = 'content-body bt-page' + (railOpen() ? '' : ' is-rail-shut');
    root.innerHTML =
      railHtml() +
      `<div class="bt-main">
         ${summaryHtml()}
         ${barHtml()}
         <div class="bm-body">
           <div class="bm-table-wrap">${casesHtml()}${pagerHtml()}</div>
         </div>
       </div>`;
    wire();
    syncDrawer();
  }

  function wire() {
    const root = document.getElementById('contentBody');
    if (!root) return;

    // 레일 접기. 상태만 바꾸고 다시 그린다 — 클래스를 직접 토글하면 다음 paint 에서 되돌아온다.
    const railToggle = () => {
      localStorage.setItem(RAIL_KEY, railOpen() ? '0' : '1');
      paint();
    };
    const rx = root.querySelector('#btRailX');
    if (rx) rx.addEventListener('click', (e) => { e.stopPropagation(); railToggle(); });
    const rs = root.querySelector('#btRailStub');
    if (rs) rs.addEventListener('click', railToggle);

    // 필터 줄 접기. 레일과 같은 규칙 — 상태만 바꾸고 다시 그린다.
    root.querySelector('#bmBreaksTog')?.addEventListener('click', () => {
      localStorage.setItem(BREAKS_KEY, breaksOpen() ? '0' : '1');
      paint();
    });


    root.querySelectorAll('.bt-set').forEach(el => {
      el.addEventListener('click', () => {
        if (String(state.runId) === el.dataset.run) return;
        state.runId = el.dataset.run;
        // An outcome filter belongs to the run it was chosen in: a cause present in one run need
        // not exist in the next, and carrying it over shows an empty table for an unseen reason.
        state.cause = '';
        FILTERS.forEach(k => { state.filters[k] = ''; });
        state.search = '';
        state.offset = 0;
        state.detail = null;
        reloadRun();
      });
    });

    root.querySelectorAll('[data-cause]').forEach(el => {
      el.addEventListener('click', () => {
        const next = el.dataset.cause || '';
        state.cause = next && state.cause === next ? '' : next;
        state.offset = 0;
        state.detail = null;
        reloadRun();
      });
    });

    root.querySelectorAll('.bm-chip[data-filter]').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.filter;
        const val = el.dataset.value;
        state.filters[key] = val && state.filters[key] === val ? '' : val;
        state.offset = 0;
        state.detail = null;
        reloadRun();
      });
    });

    const tech = root.querySelector('#btresTechnique');
    tech?.addEventListener('change', () => {
      state.filters.technique = tech.value;
      state.offset = 0;
      reloadRun();
    });

    const search = root.querySelector('#btresSearch');
    if (search) {
      let t = null;
      search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => { state.search = search.value.trim(); state.offset = 0; reloadRun(); }, 250);
      });
    }

    root.querySelector('#btresClear')?.addEventListener('click', () => {
      FILTERS.forEach(k => { state.filters[k] = ''; });
      state.search = '';
      state.cause = '';
      state.offset = 0;
      reloadRun();
    });

    root.querySelectorAll('.bm-th-sort').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.sort;
        if (state.sort === key) state.desc = !state.desc;
        else { state.sort = key; state.desc = false; }
        state.offset = 0;
        state.detail = null;
        reloadRun();
      });
    });

    root.querySelectorAll('.bm-row').forEach(el => {
      el.addEventListener('click', () => {
        const seq = Number(el.dataset.seq);
        if (state.detail && Number(state.detail.summary && state.detail.summary.seq) === seq) {
          state.detail = null;
          paint();
          return;
        }
        openCase(seq);
      });
    });

    root.querySelectorAll('.bm-page').forEach(el => {
      el.addEventListener('click', () => {
        if (el.disabled) return;
        state.offset = Number(el.dataset.page) || 0;
        state.detail = null;
        reloadRun();
      });
    });
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.detail) { state.detail = null; paint(); }
  });

  function boot() {
    if (!document.getElementById('contentBody')) return;
    if ((new URLSearchParams(location.search).get('tab') || 'test') !== 'result') return;
    loadAll();
    window.NMS.onRefresh(loadAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

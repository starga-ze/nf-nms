/* benchtest.js — AI › Benchtest
 *
 * The prompt sets the Assistant's guardrail is scored against, read out of pretzel_knowledge. This
 * page is a reader and only a reader: sets arrive through Configuration ▸ System Management ▸
 * Operation ▸ Benchtest Data, and nothing here writes. A prompt edited in place would belong to no
 * set, and every result ever recorded against its id would quietly start meaning something else.
 *
 * Several sets coexist, so the first question the page has to answer is *which one*. The rail on
 * the left is that question; everything to the right of it is scoped to the set selected there,
 * and the selection is remembered across visits because an operator comparing two runs comes back
 * to the same set repeatedly.
 *
 * The header band is the part that matters most after that. A detection rate is only interpretable
 * next to the composition it came from, so the counts sit above the table rather than behind a
 * menu — and they are computed from the stored rows, not read from the file's own header.
 *
 * `expected` is the set's own label, not a result. What actually happened on a run is a separate
 * record against the same prompt id, and drawing the two in one cell is the single mistake here
 * that would matter.
 */
(function () {
  'use strict';

  const { esc } = window.NMS.utils;
  const fmtTs = (s) => window.NMS.utils.fmtTs(s);

  const PAGE = 50;
  // 레일 접힘 상태. 화면마다 따로 기억한다 — 세트를 고르는 중과 결과를 읽는 중은
  // 필요한 화면 폭이 다르다.
  const RAIL_KEY = 'pz.benchtest.rail.test';
  const railOpen = () => localStorage.getItem(RAIL_KEY) !== '0';

  // 필터 칩 줄 접힘. 대분류 10 + 검사 시점 5 + 구분 2 + 언어 3 이라 펼친 채로는 표가 시작하기
  // 전에 화면 절반이 지나간다. 접어도 무엇이 걸려 있는지는 헤더 요약으로 남는다 — 접힌 필터가
  // 조용히 표를 좁히고 있으면 "왜 30건뿐이지"를 매번 다시 찾게 된다.
  const BREAKS_KEY = 'pz.benchtest.breaks.test';
  const breaksOpen = () => localStorage.getItem(BREAKS_KEY) !== '0';

  const PICK_KEY = 'pz.benchtest.set';

  // Filter columns the server accepts. Closed here so a stale bookmark cannot put an arbitrary
  // column name into the query string and have the page render a control for it.
  const FILTERS = ['category', 'verdict', 'language', 'technique', 'checkpoint'];

  // 대분류 열 개. 서버가 주는 by_category 순서는 알파벳순이라, 사람이 읽는 순서(사용자 입력 →
  // 서비스 응답 → 도구 → 외부 지식)와 다르다. 칩을 그 순서로 세우려고 목록을 여기 둔다.
  // 한글 이름도 같이 들고 있는 이유는 세트가 category_ko 를 행마다 싣고 다니지만 요약 버킷에는
  // 코드만 오기 때문이다.
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
    sets: null,        // BenchmarkDataset[] | null while unread
    setId: null,
    summary: null,
    rows: [],
    total: 0,
    offset: 0,
    filters: { category: '', verdict: '', language: '', technique: '', checkpoint: '' },
    search: '',
    sort: 'row_no',      // 'row_no' (the file's own order) | 'prompt_id'
    desc: false,
    selected: null,
    error: '',
    loading: true,
  };

  const currentSet = () => (state.sets || []).find(s => String(s.id) === String(state.setId)) || null;

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ── Data ────────────────────────────────────────────────────────────────────

  async function loadSets() {
    try {
      const d = await window.NMS.utils.pollTicket(
        '/api/benchtest/datasets', '/api/benchtest/result');
      if (!d) return;
      state.sets = Array.isArray(d.datasets) ? d.datasets : [];
      state.error = d.error || '';
    } catch (e) {
      state.sets = [];
      state.error = 'could not read the benchtest sets';
    }

    // A remembered set can have been deleted between visits, and a box with exactly one set has
    // exactly one sensible answer. Both settled here rather than on every render.
    const known = (state.sets || []).map(s => String(s.id));
    let want = state.setId != null ? String(state.setId) : (localStorage.getItem(PICK_KEY) || '');
    if (!want || known.indexOf(want) === -1) want = known[0] || null;
    state.setId = want;
    if (want) localStorage.setItem(PICK_KEY, want);
  }

  function queryString() {
    const p = new URLSearchParams();
    p.set('id', String(state.setId));
    for (const k of FILTERS) if (state.filters[k]) p.set(k, state.filters[k]);
    if (state.search) p.set('q', state.search);
    p.set('offset', String(state.offset));
    p.set('limit', String(PAGE));
    // Sorting is the server's: the page holds 50 of thousands of rows, and ordering those 50
    // would sort the window rather than the set.
    if (state.sort !== 'row_no') p.set('sort', state.sort);
    if (state.desc) p.set('desc', '1');
    return p.toString();
  }

  async function loadRows() {
    if (!state.setId) {
      state.summary = null;
      state.rows = [];
      state.total = 0;
      state.loading = false;
      return;
    }
    try {
      // Two tickets in flight at once: they are independent reads and the header must not wait
      // for the table's page to come back.
      const [sum, list] = await Promise.all([
        window.NMS.utils.pollTicket(
          '/api/benchtest/summary?id=' + encodeURIComponent(state.setId),
          '/api/benchtest/result'),
        window.NMS.utils.pollTicket(
          '/api/benchtest/rows?' + queryString(), '/api/benchtest/result'),
      ]);
      if (!sum || !list) return;
      if (sum.error || list.error) {
        state.error = sum.error || list.error;
        state.summary = null;
        state.rows = [];
        state.total = 0;
      } else {
        state.summary = sum;
        state.rows = Array.isArray(list.rows) ? list.rows : [];
        state.total = Number(list.total) || 0;
        state.error = '';
      }
    } catch (e) {
      // An empty set and a failed read look identical in a table, so they must not read the same
      // in the strip above it.
      state.error = 'could not read this benchtest set';
      state.rows = [];
      state.total = 0;
    }
    state.loading = false;
  }

  async function loadAll() {
    state.loading = true;
    paint();
    await loadSets();
    await loadRows();
    paint();
  }

  async function reloadRows() {
    state.loading = true;
    paint();
    await loadRows();
    paint();
  }

  // ── Set rail ────────────────────────────────────────────────────────────────

  function railHtml() {
    if (state.sets === null) {
      return `<aside class="bt-rail"><div class="bt-rail-stub" id="btRailStub" title="패널 펼치기"><span class="bt-rail-chev"></span><span class="bt-rail-stub-t">Sets</span></div><div class="bt-rail-empty">loading…</div></aside>`;
    }
    if (!state.sets.length) {
      // The page cannot fix this, and the place that can is one specific screen — so name it
      // rather than leaving an empty panel with nothing to act on.
      return `<aside class="bt-rail"><div class="bt-rail-stub" id="btRailStub" title="패널 펼치기"><span class="bt-rail-chev"></span><span class="bt-rail-stub-t">Sets</span></div>
          <div class="bt-rail-h"><span class="bt-rail-t">Sets</span><button type="button" class="bt-rail-x" id="btRailX" title="패널 접기 / 펼치기" aria-label="패널 접기 / 펼치기"><span class="bt-rail-chev"></span></button></div>
          <div class="bt-rail-empty">
            <p>No benchtest set has been imported yet.</p>
            <p class="bt-rail-hint">Import a <code>.jsonl</code> from
               Configuration ▸ System Management ▸ Operation ▸ Benchtest Data.</p>
            <a class="bt-rail-link" href="settings?tab=operation">Open Operation</a>
          </div>
        </aside>`;
    }
    const items = state.sets.map(s => {
      const on = String(s.id) === String(state.setId);
      return `<button type="button" class="bt-set${on ? ' is-on' : ''}" data-set="${esc(String(s.id))}">
          <span class="bt-set-name">${esc(s.name)}</span>
          <span class="bt-set-when">${esc(fmtTs(s.uploaded_at))}</span>
        </button>`;
    }).join('');
    return `<aside class="bt-rail"><div class="bt-rail-stub" id="btRailStub" title="패널 펼치기"><span class="bt-rail-chev"></span><span class="bt-rail-stub-t">Sets</span></div>
        <div class="bt-rail-h"><span class="bt-rail-t">Sets</span><span class="bt-rail-n">${state.sets.length}</span><button type="button" class="bt-rail-x" id="btRailX" title="패널 접기 / 펼치기" aria-label="패널 접기 / 펼치기"><span class="bt-rail-chev"></span></button></div>
        <div class="bt-rail-list">${items}</div>
      </aside>`;
  }

  // ── Header band ─────────────────────────────────────────────────────────────

  // 서버가 준 카테고리 버킷을 사람이 읽는 순서로 세운다. 목록에 없는 코드(다른 데서 만든 세트)는
  // 버리지 않고 뒤에 붙인다 — 콘솔이 모르는 값이라고 세트의 일부를 감추면 총합이 안 맞는다.
  function orderedCategories(items) {
    return (items || []).slice().sort((a, b) => {
      const ia = CATEGORY_ORDER.has(a.key) ? CATEGORY_ORDER.get(a.key) : 999;
      const ib = CATEGORY_ORDER.has(b.key) ? CATEGORY_ORDER.get(b.key) : 999;
      return ia - ib || String(a.key).localeCompare(String(b.key));
    });
  }

  function breakdown(label, items, key) {
    if (!items || !items.length) return '';
    const active = state.filters[key] || '';
    // An explicit All, rather than leaving "none of them lit" to mean it. The unlit state is
    // ambiguous at a glance — it reads as "nothing chosen yet" as easily as "everything" — and
    // this is the control that decides what a Test run covers, so it has to say which.
    const cells = [`<button type="button" class="bm-chip bm-chip-all${active ? '' : ' is-on'}"
                      data-filter="${esc(key)}" data-value="">
                <span class="bm-chip-k">All</span>
              </button>`].concat(items.map(b => {
      const on = active === b.key;
      // Deliberately no count. These are the whole set's totals, and once a filter is on they
      // disagree with the table underneath — a chip reading "B 375" above 40 visible rows is a
      // number that has to be explained away every time it is read. The row count that IS true of
      // what is on screen lives in the bar, where it changes with the filters.
      return `<button type="button" class="bm-chip${on ? ' is-on' : ''}"
                      data-filter="${esc(key)}" data-value="${esc(b.key)}">
                <span class="bm-chip-k">${esc(b.key)}</span>
              </button>`;
    })).join('');
    return `<div class="bm-break">
              <div class="bm-break-label">${esc(label)}</div>
              <div class="bm-break-row">${cells}</div>
            </div>`;
  }

  function headerHtml() {
    const s = state.summary;
    // The summary carries its own copy of the set header. Preferred over the rail's row: the two
    // are read at different moments, and after an import the summary is the fresher of them.
    const set = (s && s.dataset) || currentSet();
    // What a Test run would cover. Before the first page lands there is no filtered count yet, so
    // it falls back to the whole set rather than flashing a zero that is not true of anything.
    const selected = state.loading && !state.rows.length
      ? Number((set && set.row_count) || 0) : state.total;
    if (!s || !set) {
      return `<section class="bm-head bm-head-idle">
          <div class="bm-head-sub">${state.sets && state.sets.length
            ? 'Select a set on the left.' : 'Nothing to show yet.'}</div>
        </section>`;
    }
    return `
      <section class="bm-head">
        <div class="bm-head-top">
          <div class="bm-head-id">
            <div class="bm-head-total">
              <span class="bm-sel">${selected.toLocaleString()}</span><span
                    class="bm-of">/${Number(set.row_count || 0).toLocaleString()}</span>
            </div>
            <div class="bm-head-sub">prompts selected in <b>${esc(set.name)}</b></div>
          </div>
          <dl class="bm-meta">
            <div><dt>File</dt><dd>${esc(set.filename || '—')}</dd></div>
            <div><dt>Size</dt><dd>${esc(fmtBytes(set.byte_size))}</dd></div>
            <div><dt>Imported</dt><dd>${esc(fmtTs(set.uploaded_at))}</dd></div>
            <div><dt>Digest</dt><dd><code>${esc(String(set.content_sha || '').slice(0, 12))}</code></dd></div>
          </dl>
        </div>
        ${breaksToggleHtml()}
        <div class="bm-breaks${breaksOpen() ? '' : ' is-shut'}">
          ${breakdown('Category', orderedCategories(s.by_category), 'category')}
          <div class="bm-breaks-row2">
            ${breakdown('Checkpoint', s.by_checkpoint, 'checkpoint')}
            ${breakdown('Verdict', s.by_verdict, 'verdict')}
            ${breakdown('Language', s.by_language, 'language')}
          </div>
        </div>
      </section>`;
  }

  // 접었을 때 무엇이 걸려 있는지 한 줄로. 걸린 것이 없으면 요약도 없다 — 빈 라벨이 붙어 있으면
  // 필터가 있는지 없는지를 눈이 매번 확인하게 된다.
  function activeSummary() {
    const on = FILTERS.filter(k => state.filters[k]).map(k => state.filters[k]);
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

  // ── Filter bar ──────────────────────────────────────────────────────────────

  function techniqueOptions() {
    const banks = (state.summary && state.summary.techniques) || [];
    const cat = state.filters.category;
    const shown = banks.filter(t => !cat || t.category === cat);
    const seen = new Set();
    let html = `<option value="">All techniques</option>`;
    for (const t of shown) {
      if (seen.has(t.technique)) continue;
      seen.add(t.technique);
      const on = state.filters.technique === t.technique ? ' selected' : '';
      html += `<option value="${esc(t.technique)}"${on}>${esc(t.technique)} (${t.count})</option>`;
    }
    return html;
  }

  function countLabel() {
    if (state.loading) return 'loading…';
    if (state.error || !state.setId) return '';
    if (!state.total) return 'no rows';
    const from = state.offset + 1;
    const to = Math.min(state.offset + PAGE, state.total);
    return `${from.toLocaleString()}–${to.toLocaleString()} of ${state.total.toLocaleString()}`;
  }

  function barHtml() {
    if (!state.setId) return '';
    const any = FILTERS.some(k => state.filters[k]) || state.search;
    return `
      <div class="bm-bar">
        <select class="bm-select" id="bmTechnique">${techniqueOptions()}</select>
        <input class="bm-search" id="bmSearch" type="search" spellcheck="false"
               placeholder="Search contents or id" value="${esc(state.search)}" />
        <button type="button" class="bm-clear${any ? '' : ' is-off'}" id="bmClear">Clear</button>
        <div class="bm-count">${countLabel()}</div>
        <button type="button" class="bm-test" id="bmTest"${state.total ? '' : ' disabled'}>Test</button>
      </div>`;
  }

  // ── Table ───────────────────────────────────────────────────────────────────
  function rowsHtml() {
    if (state.error) return `<div class="bm-empty bm-empty-err">${esc(state.error)}</div>`;
    if (!state.setId) return `<div class="bm-empty">No set selected.</div>`;
    if (state.loading && !state.rows.length) return `<div class="bm-empty">loading…</div>`;
    if (!state.rows.length) return `<div class="bm-empty">No case matches these filters.</div>`;

    const body = state.rows.map((r, i) => {
      const attack = r.verdict === 'malicious';
      const sel = state.selected === r.prompt_id ? ' is-sel' : '';
      return `<tr class="bm-row${sel}" data-id="${esc(r.prompt_id)}">
          <td class="bm-c-no">${state.offset + i + 1}</td>
          <td class="bm-c-id"><code>${esc(r.prompt_id)}</code></td>
          <td class="bm-c-cat" title="${esc(r.category_ko || '')}">
            <span class="bm-cat">${esc(CATEGORY_KO.get(r.category) || r.category)}</span>
          </td>
          <td class="bm-c-cp">${esc(r.checkpoint)}</td>
          <td class="bm-c-tech">${esc(r.technique)}</td>
          <td class="bm-c-lang">${esc(r.language)}</td>
          <td class="bm-c-exp">
            <span class="bm-exp ${attack ? 'is-block' : 'is-allow'}">${esc(r.expected_action)}</span>
          </td>
          <td class="bm-c-det">${esc((r.expected_detector || []).join(', '))}</td>
        </tr>`;
    }).join('');

    const arrow = state.desc ? '▾' : '▴';
    const sorted = state.sort === 'prompt_id';
    return `<table class="bm-table">
        <thead><tr>
          <th class="bm-th-sort${sorted ? '' : ' is-on'}" data-sort="row_no"
              title="Order as the file has them">#${sorted ? '' : ' ' + arrow}</th>
          <th class="bm-th-sort${sorted ? ' is-on' : ''}" data-sort="prompt_id"
              title="Order by prompt id">ID${sorted ? ' ' + arrow : ''}</th>
          <th>Category</th><th>Checkpoint</th><th>Technique</th><th>Lang</th>
          <th>Expected action</th><th>Expected detector</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>`;
  }

  function pagerHtml() {
    if (state.total <= PAGE) return '';
    const last = Math.max(0, Math.floor((state.total - 1) / PAGE) * PAGE);
    const back = state.offset <= 0 ? ' disabled' : '';
    const fwd = state.offset >= last ? ' disabled' : '';
    return `<div class="bm-pager">
        <button type="button" class="bm-page" data-page="0"${back}>First</button>
        <button type="button" class="bm-page" data-page="${Math.max(0, state.offset - PAGE)}"${back}>Prev</button>
        <button type="button" class="bm-page" data-page="${Math.min(last, state.offset + PAGE)}"${fwd}>Next</button>
        <button type="button" class="bm-page" data-page="${last}"${fwd}>Last</button>
      </div>`;
  }

  // ── Drawer ──────────────────────────────────────────────────────────────────

  // The drawer lives outside the paint cycle, mounted once on <body> and toggled with a class.
  // Everything else here re-renders #contentBody wholesale on every repaint, and a panel rebuilt
  // from scratch cannot animate — the element the transition was running on is gone. Same shape
  // the API Collection drawer uses, so the two slide identically.
  function drawerEl() {
    let node = document.getElementById('btDrawer');
    if (node) return node;

    const overlay = document.createElement('div');
    overlay.className = 'bt-drawer-overlay';
    overlay.id = 'btDrawerOverlay';
    overlay.addEventListener('click', () => { state.selected = null; syncDrawer(); paintRows(); });
    document.body.appendChild(overlay);

    node = document.createElement('aside');
    node.className = 'bt-drawer';
    node.id = 'btDrawer';
    document.body.appendChild(node);
    return node;
  }

  function syncDrawer() {
    const node = drawerEl();
    const overlay = document.getElementById('btDrawerOverlay');
    const html = drawerHtml();
    // Filled before the class flips, so the panel slides in already carrying its content rather
    // than arriving empty and filling in behind the reader. Left as it was on close, so it slides
    // out with its content instead of blanking first.
    if (html) node.innerHTML = html;
    node.classList.toggle('open', !!html);
    overlay.classList.toggle('open', !!html);
    node.querySelector('#bmDrawerX')?.addEventListener('click', () => {
      state.selected = null;
      syncDrawer();
      paintRows();
    });
  }

  // Raw Contents — 요청 본문 그대로 한 블록.
  //
  // 처음에는 원소별로 펴서 tool_event 의 metadata 를 표로, input/output 을 따로 그렸다. 그런데
  // 그러면 도구 케이스만 다른 화면처럼 보인다 — 프롬프트 케이스는 pre 한 덩어리인데 도구
  // 케이스는 dl 과 pre 가 섞인 3단 구조라, 같은 표에서 넘어온 두 행이 다른 제품처럼 읽혔다.
  // 어차피 이 블록을 여는 사람은 "실제로 무엇이 나갔나"를 보려는 것이므로, 나간 그대로 보인다.
  function contentsHtml(r) {
    let text = r.contents_json || '';
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* as-is */ }
    return `<div class="bm-drawer-label">Raw Contents</div>
            <pre class="bm-prompt">${esc(text || '—')}</pre>`;
  }

  function drawerHtml() {
    const r = state.rows.find(x => x.prompt_id === state.selected);
    if (!r) return '';
    const meta = [
      ['Line in file', r.row_no],
      ['Category', [CATEGORY_KO.get(r.category) || r.category_ko, r.category]
        .filter(Boolean).join(' · ')],
      ['Checkpoint', r.checkpoint],
      ['Technique', r.technique],
      ['Verdict', r.verdict],
      ['Expected action', r.expected_action],
      ['Expected detector', (r.expected_detector || []).join(', ')],
      ['Language', r.language],
    ].filter(([, v]) => v !== '' && v !== null && v !== undefined)
     .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    // Fields the file carried that the schema has no column for. Shown rather than hidden: the
    // stored set is meant to be a faithful copy of the uploaded file, and a field the console
    // silently swallowed would make that claim false.
    let extra = '';
    if (r.extra_json) {
      let pretty = r.extra_json;
      try { pretty = JSON.stringify(JSON.parse(r.extra_json), null, 2); } catch (e) { /* as-is */ }
      extra = `<div class="bm-drawer-label">Other fields</div>
               <pre class="bm-prompt">${esc(pretty)}</pre>`;
    }

    return `<div class="bm-drawer-h">
          <code class="bm-drawer-id">${esc(r.prompt_id)}</code>
          <button type="button" class="bm-drawer-x" id="bmDrawerX" aria-label="Close">×</button>
        </div>
        <dl class="bm-drawer-meta">${meta}</dl>
        ${contentsHtml(r)}
        ${extra}`;
  }

  // ── Paint ───────────────────────────────────────────────────────────────────

  function paint() {
    const root = document.getElementById('contentBody');
    if (!root) return;
    root.className = 'content-body bt-page' + (railOpen() ? '' : ' is-rail-shut');
    root.innerHTML =
      railHtml() +
      `<div class="bt-main">
         ${headerHtml()}
         ${barHtml()}
         <div class="bm-body">
           <div class="bm-table-wrap">${rowsHtml()}${pagerHtml()}</div>
         </div>
       </div>`;
    wire();
    syncDrawer();
  }

  // Selecting a row changes two things, and neither needs the header or the filter bar rebuilt:
  // the highlight in the table, and what the drawer holds.
  function paintRows() {
    const wrap = document.querySelector('.bm-table-wrap');
    if (!wrap) return paint();
    wrap.innerHTML = rowsHtml() + pagerHtml();
    wireRows();
  }

  function resetView() {
    state.offset = 0;
    state.selected = null;
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
        if (String(state.setId) === el.dataset.set) return;
        state.setId = el.dataset.set;
        localStorage.setItem(PICK_KEY, state.setId);
        // Filters belong to the set that was open, not to the operator: a technique that exists in
        // one set need not exist in the next, and carrying it over shows an empty table for a
        // reason nobody can see.
        FILTERS.forEach(k => { state.filters[k] = ''; });
        state.search = '';
        resetView();
        reloadRows();
      });
    });

    root.querySelectorAll('.bm-chip').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.filter;
        const val = el.dataset.value;
        // A value chip toggles: clicking the active one is how an operator gets back to the whole
        // set, which is otherwise a trip to Clear for something they just did. All is not a
        // toggle — it is the cleared state, so clicking it twice must not turn the filter back on.
        state.filters[key] = val && state.filters[key] === val ? '' : val;
        if (key === 'category') state.filters.technique = '';
        resetView();
        reloadRows();
      });
    });

    const tech = root.querySelector('#bmTechnique');
    tech?.addEventListener('change', () => {
      state.filters.technique = tech.value;
      resetView();
      reloadRows();
    });

    const search = root.querySelector('#bmSearch');
    if (search) {
      let timer = null;
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.search = search.value.trim();
          resetView();
          reloadRows();
        }, 250);
      });
    }

    root.querySelector('#bmClear')?.addEventListener('click', () => {
      FILTERS.forEach(k => { state.filters[k] = ''; });
      state.search = '';
      resetView();
      reloadRows();
    });

    // The run's scope is whatever the table is showing. Handed over rather than recomputed, so a
    // result can never be attributed to a filter other than the one that was on screen.
    root.querySelector('#bmTest')?.addEventListener('click', () => {
      const set = (state.summary && state.summary.dataset) || currentSet();
      if (!set || !window.NMS.benchtestRun) return;
      window.NMS.benchtestRun.open({
        datasetId: set.id,
        setName: set.name,
        filters: Object.assign({}, state.filters),
        search: state.search,
        selected: state.total,
      });
    });

    root.querySelectorAll('.bm-th-sort').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.sort;
        // Clicking the column already sorted on reverses it; clicking the other one starts it
        // ascending, which is what every table in this console does.
        if (state.sort === key) state.desc = !state.desc;
        else { state.sort = key; state.desc = false; }
        state.offset = 0;
        state.selected = null;
        reloadRows();
      });
    });

    wireRows();
  }

  function wireRows() {
    const root = document.getElementById('contentBody');
    if (!root) return;

    root.querySelectorAll('.bm-row').forEach(el => {
      el.addEventListener('click', () => {
        state.selected = (state.selected === el.dataset.id) ? null : el.dataset.id;
        syncDrawer();
        paintRows();
      });
    });

    root.querySelectorAll('.bm-page').forEach(el => {
      el.addEventListener('click', () => {
        if (el.disabled) return;
        state.offset = Number(el.dataset.page) || 0;
        state.selected = null;
        reloadRows();
      });
    });
  }

  // ── Boot ────────────────────────────────────────────────────────────────────

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.selected) {
      state.selected = null;
      syncDrawer();
      paintRows();
    }
  });

  function boot() {
    if (!document.getElementById('contentBody')) return;
    // The Result tab is a different module on the same page. Bailing here rather than rendering
    // and hiding: two modules painting one container is a race nobody can read.
    const tab = new URLSearchParams(location.search).get('tab') || 'test';
    if (tab !== 'test') return;
    window.NMS.clearOnLogout(PICK_KEY);
    loadAll();
    window.NMS.onRefresh(loadAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

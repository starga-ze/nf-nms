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
  const PICK_KEY = 'pz.benchtest.set';

  // Filter columns the server accepts. Closed here so a stale bookmark cannot put an arbitrary
  // column name into the query string and have the page render a control for it.
  const FILTERS = ['category', 'verdict', 'language', 'technique'];

  const state = {
    sets: null,        // BenchmarkDataset[] | null while unread
    setId: null,
    summary: null,
    rows: [],
    total: 0,
    offset: 0,
    filters: { category: '', verdict: '', language: '', technique: '' },
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
      return `<aside class="bt-rail"><div class="bt-rail-empty">loading…</div></aside>`;
    }
    if (!state.sets.length) {
      // The page cannot fix this, and the place that can is one specific screen — so name it
      // rather than leaving an empty panel with nothing to act on.
      return `<aside class="bt-rail">
          <div class="bt-rail-h">Sets</div>
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
    return `<aside class="bt-rail">
        <div class="bt-rail-h">Sets<span class="bt-rail-n">${state.sets.length}</span></div>
        <div class="bt-rail-list">${items}</div>
      </aside>`;
  }

  // ── Header band ─────────────────────────────────────────────────────────────

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
        <div class="bm-breaks">
          ${breakdown('Category', s.by_category, 'category')}
          ${breakdown('Verdict', s.by_verdict, 'verdict')}
          ${breakdown('Language', s.by_language, 'language')}
        </div>
      </section>`;
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
               placeholder="Search prompt text or id" value="${esc(state.search)}" />
        <button type="button" class="bm-clear${any ? '' : ' is-off'}" id="bmClear">Clear</button>
        <div class="bm-count">${countLabel()}</div>
        <button type="button" class="bm-test" id="bmTest"${state.total ? '' : ' disabled'}>Test</button>
      </div>`;
  }

  // ── Table ───────────────────────────────────────────────────────────────────

  // One line of the prompt: enough to tell two rows apart without pretending the cell holds the
  // prompt. The whole thing lives in the drawer.
  function firstLine(text) {
    const line = String(text || '').split('\n').find(l => l.trim()) || '';
    return line.length > 140 ? line.slice(0, 140) + '…' : line;
  }

  function rowsHtml() {
    if (state.error) return `<div class="bm-empty bm-empty-err">${esc(state.error)}</div>`;
    if (!state.setId) return `<div class="bm-empty">No set selected.</div>`;
    if (state.loading && !state.rows.length) return `<div class="bm-empty">loading…</div>`;
    if (!state.rows.length) return `<div class="bm-empty">No prompt matches these filters.</div>`;

    const body = state.rows.map((r, i) => {
      const attack = r.verdict === 'malicious';
      const sel = state.selected === r.prompt_id ? ' is-sel' : '';
      return `<tr class="bm-row${sel}" data-id="${esc(r.prompt_id)}">
          <td class="bm-c-no">${state.offset + i + 1}</td>
          <td class="bm-c-id"><code>${esc(r.prompt_id)}</code></td>
          <td class="bm-c-cat"><span class="bm-cat">${esc(r.category)}</span></td>
          <td class="bm-c-tech">${esc(r.technique)}</td>
          <td class="bm-c-lang">${esc(r.language)}</td>
          <td class="bm-c-exp">
            <span class="bm-exp ${attack ? 'is-block' : 'is-allow'}">${esc(r.expected)}</span>
          </td>
          <td class="bm-c-det">${esc((r.expected_labels || []).join(', '))}</td>
          <td class="bm-c-prompt">${esc(firstLine(r.prompt))}</td>
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
          <th>Cat</th><th>Technique</th><th>Lang</th>
          <th>Expected</th><th>Detector</th><th>Prompt</th>
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

  function drawerHtml() {
    const r = state.rows.find(x => x.prompt_id === state.selected);
    if (!r) return '';
    const meta = [
      ['Line in file', r.row_no],
      ['Category', [r.category, r.category_ko].filter(Boolean).join(' · ')],
      ['Technique', r.technique],
      ['Verdict', r.verdict],
      ['Expected', r.expected],
      ['Scan target', r.scan_target],
      ['Language', r.language],
      ['Severity', r.severity],
      ['Detector', (r.expected_labels || []).join(', ')],
      ['Origin', r.origin],
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
        <div class="bm-drawer-label">Prompt</div>
        <pre class="bm-prompt">${esc(r.prompt)}</pre>
        ${extra}`;
  }

  // ── Paint ───────────────────────────────────────────────────────────────────

  function paint() {
    const root = document.getElementById('contentBody');
    if (!root) return;
    root.className = 'content-body bt-page';
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

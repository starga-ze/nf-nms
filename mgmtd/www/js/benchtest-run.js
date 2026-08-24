/* benchtest-run.js — AI › Benchtest › Test
 *
 * Executing the selected prompts against the guardrail, and reading the result.
 *
 * The window is its own overlay rather than the shared confirm modal: a run is minutes long, it
 * repaints on every case, and it stays useful after it ends. It also has to survive being closed
 * and reopened — the progress lives in a slot on the appliance, not in this page, so reopening
 * mid-run rejoins the run in progress instead of starting a second one.
 *
 * Scope is the filter the table already has. That is the whole reason the header counts "selected
 * of total": a run is only interpretable next to the prompts that were in it, and mgmtd forwards
 * the filter rather than resolving it so nothing here has to know which prompts those are.
 *
 * Live rows are deliberately terse — one line each, gtest-style, because the point during a run is
 * the tick and the failures. Nothing more: the request and response of a case live on the Result
 * tab, which reads them from the database. A run's numbers have to outlive this window, and a
 * detail pane here would be a second place they appear that disappears when the tab is closed.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};
  const { esc } = window.NMS.utils;

  const POLL_MS = 400;
  const CASE_PAGE = 200;

  // Outcomes, grouped by what they mean for the reader. The Korean labels are the runner's own —
  // they are what is stored on the case, and translating them here would make the console and the
  // database disagree about what a result is called.
  const GOOD = ['정탐', '정상통과'];
  const WARN = ['정탐(오분류)', '오탐(오분류)', '미탐(모델거부)', '미차단(flagged)', '오탐(flagged)'];
  const EXCLUDED = ['미검사', '호출실패'];

  function tone(cause) {
    if (GOOD.indexOf(cause) !== -1) return 'ok';
    if (EXCLUDED.indexOf(cause) !== -1) return 'skip';
    if (WARN.indexOf(cause) !== -1) return 'warn';
    return 'bad';
  }

  let el = null;        // the overlay, while open
  let timer = null;
  const state = {
    scope: null,        // { datasetId, filters, search, selected, setName }
    runId: 0,
    running: false,
    done: 0,
    total: 0,
    stage: '',
    error: '',
    tally: [],
    name: '',           // the run's name, kept across repaints
    note: '',
    lines: [],          // live cases, newest last
    summary: null,
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  function open(scope) {
    state.scope = scope;
    if (!state.running) {
      // A finished run's result stays on screen until a new one is started; reopening the window
      // on a fresh scope should not show the previous run's numbers as if they were this scope's.
      state.runId = 0;
      state.lines = [];
      state.tally = [];
      state.summary = null;
      state.done = state.total = 0;
      state.stage = state.error = '';
    }
    mount();
    // Rejoin whatever the appliance is doing, which is how reopening mid-run works at all.
    poll();
  }

  function close() {
    stopPolling();
    if (el) el.remove();
    el = null;
  }

  function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  // ── Server ────────────────────────────────────────────────────────────────

  function scopeQuery() {
    const p = new URLSearchParams();
    p.set('id', String(state.scope.datasetId));
    for (const k of ['category', 'verdict', 'language', 'technique']) {
      if (state.scope.filters[k]) p.set(k, state.scope.filters[k]);
    }
    if (state.scope.search) p.set('q', state.scope.search);
    // The operator's note travels with the run and is stored on it. "#7" tells a reader nothing
    // about why a run was made, and the Result list is a list of runs.
    // Empty means the placeholder, not "no name": the field shows what it will be called, so a
    // reader who leaves it alone gets the name they were looking at.
    p.set('name', (state.name || '').trim().slice(0, 200) || suggestedName());
    if ((state.note || '').trim()) p.set('note', state.note.trim().slice(0, 2000));
    return p.toString();
  }

  async function start() {
    const named = document.getElementById('btrName');
    if (named) state.name = named.value;
    const noted = document.getElementById('btrNote');
    if (noted) state.note = noted.value;
    state.error = '';
    state.lines = [];
    state.tally = [];
    state.summary = null;
    state.done = 0;
    state.total = state.scope.selected || 0;
    state.stage = 'starting';
    state.running = true;
    paint();
    try {
      const r = await fetch('/api/benchtest/run?' + scopeQuery(),
                            { method: 'POST', credentials: 'same-origin' });
      if (r.status === 401) { window.location.href = '/'; return; }
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) {
        // Not an error to recover from — something is already running, and the poll below will
        // show it. Saying so beats a failure message for a window that is about to fill up.
        state.error = 'A run is already in flight; showing it.';
      } else if (!r.ok || d.error) {
        state.running = false;
        state.stage = 'failed';
        state.error = d.error || `could not start the run (${r.status})`;
      }
    } catch (e) {
      state.running = false;
      state.stage = 'failed';
      state.error = 'could not start the run';
    }
    paint();
    poll();
  }

  async function cancel() {
    try {
      await fetch('/api/benchtest/run/cancel', { method: 'POST', credentials: 'same-origin' });
    } catch (e) { /* the poll reports what actually happened */ }
  }

  async function poll() {
    stopPolling();
    let d = null;
    try {
      d = await window.NMS.utils.fetchJSON('/api/benchtest/run/progress');
    } catch (e) {
      state.error = 'lost contact with the appliance';
      state.running = false;
      paint();
      return;
    }
    if (!d) return;

    state.running = !!d.running;
    if (d.stage) state.stage = d.stage;
    if (d.run_id) state.runId = Number(d.run_id);
    if (typeof d.done === 'number') state.done = d.done;
    if (d.total) state.total = d.total;
    if (d.error) state.error = d.error;
    if (Array.isArray(d.tally)) state.tally = d.tally;

    // Every case since the last poll, drained server-side. Cases finish faster than this polls,
    // so reading only the latest message showed about one line in ten.
    const batch = Array.isArray(d.cases) && d.cases.length
      ? d.cases
      : (d.last_case && d.last_case.seq ? [d.last_case] : []);
    for (const one of batch) {
      const seq = Number(one.seq);
      const last = state.lines.length ? state.lines[state.lines.length - 1] : null;
      if (!last || seq > Number(last.seq)) state.lines.push(one);
    }
    // The list is a live view, not a transcript: the whole run is loaded from the database when it
    // ends, so holding every line here would be a second copy that only costs memory.
    if (state.lines.length > 600) state.lines.splice(0, state.lines.length - 600);

    if (!state.running && state.runId && !state.summary) {
      await loadSummary();
    }
    paint();
    if (state.running) timer = setTimeout(poll, POLL_MS);
  }

  async function loadSummary() {
    try {
      const [sum, list] = await Promise.all([
        window.NMS.utils.pollTicket('/api/benchtest/run?run=' + state.runId,
                                    '/api/benchtest/result'),
        window.NMS.utils.pollTicket(
          '/api/benchtest/cases?run=' + state.runId + '&limit=' + CASE_PAGE,
          '/api/benchtest/result'),
      ]);
      if (sum && !sum.error) state.summary = sum;
      if (list && !list.error && Array.isArray(list.cases)) {
        // Replaces the sampled live list with the complete one.
        state.lines = list.cases;
        state.casesTotal = list.total;
      }
    } catch (e) {
      state.error = state.error || 'the run finished but its result could not be read';
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function scopeLine() {
    const f = state.scope.filters;
    const parts = ['category', 'verdict', 'language', 'technique']
      .filter(k => f[k]).map(k => `${k}=${f[k]}`);
    if (state.scope.search) parts.push(`"${state.scope.search}"`);
    return parts.length ? parts.join(' · ') : 'the whole set';
  }

  function headHtml() {
    const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
    const label = state.running
      ? `${state.done.toLocaleString()} / ${state.total.toLocaleString()}`
      : (state.stage === 'finished' || state.summary
          ? `${state.done.toLocaleString()} of ${state.total.toLocaleString()} completed`
          : `${(state.scope.selected || 0).toLocaleString()} prompts selected`);

    return `<div class="btr-head">
        <div class="btr-head-l">
          <div class="btr-title">Benchtest</div>
          <div class="btr-scope">${esc(state.scope.setName || '')} · ${esc(scopeLine())}</div>
        </div>
        <div class="btr-head-r">
          <div class="btr-count">${esc(label)}</div>
          ${state.running
            ? `<button type="button" class="btr-btn btr-stop" id="btrCancel">Stop</button>`
            : `<button type="button" class="btr-btn btr-run" id="btrRun">Run</button>`}
          <button type="button" class="btr-x" id="btrClose" aria-label="Close">×</button>
        </div>
      </div>
      <div class="btr-bar"><div class="btr-bar-fill" style="width:${pct}%"></div></div>`;
  }

  function tallyHtml() {
    if (!state.tally.length) return '';
    const cells = state.tally.map(t =>
      `<span class="btr-tally is-${tone(t.key)}">${esc(t.key)} <b>${t.count}</b></span>`).join('');
    return `<div class="btr-tallies">${cells}</div>`;
  }

  function summaryHtml() {
    const s = state.summary;
    if (!s || !s.run) return '';
    const detected = Number(s.detected || 0);
    const ruled = Number(s.ruled || 0);
    const refused = Number(s.refused || 0);
    const raw = ruled ? (detected / ruled) * 100 : NaN;
    const scanned = ruled - refused;
    const adj = scanned > 0 ? (detected / scanned) * 100 : NaN;
    const pct = (v) => isNaN(v) ? '—' : v.toFixed(1) + '%';

    return `<div class="btr-summary">
        <div class="btr-stat">
          <div class="btr-stat-k">Detected</div>
          <div class="btr-stat-v">${pct(raw)}</div>
          <div class="btr-stat-n">${detected} / ${ruled} attacks</div>
        </div>
        <div class="btr-stat">
          <div class="btr-stat-k">Adjusted</div>
          <div class="btr-stat-v is-adj">${pct(adj)}</div>
          <div class="btr-stat-n">${refused} model refusal${refused === 1 ? '' : 's'} excluded</div>
        </div>
        <div class="btr-stat btr-stat-wide">
          <div class="btr-stat-k">Run</div>
          <div class="btr-stat-n">#${s.run.id} · ${esc(s.run.status)} · ${esc(s.run.model || '—')}</div>
          <div class="btr-stat-n">${esc(String(s.run.started_at || '').replace('T', ' ').split('.')[0])}</div>
        </div>
      </div>`;
  }

  function resultLinkHtml() {
    if (!state.summary || !state.runId) return '';
    // Where the rest of it lives. Said once, here, rather than left for the reader to discover:
    // the window they are looking at is about to be closed and this is the only moment they are
    // thinking about this run.
    return `<div class="btr-more">Request and response for every case are on
        <a href="benchtest?tab=result">Result</a>.</div>`;
  }

  // The default names the run after what it is: the set, the scope, and when. A machine stamp
  // like 2026-08-22-040700 is unique and unreadable — in a list of twenty runs it tells a reader
  // nothing, which is the one job a default name has.
  function suggestedName() {
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const when = `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
    const set = String(state.scope.setName || 'benchtest').replace(/\.jsonl?$/i, '');
    const f = state.scope.filters;
    const scope = ['category', 'verdict', 'language', 'technique']
      .map(k => f[k]).filter(Boolean).join('/');
    return scope ? `${set} ${scope} · ${when}` : `${set} · ${when}`;
  }

  function formHtml() {
    return `<form class="btr-form" id="btrForm" autocomplete="off">
        <div class="btr-f">
          <label class="btr-f-k" for="btrName">File name</label>
          <input class="btr-f-v" id="btrName" type="text" maxlength="200" spellcheck="false"
                 placeholder="${esc(suggestedName())}" value="${esc(state.name || '')}" />
          <span class="btr-f-hint">Leave blank to use the suggested name.</span>
        </div>
        <div class="btr-f">
          <label class="btr-f-k" for="btrNote">Description <i>optional</i></label>
          <input class="btr-f-v" id="btrNote" type="text" maxlength="2000"
                 value="${esc(state.note || '')}" />
        </div>
      </form>`;
  }

  function linesHtml() {
    if (state.error && !state.lines.length) {
      return `<div class="btr-empty btr-empty-err">${esc(state.error)}</div>`;
    }
    if (!state.lines.length) {
      return state.running ? `<div class="btr-empty">starting…</div>` : formHtml();
    }
    const rows = state.lines.map(c => {
      return `<div class="btr-line is-${tone(c.cause)}" data-seq="${c.seq}">
          <span class="btr-seq">[${c.seq}/${state.total || '?'}]</span>
          <span class="btr-id">${esc(c.prompt_id)}</span>
          <span class="btr-cause">${esc(c.cause)}</span>
          <span class="btr-verdict">${esc(c.verdict)}</span>
          <span class="btr-det">${esc((c.detectors || []).join(',') || '-')}</span>
          <span class="btr-ms">${c.latency_ms ? c.latency_ms + 'ms' : ''}</span>
        </div>`;
    }).join('');
    return `<div class="btr-lines" id="btrLines">${rows}</div>`;
  }

  function pretty(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (e) { return text; }
  }

  function mount() {
    if (!el) {
      el = document.createElement('div');
      el.className = 'btr-overlay';
      document.body.appendChild(el);
    }
    paint();
  }

  function paint() {
    if (!el) return;
    // The window repaints on every poll; an uncontrolled input would lose what is being typed.
    const typedName = document.getElementById('btrName');
    if (typedName) state.name = typedName.value;
    const typedNote = document.getElementById('btrNote');
    if (typedNote) state.note = typedNote.value;
    // The live list is followed while it is running, unless the reader has scrolled up to look at
    // something — pulling them back to the bottom mid-read is worse than a list that waits.
    const list = el.querySelector('#btrLines');
    const stick = !list || (list.scrollHeight - list.scrollTop - list.clientHeight) < 40;
    const keep = list ? list.scrollTop : 0;

    el.innerHTML =
      // Narrow while it is only the form, wide once lines are running: a 520px form centred in a
      // 1,180px window is mostly empty space, and the same window has to hold an eight-column
      // line a minute later.
      `<div class="btr-win${state.lines.length || state.running ? '' : ' is-compact'}"
            role="dialog" aria-modal="true">
         ${headHtml()}
         ${state.error && state.lines.length ? `<div class="btr-err">${esc(state.error)}</div>` : ''}
         ${summaryHtml()}
         ${tallyHtml()}
         ${resultLinkHtml()}
         <div class="btr-body">
           <div class="btr-list-wrap">${linesHtml()}</div>
         </div>
       </div>`;

    const next = el.querySelector('#btrLines');
    if (next) next.scrollTop = stick ? next.scrollHeight : keep;
    wire();
  }

  function wire() {
    el.querySelector('#btrClose')?.addEventListener('click', close);
    el.querySelector('#btrRun')?.addEventListener('click', start);
    // Enter in either field starts the run: the form is two inputs and a button, and reaching for
    // the mouse to finish something you just typed is a step nobody wants.
    el.querySelector('#btrForm')?.addEventListener('submit', (ev) => { ev.preventDefault(); start(); });
    el.querySelector('#btrCancel')?.addEventListener('click', cancel);
    el.addEventListener('mousedown', (ev) => {
      // Click-outside closes, but only when nothing is running: a stray click must not look like
      // it stopped a run it did not stop.
      if (ev.target === el && !state.running) close();
    }, { once: true });
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && el && !state.running) close();
  });

  window.NMS.benchtestRun = { open, close };
})();

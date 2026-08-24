/* benchtest-card.js — Configuration ▸ System Management ▸ Operation ▸ Benchtest Data (jsonl).
 *
 * The import/export end of the benchtest sets. It sits on Operation rather than on the Benchtest
 * page because it is the same kind of act as importing a config: moving a file on or off the
 * appliance, which an operator does rarely and deliberately. The Benchtest page under AI is the
 * reader — it lists what is here and renders it, and never writes.
 *
 * Import adds; it never replaces. A result recorded last week was scored against the set that
 * existed last week, so overwriting one would quietly change what that result means. Re-importing
 * bytes that are already stored is recognised by digest and reported as "already here", pointing
 * at the set that holds them — not as an error, because nothing failed.
 *
 * Export writes the set back out as the .jsonl it arrived as, one JSON object per line, so a file
 * that goes out of the appliance can be fed straight back to the runner.
 *
 * Mounted by operation.js rather than inlined: that module replaces #contentBody wholesale on
 * every render, which would wipe anything this card had drawn itself.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};
  const { esc } = window.NMS.utils;
  const modal = () => window.NMS.modal;

  // The store accepts more than this; the browser is stopped earlier so a wrong file is refused
  // before it is read into memory and pushed at the appliance.
  const MAX_BYTES = 32 * 1024 * 1024;

  let sets = null;    // BenchmarkDataset[] | null while unread
  let msg = null;     // { text, err }
  let busy = false;

  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const IC = {
    imp: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
    exp: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    view: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  };

  const trimTs = (s) => (s ? String(s).split('.')[0].replace('T', ' ') : '—');

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  async function load() {
    try {
      const d = await window.NMS.utils.pollTicket(
        '/api/benchtest/datasets', '/api/benchtest/result');
      if (!d) return;
      sets = Array.isArray(d.datasets) ? d.datasets : [];
      if (d.error) msg = { text: d.error, err: true };
    } catch (e) {
      sets = [];
      msg = { text: 'could not read the benchtest sets', err: true };
    }
    render();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  function render() {
    const mount = document.getElementById('benchtestMount');
    if (!mount) return;

    const total = sets ? sets.length : 0;
    const rows = sets ? sets.reduce((a, s) => a + (Number(s.row_count) || 0), 0) : 0;
    const newest = sets && sets.length ? sets[0] : null;

    mount.innerHTML =
      `<div class="info-card op-card">
         <div class="info-card-title">Benchtest Data
           <span class="info-hint">jsonl</span></div>

         <div class="info-row"><span class="info-label">Sets</span>
           <span class="info-value">${sets === null ? '—' : total}</span></div>
         <div class="info-row"><span class="info-label">Prompts</span>
           <span class="info-value">${sets === null ? '—' : rows.toLocaleString()}</span></div>
         <div class="info-row"><span class="info-label">Latest</span>
           <span class="info-value">${newest ? esc(newest.name) + ' · ' + esc(trimTs(newest.uploaded_at)) : '—'}</span></div>

         <div class="op-toolbar">
           <button class="op-btn" id="btView" ${total ? '' : 'disabled'}
                   title="Open the benchtest browser">${IC.view}<span>View</span></button>
           <span class="op-sep"></span>
           <button class="op-btn" id="btImport" ${busy ? 'disabled' : ''}
                   title="Upload a .jsonl set to the appliance">${IC.imp}<span>Import</span></button>
           <button class="op-btn" id="btExport" ${total && !busy ? '' : 'disabled'}
                   title="Download a stored set to this device">${IC.exp}<span>Export</span></button>
           <input type="file" id="btFile" accept="application/jsonl,application/json,.jsonl,.json" hidden>
         </div>

         ${msg ? `<div class="op-msg ${msg.err ? 'err' : 'ok'}">${esc(msg.text)}</div>` : ''}
       </div>`;

    wire();
  }

  function setMsg(text, err) { msg = { text, err: !!err }; render(); }

  // ── Import ────────────────────────────────────────────────────────────────

  async function doImport(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      return setMsg(`${file.name} is ${fmtBytes(file.size)}; the limit is ${fmtBytes(MAX_BYTES)}.`, true);
    }
    if (!file.size) return setMsg(`${file.name} is empty.`, true);

    busy = true;
    setMsg(`Uploading ${file.name}…`, false);
    try {
      // Raw body, not multipart: the payload is one file and nothing else. The filename rides in
      // the query string rather than a header — mgmtd's request struct carries no general header
      // map, and threading one through the HTTP session for a label would be a wide change for a
      // narrow need.
      const d = await window.NMS.utils.pollTicket(
        '/api/benchtest/datasets?filename=' + encodeURIComponent(file.name),
        '/api/benchtest/result',
        { dispatch: { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: file },
          // An upload parses and inserts thousands of rows on the far side, so it is given a
          // longer ceiling than a read.
          everyMs: 400, tries: 150 });
      if (!d) return;

      if (d.duplicate && d.dataset) {
        // Nothing failed and nothing was created. Say which set it already is.
        setMsg(`Already stored as "${d.dataset.name}" (${trimTs(d.dataset.uploaded_at)}).`, false);
      } else if (d.error) {
        // A rejected file has per-line detail worth reading, and a one-line strip cannot hold it.
        showProblems(file.name, d.error, d.problems || []);
        setMsg(d.error || `Could not import ${file.name}.`, true);
      } else if (d.dataset) {
        setMsg(`Imported "${d.dataset.name}" — ${Number(d.dataset.row_count).toLocaleString()} prompts.`, false);
      } else {
        setMsg(`Imported ${file.name}.`, false);
      }
    } catch (e) {
      setMsg(`Could not import ${file.name}.`, true);
    }
    busy = false;
    load();
  }

  function showProblems(filename, message, problems) {
    if (!problems.length || !modal()) return;
    const list = problems.map(p => `<li>${esc(p)}</li>`).join('');
    modal().open({
      title: 'Import rejected',
      body: `<p class="field-hint">${esc(filename)} — ${esc(message)}</p>
             <ul class="bt-problems">${list}</ul>`,
      okLabel: 'Close',
      onOk: () => true,
    });
  }

  // ── Export ────────────────────────────────────────────────────────────────

  function doExport() {
    if (!sets || !sets.length) return;
    if (sets.length === 1) return download(sets[0]);
    if (!modal()) return download(sets[0]);

    const options = sets.map(s =>
      `<option value="${esc(String(s.id))}">${esc(s.name)} — ${Number(s.row_count).toLocaleString()} prompts, ${esc(trimTs(s.uploaded_at))}</option>`
    ).join('');
    modal().open({
      title: 'Export benchtest set',
      body: `<label class="field-label" for="btExportPick">Set</label>
             <select class="input" id="btExportPick">${options}</select>`,
      okLabel: 'Download',
      onOk: () => {
        const pick = document.getElementById('btExportPick');
        const chosen = sets.find(s => String(s.id) === (pick && pick.value));
        if (chosen) download(chosen);
        return true;
      },
    });
  }

  // The set leaves as the .jsonl it arrived as, so an exported file can be fed straight back to
  // the runner.
  //
  // This one cannot use pollTicket: every other call resolves to a JSON document, and the answer
  // here is the file itself. So the poll is written out — the result endpoint answers
  // {status:"pending"} as JSON while the work is in flight and then switches to the bytes, and
  // the content type is what tells the two apart.
  async function download(set) {
    setMsg(`Preparing "${set.name}"…`, false);
    try {
      const first = await window.NMS.utils.fetchJSON(
        '/api/benchtest/export?id=' + encodeURIComponent(set.id));
      if (!first) return;
      if (first.error) return setMsg(first.error, true);
      if (!first.ticket) throw new Error('no ticket');

      const url = '/api/benchtest/result?ticket=' + first.ticket;
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 400));
        const r = await fetch(url, { credentials: 'same-origin' });
        if (r.status === 401) { window.location.href = '/'; return; }

        const type = r.headers.get('content-type') || '';
        if (type.indexOf('json') !== -1) {
          const d = await r.json().catch(() => ({}));
          if (d.status === 'pending') continue;
          return setMsg(d.error || `Could not export "${set.name}".`, true);
        }
        if (!r.ok) throw new Error(r.status);

        // Saved through a blob URL revoked immediately after the click: a megabyte held in a
        // dangling object URL outlives the page that made it.
        const blob = await r.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = /\.jsonl?$/i.test(set.filename || '') ? set.filename : `${set.name}.jsonl`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
        return setMsg(`Exported "${set.name}".`, false);
      }
      setMsg(`Timed out exporting "${set.name}".`, true);
    } catch (e) {
      setMsg(`Could not export "${set.name}".`, true);
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function wire() {
    const file = document.getElementById('btFile');
    document.getElementById('btImport')?.addEventListener('click', () => file && file.click());
    file?.addEventListener('change', () => {
      const chosen = file.files && file.files[0];
      // Reset first: picking the same file twice in a row fires no change event otherwise, and the
      // second import silently does nothing.
      file.value = '';
      doImport(chosen);
    });
    document.getElementById('btExport')?.addEventListener('click', doExport);
    document.getElementById('btView')?.addEventListener('click', () => {
      window.location.href = 'benchtest';
    });
  }

  async function mount() {
    render();
    await load();
  }

  window.NMS.benchtestCard = { mount };
})();

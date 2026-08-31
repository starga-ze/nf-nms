/* log-viewer.js — Monitor › System Log
 *
 * Thin renderer over GET /api/logs. All the heavy lifting (ANSI stripping, level detection, multi-line
 * folding, noise removal) now happens once at ingest in engined, and filtering + paging happen in
 * postgres — so this file only builds the query string, appends rows, and draws them. No log parsing.
 */
(function () {
  'use strict';

  const PAGE_SIZE = 100;
  const LIVE_INTERVAL_MS = 5000;

  // Severity threshold options: picking WARN shows WARN and worse (the server filters level >= n).
  const LEVEL_FILTERS = [
    { v: '',      label: 'All'   },
    { v: 'trace', label: 'Trace' },
    { v: 'debug', label: 'Debug' },
    { v: 'info',  label: 'Info'  },
    { v: 'warn',  label: 'Warn'  },
    { v: 'error', label: 'Error' },
  ];

  const DAEMONS = ['ipcd', 'engined', 'mgmtd', 'authd', 'probed', 'collectord', 'topologyd', 'apid'];

  // Row badge class per level name returned by the API.
  const LEVEL_CLASS = {
    TRACE: 'trace', DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error', CRITICAL: 'crit',
  };

  const state = {
    daemon: '',
    level: '',
    q: '',
    cursor: null,     // next_cursor from the server; null once exhausted
    maxOid: 0,        // newest oid currently shown — Live prepends anything above it
    loading: false,
    ended: false,
    live: false,
  };

  let liveTimer = null;
  let observer = null;
  let searchDebounce = null;

  const esc = (s) => window.NMS.utils.esc(s);

  // ── Rendering ─────────────────────────────────────────────
  function rowHtml(r) {
    const lv = LEVEL_CLASS[r.level] || 'info';
    return (
      `<tr class="syslog-row">` +
      `<td class="syslog-td-time">${esc(r.ts)}</td>` +
      `<td class="syslog-td-lv"><span class="syslog-badge syslog-lv-${lv}">${esc(r.level)}</span></td>` +
      `<td class="syslog-td-daemon"><span class="syslog-chip">${esc(r.daemon)}</span></td>` +
      `<td class="syslog-td-loc">${r.loc ? esc(r.loc) : '<span class="syslog-muted">—</span>'}</td>` +
      `<td class="syslog-td-msg">${esc(r.message)}</td>` +
      `</tr>`
    );
  }

  function setStatus(text, isErr) {
    const el = document.getElementById('syslogStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('syslog-err', !!isErr);
  }

  function buildUrl(before) {
    const p = new URLSearchParams();
    if (state.daemon) p.set('daemon', state.daemon);
    if (state.level) p.set('level', state.level);
    if (state.q) p.set('q', state.q);
    if (before) p.set('before', before);
    p.set('limit', String(PAGE_SIZE));
    return '/api/logs?' + p.toString();
  }

  // ── Data flow ─────────────────────────────────────────────
  // Reset: clear the list and load the newest page for the current filters.
  async function reload() {
    state.cursor = null;
    state.maxOid = 0;
    state.ended = false;
    const body = document.getElementById('syslogBody');
    if (body) body.innerHTML = '';
    setStatus('Loading…');
    await loadMore(true);
  }

  // Append the next older page (keyset: rows with oid < cursor).
  async function loadMore(isReset) {
    if (state.loading || (state.ended && !isReset)) return;
    state.loading = true;
    try {
      const data = await window.NMS.utils.fetchJSON(buildUrl(isReset ? '' : state.cursor));
      if (!data) return; // 401 redirect handled by fetchJSON
      const rows = data.rows || [];
      const body = document.getElementById('syslogBody');
      if (body && rows.length) {
        body.insertAdjacentHTML('beforeend', rows.map(rowHtml).join(''));
        const firstOid = parseInt(rows[0].oid, 10);
        if (firstOid > state.maxOid) state.maxOid = firstOid;
      }
      state.cursor = data.next_cursor;
      state.ended = !data.next_cursor;
      const total = body ? body.children.length : 0;
      setStatus(state.ended ? `${total} entries · end of log` : `${total} entries — scroll for more`);
    } catch (e) {
      setStatus('Failed to load: ' + String(e), true);
    } finally {
      state.loading = false;
    }
  }

  // Live: pull anything newer than what we show and prepend it, keeping scroll position steady.
  async function pollLive() {
    if (state.loading) return;
    try {
      const data = await window.NMS.utils.fetchJSON(buildUrl(''));
      if (!data) return;
      const fresh = (data.rows || []).filter(r => parseInt(r.oid, 10) > state.maxOid);
      if (!fresh.length) return;
      const body = document.getElementById('syslogBody');
      const scroll = document.getElementById('syslogScroll');
      if (!body) return;
      const atTop = scroll ? scroll.scrollTop < 8 : true;
      const prevH = scroll ? scroll.scrollHeight : 0;
      body.insertAdjacentHTML('afterbegin', fresh.map(rowHtml).join(''));
      state.maxOid = parseInt(fresh[0].oid, 10);
      // If the user had scrolled down, hold their view by offsetting for the inserted height.
      if (scroll && !atTop) scroll.scrollTop += scroll.scrollHeight - prevH;
    } catch (_) { /* transient; next tick retries */ }
  }

  // ── Resizable columns ─────────────────────────────────────
  // Each header (except the flexible Message column) gets a drag grip on its right edge; dragging
  // sets that column's width and persists it. table-layout:fixed means the th widths drive the whole
  // column, so nothing else needs touching.
  // Bump the suffix to discard previously-saved widths (e.g. after changing the CSS defaults).
  const COLW_KEY = 'syslogColW2';

  function saveWidths(ths) {
    const w = {};
    ths.forEach((th, i) => { if (th.style.width) w[i] = parseInt(th.style.width, 10); });
    try { localStorage.setItem(COLW_KEY, JSON.stringify(w)); } catch (_) {}
  }

  function initColumnResize() {
    const table = document.querySelector('.syslog-table');
    if (!table) return;
    const ths = Array.from(table.querySelectorAll('thead th'));

    // Restore any saved widths first.
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(COLW_KEY) || '{}'); } catch (_) {}
    ths.forEach((th, i) => { if (saved[i]) th.style.width = saved[i] + 'px'; });

    // Grips on every column but the last (Message absorbs the slack).
    ths.forEach((th, i) => {
      if (i === ths.length - 1) return;
      const grip = document.createElement('span');
      grip.className = 'syslog-col-grip';
      th.appendChild(grip);

      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = th.offsetWidth;
        grip.classList.add('dragging');
        table.classList.add('resizing');
        grip.setPointerCapture(e.pointerId);

        const onMove = (ev) => {
          const w = Math.max(40, startW + (ev.clientX - startX));
          th.style.width = w + 'px';
        };
        const onUp = () => {
          grip.classList.remove('dragging');
          table.classList.remove('resizing');
          grip.removeEventListener('pointermove', onMove);
          grip.removeEventListener('pointerup', onUp);
          saveWidths(ths);
        };
        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onUp);
      });
    });
  }

  function setLive(on) {
    state.live = on;
    const btn = document.getElementById('syslogLive');
    if (btn) btn.classList.toggle('active', on);
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (on) liveTimer = setInterval(pollLive, LIVE_INTERVAL_MS);
  }

  // ── Toolbar wiring ────────────────────────────────────────
  function mount() {
    const host = document.getElementById('contentBody');
    if (!host) return;

    const levelOpts = LEVEL_FILTERS.map(l =>
      `<option value="${l.v}">${l.v ? l.label + '+' : 'All Levels'}</option>`
    ).join('');

    const daemonOpts = ['<option value="">All Services</option>']
      .concat(DAEMONS.map(d => `<option value="${d}">${d}</option>`)).join('');

    host.innerHTML = `
      <div class="syslog">
        <div class="table-toolbar">
          <div class="table-search-wrap">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input class="table-search-input" id="syslogSearch" placeholder="Search messages…" autocomplete="off">
          </div>
          <div class="syslog-select-wrap">
            <select id="syslogDaemon">${daemonOpts}</select>
          </div>
          <div class="syslog-select-wrap">
            <select id="syslogLevel">${levelOpts}</select>
          </div>
          <button class="syslog-live" id="syslogLive" type="button" title="Stream new entries">
            <span class="syslog-live-dot"></span> Live
          </button>
        </div>
        <div class="card syslog-card">
          <div class="syslog-table-wrap" id="syslogScroll">
            <table class="syslog-table">
              <thead><tr>
                <th class="syslog-th-time">Time</th>
                <th class="syslog-th-lv">Level</th>
                <th class="syslog-th-daemon">Service</th>
                <th class="syslog-th-loc">Location</th>
                <th>Message</th>
              </tr></thead>
              <tbody id="syslogBody"></tbody>
            </table>
            <div id="syslogSentinel" class="syslog-sentinel"></div>
            <div class="syslog-status" id="syslogStatus"></div>
          </div>
        </div>
      </div>`;

    // Native <select> → themed dropdown, matching the rest of the app.
    window.NMS.utils.enhanceSelects(host);

    document.getElementById('syslogSearch').addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      const v = e.target.value.trim();
      searchDebounce = setTimeout(() => { state.q = v; reload(); }, 300);
    });

    document.getElementById('syslogDaemon').addEventListener('change', (e) => {
      state.daemon = e.target.value;
      reload();
    });

    document.getElementById('syslogLevel').addEventListener('change', (e) => {
      state.level = e.target.value;
      reload();
    });

    document.getElementById('syslogLive').addEventListener('click', () => setLive(!state.live));

    // Infinite scroll: fetch the next older page when the sentinel enters the scroll region.
    const scroll = document.getElementById('syslogScroll');
    const sentinel = document.getElementById('syslogSentinel');
    observer = new IntersectionObserver((entries) => {
      if (entries.some(en => en.isIntersecting)) loadMore(false);
    }, { root: scroll, rootMargin: '200px' });
    observer.observe(sentinel);

    // Topbar Refresh reloads the newest page for the current filters.
    if (window.NMS.onRefresh) window.NMS.onRefresh(reload);

    initColumnResize();
    reload();
  }

  document.addEventListener('DOMContentLoaded', mount);
}());

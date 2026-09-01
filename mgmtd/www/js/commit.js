/* commit.js — shared publish flow for every Configuration tab.
 *
 * Review modal with a side-by-side JSON diff, then a progress bar while the reload converges.
 * Extracted from config.js so Inventory and Authentication publish through one implementation:
 * a page supplies what changed, this owns how it is reviewed, sent and awaited.
 *
 *   window.NMS.commitFlow({ payload, before, after, onPublished })
 *     payload     — [{ daemon, domain, values }] sent to /api/settings/commit
 *     before/after — the objects rendered in the diff (structure is the page's business)
 *     onPublished — called once the commit is accepted, before the reload finishes
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  const RELOAD_TIMEOUT_MS = 30000;
  const POLL_MS = 800;

  // ── Staged (uncommitted) changes ─────────────────────────────────────────────
  // Settings tabs switch client-side (see main.js), but staged state is still held in
  // sessionStorage so it survives a full page reload too: scoped to this browser tab, gone when
  // the tab closes. Publishing clears it; the server copy then wins.
  const DRAFT_PREFIX = 'pz.draft.';
  const BASE_KEY = DRAFT_PREFIX + '__base_version';

  window.NMS.draft = {
    get(key, fallback) {
      try {
        const raw = sessionStorage.getItem(DRAFT_PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { sessionStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(value)); } catch (_) { /* quota/private mode */ }
    },
    clear(key) {
      try { sessionStorage.removeItem(DRAFT_PREFIX + key); } catch (_) { /* ignore */ }
    },

    // Staged edits are per browser tab and survive a page reload — which means they also survive
    // the server losing the configuration they were made against. After `pretzel reset` (or a
    // rollback) the version goes backwards and every staged oid refers to objects that no longer
    // exist, so the drafts are dropped rather than offered for publish.
    //
    // Called by each module right after it fetches /api/settings and before it reads its draft,
    // so whichever module loads first does the clearing.
    checkBase(version) {
      if (typeof version !== 'number' || version <= 0) return;
      let base = 0;
      try { base = parseInt(sessionStorage.getItem(BASE_KEY), 10) || 0; } catch (_) { return; }

      if (base && version < base) {
        try {
          Object.keys(sessionStorage)
            .filter(k => k.indexOf(DRAFT_PREFIX) === 0 && k !== BASE_KEY)
            .forEach(k => sessionStorage.removeItem(k));
        } catch (_) { /* ignore */ }
        // Nothing is staged any more, and the flag is what every other page reads.
        window.NMS.setPendingChanges(0);
        staleBase = { from: base, to: version };
      }

      try { sessionStorage.setItem(BASE_KEY, String(version)); } catch (_) { /* ignore */ }
    },
  };

  // Set when checkBase discarded drafts, so the page can say so once it has rendered.
  let staleBase = null;

  // ── Staging registry ─────────────────────────────────────────────────────────
  // Every tab's module is loaded on the settings page and registers a provider describing its
  // own domain. The registry then owns the cross-domain view: whether anything is dirty (drives
  // the Publish button) and what a single publish sends — regardless of which tab is showing.
  //
  //   provider = {
  //     key,                         sessionStorage draft key
  //     dirty:   () => boolean,      staged differs from the committed copy
  //     payload: () => [changes],    /api/settings/commit entries for this domain
  //     before:  () => object,       committed view, for the diff
  //     after:   () => object,       staged view, for the diff
  //     onPublished: () => void,     clear the draft, adopt staged as committed
  //     problems?: () => [string],   optional: references that would publish broken
  //   }
  //
  // Only this page loads the registry, but the Publish button is on every page and its enabled
  // state is mirrored through sessionStorage by NMS.setPendingChanges (js/main.js) — so refresh()
  // below is what keeps that flag true wherever the operator walks next.
  const providers = [];

  const anyDirty = () => providers.some(p => p.dirty());

  function refresh() {
    window.NMS.setPendingChanges(anyDirty() ? 1 : 0);
  }

  window.NMS.staging = {
    // No refresh() here: providers register before their fetch lands, so at this point every one
    // of them reports clean. Publishing that answer would clear the pending flag — and with it
    // the button state the other pages read — for as long as the load takes. Each module calls
    // refresh() itself once it has data.
    register(provider) { providers.push(provider); return provider; },
    refresh,
    anyDirty,

    publish() {
      const dirty = providers.filter(p => p.dirty());
      if (!dirty.length) return;
      const before = {}, after = {}, payload = [];
      let problems = [];
      dirty.forEach(p => {
        Object.assign(before, p.before());
        Object.assign(after, p.after());
        payload.push.apply(payload, p.payload());
        if (typeof p.problems === 'function') problems = problems.concat(p.problems());
      });
      window.NMS.commitFlow({
        payload, before, after, problems,
        onPublished: () => { dirty.forEach(p => p.onPublished()); refresh(); },
      });
    },
  };

  window.NMS.onCommit(() => window.NMS.staging.publish());

  // Publish pressed on a page that has no registry (Insight, Monitor, …) navigates here with a
  // handoff flag; open the same flow on arrival so the click means one thing everywhere.
  // Providers register at script load but only learn their dirty state once each module's fetch
  // lands, so wait for that rather than firing into a registry that still looks clean.
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.NMS.pending.takeHandoff()) return;
    const began = Date.now();
    (function waitForData() {
      if (anyDirty()) { window.NMS.staging.publish(); return; }
      if (Date.now() - began < 5000) setTimeout(waitForData, 100);
    })();
  });

  // Report a discard once, after the tab has painted — an alert during module load would fire
  // before the operator can see what changed.
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (!staleBase) return;
      const { from, to } = staleBase;
      staleBase = null;
      alert(`Staged changes were discarded.\n\nThey were made against configuration version ${from}, `
        + `but the appliance is now on version ${to} — the configuration they referred to no longer `
        + `exists (a reset or a rollback). Nothing was published.`);
    }, 0);
  });

  // ── Running-config viewer ────────────────────────────────────────────────────
  // The committed document in full, as the daemons see it — the counterpart to Publish's diff,
  // which only shows what is about to change. Read-only, so it reuses the modal without a foot
  // action beyond Close.
  window.NMS.viewRunningConfig = async function () {
    const ov = ensureModal();
    ov.querySelector('#cmTitle').textContent = 'Running configuration';
    ov.querySelector('#cmBody').innerHTML = `<div class="cm-loading">Loading…</div>`;
    ov.querySelector('#cmFoot').innerHTML = `<button class="btn-sm" id="cmDone">Close</button>`;
    ov.querySelector('#cmDone').onclick = closeModal;
    ov.classList.add('open');

    let doc;
    try {
      const r = await fetch('/api/settings/running-config',
                            { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      doc = await r.json();
    } catch (e) {
      ov.querySelector('#cmBody').innerHTML = `<div class="cm-loading">Failed to load: ${esc(e.message)}</div>`;
      return;
    }

    const pretty = JSON.stringify(doc.config, null, 2);
    ov.querySelector('#cmTitle').textContent = `Running configuration — version ${esc(doc.version)}`;
    ov.querySelector('#cmBody').innerHTML = `
      <div class="rc-meta">Committed ${esc(doc.committed_at || '')}${
        anyDirty() ? ' · <b class="rc-dirty">staged changes are not included</b>' : ''}</div>
      <pre class="rc-doc">${esc(pretty)}</pre>`;
    ov.querySelector('#cmFoot').innerHTML = `
      <button class="btn-sm" id="cmCopy">Copy JSON</button>
      <span style="flex:1"></span>
      <button class="btn-sm" id="cmDone">Close</button>`;
    ov.querySelector('#cmDone').onclick = closeModal;
    ov.querySelector('#cmCopy').onclick = (e) => {
      navigator.clipboard?.writeText(pretty)
        .then(() => { e.target.textContent = 'Copied'; })
        .catch(() => { e.target.textContent = 'Copy failed'; });
    };
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Longest-common-subsequence diff, rendered as aligned left/right rows.
  function splitDiff(beforeStr, afterStr) {
    const a = beforeStr.split('\n'), b = afterStr.split('\n');
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const rows = [];
    let i = 0, j = 0, remq = [], addq = [];
    const flush = () => {
      for (let k = 0; k < Math.max(remq.length, addq.length); k++)
        rows.push({ l: remq[k] ?? null, r: addq[k] ?? null, ch: true });
      remq = []; addq = [];
    };
    while (i < n && j < m) {
      if (a[i] === b[j]) { flush(); rows.push({ l: a[i], r: b[j], ch: false }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) remq.push(a[i++]);
      else addq.push(b[j++]);
    }
    while (i < n) remq.push(a[i++]);
    while (j < m) addq.push(b[j++]);
    flush();
    return rows;
  }

  function diffHtml(before, after) {
    const rows = splitDiff(JSON.stringify(before, null, 2), JSON.stringify(after, null, 2));
    const cell = (line, side, ch) => line == null
      ? `<div class="sd-line sd-empty"></div>`
      : `<div class="sd-line ${ch ? (side === 'l' ? 'sd-del' : 'sd-add') : ''}">${esc(line)}</div>`;
    return `
      <div class="cm-split">
        <div class="cm-split-pane"><div class="cm-split-head">Before</div>${rows.map(r => cell(r.l, 'l', r.ch)).join('')}</div>
        <div class="cm-split-pane"><div class="cm-split-head">After</div>${rows.map(r => cell(r.r, 'r', r.ch)).join('')}</div>
      </div>`;
  }

  function ensureModal() {
    let ov = document.getElementById('cmOverlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'cmOverlay';
    ov.className = 'cm-overlay';
    ov.innerHTML = `
      <div class="cm-dialog" role="dialog" aria-modal="true">
        <div class="cm-head"><span class="cm-title" id="cmTitle">Review changes</span><button class="cm-close" id="cmClose" aria-label="Close">&times;</button></div>
        <div class="cm-body" id="cmBody"></div>
        <div class="cm-foot" id="cmFoot"></div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeModal(); });
    ov.querySelector('#cmClose').addEventListener('click', closeModal);
    return ov;
  }
  function closeModal() { document.getElementById('cmOverlay')?.classList.remove('open'); }

  // The centre-screen modal is shared infrastructure: the publish diff, the running-config
  // viewer and the connector endpoint test all render into the same element rather than each
  // building their own overlay. It stacks above the slide-over (z-index 600 vs 501), so an
  // editor can raise it without being dismissed.
  window.NMS.modal = {
    open(title, bodyHtml, footHtml) {
      const ov = ensureModal();
      ov.querySelector('#cmTitle').textContent = title;
      ov.querySelector('#cmBody').innerHTML = bodyHtml;
      ov.querySelector('#cmFoot').innerHTML = footHtml || `<button class="btn-sm" id="cmDone">Close</button>`;
      ov.querySelector('#cmDone')?.addEventListener('click', closeModal);
      ov.classList.add('open');
      return ov;
    },
    close: closeModal,
  };

  // ── Confirm ─────────────────────────────────────────────────────────────────────────────────
  //
  // The console's own dialog, in place of window.confirm. Not cosmetic: the native one is drawn by
  // the browser in the operating system's language and typography, so a destructive step — the one
  // moment the page most needs to look like it belongs to this appliance — was the one that did
  // not. It also cannot be styled, cannot carry a danger colour on the confirming button, and its
  // wording ("OK") says nothing about what is about to happen.
  //
  // Built on NMS.modal so it stacks above a slide-over the same way the review diff does, and so a
  // page that has an editor open can ask without being dismissed.
  //
  // Promise-based rather than callback: the callers are `async` already, and `if (!await ...) return;`
  // reads the way the `if (!confirm(...)) return;` it replaces did.
  window.NMS.confirm = function (opts) {
    const o = typeof opts === 'string' ? { message: opts } : (opts || {});
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        closeModal();
        resolve(v);
      };

      const body = `<p class="cf-msg">${esc(o.message || 'Are you sure?')}</p>`
        + (o.detail ? `<p class="cf-detail">${esc(o.detail)}</p>` : '');
      const ov = window.NMS.modal.open(
        o.title || 'Confirm', body,
        `<button class="btn-sm" id="cfNo">${esc(o.cancelLabel || 'Cancel')}</button>
         <button class="btn-primary btn-sm${o.danger === false ? '' : ' is-danger'}" id="cfYes">${
           esc(o.confirmLabel || 'Remove')}</button>`);

      ov.querySelector('#cfNo').addEventListener('click', () => done(false));
      ov.querySelector('#cfYes').addEventListener('click', () => done(true));
      ov.querySelector('#cfYes').focus();

      // Dismissing by any other route is a no. The overlay's own backdrop click and the head's
      // close cross both run closeModal without telling us, so the promise is settled here rather
      // than left pending for the life of the page.
      ov.addEventListener('click', (e) => { if (e.target === ov) done(false); }, { once: true });
      ov.querySelector('#cmClose')?.addEventListener('click', () => done(false), { once: true });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey, true); done(false); }
      }, true);
    });
  };

  // ── Device-test panel (shared by the API Key, Endpoint, Connector and SASE tests) ───────────
  //
  // One renderer for all four so a test looks the same wherever it is run from, and so the running
  // state is not re-invented per page.
  //
  // On what is animated: the appliance performs the device exchange and answers the held ticket ONCE,
  // with every step's outcome at the end — while it is in flight the poll returns only "pending". So
  // there is no per-step progress to show, and pretending otherwise (ticking steps green on a timer)
  // would report success the appliance never reported. Instead every step spins together, meaning
  // "this is what is being attempted", and the one truly live figure — how long the call has been
  // outstanding — is counted up beside it. That matters here: a SASE read routinely takes ~8s and a
  // dead device runs to the timeout, and the operator can see the difference as it happens.
  // (`esc` is the module-level helper declared further down this file.)
  window.NMS.testPanel = {
    // st: undefined/null = not run, 'running' = in flight, else {ok, detail} from the appliance.
    step(label, st) {
      const mark = st === 'running' ? '<span class="ts-spin"></span>'
                 : !st ? '<span class="ts-idle">·</span>'
                 : st.ok ? '<span class="ts-ok">✓</span>'
                 : '<span class="ts-fail">✗</span>';
      return `<div class="ts-row"><span class="ts-mark">${mark}</span>
                <span class="ts-label">${esc(label)}</span>
                <span class="ts-detail">${esc((st && st !== 'running' && st.detail) || '')}</span></div>`;
    },

    // The panel body to show while the test is in flight. `note` is optional context under the steps.
    // Marked with a data attribute rather than an id: the connector page renders this inline in the
    // editor, so two panels can exist at once and an id would collide.
    runningBody(labels, note) {
      return `<div class="test-panel running">
          <div class="ts-head"><span class="ts-spin"></span>
            <span class="ts-head-label">Running</span>
            <span class="ts-elapsed" data-ts-elapsed>0.0s</span></div>
          ${labels.map((l) => this.step(l, 'running')).join('')}
          ${note ? `<div class="ts-note">${esc(note)}</div>` : ''}
        </div>`;
    },

    // Drive the elapsed counter inside `root` (default: the whole document). Returns a handle whose
    // stop() ends the counter and reports the seconds elapsed. The timer also self-cancels once its
    // element leaves the DOM, so a caller that throws before stopping cannot leave one running.
    attachElapsed(root) {
      const began = Date.now();
      const scope = root || document;
      // Per-handle, not shared: the connector page runs its panel inline, so a second test started
      // elsewhere must not freeze the first one's counter.
      let timer = setInterval(() => {
        const el = scope.querySelector('[data-ts-elapsed]');
        if (!el) { clearInterval(timer); timer = null; return; }
        el.textContent = ((Date.now() - began) / 1000).toFixed(1) + 's';
      }, 100);
      return {
        stop() {
          if (timer) { clearInterval(timer); timer = null; }
          return (Date.now() - began) / 1000;
        },
      };
    },

    // Open the modal in the running state and start the counter (the modal-based tests). The footer
    // stays the default Close: the appliance owns the in-flight exchange and there is no way to call
    // it back, so a button labelled Cancel would promise something this cannot do.
    start(title, labels, note) {
      window.NMS.modal.open(title, this.runningBody(labels, note));
      return this.attachElapsed(document);
    },
  };

  function progView() {
    return `
      <div class="cm-prog">
        <div class="cm-prog-head"><span id="cmProgLabel">Publishing</span><span id="cmProgPct">0%</span></div>
        <div class="cm-prog-track"><div class="cm-prog-fill" id="cmProgFill"></div></div>
      </div>`;
  }
  function setProg(pct, label, kind) {
    const f = document.getElementById('cmProgFill'), p = document.getElementById('cmProgPct'), l = document.getElementById('cmProgLabel');
    if (f) { f.style.width = Math.round(pct) + '%'; f.className = 'cm-prog-fill' + (kind ? ' ' + kind : ''); }
    if (p) p.textContent = Math.round(pct) + '%';
    if (l && label) l.textContent = label;
  }

  async function pollProgress(startTs) {
    if (!document.getElementById('cmProgFill')) return;
    let st;
    try {
      st = await fetch('/api/settings/reload-status', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(r => r.json());
    } catch (_) { st = null; }

    const elapsed = Date.now() - startTs;
    const foot = document.getElementById('cmFoot');
    if (st && st.status === 'complete') {
      setProg(100, 'Published', 'ok');
      foot.innerHTML = `<button class="btn-primary btn-sm" id="cmDone">Done</button>`;
      document.getElementById('cmDone').onclick = closeModal;
      return;
    }
    // The configuration was written but the fleet did not converge onto it — a daemon failed to come
    // back. Distinct from a timeout, which says only that it is taking longer than we wait: this is
    // engined reporting that it is not coming. Nothing here can be retried by publishing again, so
    // the message points at the logs rather than offering a button that would not help.
    if (st && st.status === 'failed') {
      setProg(100, 'Applied, but the daemons did not come back', 'error');
      document.getElementById('cmBody')?.insertAdjacentHTML('beforeend', `<div class="cm-warn">
          <div class="cm-warn-h">Reload did not converge</div>
          <ul><li>The new configuration was committed, but at least one daemon failed to restart
            onto it. The appliance is running a mix of old and new configuration.</li></ul>
          <div class="cm-warn-note">Check <a href="monitor?tab=system-log">Monitor › System Log</a>
            for the daemon that did not report ready. Publishing again will not fix this.</div>
        </div>`);
      foot.innerHTML = `<button class="btn-sm" id="cmDone">Close</button>`;
      document.getElementById('cmDone').onclick = closeModal;
      return;
    }
    if (elapsed >= RELOAD_TIMEOUT_MS) {
      setProg(100, 'Timed out — committed, still applying', 'warn');
      foot.innerHTML = `<button class="btn-sm" id="cmDone">Close</button>`;
      document.getElementById('cmDone').onclick = closeModal;
      return;
    }
    const cur = parseInt(document.getElementById('cmProgFill').style.width) || 30;
    setProg(cur + (90 - cur) * 0.25, 'Applying');
    setTimeout(() => pollProgress(startTs), POLL_MS);
  }

  async function doCommit(opts) {
    const body = document.getElementById('cmBody'), foot = document.getElementById('cmFoot');
    foot.innerHTML = `<button class="btn-sm" id="cmDone" disabled>Working…</button>`;
    body.innerHTML = progView();
    setProg(10, 'Publishing');

    try {
      const r = await fetch('/api/settings/commit', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: opts.payload }),
      });
      const res = await r.json().catch(() => ({}));

      // `failed` has to be read even on a 2xx, and the body has to be read even on a non-2xx. A
      // partially accepted batch used to answer 200 with the rejections buried in `results`, and
      // this only looked at `applied` — so onPublished below cleared the drafts for changes the
      // server never took. That was the one way a published edit could vanish without a word.
      const rejected = (res.results || []).filter(x => x && x.ok === false);
      if (!r.ok || (res.failed | 0) > 0 || (res.applied | 0) <= 0) {
        throw Object.assign(new Error(res.error || 'HTTP ' + r.status), { rejected });
      }
    } catch (e) {
      setProg(100, 'Not published', 'error');
      body.insertAdjacentHTML('beforeend', rejectionBlock(e.message, e.rejected));
      foot.innerHTML = `<button class="btn-sm" id="cmDone">Close</button>`;
      document.getElementById('cmDone').onclick = closeModal;
      return;
    }

    if (typeof opts.onPublished === 'function') opts.onPublished();
    setProg(30, 'Applying');
    pollProgress(Date.now());
  }

  // Why nothing was published. The server answers per change, and those reasons are the useful part
  // — "connector collects an endpoint that does not exist" names what to go and fix, where a bare
  // status code sends the operator to the logs. The closing line matters as much: the drafts are
  // still staged, so this is a retry rather than lost work.
  function rejectionBlock(message, rejected) {
    const items = (rejected && rejected.length)
      ? rejected.map(x => `<li><b>${esc(x.daemon)}.${esc(x.domain)}</b> — ${esc(x.error || 'rejected')}</li>`).join('')
      : `<li>${esc(message)}</li>`;
    return `<div class="cm-warn">
        <div class="cm-warn-h">Nothing was published</div>
        <ul>${items}</ul>
        <div class="cm-warn-note">The batch is applied whole or not at all, so no part of it was
          committed. Your staged changes are still here — fix the above and publish again.</div>
      </div>`;
  }

  // Dangling references are worth stopping on: they publish quietly and only show up later as a
  // red "missing" in a table. The commonest cause is staged edits outliving the configuration
  // they were made against — a server reset or rollback leaves drafts pointing at objects that
  // no longer exist, since staging is per browser tab and survives both.
  function problemBlock(problems) {
    if (!problems || !problems.length) return '';
    return `<div class="cm-warn">
        <div class="cm-warn-h">${problems.length} broken reference${problems.length > 1 ? 's' : ''}</div>
        <ul>${problems.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="cm-warn-note">Publishing anyway is allowed, but these will show as
          <b>missing</b> until the target exists. If the staged edits predate a reset, cancel and
          recreate what they point at — or close this browser tab, which discards them.</div>
      </div>`;
  }

  window.NMS.commitFlow = function (opts) {
    if (JSON.stringify(opts.before) === JSON.stringify(opts.after)) return;
    const ov = ensureModal();
    ov.querySelector('#cmTitle').textContent = 'Review changes';
    ov.querySelector('#cmBody').innerHTML = problemBlock(opts.problems) + diffHtml(opts.before, opts.after);
    ov.querySelector('#cmFoot').innerHTML = `
      <button class="btn-sm" id="cmCancel">Cancel</button>
      <button class="btn-primary btn-sm" id="cmPublish">Publish</button>`;
    ov.querySelector('#cmCancel').onclick = closeModal;
    ov.querySelector('#cmPublish').onclick = () => doCommit(opts);
    ov.classList.add('open');
  };
})();

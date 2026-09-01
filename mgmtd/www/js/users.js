/* users.js — Configuration ▸ User Management.
 *
 * The local accounts: who may sign in, and who may manage accounts.
 *
 * Two stores, one Publish — the same split as AI Provider and API Credential:
 *
 *   running_config   the declaration. { oid, username, role } per account, staged like any other
 *                    object, versioned, and rendered in the review diff.
 *   local_users      what proves an account. The password hash and salt, keyed by the same oid.
 *                    It cannot go in running_config: that document is append-versioned and written
 *                    out by Save-to-file, so a hash there would be permanent and readable by every
 *                    reviewer — and changing a password would mint a configuration version.
 *
 * A typed password is staged browser-local and never enters the commit payload. Publish sends the
 * declaration to the commit and the passwords to POST /api/user/credential, where mgmtd hashes them.
 *
 * Two roles. An admin may add, remove and set passwords for accounts; a user may not. The console
 * hides those controls for a user, and mgmtd refuses the requests anyway — the hiding is a
 * courtesy and the refusal is the rule.
 *
 * The username and the role of an existing account are fixed here. A username is the handle someone
 * signs in with and what anything they own is remembered by; renaming it would not be an edit but a
 * different person.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  const TAB = 'user';
  const DRAFT_KEY = 'user';
  const SECRET_KEY = 'user-password';
  const SCOPE = 'pretzel';
  const DOMAIN = 'user';

  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;
  const { esc } = window.NMS.utils;

  const MIN_PASSWORD = 8;

  // Admin may manage accounts; user may not. That is the whole of the difference, it is stated in
  // the header comment above, and a console that repeated it inside the picker would be explaining
  // a two-item list.
  const ROLES = [{ id: 'admin', label: 'Admin' }, { id: 'user', label: 'User' }];
  const roleOf = (id) => ROLES.find(r => r.id === id) || ROLES[1];

  let deployed = [];
  let state = { list: [] };
  let creds = null;      // oid -> { username, stored, must_change, updated_at }
  let self = '';         // the signed-in username
  let myRole = '';       // and their role — 'admin' unlocks the controls below
  let editIdx = null;
  let draft = null;
  let pwDraft = '';
  let pwConfirm = '';
  let saveNote = '';
  let banner = null;

  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ── The staged passwords ─────────────────────────────────────────────────────
  // `null` means "remove this account on Publish", which is a different instruction from "no
  // change" and has to survive as one — an empty string cannot say both.
  const pending = {
    all: () => window.NMS.draft.get(SECRET_KEY, {}),
    has: (oid) => Object.prototype.hasOwnProperty.call(pending.all(), oid),
    get: (oid) => pending.all()[oid],
    set(oid, value) {
      const s = pending.all(); s[oid] = value;
      window.NMS.draft.set(SECRET_KEY, s); window.NMS.staging.refresh();
    },
    drop(oid) {
      const s = pending.all(); delete s[oid];
      window.NMS.draft.set(SECRET_KEY, s); window.NMS.staging.refresh();
    },
    clear() { window.NMS.draft.set(SECRET_KEY, {}); },
    any: () => Object.keys(pending.all()).length > 0,
  };

  const credOf     = (oid) => (creds && creds[oid]) || null;
  const pwStored   = (oid) => !!(credOf(oid) && credOf(oid).stored);
  // What the appliance will hold after Publish — the staged change laid over what it holds now.
  const pwEffective = (oid) => (pending.has(oid) ? pending.get(oid) !== null : pwStored(oid));
  const isSelf = (e) => !!e && !!self && e.username === self;
  const iAmAdmin = () => myRole === 'admin';

  function normalizeEntry(u) {
    const src = (u && typeof u === 'object') ? u : {};
    return {
      oid: String(src.oid || ''),
      username: String(src.username || ''),
      role: ROLES.some(r => r.id === src.role) ? src.role : 'user',
      description: String(src.description || ''),
    };
  }

  const normalize = (scope) => {
    const src = (scope && typeof scope === 'object') ? scope : {};
    const raw = Array.isArray(src.list) ? src.list : [];
    return raw.filter(u => u && u.oid && u.username).map(normalizeEntry);
  };

  // ── Staging ──────────────────────────────────────────────────────────────────
  const stage = () => { window.NMS.draft.set(DRAFT_KEY, state.list); window.NMS.staging.refresh(); };

  async function load() {
    try {
      const r = await fetch('/api/settings', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (r.status === 401) { location.href = '/'; return; }
      const d = await r.json();
      window.NMS.draft.checkBase(d.version);
      deployed = normalize(((d.scopes || {})[SCOPE] || {})[DOMAIN]);
    } catch (_) { deployed = []; }
    const staged = window.NMS.draft.get(DRAFT_KEY, null);
    state.list = staged ? staged.map(normalizeEntry) : clone(deployed);
    window.NMS.staging.refresh();
  }

  async function loadCreds() {
    try {
      const r = await fetch('/api/user/credentials', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      creds = d.users || {};
      self = d.self || '';
      myRole = d.role || '';
    } catch (_) { creds = null; }
  }

  const commitPayload = () => [{ scope: SCOPE, domain: DOMAIN, values: { list: state.list } }];

  // The staged passwords as words, never as values.
  //
  // Not cosmetic: commitFlow returns early when `before` and `after` serialise the same, so a
  // Publish that changed ONLY a password would enable the button, open nothing, and store nothing.
  // Setting one is also a change the review should show.
  const pwStateView = (staged) => {
    const out = {};
    state.list.forEach(u => {
      const had = pwStored(u.oid);
      if (!staged || !pending.has(u.oid)) { out[u.username] = had ? 'set' : 'not set'; return; }
      const v = pending.get(u.oid);
      out[u.username] = v === null ? 'account removed' : (had ? 'set (replaced)' : 'set');
    });
    return out;
  };

  window.NMS.staging.register({
    key: DRAFT_KEY,
    // A password-only change is still a change. Without this the Publish button stays dark and the
    // password the operator entered sits in the browser until something else happens to be dirty.
    dirty: () => JSON.stringify(state.list) !== JSON.stringify(deployed) || pending.any(),
    payload: commitPayload,
    before: () => ({ users: deployed, passwords: pwStateView(false) }),
    after: () => ({ users: state.list, passwords: pwStateView(true) }),
    onPublished() {
      deployed = clone(state.list);
      window.NMS.draft.clear(DRAFT_KEY);
      applyPending();
    },
    problems() {
      const out = [];
      state.list.forEach(u => {
        if (creds && !pwEffective(u.oid))
          out.push(`Account "${u.username}" has no password — nobody can sign in as it.`);
      });
      return out;
    },
  });

  // ── Password store ───────────────────────────────────────────────────────────
  // Sent on Publish, never before, then the appliance is re-read so what the page reports is the
  // stored state rather than this function's optimism.
  async function applyPending() {
    const staged = pending.all();
    const oids = Object.keys(staged);
    if (!oids.length) return;

    const failed = [];
    for (const oid of oids) {
      const value = staged[oid];
      // The username travels with it: engined keys local_users on the name, and a removal has to
      // name the row it deletes even though the declaration it matched is already gone from the
      // staged list.
      const known = deployed.find(u => u.oid === oid) || state.list.find(u => u.oid === oid);
      const username = (known && known.username) || (credOf(oid) || {}).username || '';
      const body = value === null
        ? { oid, username, remove: true }
        : { oid, username, password: value };
      try {
        const r = await fetch('/api/user/credential', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || ('HTTP ' + r.status));
        }
      } catch (e) { failed.push(`${username || oid}: ${e.message || e}`); }
    }

    // Cleared whether or not every request landed. A staged password that failed is not worth
    // retrying silently on the next unrelated Publish — the operator is told, and re-enters it if
    // they mean to.
    pending.clear();
    pwDraft = ''; pwConfirm = '';
    await loadCreds();
    banner = failed.length
      ? { bad: true, text: `Could not apply ${failed.length} account change: ${failed.join('; ')}` }
      : null;
    window.NMS.staging.refresh();
    render();
  }

  // ── Table ────────────────────────────────────────────────────────────────────
  // No password column. It only ever said "Set": the console refuses to create an account without
  // one, and the states that are not "Set" are either transient (staged, until the next Publish)
  // or a failure the banner is already shouting about. A column that reads the same on every row
  // is a column nobody looks at, and it was crowding the two that differ.
  //
  // What is left of it is a mark beside the name, and only when there is something to say.
  function nameCell(u) {
    const staged = pending.has(u.oid);
    const marks = [];
    if (isSelf(u)) marks.push('<span class="usr-tag">you</span>');
    if (staged && pending.get(u.oid) === null) marks.push('<span class="usr-tag is-drop">removing</span>');
    else if (staged) marks.push('<span class="usr-tag is-staged">password staged</span>');
    else if (creds !== null && !pwStored(u.oid)) marks.push('<span class="usr-tag is-drop">no password</span>');
    return `<div class="cell-name">${esc(u.username)}${marks.join('')}${
      u.description ? `<span class="ai-fam">${esc(u.description)}</span>` : ''}</div>`;
  }

  const table = window.NMS.table.create({
    id: 'cfg.users',
    tableClass: 'cfg-table-user',
    searchPlaceholder: 'Search accounts…',
    empty: '<div class="cfg-empty">No account is declared.</div>',
    onRows: (tbody) => {
      tbody.querySelectorAll('[data-edit]').forEach(b =>
        b.addEventListener('click', () => openEditor(+b.dataset.edit)));
      tbody.querySelectorAll('[data-del]').forEach(b =>
        b.addEventListener('click', () => removeEntry(+b.dataset.del)));
    },
    columns: [
      { key: 'username', label: 'Username', cls: 'col-name', filter: 'enum',
        text: (u) => u.username,
        searchText: (u) => `${u.username} ${u.description}`,
        cell: nameCell },
      { key: 'role', label: 'Role', cls: 'col-role', filter: 'enum',
        text: (u) => roleOf(u.role).label,
        cell: (u) => `<span class="usr-role is-${esc(u.role)}">${esc(roleOf(u.role).label)}</span>` },
      { key: 'act', label: '', cls: 'col-act', sort: false,
        cell: (u, i) => {
          if (!iAmAdmin()) return '';
          const lastAdmin = u.role === 'admin'
            && state.list.filter(x => x.role === 'admin').length < 2;
          const why = isSelf(u) ? 'You cannot remove the account you are signed in as'
                    : state.list.length < 2 ? 'The last account cannot be removed'
                    : lastAdmin ? 'The last admin cannot be removed'
                    : 'Remove';
          const blocked = isSelf(u) || state.list.length < 2 || lastAdmin;
          return `
          <button class="icon-btn" data-edit="${i}" title="Set password">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          </button>
          <button class="icon-btn danger" data-del="${i}" title="${esc(why)}"${blocked ? ' disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>`;
        } },
    ],
  });

  const paintTable = () => {
    const host = document.getElementById('usrTable');
    if (host) table.mount(host, state.list);
    const meta = document.getElementById('usrMeta');
    if (meta) {
      const n = state.list.length;
      const p = Object.keys(pending.all()).length;
      meta.textContent = `${n} account${n === 1 ? '' : 's'}`
        + (p ? ` · ${p} change${p > 1 ? 's' : ''} pending publish` : '');
    }
  };

  async function removeEntry(idx) {
    const u = state.list[idx];
    if (!u || !iAmAdmin() || isSelf(u) || state.list.length < 2) return;
    if (u.role === 'admin' && state.list.filter(x => x.role === 'admin').length < 2) return;

    const ok = await window.NMS.confirm({
      title: 'Remove account',
      message: `Remove the account "${u.username}"?`,
      detail: 'Its password is deleted on Publish. Nothing happens until then.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    // Staged, not applied — and the password store is told to delete the row, because removing the
    // declaration alone would leave local_users holding an account nothing declares.
    pending.set(u.oid, null);
    state.list.splice(idx, 1);
    stage();
    paintTable();
  }

  // ── Editor ───────────────────────────────────────────────────────────────────
  function editorForm() {
    const isNew = editIdx == null;
    const staged = pending.has(draft.oid) && pending.get(draft.oid) !== null;

    return `
      <div class="field-row"><label>Username</label>
        ${isNew
          ? `<input type="text" data-f="username" spellcheck="false" autocomplete="off"
                    value="${esc(draft.username)}">`
          : `<div class="ep-fixed">${esc(draft.username)}</div>`}
      </div>

      <div class="field-row"><label>Role</label>
        <select data-f="role">
          ${ROLES.map(r => `<option value="${esc(r.id)}"${
            r.id === draft.role ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>
      </div>

      <div class="field-row"><label>Description</label>
        <input type="text" data-f="description" value="${esc(draft.description)}"></div>

      ${staged ? `
        <div class="field-row"><label>Password</label>
          <div class="gr-key-staged">
            <span class="ai-key is-staged"><i></i>Staged for publish</span>
            <button class="btn-sm" id="usrPwUndo" type="button">Undo</button>
          </div>
        </div>` : `
        <div class="field-row"><label>Password</label>
          <input type="password" data-pw="password" autocomplete="new-password" spellcheck="false"
                 value="${esc(pwDraft)}"></div>
        <div class="field-row"><label>Password Confirm</label>
          <input type="password" data-pw="confirm" autocomplete="new-password" spellcheck="false"
                 value="${esc(pwConfirm)}"></div>`}`;
  }

  function paintEditor() {
    const body = document.getElementById('usrBody');
    if (!body || !draft) return;
    body.innerHTML = editorForm();
    window.NMS.utils.enhanceSelects(body);
    const note = document.getElementById('usrSaveNote');
    if (note) note.textContent = saveNote;
    wireEditor();
  }

  function openEditor(idx) {
    editIdx = idx;
    draft = idx == null
      ? normalizeEntry({ oid: window.NMS.utils.newUuid(), role: 'user' })
      : clone(state.list[idx]);
    pwDraft = ''; pwConfirm = ''; saveNote = '';

    document.getElementById('usrTitle').textContent = idx == null ? 'Add Account' : 'Edit Account';
    document.getElementById('usrFoot').innerHTML = `
      <span class="ed-foot-note" id="usrSaveNote"></span>
      <button class="btn-sm" id="usrCancel" type="button">Cancel</button>
      <button class="btn-primary btn-sm" id="usrSave" type="button">Save</button>`;
    paintEditor();

    document.getElementById('usrCancel').onclick = closeEditor;
    document.getElementById('usrSave').onclick = saveEditor;
    document.getElementById('usrOverlay').classList.add('open');
    document.getElementById('usrPanel').classList.add('open');
  }

  const closeEditor = () => {
    editIdx = null; draft = null; pwDraft = ''; pwConfirm = ''; saveNote = '';
    document.getElementById('usrOverlay').classList.remove('open');
    document.getElementById('usrPanel').classList.remove('open');
  };

  function saveEditor() {
    const body = document.getElementById('usrBody');
    const bad = (note, field) => {
      saveNote = note;
      paintEditor();
      window.NMS.utils.markInvalid(document.getElementById('usrBody'), field);
    };
    window.NMS.utils.clearInvalid(body);

    const name = draft.username.trim();
    if (editIdx == null) {
      if (!name) return bad('Enter a username.', 'username');
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name))
        return bad('Letters, digits, dot, dash and underscore only.', 'username');
      // Case-insensitively: two accounts an operator cannot tell apart are two accounts one of
      // them signs in to by mistake. mgmtd refuses it too — this is so they hear about it here.
      if (state.list.some((u, i) => i !== editIdx && u.username.toLowerCase() === name.toLowerCase()))
        return bad('That username is already taken.', 'username');
      draft.username = name;
    }

    // The last admin cannot be demoted, for the same reason it cannot be removed.
    if (editIdx != null && draft.role !== 'admin'
        && state.list[editIdx].role === 'admin'
        && state.list.filter(x => x.role === 'admin').length < 2)
      return bad('This is the last admin — another account must be an admin first.', 'role');

    const typed = pwDraft.trim();
    if (typed) {
      if (typed.length < MIN_PASSWORD)
        return bad(`The password must be at least ${MIN_PASSWORD} characters.`, '[data-pw="password"]');
      if (typed !== pwConfirm.trim())
        return bad('The two passwords do not match.', '[data-pw="confirm"]');
    } else if (editIdx == null && !pending.has(draft.oid)) {
      // A new account with no password would be published and then be unable to sign in, and the
      // operator is standing in the one panel where they can fix it.
      return bad('Enter a password.', '[data-pw="password"]');
    }

    // The password leaves the panel the same way the declaration does — staged, not applied. It
    // goes to its own store rather than into the entry, so it cannot reach the commit payload even
    // by accident, but it is committed to by the same button.
    if (typed) pending.set(draft.oid, typed);

    const out = normalizeEntry(draft);
    if (editIdx == null) state.list.push(out);
    else state.list[editIdx] = out;

    stage();
    closeEditor();
    paintTable();
  }

  function wireEditor() {
    const body = document.getElementById('usrBody');
    body.querySelectorAll('[data-f]').forEach(inp => {
      if (inp.tagName === 'SELECT') {
        inp.addEventListener('change', () => { draft[inp.dataset.f] = inp.value; saveNote = ''; });
        return;
      }
      // No repaint on input: a repaint per keystroke would take the caret with it.
      inp.addEventListener('input', () => { draft[inp.dataset.f] = inp.value; saveNote = ''; });
    });
    body.querySelector('[data-pw="password"]')?.addEventListener('input', (e) => { pwDraft = e.target.value; });
    body.querySelector('[data-pw="confirm"]')?.addEventListener('input', (e) => { pwConfirm = e.target.value; });
    document.getElementById('usrPwUndo')?.addEventListener('click', () => {
      pending.drop(draft.oid);
      pwDraft = ''; pwConfirm = '';
      paintEditor();
      paintTable();
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== TAB) return;

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">User Management</span>
            <span class="cfg-h-sub" id="usrMeta"></span>
          </div>
          ${iAmAdmin() ? '<button class="btn-primary btn-sm" id="usrAdd">+ Add Account</button>' : ''}
        </div>

        ${banner ? `<div class="ai-banner${banner.bad ? ' bad' : ''}">${esc(banner.text)}</div>` : ''}

        <div id="usrTable"></div>
      </div>

      <div class="slideover-overlay" id="usrOverlay"></div>
      <aside class="slideover" id="usrPanel">
        <div class="slideover-head">
          <span class="slideover-title" id="usrTitle">Account</span>
          <button class="slideover-close" id="usrClose" type="button">&times;</button>
        </div>
        <div class="slideover-body" id="usrBody"></div>
        <div class="slideover-foot" id="usrFoot"></div>
      </aside>`;

    paintTable();

    const add = document.getElementById('usrAdd');
    if (add) add.onclick = () => openEditor(null);
    document.getElementById('usrClose').onclick = closeEditor;
    document.getElementById('usrOverlay').onclick = closeEditor;
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const refresh = async () => { await Promise.all([load(), loadCreds()]); render(); };

  function activate() {
    render();
    // render(), not paintTable(): the toolbar's Add button exists only for an admin, and the role
    // arrives with the credential state. Repainting the table body alone left the page drawn as it
    // was a moment earlier — before anyone knew who was asking — so an admin got no Add button.
    if (creds === null) loadCreds().then(render);
    window.NMS.onRefresh(refresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    if (activeTab() === TAB) activate();
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === TAB) activate();
  });
})();

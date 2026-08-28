/* users.js — Configuration ▸ User.
 *
 * Account management. Local credentials live in the local_users table (NOT running_config —
 * password changes must never create config-history versions), so this tab has no staging
 * provider: changes apply immediately through their own endpoints. Today that is the signed-in
 * account and its password (POST /api/change-password); SSO users authenticate via Okta and
 * have no local password.
 */
(function () {
  'use strict';

  window.NMS = window.NMS || {};

  // Read live (not once): settings tabs switch client-side without a page load (see main.js).
  const activeTab = () => new URLSearchParams(location.search).get('tab') || window.NMS.settingsDefaultTab;

  const { esc } = window.NMS.utils;

  let username = '—';

  async function load() {
    try {
      const info = await fetch('/api/whoami', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(r => (r.ok ? r.json() : null));
      if (info && info.username) username = info.username;
    } catch (_) { /* keep dash */ }
  }

  function render() {
    const el = document.getElementById('contentBody');
    if (!el || activeTab() !== 'user') return;

    el.innerHTML = `
      <div class="cfg-page">
        <div class="cfg-toolbar">
          <div class="cfg-toolbar-meta">
            <span class="cfg-h">User</span>
            <span class="cfg-h-sub">local accounts &amp; credentials</span>
          </div>
        </div>

        <div class="cfg-cards">
          <div class="cfg-card">
            <div class="cfg-card-h">Signed in as</div>
            <div class="cfg-card-big">${esc(username)}</div>
            <p class="field-hint">Passwords are hashed and kept out of the configuration.
              SSO accounts have none.</p>
          </div>

          <div class="cfg-card">
            <div class="cfg-card-h">Change password</div>
            <div class="field-row"><label>Current</label>
              <input type="password" id="usOld" autocomplete="current-password"/></div>
            <div class="field-row"><label>New</label>
              <input type="password" id="usNew" autocomplete="new-password"/></div>
            <div class="field-row"><label>Confirm</label>
              <input type="password" id="usNew2" autocomplete="new-password"/></div>
            <div class="cfg-card-foot">
              <span class="cfg-card-msg" id="usMsg"></span>
              <button class="btn-primary btn-sm" id="usSave">Update password</button>
            </div>
          </div>
        </div>
      </div>`;

    wire();
  }

  function wire() {
    const msg = (text, ok) => {
      const m = document.getElementById('usMsg');
      if (m) { m.textContent = text; m.className = 'cfg-card-msg ' + (ok ? 'ok' : 'err'); }
    };

    document.getElementById('usSave')?.addEventListener('click', async () => {
      const oldPass = document.getElementById('usOld').value;
      const newPass = document.getElementById('usNew').value;
      const newPass2 = document.getElementById('usNew2').value;

      if (!newPass) return msg('New password must not be empty.', false);
      if (newPass !== newPass2) return msg('New passwords do not match.', false);

      try {
        const r = await fetch('/api/change-password', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ old_password: oldPass, new_password: newPass }),
        });
        if (r.status === 401) return msg('Current password is incorrect.', false);
        if (!r.ok) return msg('Update failed (HTTP ' + r.status + ').', false);
        ['usOld', 'usNew', 'usNew2'].forEach(id => { document.getElementById(id).value = ''; });
        msg('Password updated.', true);
      } catch (e) {
        msg('Request failed: ' + e.message, false);
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  const userRefresh = async () => { await load(); render(); };

  function activate() {
    render();
    window.NMS.onRefresh(userRefresh);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await load();
    if (activeTab() === 'user') activate();
  });

  document.addEventListener('nms:tab-change', (e) => {
    if (e.detail.tab === 'user') activate();
  });
})();

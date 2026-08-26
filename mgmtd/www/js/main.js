/* main.js — sidebar injection + shared utilities */
(function () {
  'use strict';

  // ── Session guard ─────────────────────────────────────────────────────────
  // Any API call that comes back 401 with the UNAUTHENTICATED marker means the session expired
  // (30-min TTL) or the server was restarted — mgmtd keeps sessions in memory, so a `./pretzel
  // start` redeploy drops them all and the old cookie is dead. Whatever the operator was doing,
  // bounce them to the login page. Installed here, at the top of the first script every
  // authenticated page loads, so EVERY fetch is covered — not just the ones that remembered to
  // check r.status. Semantic 401s (wrong password on the login/change-password forms) carry no
  // such code and pass straight through to their own handlers. The login page does not load
  // main.js, so this never causes a redirect loop.
  (function installSessionGuard() {
    const origFetch = window.fetch.bind(window);
    let redirecting = false;
    window.fetch = async function (...args) {
      const res = await origFetch(...args);
      if (res.status === 401 && !redirecting) {
        try {
          const data = await res.clone().json();
          if (data && data.code === 'UNAUTHENTICATED') {
            redirecting = true;
            window.location.href = '/';
          }
        } catch (e) { /* non-JSON 401 — leave it to the caller */ }
      }
      return res;
    };
  })();

  // ── Session heartbeat ─────────────────────────────────────────────────────
  // Two jobs, and they must stay separate — the whole idle timeout depends on the distinction.
  //
  //   renew  POST /api/session/keepalive — the only route that moves the session's expiry.
  //          Fired from real operator input (pointer, key, wheel) and nothing else, throttled to
  //          one per RENEW_MS. So the 30-minute TTL measures idleness, not how long ago the
  //          operator signed in.
  //   probe  GET /api/whoami — validates without extending. This is what notices a session that
  //          died while the tab sat idle, so the operator meets the login page rather than a
  //          screen full of stale data.
  //
  // Nothing else may renew: the Home dashboard, the Infrastructure and API Collection live views
  // and the log tail all poll on timers, and if polling extended the session then leaving any of
  // those open would keep it alive for ever. That is also why returning to the tab only probes —
  // alt-tabbing back is not work, and must not buy another 30 minutes.
  //
  // The redirect itself is still the 401 guard above; here we only make sure a request happens.
  (function installSessionHeartbeat() {
    const RENEW_MS = 30000;   // at most one renewal per 30s of continuous activity
    const PROBE_MS = 60000;   // idle liveness check
    const PROBE_MIN_MS = 3000;

    let renewedAt = 0, probedAt = 0;

    // Renewing is itself an authenticated call, so an operator who comes back to a dead session
    // and clicks is bounced by the 401 on this very request — no separate check needed.
    function noteActivity() {
      const now = Date.now();
      if (now - renewedAt < RENEW_MS) return;
      renewedAt = now;
      probedAt = now;
      window.fetch('/api/session/keepalive', { method: 'POST', credentials: 'same-origin' })
        .catch(() => {});
    }

    function probe() {
      const now = Date.now();
      if (now - probedAt < PROBE_MIN_MS) return;
      probedAt = now;
      window.fetch('/api/whoami', { credentials: 'same-origin' }).catch(() => {});
    }

    ['pointerdown', 'keydown', 'wheel'].forEach(
      t => document.addEventListener(t, noteActivity, { capture: true, passive: true }));

    setInterval(probe, PROBE_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') probe();
    });
    window.addEventListener('focus', probe);
  })();

  // ── Configuration groups ─────────────────────────────────────────────────
  // One definition drives both navigation levels: the sidebar flyout lists the groups, and the
  // topbar shows the tabs of whichever group is open. Grouped by what the operator is working
  // on rather than by data type —
  //   Site Management    where things are, and what is there (a Site is one customer)
  //   API Profile        the reusable definitions a connector references
  //   API Connector      binding a device + credential + endpoints on a schedule
  //   System Management  this appliance, not the managed estate
  // A group with a single tab renders no tab row; its name in the sidebar is the whole story.
  const SETTINGS_GROUPS = [
    { id: 'site-management', label: 'Site Management', tabs: [
        { id: 'sites',        label: 'Sites'        },
        { id: 'devices',      label: 'Devices'      } ] },
    { id: 'api-profile', label: 'API Profile', tabs: [
        { id: 'api-key',      label: 'API Credential' },
        { id: 'api-endpoint', label: 'API Endpoint' } ] },
    { id: 'api-connector', label: 'API Connector', tabs: [
        { id: 'api-connector', label: 'API Connector' } ] },
    { id: 'system-management', label: 'System Management', tabs: [
        { id: 'user',         label: 'User'         },
        { id: 'operation',    label: 'Operation'    } ] },
  ];

  const SETTINGS_TABS = SETTINGS_GROUPS.reduce((acc, g) => acc.concat(g.tabs), []);
  const groupOfTab = (tabId) =>
    SETTINGS_GROUPS.find(g => g.tabs.some(t => t.id === tabId)) || SETTINGS_GROUPS[0];

  // ── Sidebar definition ───────────────────────────────────────────────────
  // Single source of truth for all pages.

  const SIDEBAR_NAV = [

    {
      type: 'link', id: 'home', label: 'Home', href: 'home',
      icon: `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
             <polyline points="9 22 9 12 15 12 15 22"/>`,
    },

    { type: 'section', label: 'AI' },
    {
      // The internal assistant itself, not a view of it: the one page here that an ordinary
      // employee would use rather than an operator. It sits above Insight because the security
      // story on the pages below it starts with the traffic this page generates.
      type: 'link', id: 'assistant', label: 'Assistant', href: 'chatbot',
      icon: `<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>
             <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>`,
    },
    {
      // The prompt sets the Assistant's guardrail is measured against. It sits beside the Assistant
      // rather than under Insight because it is the same subject read from the other end: one page
      // is the traffic, the other is the set the traffic is scored on.
      type: 'link', id: 'benchtest', label: 'Benchtest', href: 'benchtest',
      icon: `<path d="M4 20h16"/><rect x="5" y="11" width="3.6" height="6" rx="1"/>
             <rect x="10.2" y="7" width="3.6" height="10" rx="1"/>
             <rect x="15.4" y="13" width="3.6" height="4" rx="1"/>`,
    },

    { type: 'section', label: 'Insight' },
    {
      // The estate as a picture rather than a list: who connects, what they land on, where it exits.
      type: 'link', id: 'site-topology', label: 'Infrastructure', href: 'topology',
      icon: `<circle cx="5" cy="12" r="2.4"/><circle cx="12" cy="5.5" r="2.4"/>
             <circle cx="12" cy="18.5" r="2.4"/><circle cx="19" cy="12" r="2.4"/>
             <path d="M7 11l3-4M7 13l3 4M14 7l3 3.4M14 17l3-3.4"/>`,
    },
    {
      // The other half of the same estate: not its shape, but what its APIs are actually returning
      // and whether the collection cycle is still turning.
      type: 'link', id: 'api-collection', label: 'API Collection', href: 'collection',
      icon: `<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/>
             <path d="M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/>
             <path d="M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5"/>`,
    },

    { type: 'section', label: 'Control' },
    {
      type: 'link', id: 'remote-access', label: 'Remote Access', href: '#', soon: true,
      icon: `<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>`,
    },
    {
      type: 'link', id: 'power', label: 'Power Control', href: '#', soon: true,
      icon: `<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>`,
    },

    { type: 'section', label: 'Administrator' },
    {
      // A flyout group, not a link: the groups live here so the topbar carries a single row of
      // tabs. Each subitem opens its group's first tab.
      type: 'group', id: 'configuration', label: 'Configuration',
      subitems: SETTINGS_GROUPS.map(g => ({
        id: g.id,
        label: g.label,
        href: `settings?tab=${g.tabs[0].id}`,
        tabs: g.tabs.map(t => t.id),
      })),
      icon: `<circle cx="12" cy="12" r="3"/>
             <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06
                      a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09
                      A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83
                      l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09
                      A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83
                      l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09
                      a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83
                      l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09
                      a1.65 1.65 0 0 0-1.51 1z"/>`,
    },
    { type: 'section', label: 'Monitor' },
    {
      type: 'link', id: 'system-log', label: 'System Log', href: 'log-viewer',
      icon: `<path d="M4 5h16"/><path d="M4 12h10"/><path d="M4 19h7"/>
             <path d="M15 16l2.5 3 3.5-6"/>`,
    },

    { type: 'section', label: 'Laboratory' },
    {
      type: 'link', id: 'laboratory', label: 'Laboratory', href: 'laboratory',
      icon: `<path d="M9 3h6"/>
             <path d="M10 3v6.5L4.6 18.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9.5V3"/>
             <line x1="7" y1="15" x2="17" y2="15"/>`,
    },
  ];

  function buildSvg(inner) {
    return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">${inner}</svg>`;
  }

  // Per-page top layout: title + optional detail tabs. Single source of truth so every
  // page gets the same fixed header band (injected into #pageTopbar by buildTopbar).
  const PAGES = {
    'home':            { title: 'Home' },
    'chatbot':         { title: 'Assistant' },
    // Two tabs, plain navigation like the audit page: Test browses the set and launches a run,
    // Result reads runs that already happened. A run's result has to outlive the window it was
    // watched in — the modal is a view of a run in flight, not the only place its numbers exist.
    'benchtest':       { title: 'Benchtest', tabs: [
                           { id: 'test',   label: 'Test'   },
                           { id: 'result', label: 'Result' } ] },
    // The group is chosen in the sidebar flyout (SETTINGS_GROUPS); the topbar shows that
    // group's name and one row of its tabs.
    'settings':        { title: 'Configuration', groups: SETTINGS_GROUPS },
    'topology':        { title: 'Infrastructure' },
    'collection':      { title: 'API Collection' },
    'log-viewer':      { title: 'System Log' },
    'laboratory':      { title: 'Laboratory' },
    // Reached from the Tech Documentation card, not from the sidebar: it is a view of one
    // appliance dataset rather than a place an operator navigates to on their own.
    'tech-doc':        { title: 'Tech Documentation' },
  };

  // The flyout is rebuilt from the toggle's data-subitems each time it opens, so marking the
  // active group there is enough to keep it correct after an in-place tab switch.
  function syncFlyoutActive(tabId) {
    const toggle = document.querySelector('.nav-group[data-group-id="configuration"] .nav-group-toggle');
    if (!toggle) return;
    let subs;
    try { subs = JSON.parse(toggle.dataset.subitems || '[]'); } catch (_) { return; }
    subs.forEach(s => { s.active = !!(s.tabs && s.tabs.indexOf(tabId) !== -1); });
    toggle.dataset.subitems = JSON.stringify(subs);
  }

  function buildTopbar() {
    const el = document.getElementById('pageTopbar');
    if (!el) return;

    const page = location.pathname.split('/').pop() || 'home';
    const cfg = PAGES[page];
    if (!cfg) { el.remove(); return; }

    // Grouped pages still address a tab with a single ?tab= id; the group is derived from it, so
    // links stay short and a module only ever has to look at one parameter.
    const allTabs = cfg.groups ? cfg.groups.reduce((acc, g) => acc.concat(g.tabs), []) : (cfg.tabs || []);
    const defaultTab = allTabs.length ? allTabs[0].id : '';
    const params = new URLSearchParams(location.search);
    const requested = params.get('tab');
    const activeTab = allTabs.some(t => t.id === requested) ? requested : defaultTab;
    const activeGroup = cfg.groups
      ? (cfg.groups.find(g => g.tabs.some(t => t.id === activeTab)) || cfg.groups[0])
      : null;

    // With the group chosen in the sidebar, the heading names the group — otherwise the flyout
    // closes and nothing on screen says which part of Configuration this is.
    const heading = activeGroup ? activeGroup.label : cfg.title;
    document.title = 'Pretzel — ' + heading;

    let html = `
      <div class="topbar-main">
        <h1 class="topbar-title">${heading}</h1>
        <div class="topbar-actions">
          <button class="topbar-commit" id="commitBtn" type="button" disabled>
            <span id="commitLabel">Publish</span>
          </button>
          <button class="btn btn-ghost btn-icon-only" id="refreshBtn" type="button" title="Refresh" aria-label="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
      </div>`;

    const tabRow = (tabs) => `<nav class="page-tabs">` + tabs.map(t =>
      `<a class="page-tab ${t.id === activeTab ? 'active' : ''}" href="${page}?tab=${t.id}" data-tab="${t.id}">${t.label}</a>`
    ).join('') + `</nav>`;

    if (cfg.groups) {
      // One row only: the tabs of the group the sidebar opened. A single-tab group is its own
      // content, so a tab row of one would be noise.
      if (activeGroup.tabs.length > 1) {
        el.classList.add('has-tabs');
        html += tabRow(activeGroup.tabs);
      }
    } else if (cfg.tabs) {
      el.classList.add('has-tabs');
      html += tabRow(cfg.tabs);
    }

    el.innerHTML = html;

    // Settings navigation is client-side: every tab module stays loaded with its in-memory and
    // staged state, so the topbar — and the Publish pending state — survives the switch
    // instead of being rebuilt disabled and re-enabled once the data refetch lands. Modules
    // repaint on 'nms:tab-change'. Other tabbed pages (audit) keep plain navigation.
    if (cfg.groups && page === 'settings') {
      const currentTab = () => {
        const t = new URLSearchParams(location.search).get('tab');
        return allTabs.some(x => x.id === t) ? t : defaultTab;
      };

      function onTabClick(e) {
        e.preventDefault();
        const tabId = e.currentTarget.dataset.tab;
        if (tabId !== currentTab()) switchTab(tabId, true);
      }

      function switchTab(tabId, push) {
        if (push) history.pushState({ tab: tabId }, '', `${page}?tab=${tabId}`);

        const group = groupOfTab(tabId);

        // Changing group changes both the heading and which tabs exist.
        const title = el.querySelector('.topbar-title');
        if (title) title.textContent = group.label;
        document.title = 'Pretzel — ' + group.label;

        const existing = el.querySelector('.page-tabs');
        if (group.tabs.length > 1) {
          if (existing) existing.outerHTML = tabRow(group.tabs);
          else el.insertAdjacentHTML('beforeend', tabRow(group.tabs));
          el.classList.add('has-tabs');
          el.querySelectorAll('.page-tab').forEach(a => {
            a.classList.toggle('active', a.dataset.tab === tabId);
            a.addEventListener('click', onTabClick);
          });
        } else {
          if (existing) existing.remove();
          el.classList.remove('has-tabs');
        }

        // Keep the sidebar's flyout highlight in step. Only the stored subitem state is
        // rewritten — rebuilding the sidebar would mean re-running initFlyouts, whose
        // document/window listeners would then accumulate on every switch.
        syncFlyoutActive(tabId);

        document.dispatchEvent(new CustomEvent('nms:tab-change', { detail: { tab: tabId, group: group.id } }));
      }

      el.querySelectorAll('.page-tab').forEach(a => a.addEventListener('click', onTabClick));
      window.addEventListener('popstate', () => switchTab(currentTab(), false));

      // The sidebar flyout navigates between groups. While already on this page that should be
      // the same in-place switch as a tab click — a full load would rebuild the topbar and make
      // the Publish state flicker back through disabled.
      window.NMS = window.NMS || {};
      window.NMS.gotoSettingsTab = (tabId) => {
        if (!allTabs.some(t => t.id === tabId) || tabId === currentTab()) return false;
        switchTab(tabId, true);
        return true;
      };
    }

    // Staged changes belong to the browser tab, not to a page, so the button reflects them on
    // every page. Painted from the stored flag here and corrected by setPendingChanges once the
    // staging registry (js/commit.js, Configuration only) has its data.
    applyPending(window.NMS.pending.get());

    document.getElementById('commitBtn')?.addEventListener('click', () => {
      if (typeof window.NMS._onCommit === 'function') { window.NMS._onCommit(); return; }
      // Only Configuration loads the staging registry, and the review diff needs every tab
      // module's committed baseline — so a publish started elsewhere is handed to that page,
      // which opens the same flow on arrival (see js/commit.js).
      try { sessionStorage.setItem(PUBLISH_ON_LOAD_KEY, '1'); } catch (_) { /* ignore */ }
      location.href = 'settings';
    });

    document.getElementById('refreshBtn')?.addEventListener('click', (e) => {
      const b = e.currentTarget;
      b.classList.add('spinning');
      setTimeout(() => b.classList.remove('spinning'), 600);
      // Re-render the current page: pages register their render via NMS.onRefresh; if none
      // is registered (e.g. an empty skeleton page), fall back to a full reload.
      if (typeof window.NMS._onRefresh === 'function') window.NMS._onRefresh();
      else window.location.reload();
    });
  }

  // Parse an href into { page, tab, proto } so active-state matching can account for
  // query params (settings.html?tab=protocol&proto=snmp etc.), not just the file name.
  function parseHref(href) {
    const [page, query] = String(href || '').split('?');
    const p = new URLSearchParams(query || '');
    return { page, tab: p.get('tab') || '', proto: p.get('proto') || '' };
  }

  function buildSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    const activePage  = location.pathname.split('/').pop() || 'home';
    const params      = new URLSearchParams(location.search);
    const activeProto = params.get('proto') || '';
    // Settings without ?tab= lands on the first tab, so resolve it here too or the sidebar
    // would show no group highlighted on a bare /settings.
    const requestedTab = params.get('tab') || '';
    const activeTab = (activePage === 'settings' && !SETTINGS_TABS.some(t => t.id === requestedTab))
      ? SETTINGS_TABS[0].id
      : requestedTab;

    // A link/subitem is active when its page matches and any tab/proto it pins matches.
    const hrefActive = (href, disabled) => {
      if (disabled) return false;
      const h = parseHref(href);
      if (!h.page || h.page === '#' || h.page !== activePage) return false;
      if (h.tab   && h.tab   !== activeTab)   return false;
      if (h.proto && h.proto !== activeProto) return false;
      return true;
    };

    let html = `
      <div class="sidebar-brand">
        <div class="brand-icon">P</div>
        <span class="brand-name">Pretzel</span>
        <button class="sidebar-toggle" id="sidebarToggle" aria-label="Collapse sidebar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
            <polyline points="15 9 12 12 15 15"/>
          </svg>
        </button>
      </div>
      <nav class="sidebar-nav">`;

    for (const item of SIDEBAR_NAV) {
      if (item.type === 'section') {
        html += `<div class="nav-section-label">${item.label}</div>`;
        continue;
      }

      if (item.type === 'link') {
        const active = hrefActive(item.href, item.disabled);
        const cls = ['nav-item', active ? 'active' : '', item.disabled ? 'nav-disabled' : ''].filter(Boolean).join(' ');
        const href = item.disabled ? '#' : item.href;
        const tooltip = item.disabled ? `${item.label} (Coming soon)` : item.label;
        html += `<a class="${cls}" href="${href}" data-page="${item.href || ''}" data-tooltip="${tooltip}">
          ${buildSvg(item.icon)}
          <span class="nav-label">${item.label}</span>
          ${item.soon ? '<span class="nav-badge-soon">Coming soon</span>' : ''}
          ${item.badgeId ? `<span class="nav-badge" id="${item.badgeId}">--</span>` : ''}
        </a>`;
        continue;
      }

      if (item.type === 'group') {
        // Flyout group: the toggle never navigates; hovering/clicking it reveals a
        // flyout (built by initFlyouts from data-subitems) to the right — works the
        // same expanded or collapsed. The group is "active" if a subitem is active.
        //
        // A subitem links to its group's first tab, so matching on the href alone would drop
        // the highlight the moment the operator moved to a second tab. When the subitem lists
        // the tabs it owns, membership decides instead.
        const subs = item.subitems.map(s => ({
          id: s.id, label: s.label, href: s.href, tabs: s.tabs || null,
          soon: !!s.soon,
          active: s.tabs
            ? (parseHref(s.href).page === activePage && s.tabs.indexOf(activeTab) !== -1)
            : hrefActive(s.href, false),
        }));
        const groupActive = subs.some(s => s.active);
        const cls = ['nav-item', 'nav-group-toggle', groupActive ? 'active' : ''].filter(Boolean).join(' ');
        const dataSubs = JSON.stringify(subs).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        html += `<div class="nav-group" data-group-id="${item.id}">
          <button type="button" class="${cls}" data-tooltip="${item.label}"
                  data-label="${item.label}" data-subitems="${dataSubs}" aria-haspopup="true" aria-expanded="false">
            ${buildSvg(item.icon)}
            <span class="nav-label">${item.label}</span>
            ${item.badgeId ? `<span class="nav-badge" id="${item.badgeId}">--</span>` : ''}
            <svg class="nav-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <polyline points="9 6 15 12 9 18"/>
            </svg>
          </button>
        </div>`;
      }
    }

    html += `</nav>
      <div class="sidebar-footer">
        <button type="button" class="nav-item nav-theme" id="navTheme" data-tooltip="Theme"
                aria-pressed="false">
          <span class="nav-theme-ic" id="navThemeIc"></span>
          <span class="nav-label" id="navThemeLabel">Dark mode</span>
          <span class="nav-sw" aria-hidden="true"><span class="nav-sw-knob"></span></span>
        </button>
        <div class="nav-item nav-user" id="navUser" data-tooltip="Signed in">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          <span class="nav-label nav-user-name" id="navUserName">--</span>
        </div>
        <button type="button" class="nav-item nav-logout" id="navLogout" data-tooltip="Log out">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          <span class="nav-label">Log out</span>
        </button>
        <div class="nav-item nav-version" data-tooltip="v0.1.0-dev"
             style="cursor:default;opacity:.35;pointer-events:none;">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span class="nav-label">v0.1.0-dev</span>
        </div>
      </div>`;

    sidebar.innerHTML = html;
  }

  // ── Sidebar collapse/expand ───────────────────────────────────────────────

  const COLLAPSED_KEY = 'sidebarCollapsed';

  function initSidebar() {
    const sidebar       = document.getElementById('sidebar');
    const overlay       = document.getElementById('sidebarOverlay');
    const railToggle    = document.getElementById('railToggle');
    const railToggleBtn = document.getElementById('railToggleBtn');
    if (!sidebar) return;

    const isMobile = () => window.innerWidth <= 680;

    function isCollapsed() { return sidebar.classList.contains('collapsed'); }

    function applyCollapsed(collapsed) {
      sidebar.classList.toggle('collapsed', collapsed);
      if (railToggle)
        railToggle.style.display = (!isMobile() && collapsed) ? 'flex' : 'none';
    }

    if (isMobile()) {
      sidebar.classList.remove('collapsed');
      if (railToggle) railToggle.style.display = 'flex';
    } else {
      applyCollapsed(localStorage.getItem(COLLAPSED_KEY) === 'true');
    }

    // The pre-paint width is now owned by the .collapsed class (applied above); drop
    // the bootstrap html class so it can't override width once the user toggles.
    document.documentElement.classList.remove('sb-init-collapsed');

    // Toggle button is injected by buildSidebar — need to bind after inject
    const toggleBtn = document.getElementById('sidebarToggle');
    toggleBtn?.addEventListener('click', () => {
      const next = !isCollapsed();
      applyCollapsed(next);
      localStorage.setItem(COLLAPSED_KEY, String(next));
    });

    function openMobile()  { sidebar.classList.add('mobile-open'); overlay?.classList.add('visible'); if (railToggle) railToggle.style.display = 'none'; }
    function closeMobile() { sidebar.classList.remove('mobile-open'); overlay?.classList.remove('visible'); if (railToggle) railToggle.style.display = 'flex'; }

    railToggleBtn?.addEventListener('click', () => {
      isMobile() ? openMobile() : applyCollapsed(false) || localStorage.setItem(COLLAPSED_KEY, 'false');
    });
    overlay?.addEventListener('click', closeMobile);

    window.addEventListener('resize', () => {
      if (!isMobile()) {
        sidebar.classList.remove('mobile-open');
        overlay?.classList.remove('visible');
        applyCollapsed(localStorage.getItem(COLLAPSED_KEY) === 'true');
      } else {
        sidebar.classList.remove('collapsed');
        applyCollapsed(false);
        if (railToggle) railToggle.style.display = 'flex';
      }
    });
  }

  // ── Nav group flyouts ─────────────────────────────────────────────────────
  // Groups don't expand inline; hovering/clicking the toggle reveals a flyout to the
  // right. The panel is a single shared element appended to <body> so the sidebar's
  // overflow never clips it — works identically whether the rail is expanded or
  // collapsed, satisfying "still selectable when collapsed".

  function initFlyouts() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    let flyout = document.getElementById('navFlyout');
    if (!flyout) {
      flyout = document.createElement('div');
      flyout.id = 'navFlyout';
      flyout.className = 'nav-flyout';
      document.body.appendChild(flyout);
    }

    let hideTimer = null;
    const cancelHide   = () => clearTimeout(hideTimer);
    const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 160); };

    function hide() {
      flyout.classList.remove('visible');
      sidebar.querySelectorAll('.nav-group-toggle[aria-expanded="true"]')
        .forEach(t => t.setAttribute('aria-expanded', 'false'));
    }

    function show(group) {
      const toggle = group.querySelector('.nav-group-toggle');
      if (!toggle) return;

      let subs = [];
      try { subs = JSON.parse(toggle.dataset.subitems || '[]'); } catch (_) { /* ignore */ }

      flyout.innerHTML =
        `<div class="nav-flyout-title">${toggle.dataset.label || ''}</div>` +
        subs.map(s => {
          const cls  = ['nav-flyout-item', s.active ? 'active' : '', s.soon ? 'is-soon' : ''].filter(Boolean).join(' ');
          const href = s.soon ? '#' : s.href;
          const tab  = (s.tabs && s.tabs.length) ? ` data-goto-tab="${s.tabs[0]}"` : '';
          return `<a class="${cls}" href="${href}"${tab}>` +
                 `<span>${s.label}</span>` +
                 (s.soon ? '<span class="nav-badge-soon">Soon</span>' : '') +
                 `</a>`;
        }).join('');

      // Already on the target page: switch in place rather than reloading, so the topbar and
      // the staged Publish state survive (see NMS.gotoSettingsTab).
      flyout.querySelectorAll('[data-goto-tab]').forEach(a => {
        a.addEventListener('click', (e) => {
          if (typeof window.NMS.gotoSettingsTab !== 'function') return;
          e.preventDefault();
          window.NMS.gotoSettingsTab(a.dataset.gotoTab);
          hide();
        });
      });

      // Anchor to the right edge of the toggle, clamped to the viewport.
      const r = toggle.getBoundingClientRect();
      flyout.style.visibility = 'hidden';
      flyout.classList.add('visible');
      const fh = flyout.offsetHeight;
      let top = r.top;
      if (top + fh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - fh);
      flyout.style.top  = `${top}px`;
      flyout.style.left = `${r.right + 6}px`;
      flyout.style.visibility = '';

      sidebar.querySelectorAll('.nav-group-toggle[aria-expanded="true"]')
        .forEach(t => t.setAttribute('aria-expanded', 'false'));
      toggle.setAttribute('aria-expanded', 'true');
    }

    sidebar.querySelectorAll('.nav-group').forEach(group => {
      const toggle = group.querySelector('.nav-group-toggle');
      group.addEventListener('mouseenter', () => { cancelHide(); show(group); });
      group.addEventListener('mouseleave', scheduleHide);
      toggle?.addEventListener('click', (e) => { e.preventDefault(); cancelHide(); show(group); });
    });

    flyout.addEventListener('mouseenter', cancelHide);
    flyout.addEventListener('mouseleave', scheduleHide);

    // Dismiss when clicking away, scrolling, or resizing (anchor would go stale).
    document.addEventListener('click', (e) => {
      if (!flyout.contains(e.target) && !e.target.closest('.nav-group')) hide();
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
  }

  // ── Global hover tooltip ──────────────────────────────────────────────────
  // Any element with [data-tip] shows a small fixed-position tooltip on hover/focus.
  // Event-delegated, so it covers content rendered dynamically after load.

  function initTooltips() {
    let tip = document.getElementById('appTooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'appTooltip';
      tip.className = 'app-tooltip';
      document.body.appendChild(tip);
    }

    function show(el) {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      tip.textContent = text;
      tip.classList.add('visible');
      const r  = el.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let left = r.left + r.width / 2 - tr.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
      let top = r.top - tr.height - 8;
      if (top < 8) top = r.bottom + 8;   // flip below if no room above
      tip.style.left = `${left}px`;
      tip.style.top  = `${top}px`;
    }
    function hide() { tip.classList.remove('visible'); }

    document.addEventListener('mouseover', e => {
      const t = e.target.closest('[data-tip]');
      if (t) show(t);
    });
    document.addEventListener('mouseout', e => {
      const t = e.target.closest('[data-tip]');
      if (t && !t.contains(e.relatedTarget)) hide();
    });
    document.addEventListener('focusin',  e => { const t = e.target.closest('[data-tip]'); if (t) show(t); });
    document.addEventListener('focusout', hide);
    window.addEventListener('scroll', hide, true);
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  // One attribute on <html> selects the palette; main.css does the rest (see the :root[data-theme]
  // block there). The choice is stamped before first paint by the inline script in each page, so
  // this module only has to keep the footer control in sync and write the preference down.
  //
  // A stored choice is always explicit ('dark' or 'light'), never "follow the system": an operator
  // who picked light on a machine set to dark meant it, and should not have it undone at sunset.
  // Only the absence of a choice follows the system.

  const THEME_KEY = 'theme';

  const MOON = `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
      <path d="M20.5 14.4A8.5 8.5 0 1 1 9.6 3.5a6.8 6.8 0 0 0 10.9 10.9z"/>
    </svg>`;

  const systemTheme = () =>
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';

  function storedTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return (v === 'dark' || v === 'light') ? v : null;
    } catch (_) { return null; }
  }

  function applyTheme(theme, persist) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    if (persist) { try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* private mode */ } }
    syncThemeControl(t);
  }

  // One switch with a fixed name: "Dark mode", on or off. Swapping the label between Dark and Light
  // made the row read as two different controls depending on when you looked at it.
  function syncThemeControl(t) {
    const btn = document.getElementById('navTheme');
    const ic = document.getElementById('navThemeIc');
    if (!btn || !ic) return;
    const dark = t === 'dark';
    btn.classList.toggle('on', dark);
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.setAttribute('data-tooltip', dark ? 'Dark mode · on' : 'Dark mode · off');
    if (!ic.firstChild) ic.innerHTML = MOON;
  }

  function initTheme() {
    const stored = storedTheme();
    applyTheme(stored || systemTheme(), false);

    document.getElementById('navTheme')?.addEventListener('click', () => {
      const now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      applyTheme(now === 'dark' ? 'light' : 'dark', true);
    });

    // With no explicit choice on record, follow the machine when it changes.
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', (e) => {
        if (!storedTheme()) applyTheme(e.matches ? 'dark' : 'light', false);
      });
    }
  }

  // ── User footer (identity + logout) ───────────────────────────────────────
  // Fills the signed-in user's name (GET /api/whoami) and wires the logout button
  // (POST /api/logout, then back to the login page). Failures degrade quietly — the
  // footer just shows a dash rather than blocking the page.

  function initUserFooter() {
    const nameEl = document.getElementById('navUserName');
    const userEl = document.getElementById('navUser');

    fetch('/api/whoami', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(info => {
        const name = info && info.username ? info.username : '—';
        if (nameEl) nameEl.textContent = name;
        if (userEl) userEl.setAttribute('data-tooltip', name);
      })
      .catch(() => { if (nameEl) nameEl.textContent = '—'; });

    document.getElementById('navLogout')?.addEventListener('click', async () => {
      // Cleared before the request, not after: the redirect below may win the race with a slow
      // POST, and a logout that ends the server session while leaving the person's chat threads
      // in this browser is the failure worth avoiding. Clearing twice would be harmless; not
      // clearing at all is what leaves one user's conversations for the next one to read.
      for (const key of window.NMS._userStoreKeys || []) {
        try { localStorage.removeItem(key); } catch (_) { /* private mode — nothing stored anyway */ }
      }
      try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) { /* logout is best-effort; redirect regardless */ }
      window.location.href = '/';
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    buildSidebar();
    buildTopbar();
    initSidebar();
    initFlyouts();
    initTooltips();
    initTheme();
    initUserFooter();
  });

  /* ── Shared utils ── */
  window.NMS = window.NMS || {};

  // Top-right Publish button control. setPendingChanges(n) is called whenever the staged change
  // count changes (0 => disabled/muted, >0 => active); register the deploy action with
  // onCommit(fn).
  //
  // The pending state is mirrored into sessionStorage next to the drafts themselves, because the
  // drafts outlive the page: they are per browser tab (js/commit.js), while the staging registry
  // that can compute dirtiness is only loaded on Configuration. Without this, walking to Insight
  // with changes staged showed a dead Publish button — the changes were still there, nothing on
  // that page knew it.
  const PENDING_KEY = 'pz.pending';
  const PUBLISH_ON_LOAD_KEY = 'pz.publishOnLoad';

  function applyPending(dirty) {
    const commit = document.getElementById('commitBtn');
    if (commit) commit.disabled = !dirty;   // label stays "Publish"; only enabled state changes
  }

  window.NMS.pending = {
    get() {
      try { return sessionStorage.getItem(PENDING_KEY) === '1'; } catch (_) { return false; }
    },
    set(dirty) {
      try {
        if (dirty) sessionStorage.setItem(PENDING_KEY, '1');
        else sessionStorage.removeItem(PENDING_KEY);
      } catch (_) { /* quota/private mode */ }
    },
    // Consumed once by the page that owns the publish flow.
    takeHandoff() {
      try {
        const v = sessionStorage.getItem(PUBLISH_ON_LOAD_KEY);
        sessionStorage.removeItem(PUBLISH_ON_LOAD_KEY);
        return v === '1';
      } catch (_) { return false; }
    },
  };

  window.NMS.setPendingChanges = function (n) {
    const dirty = (n | 0) > 0;
    window.NMS.pending.set(dirty);
    applyPending(dirty);
  };
  window.NMS.onCommit = function (fn) { window.NMS._onCommit = fn; };

  // Register how the current page re-renders itself when the topbar Refresh is clicked.
  // Unregistered pages fall back to a full reload.
  window.NMS.onRefresh = function (fn) { window.NMS._onRefresh = fn; };

  // localStorage keys that belong to the signed-in person and must not outlive their session.
  // Logging out ends a session on the server; anything a page kept in this browser is still here
  // afterwards, and the next person to sign in on this machine sees it. Registered by name rather
  // than cleared wholesale so a page's genuinely device-level preferences (theme, rail width) are
  // not thrown away with the data.
  window.NMS._userStoreKeys = [];
  window.NMS.clearOnLogout = function (key) {
    if (key && !window.NMS._userStoreKeys.includes(key)) window.NMS._userStoreKeys.push(key);
  };

  // Only one custom-select dropdown is open at a time; opening a second closes the first.
  let csActiveClose = null;

  window.NMS.utils = {
    // Shared by the settings tab modules (see www/js/sites.js and friends).
    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },
    newUuid() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    },
    formatUptime(seconds) {
      if (!seconds || seconds < 0) return '--';
      const d = Math.floor(seconds / 86400);
      const h = Math.floor((seconds % 86400) / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (d) return `${d}d ${h}h ${m}m`;
      if (h) return `${h}h ${m}m ${s}s`;
      return `${m}m ${s}s`;
    },
    // Dispatch-and-poll, the shape every mgmtd call that crosses to pretzel-ai has: the POST/GET
    // returns 202 {ticket} immediately and the answer is collected from a result endpoint. mgmtd
    // runs one event loop, so a call that blocked it for the length of a gRPC round trip would
    // freeze the console — the ticket is what keeps that thread free.
    //
    // Resolves with the answer document. Rejects on transport failure or when the answer never
    // arrives; `tries` × `everyMs` is the ceiling, and it is deliberately generous because the
    // work on the far side is a database read whose tail is a cold connection, not a crawl.
    async pollTicket(dispatchUrl, resultUrl, opts) {
      const o = Object.assign({ everyMs: 300, tries: 60 }, opts || {});
      const first = await this.fetchJSON(dispatchUrl, o.dispatch);
      if (!first) return null;                       // 401: fetchJSON already redirected
      if (first.error) return first;                 // refused before dispatch; it is the answer
      const ticket = first.ticket;
      if (!ticket) throw new Error('no ticket');

      const url = resultUrl + (resultUrl.indexOf('?') === -1 ? '?' : '&') + 'ticket=' + ticket;
      for (let i = 0; i < o.tries; i++) {
        await new Promise(r => setTimeout(r, o.everyMs));
        const got = await this.fetchJSON(url);
        if (!got) return null;
        if (got.status !== 'pending') return got;
      }
      throw new Error('timed out waiting for an answer');
    },

    async fetchJSON(url, opts) {
      const r = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts));
      if (r.status === 401) { window.location.href = '/'; return null; }
      if (!r.ok) throw new Error(r.status);
      return r.json();
    },

    // Every timestamp mgmtd emits is formatted by Postgres `OF`, which prints a whole-hour zone as
    // `+09` — not the `+09:00` ISO 8601 requires, so `new Date()` rejects it outright and every
    // arithmetic on the result silently becomes NaN. Pad the offset back to two fields before
    // parsing. Returns null (never an Invalid Date) when the value cannot be used.
    parseTs(s) {
      if (!s) return null;
      const t = new Date(String(s).replace(/([+-]\d{2})$/, '$1:00'));
      return isNaN(t.getTime()) ? null : t;
    },

    // An absolute timestamp, always 24-hour and always the same shape: YYYY-MM-DD HH:MM:SS in the
    // viewer's local time. Not toLocaleString(), which follows the browser's locale — on a Korean
    // browser that renders "2026. 8. 4. 오후 3:39:35", so the same appliance reads differently to
    // two operators and half the log lines it is compared against are 24-hour anyway.
    // Accepts a Date, an epoch-milliseconds number, or a server timestamp string (see parseTs).
    fmtTs(v) {
      const t = (v instanceof Date) ? v : (typeof v === 'number' ? new Date(v) : this.parseTs(v));
      if (!t || isNaN(t.getTime())) return '—';
      const p = (n) => String(n).padStart(2, '0');
      return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
             `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
    },

    // The site the operator is working in, shared by every Insight page and remembered across
    // visits. A scope is a property of the session, not of one page: picking a site on Infrastructure
    // and being dropped back at Overview on API Collection is the same annoyance as a console that
    // forgets your region. Datadog, Grafana and the AWS console all keep this.
    //
    // Reading it is deliberately forgiving — a site can be deleted between visits, so callers check
    // the value against the sites they actually received and fall back to Overview.
    siteScope: {
      key: 'pz.site',
      get() {
        try { return localStorage.getItem(this.key) || ''; } catch (_) { return ''; }
      },
      set(oid) {
        try {
          if (oid) localStorage.setItem(this.key, oid);
          else localStorage.removeItem(this.key);
        } catch (_) { /* private mode — the scope just does not persist */ }
      },
    },

    // "just now" / "42s" / "7m" / "3h" / "2d" — the age of a timestamp, for a freshness stamp.
    relAge(s) {
      const t = this.parseTs(s);
      if (!t) return '—';
      const sec = Math.max(0, (Date.now() - t.getTime()) / 1000);
      if (sec < 5) return 'just now';
      if (sec < 90) return Math.round(sec) + 's ago';
      if (sec < 5400) return Math.round(sec / 60) + 'm ago';
      if (sec < 172800) return Math.round(sec / 3600) + 'h ago';
      return Math.round(sec / 86400) + 'd ago';
    },

    // Enhance every <select> in a container with the custom dropdown below.
    enhanceSelects(container) {
      if (container) container.querySelectorAll('select').forEach(s => this.enhanceSelect(s));
    },

    // Replace a native <select>'s look with a themed dropdown that renders identically on Windows,
    // macOS and Linux — the OS draws native option lists and CSS cannot touch them. The <select>
    // stays in the DOM (hidden) as the value store and event source, so existing `.value` reads and
    // 'change' listeners keep working; picking an option sets it and dispatches a bubbling 'change'.
    enhanceSelect(select) {
      if (!select || select.dataset.csEnhanced) return;
      select.dataset.csEnhanced = '1';

      const wrap = document.createElement('div');
      wrap.className = 'cs';
      select.parentNode.insertBefore(wrap, select);
      wrap.appendChild(select);

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'cs-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.innerHTML = '<span class="cs-label"></span><span class="cs-caret" aria-hidden="true"></span>';
      wrap.appendChild(trigger);
      const label = trigger.querySelector('.cs-label');

      let panel = null, active = -1;

      const syncLabel = () => {
        const o = select.options[select.selectedIndex];
        label.textContent = o ? o.textContent : '';
        label.classList.toggle('cs-placeholder', !o || o.value === '');
      };

      const optionEls = () => (panel ? Array.from(panel.querySelectorAll('.cs-opt:not(.disabled)')) : []);

      const setActive = (i) => {
        const opts = optionEls();
        if (!opts.length) return;
        active = (i + opts.length) % opts.length;
        opts.forEach((el, idx) => el.classList.toggle('active', idx === active));
        opts[active].scrollIntoView({ block: 'nearest' });
      };

      const position = () => {
        const r = trigger.getBoundingClientRect();
        panel.style.width = r.width + 'px';
        panel.style.left = r.left + 'px';
        const below = window.innerHeight - r.bottom;
        const ph = panel.offsetHeight;
        panel.style.top = (below < ph + 8 && r.top > below ? r.top - ph - 6 : r.bottom + 6) + 'px';
      };

      const close = () => {
        if (!panel) return;
        panel.remove(); panel = null; active = -1;
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDocDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', close, true);
        window.removeEventListener('scroll', close, true);
        if (csActiveClose === close) csActiveClose = null;
      };

      const choose = (optionIndex) => {
        if (select.selectedIndex !== optionIndex) {
          select.selectedIndex = optionIndex;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        syncLabel();
        close();
        trigger.focus();
      };

      const onDocDown = (e) => {
        if (panel && !panel.contains(e.target) && !wrap.contains(e.target)) close();
      };

      const onKey = (e) => {
        if (!panel) return;
        if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
        else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const opts = optionEls();
          if (active >= 0 && opts[active]) opts[active].click();
        }
      };

      const open = () => {
        if (panel) { close(); return; }
        if (csActiveClose) csActiveClose();

        panel = document.createElement('div');
        panel.className = 'cs-panel';
        panel.setAttribute('role', 'listbox');
        Array.from(select.options).forEach((o, i) => {
          const el = document.createElement('div');
          el.className = 'cs-opt'
            + (o.disabled ? ' disabled' : '')
            + (i === select.selectedIndex ? ' sel' : '')
            + (o.value === '' ? ' placeholder' : '');
          el.setAttribute('role', 'option');
          el.textContent = o.textContent;
          if (!o.disabled) el.addEventListener('click', () => choose(i));
          panel.appendChild(el);
        });
        document.body.appendChild(panel);
        trigger.setAttribute('aria-expanded', 'true');
        position();

        const opts = optionEls();
        const sel = opts.findIndex(el => el.classList.contains('sel'));
        setActive(sel >= 0 ? sel : 0);

        document.addEventListener('mousedown', onDocDown, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', close, true);
        window.addEventListener('scroll', close, true);
        csActiveClose = close;
      };

      trigger.addEventListener('click', open);
      select.addEventListener('change', syncLabel);
      syncLabel();
    },
  };
}());

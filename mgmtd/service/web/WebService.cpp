#include "service/web/WebService.h"

#include "service/MgmtdServiceManager.h"

#include "service/web/WebAction.h"
#include "service/web/WebEvent.h"
#include "service/web/WebIpcEvent.h"
#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"

#include "util/Logger.h"

#include <memory>
#include <string>
#include <utility>

namespace pz::mgmtd
{

namespace
{

constexpr const char* kPublicPages[] = {
    "/", "/index.html", "/css/main.css", "/js/main.js", "/js/login.js",
};

}

void WebService::handleEvent(MgmtdServiceManager& sm, const WebEvent& event)
{
    Response resp;
    route(sm, event.request(), resp);

    sm.postAction(std::make_unique<WebAction>(std::move(resp), event.sessionId()));
}

// The IPC counterpart of route(). Same shape, same reason: WebService knows which controller owns
// which conversation, and the controller knows what the answer means.
void WebService::handleIpcEvent(MgmtdServiceManager& sm, const WebIpcEvent& event)
{
    const pz::ipc::IpcMessage* msg = event.message();
    if (!msg)
    {
        LOG_WARN("web IPC event without a message — dropping");
        return;
    }

    switch (event.type())
    {
    case WebIpcEventType::TopologyResponse:
        return m_topologyController.onTopologyResponse(sm, *msg);

    case WebIpcEventType::SettingsCommitStatus:
        return m_settingsController.onCommitStatus(sm, *msg);

    case WebIpcEventType::ApiConnectorTestResponse:
        return m_apiController.onTestResponse(sm, *msg);

    default:
        LOG_WARN("unhandled web IPC event (type={})", static_cast<std::uint32_t>(event.type()));
        return;
    }
}

void WebService::handleAction(MgmtdServiceManager& sm, WebAction& action)
{
    sm.txRouter().handleHttpMessage(std::move(action.response()), action.sessionId());
}

// ── The route table ────────────────────────────────────────────────────────────────────────────
// One row per URL, in first-match order. Data only — no function pointers: the row names a WebRoute,
// and route() switches on it. Adding an endpoint is one row here plus one case in the switch, the
// same two-step a new ApiEventType is in collectord.
WebService::Resolved WebService::resolve(const std::string& method, const std::string& target) const
{
    struct Row
    {
        const char* method;
        const char* path;
        Match match;
        WebRoute route;
        Access access;
        bool mustChangeExempt;
    };

    // clang-format off
    static const Row kRoutes[] = {
        // Public.
        {"GET",  "/metrics",                            
            Match::Exact,  WebRoute::Metric,             Access::Public,        false},
        {"GET",  "/health",                             
            Match::Exact,  WebRoute::Health,             Access::Public,        false},

        // Auth — local password sign-in. change-password is authenticated but exempt from the
        // must-change lock: it is the escape from it.
        {"POST", "/api/login",                          
            Match::Exact,  WebRoute::Login,              Access::Public,        false},
        {"POST", "/api/logout",                         
            Match::Exact,  WebRoute::Logout,             Access::Public,        false},
        {"POST", "/api/change-password",                
            Match::Exact,  WebRoute::ChangePassword,     Access::Authenticated, true},
        {"GET",  "/api/whoami",
            Match::Exact,  WebRoute::Whoami,             Access::Authenticated, false},
        // Renewal is its own route because it is the only one allowed to move the expiry: the
        // frontend fires it only after real operator input, so the TTL stays an idle timeout even
        // while a live view polls in the background. Kept exempt-free — a session under the
        // must-change lock has nothing to keep alive but the change-password form.
        {"POST", "/api/session/keepalive",
            Match::Exact,  WebRoute::SessionKeepalive,   Access::Authenticated, false},

        // SSO / SAML.
        {"GET",  "/api/auth/sso/info",                  
            Match::Exact,  WebRoute::SsoInfo,            Access::Public,        false},
        {"GET",  "/api/auth/sso/login",                 
            Match::Exact,  WebRoute::SsoLogin,           Access::Public,        false},
        {"POST", "/api/auth/saml/acs",                  
            Match::Exact,  WebRoute::SamlAcs,            Access::Public,        false},
        {"GET",  "/api/auth/saml/result",               
            Match::Prefix, WebRoute::SamlResult,         Access::Public,        false},

        // Settings.
        {"GET",  "/api/settings",                       
            Match::Exact,  WebRoute::Settings,           Access::Authenticated, false},
        {"GET",  "/api/settings/running-config",        
            Match::Exact,  WebRoute::RunningConfig,      Access::Authenticated, false},
        {"POST", "/api/settings/commit",                
            Match::Exact,  WebRoute::SettingsCommit,     Access::Authenticated, false},
        {"GET",  "/api/settings/reload-status",         
            Match::Exact,  WebRoute::ReloadStatus,       Access::Authenticated, false},
        {"GET",  "/api/settings/commit-queue",          
            Match::Exact,  WebRoute::CommitQueue,        Access::Authenticated, false},
        {"POST", "/api/settings/save-config",           
            Match::Exact,  WebRoute::SaveConfig,         Access::Authenticated, false},
        {"GET",  "/api/settings/saved-configs",         
            Match::Exact,  WebRoute::SavedConfigs,       Access::Authenticated, false},
        {"GET",  "/api/settings/saved-config-content",  
            Match::Prefix, WebRoute::SavedConfigContent, Access::Authenticated, false},

        // Status.
        {"GET",  "/api/status/devices",                 
            Match::Exact,  WebRoute::DeviceStatus,       Access::Authenticated, false},

        // Topology. Prefix, not Exact: the scope travels as ?site=<oid>, and an Exact row stops
        // matching the moment a query string is appended — which fails as a 404 with no handler ever
        // called, not as a visible error.
        {"GET",  "/api/topology",
            Match::Prefix, WebRoute::SiteTopology,       Access::Authenticated, false},

        // Connector tests + credential state.
        {"POST", "/api/connector/keygen-test",          
            Match::Exact,  WebRoute::KeygenTest,         Access::Authenticated, false},
        {"POST", "/api/connector/endpoint-test",        
            Match::Exact,  WebRoute::EndpointTest,       Access::Authenticated, false},
        {"POST", "/api/connector/sase-test",            
            Match::Exact,  WebRoute::SaseTest,           Access::Authenticated, false},
        {"POST", "/api/connector/sase-key",             
            Match::Exact,  WebRoute::SaseKeyStore,       Access::Authenticated, false},
        {"POST", "/api/connector/credential",           
            Match::Exact,  WebRoute::CredentialStore,    Access::Authenticated, false},
        {"POST", "/api/connector/tls-probe",            
            Match::Exact,  WebRoute::TlsProbe,           Access::Authenticated, false},
        {"GET",  "/api/connector/test-result",          
            Match::Prefix, WebRoute::ApiTestResult,      Access::Authenticated, false},
        {"GET",  "/api/connector/keys-state",           
            Match::Exact,  WebRoute::KeysState,          Access::Authenticated, false},

        // API collection — the read side of the collector's output.
        {"GET",  "/api/collection/overview",
            Match::Prefix, WebRoute::CollectionOverview, Access::Authenticated, false},
        // `samples` must precede `sample`: Prefix matching would otherwise let the shorter path
        // claim the longer one's target.
        {"GET",  "/api/collection/samples",
            Match::Prefix, WebRoute::CollectionSamples,  Access::Authenticated, false},
        {"GET",  "/api/collection/sample",
            Match::Prefix, WebRoute::CollectionSample,   Access::Authenticated, false},

        // Assistant. The POST is Exact and the poll is Prefix (it carries ?ticket=); they differ
        // by method as well, so neither can shadow the other.
        {"POST", "/api/chat",
            Match::Exact,  WebRoute::ChatSend,          Access::Authenticated, false},
        {"GET",  "/api/chat/models",
            Match::Exact,  WebRoute::ChatModels,        Access::Authenticated, false},
        {"GET",  "/api/chat/result",
            Match::Prefix, WebRoute::ChatResult,        Access::Authenticated, false},

        // Tech-doc knowledge base. /result and /progress are Prefix (the first carries ?ticket=);
        // /status, /check and /refresh are Exact, and every pair differs by method or by path, so
        // none of them can shadow another.
        {"GET",  "/api/techdoc/status",
            Match::Exact,  WebRoute::TechDocStatus,     Access::Authenticated, false},
        {"GET",  "/api/techdoc/result",
            Match::Prefix, WebRoute::TechDocResult,     Access::Authenticated, false},
        {"POST", "/api/techdoc/refresh",
            Match::Exact,  WebRoute::TechDocRefresh,    Access::Authenticated, false},
        {"GET",  "/api/techdoc/progress",
            Match::Exact,  WebRoute::TechDocProgress,   Access::Authenticated, false},
        {"POST", "/api/techdoc/cancel",
            Match::Exact,  WebRoute::TechDocCancel,     Access::Authenticated, false},
        // Benchtest sets. The three /datasets entries differ by method, so none can shadow
        // another; /result carries ?ticket= and the rest carry ?id=, so all are Prefix.
        {"GET",  "/api/benchtest/datasets",
            Match::Prefix, WebRoute::BenchtestDatasets,  Access::Authenticated, false},
        {"POST", "/api/benchtest/datasets",
            Match::Prefix, WebRoute::BenchtestUpload,    Access::Authenticated, false},
        {"DELETE", "/api/benchtest/datasets",
            Match::Prefix, WebRoute::BenchtestDelete,    Access::Authenticated, false},
        {"GET",  "/api/benchtest/summary",
            Match::Prefix, WebRoute::BenchtestSummary,   Access::Authenticated, false},
        {"GET",  "/api/benchtest/rows",
            Match::Prefix, WebRoute::BenchtestRows,      Access::Authenticated, false},
        {"GET",  "/api/benchtest/export",
            Match::Prefix, WebRoute::BenchtestExport,    Access::Authenticated, false},
        {"GET",  "/api/benchtest/result",
            Match::Prefix, WebRoute::BenchtestResult,    Access::Authenticated, false},

        // Runs. The two longer /run/ paths are Exact and come first: /run is Prefix and would
        // otherwise claim both of them.
        {"GET",  "/api/benchtest/run/progress",
            Match::Exact,  WebRoute::BenchtestRunProgress, Access::Authenticated, false},
        {"POST", "/api/benchtest/run/cancel",
            Match::Exact,  WebRoute::BenchtestRunCancel,   Access::Authenticated, false},
        // "runs" before "run": Prefix matching would let the shorter path claim the longer one.
        {"GET",  "/api/benchtest/runs",
            Match::Prefix, WebRoute::BenchtestRuns,        Access::Authenticated, false},
        {"GET",  "/api/benchtest/run",
            Match::Prefix, WebRoute::BenchtestRunInfo,     Access::Authenticated, false},
        {"POST", "/api/benchtest/run",
            Match::Prefix, WebRoute::BenchtestRunStart,    Access::Authenticated, false},
        {"GET",  "/api/benchtest/cases",
            Match::Prefix, WebRoute::BenchtestCases,       Access::Authenticated, false},
        {"GET",  "/api/benchtest/case",
            Match::Prefix, WebRoute::BenchtestCase,        Access::Authenticated, false},

        {"GET",  "/api/techdoc/documents",
            Match::Prefix, WebRoute::TechDocDocuments,  Access::Authenticated, false},

        // Logs.
        {"GET",  "/api/logs",
            Match::Prefix, WebRoute::Logs,               Access::Authenticated, false},
    };
    // clang-format on

    for (const auto& r : kRoutes)
    {
        if (method != r.method)
            continue;
        const bool hit =
            (r.match == Match::Exact) ? (target == r.path) : (target.rfind(r.path, 0) == 0);
        if (hit)
            return Resolved{r.route, r.access, r.mustChangeExempt};
    }
    return Resolved{};
}

// Resolve, apply the two cross-cutting gates once, then hand off to the owning controller in a single
// switch — the mgmtd counterpart of collectord's ApiService::route().
void WebService::route(MgmtdServiceManager& sm, const Request& req, Response& resp)
{
    LOG_TRACE("HTTP request (method={}, target={})", req.method, req.target);

    const Resolved r = resolve(req.method, req.target);
    if (r.route == WebRoute::None)
    {
        // Nothing in the table claimed it — a static file (everything outside /api).
        if (isStaticTarget(req.target))
            staticFallback(sm, req, resp);
        return;
    }

    if (r.access == Access::Authenticated)
    {
        if (!sm.authService().validateSession(sessionCookie(req)))
        {
            // The code lets the frontend tell a session-expiry 401 (bounce to login) apart from a
            // semantic 401 like a wrong current password on the change-password form.
            return fill(resp, 401, R"({"error":"unauthorized","code":"UNAUTHENTICATED"})");
        }

        // The must-change-password lock: an authenticated operator with a pending forced change may
        // reach only the change-password route until it is done.
        if (!r.mustChangeExempt && req.target.rfind("/api/", 0) == 0 &&
            sm.authService().mustChangePassword())
        {
            return fill(resp, 403, R"({"error":"password change required","code":"MUST_CHANGE_PASSWORD"})");
        }
    }

    switch (r.route)
    {
    case WebRoute::Metric:             return metric(sm, req, resp);
    case WebRoute::Health:             return health(sm, req, resp);

    case WebRoute::Login:              return m_authController.login(sm, req, resp);
    case WebRoute::Logout:             return m_authController.logout(sm, req, resp);
    case WebRoute::ChangePassword:     return m_authController.changePassword(sm, req, resp);
    case WebRoute::Whoami:             return m_authController.whoami(sm, req, resp);
    case WebRoute::SessionKeepalive:   return m_authController.keepalive(sm, req, resp);

    case WebRoute::SsoInfo:            return m_ssoController.info(sm, req, resp);
    case WebRoute::SsoLogin:           return m_ssoController.login(sm, req, resp);
    case WebRoute::SamlAcs:            return m_ssoController.samlAcs(sm, req, resp);
    case WebRoute::SamlResult:         return m_ssoController.samlResult(sm, req, resp);

    case WebRoute::Settings:           return m_settingsController.get(sm, req, resp);
    case WebRoute::RunningConfig:      return m_settingsController.runningConfig(sm, req, resp);
    case WebRoute::SettingsCommit:     return m_settingsController.commit(sm, req, resp);
    case WebRoute::ReloadStatus:       return m_settingsController.reloadStatus(sm, req, resp);
    case WebRoute::CommitQueue:        return m_settingsController.commitQueue(sm, req, resp);
    case WebRoute::SaveConfig:         return m_settingsController.saveConfig(sm, req, resp);
    case WebRoute::SavedConfigs:       return m_settingsController.savedConfigs(sm, req, resp);
    case WebRoute::SavedConfigContent: return m_settingsController.savedConfigContent(sm, req, resp);

    case WebRoute::DeviceStatus:       return m_statusController.deviceStatus(sm, req, resp);
    case WebRoute::SiteTopology:       return m_topologyController.siteTopology(sm, req, resp);

    case WebRoute::KeygenTest:         return m_apiController.keygenTest(sm, req, resp);
    case WebRoute::EndpointTest:       return m_apiController.endpointTest(sm, req, resp);
    case WebRoute::SaseTest:           return m_apiController.saseTest(sm, req, resp);
    case WebRoute::SaseKeyStore:       return m_apiController.saseKeyStore(sm, req, resp);
    case WebRoute::CredentialStore:    return m_apiController.credentialStore(sm, req, resp);
    case WebRoute::TlsProbe:           return m_apiController.tlsProbe(sm, req, resp);
    case WebRoute::ApiTestResult:      return m_apiController.testResult(sm, req, resp);
    case WebRoute::KeysState:          return m_apiController.keysState(sm, req, resp);

    case WebRoute::CollectionOverview: return m_collectionController.overview(sm, req, resp);
    case WebRoute::CollectionSamples:  return m_collectionController.samples(sm, req, resp);
    case WebRoute::CollectionSample:   return m_collectionController.sample(sm, req, resp);

    case WebRoute::ChatSend:           return m_chatController.send(sm, req, resp);
    case WebRoute::ChatResult:         return m_chatController.result(sm, req, resp);
    case WebRoute::ChatModels:         return m_chatController.models(sm, req, resp);

    case WebRoute::TechDocStatus:      return m_techDocController.status(sm, req, resp);
    case WebRoute::TechDocResult:      return m_techDocController.result(sm, req, resp);
    case WebRoute::TechDocRefresh:     return m_techDocController.refresh(sm, req, resp);
    case WebRoute::TechDocProgress:    return m_techDocController.progress(sm, req, resp);
    case WebRoute::TechDocCancel:      return m_techDocController.cancel(sm, req, resp);
    case WebRoute::TechDocDocuments:   return m_techDocController.documents(sm, req, resp);

    case WebRoute::BenchtestDatasets:  return m_benchtestController.datasets(sm, req, resp);
    case WebRoute::BenchtestUpload:    return m_benchtestController.upload(sm, req, resp);
    case WebRoute::BenchtestDelete:    return m_benchtestController.remove(sm, req, resp);
    case WebRoute::BenchtestSummary:   return m_benchtestController.summary(sm, req, resp);
    case WebRoute::BenchtestRows:      return m_benchtestController.rows(sm, req, resp);
    case WebRoute::BenchtestExport:    return m_benchtestController.exportSet(sm, req, resp);
    case WebRoute::BenchtestResult:    return m_benchtestController.result(sm, req, resp);
    case WebRoute::BenchtestRunStart:  return m_benchtestController.runStart(sm, req, resp);
    case WebRoute::BenchtestRunProgress: return m_benchtestController.runProgress(sm, req, resp);
    case WebRoute::BenchtestRunCancel: return m_benchtestController.runCancel(sm, req, resp);
    case WebRoute::BenchtestRuns:      return m_benchtestController.runs(sm, req, resp);
    case WebRoute::BenchtestRunInfo:   return m_benchtestController.runInfo(sm, req, resp);
    case WebRoute::BenchtestCases:     return m_benchtestController.cases(sm, req, resp);
    case WebRoute::BenchtestCase:      return m_benchtestController.caseDetail(sm, req, resp);

    case WebRoute::Logs:               return m_logsController.list(sm, req, resp);

    case WebRoute::None:               break;   // unreachable — filtered above
    }
}

void WebService::metric(MgmtdServiceManager& sm, const Request& req, Response& resp)
{
    (void)req;
    fill(resp, 200, sm.metricService().renderPrometheus(), "text/plain; version=0.0.4; charset=utf-8");
}

// Unauthenticated liveness probe. Always 200 while mgmtd is serving — reaching this handler is itself
// proof of that — with the body carrying engined's latest per-daemon heartbeat roll-up
// ({timestamp_ms, daemons:[{name,status,latency_ms}]}) so the Home page can render a status grid.
// Until the first heartbeat round lands, the daemon list is empty rather than stale. Public route.
void WebService::health(MgmtdServiceManager& sm, const Request& req, Response& resp)
{
    (void)req;
    auto& hb = sm.heartbeatService();
    if (hb.hasData())
        fill(resp, 200, hb.latestJson());
    else
        fill(resp, 200, R"({"timestamp_ms":0,"daemons":[]})");
}

void WebService::staticFallback(MgmtdServiceManager& sm, const Request& req, Response& resp)
{
    bool isPublic = false;
    for (const auto* p : kPublicPages)
    {
        if (req.target == p)
        {
            isPublic = true;
            break;
        }
    }

    if (!isPublic && !sm.authService().validateSession(sessionCookie(req)))
    {
        resp.status = 302;
        resp.contentType = "text/plain; charset=utf-8";
        resp.body.clear();
        resp.location = "/index.html";
        return;
    }

    serveStatic(sm, req, resp);
}

void WebService::serveStatic(MgmtdServiceManager& sm, const Request& req, Response& resp)
{
    const auto& cache = sm.staticCache();
    if (!cache)
        return fill(resp, 503, "static cache unavailable", "text/plain; charset=utf-8");

    std::string staticPath(req.target);
    const auto qpos = staticPath.find('?');
    if (qpos != std::string::npos)
        staticPath.erase(qpos);

    auto file = cache->get(staticPath);
    if (!file)
        return fill(resp, 404, "not found", "text/plain; charset=utf-8");

    fill(resp, 200, std::move(file->body), std::move(file->contentType));
    resp.etag = std::move(file->etag);
}

bool WebService::isStaticTarget(const std::string& target) const
{
    return target.rfind("/api", 0) != 0;
}

}

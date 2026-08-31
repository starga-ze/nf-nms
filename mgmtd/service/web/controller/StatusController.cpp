#include "service/web/controller/StatusController.h"

#include "service/MgmtdServiceManager.h"
#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"

#include "config/Config.h"
#include "db/Database.h"
#include "http/HttpMessage.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

// Every managed device is judged on the same three-layer dependency ladder, regardless of type:
//   reachable  — can we reach it at all      (NGFW: ICMP · SASE: getPrismaAccessIP control-plane)
//   credential — do we hold valid access     (the device's bound API Key / OAuth token)
//   api        — does a real API call answer  (the device's connector's last collection sample)
// Each layer is "ok" / "fail" / "unknown" (unknown = nothing configured for that layer yet). engined
// owns devices.status (reachable); the credential and api layers are derived here by joining the
// operator's config (which API Key / connector each device carries) with the runtime state tables.
void StatusController::deviceStatus(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)sm;
    (void)req;

    json out = json::object();
    try
    {
        auto& db = pz::db::Database::instance();

        // credential state, keyed by API Key (auth_profile) oid.
        std::unordered_map<std::string, bool> credOk;   // oid -> healthy (stored + last test ok + unexpired)
        std::unordered_map<std::string, bool> credSeen;  // oid -> a row exists
        for (const auto& r : db.queryRows(
                 "SELECT oid, (key_enc IS NOT NULL AND last_test_ok "
                 "AND (expires_at IS NULL OR expires_at > now()))::int FROM api_credential_state"))
        {
            if (r.size() < 2 || r[0].empty())
                continue;
            credSeen[r[0]] = true;
            credOk[r[0]] = (r[1] == "1");
        }

        // latest collection outcome per connector.
        std::unordered_map<std::string, bool> apiOk;
        for (const auto& r : db.queryRows(
                 "SELECT DISTINCT ON (connector_oid) connector_oid, ok::int "
                 "FROM api_collection ORDER BY connector_oid, collected_at DESC"))
        {
            if (r.size() < 2 || r[0].empty())
                continue;
            apiOk[r[0]] = (r[1] == "1");
        }

        // device reachability from engined's projection.
        std::unordered_map<std::string, std::string> reachable;   // device oid -> status
        for (const auto& r : db.queryRows("SELECT oid, COALESCE(status,'') FROM ngfw_device "
                                          "UNION ALL SELECT oid, COALESCE(status,'') FROM sase_device"))
        {
            if (!r.empty() && !r[0].empty())
                reachable[r[0]] = r.size() > 1 ? r[1] : std::string();
        }

        // config: which API Key / connector each device carries.
        const auto& api = pz::config::Config::section(pz::config::scope::kPretzel, "connector");
        const auto& site = pz::config::Config::section(pz::config::scope::kPretzel, "site");

        // device oid -> best credential layer across its bound API Keys.
        std::unordered_map<std::string, std::string> credLayer;
        for (const auto& p : api.value("api_credentials", json::array()))
        {
            if (!p.is_object())
                continue;
            const std::string dev = p.value("device", std::string());
            const std::string oid = p.value("oid", std::string());
            if (dev.empty() || oid.empty())
                continue;
            const bool seen = credSeen.count(oid) != 0;
            const std::string layer = !seen ? "unknown" : (credOk[oid] ? "ok" : "fail");
            auto& cur = credLayer[dev];
            // ok wins over fail wins over unknown.
            if (cur.empty() || layer == "ok" || (layer == "fail" && cur == "unknown"))
                cur = layer;
        }

        // device oid -> best api layer across its connectors.
        std::unordered_map<std::string, std::string> apiLayer;
        for (const auto& c : api.value("connectors", json::array()))
        {
            if (!c.is_object())
                continue;
            const std::string dev = c.value("object", std::string());
            const std::string oid = c.value("oid", std::string());
            if (dev.empty() || oid.empty())
                continue;
            const bool seen = apiOk.count(oid) != 0;
            const std::string layer = !seen ? "unknown" : (apiOk[oid] ? "ok" : "fail");
            auto& cur = apiLayer[dev];
            if (cur.empty() || layer == "ok" || (layer == "fail" && cur == "unknown"))
                cur = layer;
        }

        json devices = json::array();
        for (const char* key : {"ngfw_devices", "sase_devices"})
            for (const auto& d : site.value(key, json::array()))
                devices.push_back(d);

        for (const auto& d : devices)
        {
            if (!d.is_object())
                continue;
            const std::string oid = d.value("oid", std::string());
            if (oid.empty())
                continue;

            const std::string st = reachable.count(oid) ? reachable[oid] : std::string();
            const std::string reach = (st == "active") ? "ok" : (st == "down" ? "fail" : "unknown");
            const std::string cred = credLayer.count(oid) ? credLayer[oid] : "unknown";
            const std::string apil = apiLayer.count(oid) ? apiLayer[oid] : "unknown";

            out[oid] = {{"reachable", reach}, {"credential", cred}, {"api", apil}};
        }
    }
    catch (const std::exception& e)
    {
        LOG_WARN("device status query failed: {}", e.what());
    }

    fill(resp, 200, out.dump());
}

}

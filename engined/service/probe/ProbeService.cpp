#include "service/probe/ProbeService.h"

#include "router/EnginedTxRouter.h"
#include "service/EnginedServiceManager.h"

#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"

#include "config/Config.h"
#include "db/Database.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <string>
#include <unordered_map>
#include <vector>

namespace pz::engined
{

namespace
{

std::chrono::milliseconds pollInterval()
{
    const auto& p = pz::config::Config::section(pz::config::scope::kPretzel, "probe");
    return std::chrono::seconds(p.value("poll_interval_sec", 30));
}

std::chrono::milliseconds responseTimeout()
{
    const auto& p = pz::config::Config::section(pz::config::scope::kPretzel, "probe");
    return std::chrono::seconds(p.value("response_timeout_sec", 20));
}

}

void ProbeService::start()
{
    m_pending = false;
    m_lastPollAt = {};
    LOG_INFO("ProbeService (engined) start");
}

std::unique_ptr<EnginedEvent> ProbeService::schedule(std::chrono::steady_clock::time_point now)
{
    if (m_pending)
    {
        if (now - m_requestedAt >= responseTimeout())
        {
            LOG_WARN("ProbeResult timed out — clearing pending");
            m_pending = false;
        }
        return nullptr;
    }

    if (m_lastPollAt.time_since_epoch().count() == 0 || now - m_lastPollAt >= pollInterval())
    {
        m_lastPollAt = now;
        return std::make_unique<ProbeEvent>(ProbeEventType::TriggerProbe);
    }

    return nullptr;
}

void ProbeService::handleEvent(EnginedServiceManager& serviceManager, const ProbeEvent& event)
{
    switch (event.type())
    {
    case ProbeEventType::TriggerProbe:
        sendProbeRequest(serviceManager);
        break;

    case ProbeEventType::ReceiveProbeResult:
        onProbeResult(serviceManager, event);
        break;

    case ProbeEventType::ReceiveSaseHealthResult:
        onSaseHealthResult(serviceManager, event);
        break;

    default:
        LOG_WARN("unhandled event (type={})", static_cast<std::uint32_t>(event.type()));
        break;
    }
}

void ProbeService::sendProbeRequest(EnginedServiceManager& serviceManager)
{
    const auto flag = pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request);

    pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Engined, pz::ipc::IpcDaemon::Probed,
                                                          pz::ipc::IpcCmd::ProbeRequest, 0, flag);

    auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));

    m_pending = true;
    m_requestedAt = std::chrono::steady_clock::now();

    LOG_TRACE("sending ProbeRequest to probed");

    serviceManager.txRouter().handleIpcMessage(std::move(msg));
}

void ProbeService::onProbeResult(EnginedServiceManager& serviceManager, const ProbeEvent& event)
{
    m_pending = false;

    const pz::ipc::IpcMessage* msg = event.message();
    if (!msg || msg->getPayload().empty())
    {
        LOG_WARN("empty ProbeResult — keeping previous alive snapshot");
        return;
    }

    const auto& pl = msg->getPayload();
    std::vector<std::string> ips;
    std::uint32_t aliveCount = 0;

    try
    {
        const std::string json(reinterpret_cast<const char*>(pl.data()), pl.size());
        const auto root = nlohmann::json::parse(json);
        aliveCount = root.value("alive", 0u);
        for (const auto& ip : root.value("ips", nlohmann::json::array()))
            ips.push_back(ip.get<std::string>());
    }
    catch (const std::exception& e)
    {
        LOG_WARN("failed to parse ProbeResult (error={})", e.what());
        return;
    }

    LOG_DEBUG("probe complete (alive={}, received_ips={})", aliveCount, ips.size());

    // Keep the device projections in sync with config, then reflect reachability into status.
    projectInventory();

    auto& db = pz::db::Database::instance();
    const std::string alive = nlohmann::json(ips).dump();   // JSON array of alive IPs

    // NGFW: ICMP answered → active, otherwise down.
    db.exec("UPDATE ngfw_device SET status='down' "
            "WHERE target <> ALL(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
            {alive});
    db.exec("UPDATE ngfw_device SET status='active', last_seen=now() "
            "WHERE target = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
            {alive});

    serviceManager.setAliveIps(std::move(ips));
}

void ProbeService::onSaseHealthResult(EnginedServiceManager& serviceManager, const ProbeEvent& event)
{
    (void)serviceManager;

    const pz::ipc::IpcMessage* msg = event.message();
    if (!msg || msg->getPayload().empty())
    {
        LOG_WARN("empty SaseHealthResult — keeping previous SASE snapshot");
        return;
    }

    std::vector<std::string> saseAlive;
    std::vector<std::string> saseDown;
    nlohmann::json saseEgress = nlohmann::json::object();   // target -> last getPrismaAccessIP result

    try
    {
        const auto& pl = msg->getPayload();
        const auto root = nlohmann::json::parse(std::string(reinterpret_cast<const char*>(pl.data()), pl.size()));
        for (const auto& t : root.value("sase_alive", nlohmann::json::array()))
            saseAlive.push_back(t.get<std::string>());
        for (const auto& t : root.value("sase_down", nlohmann::json::array()))
            saseDown.push_back(t.get<std::string>());
        if (root.contains("sase_egress") && root["sase_egress"].is_object())
            saseEgress = root["sase_egress"];
    }
    catch (const std::exception& e)
    {
        LOG_WARN("failed to parse SaseHealthResult (error={})", e.what());
        return;
    }

    // Control-plane probe (getPrismaAccessIP) outcome. Only probed devices appear in these lists;
    // an unconfigured SASE device is in neither and keeps its current (unknown) status. The rows
    // themselves are projected by the ProbeResult path (projectInventory), so this only sets state.
    auto& db = pz::db::Database::instance();
    if (!saseAlive.empty())
        db.exec("UPDATE sase_device SET status='active', last_seen=now() "
                "WHERE target = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
                {nlohmann::json(saseAlive).dump()});
    if (!saseDown.empty())
        db.exec("UPDATE sase_device SET status='down' "
                "WHERE target = ANY(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
                {nlohmann::json(saseDown).dump()});

    // Cache the last egress-IP response per SASE device (inventory / allow-listing).
    for (const auto& [target, result] : saseEgress.items())
        db.exec("UPDATE sase_device SET egress_result = $2::jsonb WHERE target = $1",
                {target, result.dump()});
}

void ProbeService::projectInventory()
{
    const auto& site = pz::config::Config::section(pz::config::scope::kPretzel, "site");
    auto& db = pz::db::Database::instance();

    // Upsert only the config-projected columns; runtime state (status/last_seen/api_key_enc/
    // egress_result) is written elsewhere and must survive a reload, so ON CONFLICT never touches it.
    nlohmann::json ngfwIds = nlohmann::json::array();
    for (const auto& d : site.value("ngfw_devices", nlohmann::json::array()))
    {
        if (!d.is_object())
            continue;
        const std::string oid = d.value("oid", d.value("uuid", d.value("id", std::string())));
        if (oid.empty())
            continue;
        db.exec("INSERT INTO ngfw_device (oid, site, target, name, description, fingerprint) "
                "VALUES ($1,$2,$3,$4,$5,$6) "
                "ON CONFLICT (oid) DO UPDATE SET site=EXCLUDED.site, target=EXCLUDED.target, "
                "name=EXCLUDED.name, description=EXCLUDED.description, fingerprint=EXCLUDED.fingerprint, "
                "updated_at=now()",
                {oid, d.value("site", std::string()), d.value("target", std::string()),
                 d.value("name", std::string()), d.value("description", std::string()),
                 d.value("fingerprint", std::string())});
        ngfwIds.push_back(oid);
    }
    db.exec("DELETE FROM ngfw_device WHERE oid <> ALL(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
            {ngfwIds.dump()});

    nlohmann::json saseIds = nlohmann::json::array();
    for (const auto& d : site.value("sase_devices", nlohmann::json::array()))
    {
        if (!d.is_object())
            continue;
        const std::string oid = d.value("oid", d.value("uuid", d.value("id", std::string())));
        if (oid.empty())
            continue;
        const auto health = d.value("health", nlohmann::json::object());
        const std::string body =
            health.contains("body") ? (health["body"].is_string() ? health["body"].get<std::string>()
                                                                   : health["body"].dump())
                                     : std::string();
        db.exec("INSERT INTO sase_device (oid, site, target, name, description, health_url, health_body) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7) "
                "ON CONFLICT (oid) DO UPDATE SET site=EXCLUDED.site, target=EXCLUDED.target, "
                "name=EXCLUDED.name, description=EXCLUDED.description, health_url=EXCLUDED.health_url, "
                "health_body=EXCLUDED.health_body, updated_at=now()",
                {oid, d.value("site", std::string()), d.value("target", std::string()),
                 d.value("name", std::string()), d.value("description", std::string()),
                 health.value("url", std::string()), body});
        saseIds.push_back(oid);
    }
    db.exec("DELETE FROM sase_device WHERE oid <> ALL(ARRAY(SELECT jsonb_array_elements_text($1::jsonb)))",
            {saseIds.dump()});
}

}

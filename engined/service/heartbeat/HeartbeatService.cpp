#include "service/heartbeat/HeartbeatService.h"

#include "router/EnginedTxRouter.h"
#include "service/EnginedServiceManager.h"

#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"

#include "config/Config.h"
#include "util/Logger.h"

#include <algorithm>
#include <nlohmann/json.hpp>

namespace pz::engined
{

namespace
{

std::chrono::milliseconds pollInterval()
{
    const auto& hb = pz::config::Config::section(pz::config::scope::kPretzel, "heartbeat");
    return std::chrono::seconds(hb.value("poll_interval_sec", 5));
}

std::chrono::milliseconds responseTimeout()
{
    const auto& hb = pz::config::Config::section(pz::config::scope::kPretzel, "heartbeat");
    return std::chrono::seconds(hb.value("response_timeout_sec", 2));
}

}

const std::vector<pz::ipc::IpcDaemon>& HeartbeatService::targets()
{
    static const std::vector<pz::ipc::IpcDaemon> kTargets = {
        pz::ipc::IpcDaemon::Authd,     pz::ipc::IpcDaemon::Probed, pz::ipc::IpcDaemon::Collectord,
        pz::ipc::IpcDaemon::Topologyd, pz::ipc::IpcDaemon::Mgmtd, pz::ipc::IpcDaemon::Apid,
    };
    return kTargets;
}

const std::vector<pz::ipc::IpcDaemon>& HeartbeatService::selfReported()
{
    static const std::vector<pz::ipc::IpcDaemon> kSelfReported = {
        pz::ipc::IpcDaemon::Ipcd,
        pz::ipc::IpcDaemon::Engined,
    };
    return kSelfReported;
}

void HeartbeatService::start()
{
    for (const auto daemon : targets())
    {
        m_daemonMap[daemon] = DaemonEntry{};
    }

    LOG_INFO("heartbeat service started (targets={})", targets().size());
}

std::unique_ptr<EnginedEvent> HeartbeatService::schedule(std::chrono::steady_clock::time_point now)
{
    if (m_roundActive)
    {
        if (now - m_roundStartedAt >= responseTimeout())
        {
            LOG_DEBUG("response timeout, finalizing round");
            markTimeoutsAsDead();
            m_roundActive = false;
            m_pendingCount = 0;
            return std::make_unique<HeartbeatEvent>(HeartbeatEventType::SendHeartbeatResult);
        }
        return nullptr;
    }

    if (m_lastPollAt.time_since_epoch().count() == 0 || now - m_lastPollAt >= pollInterval())
    {
        m_lastPollAt = now;
        return std::make_unique<HeartbeatEvent>(HeartbeatEventType::SendHeartbeatRequests);
    }

    return nullptr;
}

void HeartbeatService::handleEvent(EnginedServiceManager& serviceManager, const HeartbeatEvent& event)
{
    switch (event.type())
    {
    case HeartbeatEventType::SendHeartbeatRequests:
    {
        m_roundActive = true;
        m_roundStartedAt = std::chrono::steady_clock::now();
        m_pendingCount = 0;

        for (auto& [daemon, entry] : m_daemonMap)
        {
            entry.pending = true;
            entry.alive = false;
            entry.latencyMs = -1;
            entry.sentAt = m_roundStartedAt;
            ++m_pendingCount;

            serviceManager.postAction(
                std::make_unique<HeartbeatAction>(HeartbeatActionType::SendHeartbeatRequest, daemon));
        }

        LOG_TRACE("sent heartbeat requests (daemons={})", m_pendingCount);
        break;
    }

    case HeartbeatEventType::ReceiveHeartbeatResponse:
    {
        const auto* msg = event.message();
        if (!msg)
        {
            LOG_WARN("ReceiveHeartbeatResponse has empty message");
            return;
        }

        onHeartbeatResponse(serviceManager, *msg);
        break;
    }

    case HeartbeatEventType::SendHeartbeatResult:
    {
        serviceManager.postAction(
            std::make_unique<HeartbeatAction>(HeartbeatActionType::SendHeartbeatResult, buildResultJson()));
        break;
    }

    default:
        LOG_WARN("unhandled event (type={})", static_cast<std::uint32_t>(event.type()));
        break;
    }
}

void HeartbeatService::handleAction(EnginedServiceManager& serviceManager, const HeartbeatAction& action)
{
    switch (action.type())
    {
    case HeartbeatActionType::SendHeartbeatRequest:
    {
        const auto flag = pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request);

        pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Engined, action.dst(),
                                                              pz::ipc::IpcCmd::HeartbeatRequest, 0, flag);

        auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));

        LOG_TRACE("Tx HeartbeatRequest (dst={})", pz::ipc::IpcProtocol::daemonToStr(action.dst()));

        serviceManager.txRouter().handleIpcMessage(std::move(msg));
        break;
    }

    case HeartbeatActionType::SendHeartbeatResult:
    {
        const auto& jsonStr = action.resultJson();

        const auto flag = pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request);

        pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Engined, pz::ipc::IpcDaemon::Mgmtd,
                                                              pz::ipc::IpcCmd::HeartbeatResult, 0, flag);

        auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));
        msg->setPayload(reinterpret_cast<const std::uint8_t*>(jsonStr.data()), jsonStr.size());

        LOG_TRACE("Tx HeartbeatResult to mgmtd");

        serviceManager.txRouter().handleIpcMessage(std::move(msg));
        break;
    }

    default:
        LOG_WARN("unhandled action (type={})", static_cast<std::uint32_t>(action.type()));
        break;
    }
}

void HeartbeatService::onHeartbeatResponse(EnginedServiceManager& serviceManager, const pz::ipc::IpcMessage& msg)
{
    const pz::ipc::IpcDaemon src = msg.getSrc();

    auto it = m_daemonMap.find(src);
    if (it == m_daemonMap.end())
    {
        LOG_WARN("unexpected response (daemon={})", pz::ipc::IpcProtocol::daemonToStr(src));
        return;
    }

    auto& entry = it->second;

    if (!entry.pending)
    {
        LOG_TRACE("duplicate response (daemon={})", pz::ipc::IpcProtocol::daemonToStr(src));
        return;
    }

    const auto now = std::chrono::steady_clock::now();
    const auto latency = std::chrono::duration_cast<std::chrono::milliseconds>(now - entry.sentAt).count();

    entry.pending = false;
    entry.alive = true;
    entry.latencyMs = latency;
    --m_pendingCount;

    LOG_TRACE("response (daemon={}, latency_ms={})", pz::ipc::IpcProtocol::daemonToStr(src), latency);

    if (m_pendingCount <= 0)
    {
        m_roundActive = false;
        m_pendingCount = 0;
        serviceManager.postEvent(std::make_unique<HeartbeatEvent>(HeartbeatEventType::SendHeartbeatResult));
    }
}

void HeartbeatService::markTimeoutsAsDead()
{
    for (auto& [daemon, entry] : m_daemonMap)
    {
        if (entry.pending)
        {
            entry.pending = false;
            entry.alive = false;
            entry.latencyMs = -1;
            LOG_DEBUG("heartbeat timed out (daemon={})", pz::ipc::IpcProtocol::daemonToStr(daemon));
        }
    }
}

std::string HeartbeatService::buildResultJson() const
{
    using json = nlohmann::json;

    const auto nowMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
            .count();

    json root;
    root["timestamp_ms"] = nowMs;
    root["daemons"] = json::array();

    static const std::vector<pz::ipc::IpcDaemon> kOrder = {
        pz::ipc::IpcDaemon::Ipcd,  pz::ipc::IpcDaemon::Engined,   pz::ipc::IpcDaemon::Authd, pz::ipc::IpcDaemon::Probed,
        pz::ipc::IpcDaemon::Collectord, pz::ipc::IpcDaemon::Topologyd, pz::ipc::IpcDaemon::Mgmtd, pz::ipc::IpcDaemon::Apid,
    };

    const auto& self = selfReported();

    for (const auto daemon : kOrder)
    {
        json entry;
        entry["name"] = pz::ipc::IpcProtocol::daemonToStr(daemon);

        if (std::find(self.begin(), self.end(), daemon) != self.end())
        {
            entry["status"] = "alive";
            entry["latency_ms"] = 0;
            root["daemons"].push_back(std::move(entry));
            continue;
        }

        const auto it = m_daemonMap.find(daemon);

        if (it != m_daemonMap.end() && it->second.alive)
        {
            entry["status"] = "alive";
            entry["latency_ms"] = it->second.latencyMs;
        }
        else
        {
            entry["status"] = "dead";
            entry["latency_ms"] = nullptr;
        }

        root["daemons"].push_back(std::move(entry));
    }

    return root.dump();
}

}

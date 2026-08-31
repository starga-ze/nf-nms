#include "service/bootstrap/BootstrapService.h"

#include "action/EnginedActionFactory.h"
#include "event/EnginedEventFactory.h"
#include "router/EnginedTxRouter.h"
#include "service/EnginedServiceManager.h"
#include "service/commit/CommitEvent.h"

#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"

#include "config/Config.h"

#include "util/Logger.h"

#include <nlohmann/json.hpp>
#include <set>
#include <string>
#include <vector>

namespace pz::engined
{

namespace
{

const nlohmann::json& bootstrapConfig()
{
    return pz::config::Config::section(pz::config::scope::kPretzel, "bootstrap");
}

std::chrono::milliseconds clientHelloInterval()
{
    return std::chrono::seconds(bootstrapConfig().value("client_hello_interval_sec", 1));
}

std::chrono::milliseconds syncRequestInterval()
{
    return std::chrono::seconds(bootstrapConfig().value("sync_request_interval_sec", 1));
}

std::chrono::milliseconds bootWarnInterval()
{
    return std::chrono::seconds(bootstrapConfig().value("bootstrap_timeout_sec", 10));
}

std::chrono::milliseconds reloadTimeout()
{
    return std::chrono::seconds(bootstrapConfig().value("reload_timeout_sec", 20));
}

}

BootstrapService::BootstrapService(EnginedEventFactory* eventFactory, EnginedActionFactory* actionFactory)
    : m_eventFactory(eventFactory), m_actionFactory(actionFactory)
{
}

void BootstrapService::start()
{
    m_state = State::Init;
    m_startedAt = std::chrono::steady_clock::now();
    m_lastClientHelloSentAt = {};
    m_lastSyncRequestSentAt = {};
    m_lastBootWarnAt = {};
    m_reloadStartedAt = {};
    m_isReload = false;
    m_bootstrapped = false;

    initProcessMap();

    LOG_INFO("bootstrap started");
}

std::unique_ptr<EnginedEvent> BootstrapService::schedule(std::chrono::steady_clock::time_point now)
{
    if (!m_eventFactory)
    {
        LOG_ERROR("event factory is not initialized");
        return nullptr;
    }

    switch (m_state)
    {
    case State::Init:
    {
        warnIfBootSlow(now, "Init");

        m_state = State::WaitHandshake;
        m_lastClientHelloSentAt = now;

        LOG_DEBUG("scheduling ClientHello");

        return m_eventFactory->create(EnginedEventDomain::Bootstrap,
                                      static_cast<std::uint32_t>(BootstrapEventType::SendClientHello));
    }

    case State::WaitHandshake:
    {
        warnIfBootSlow(now, "WaitHandshake");

        if (now - m_lastClientHelloSentAt >= clientHelloInterval())
        {
            m_lastClientHelloSentAt = now;

            LOG_DEBUG("retrying ClientHello");

            return m_eventFactory->create(EnginedEventDomain::Bootstrap,
                                          static_cast<std::uint32_t>(BootstrapEventType::SendClientHello));
        }

        return nullptr;
    }

    case State::Reconcile:
    {
        if (m_isReload && now - m_reloadStartedAt >= reloadTimeout())
        {
            LOG_ERROR("reload did not converge in time, abandoning reload — it stays the "
                      "committed intent, daemons adopt it as they restart "
                      "(target_version={}, timeout_s={})",
                      m_targetVersion, std::chrono::duration_cast<std::chrono::seconds>(reloadTimeout()).count());
            m_isReload = false;

            return m_eventFactory->create(EnginedEventDomain::Bootstrap,
                                          static_cast<std::uint32_t>(BootstrapEventType::ReloadFailed));
        }

        if (!m_bootstrapped)
        {
            warnIfBootSlow(now, "Reconcile");
        }

        if (now - m_lastSyncRequestSentAt >= syncRequestInterval())
        {
            m_lastSyncRequestSentAt = now;
            return m_eventFactory->create(EnginedEventDomain::Bootstrap,
                                          static_cast<std::uint32_t>(BootstrapEventType::SendSyncRequest));
        }

        return nullptr;
    }
    }

    return nullptr;
}

bool BootstrapService::isReady() const
{
    return m_bootstrapped;
}

void BootstrapService::handleEvent(EnginedServiceManager& serviceManager, const BootstrapEvent& event)
{
    if (!m_actionFactory)
    {
        LOG_ERROR("action factory is not initialized");
        return;
    }

    switch (event.type())
    {
    case BootstrapEventType::SendClientHello:
    {
        auto action = m_actionFactory->create(EnginedActionDomain::Bootstrap,
                                              static_cast<std::uint32_t>(BootstrapActionType::SendClientHello));

        serviceManager.postAction(std::move(action));
        break;
    }

    case BootstrapEventType::ReceiveServerHello:
    {
        const auto* msg = event.message();
        if (!msg)
        {
            LOG_WARN("received empty ServerHello");
            return;
        }

        onServerHello(serviceManager, *msg);
        break;
    }

    case BootstrapEventType::SendSyncRequest:
    {
        auto action = m_actionFactory->create(EnginedActionDomain::Bootstrap,
                                              static_cast<std::uint32_t>(BootstrapActionType::SendSyncRequest));

        serviceManager.postAction(std::move(action));
        break;
    }

    case BootstrapEventType::ReceiveSyncResponse:
    {
        const auto* msg = event.message();
        if (!msg)
        {
            LOG_WARN("ReceiveSyncResponse has empty message");
            return;
        }

        onSyncResponse(serviceManager, *msg);
        break;
    }

    case BootstrapEventType::SendRuntimeStart:
    {
        auto action = m_actionFactory->create(EnginedActionDomain::Bootstrap,
                                              static_cast<std::uint32_t>(BootstrapActionType::SendRuntimeStart));

        serviceManager.postAction(std::move(action));
        break;
    }

    case BootstrapEventType::ReceiveRuntimeStart:
    {
        break;
    }

    case BootstrapEventType::ReloadFailed:
    {
        auto action = m_actionFactory->create(EnginedActionDomain::Bootstrap,
                                              static_cast<std::uint32_t>(BootstrapActionType::SendReloadFailed));

        serviceManager.postAction(std::move(action));
        break;
    }

    default:
        LOG_WARN("unhandled event (type={})", static_cast<std::uint32_t>(event.type()));
        break;
    }
}

void BootstrapService::handleAction(EnginedServiceManager& serviceManager, const BootstrapAction& action)
{
    std::unique_ptr<pz::ipc::IpcMessage> msg = nullptr;

    switch (action.type())
    {
    case BootstrapActionType::SendClientHello:
    {
        if (m_state != State::WaitHandshake)
        {
            LOG_DEBUG("skip SendClientHello (state={})", static_cast<int>(m_state));
            return;
        }

        LOG_INFO("sent ClientHello, awaiting ServerHello");
        msg = buildClientHelloMessage();
        break;
    }

    case BootstrapActionType::SendSyncRequest:
    {
        if (m_state != State::Reconcile)
        {
            LOG_DEBUG("skip SendSyncRequest (state={})", static_cast<int>(m_state));
            return;
        }

        LOG_TRACE("Tx SyncRequest");
        msg = buildSyncRequestMessage();
        break;
    }

    case BootstrapActionType::SendRuntimeStart:
    {
        LOG_INFO("Tx RuntimeStart, broadcast (target_version={})", m_targetVersion);
        msg = buildRuntimeStartMessage();
        serviceManager.txRouter().handleIpcMessage(std::move(msg));

        for (auto& [daemon, ps] : m_processMap)
        {
            if (ps.connected && ps.appliedVersion >= m_targetVersion)
            {
                ps.blessedGeneration = ps.generation;
            }
        }

        const bool firstConvergence = !m_bootstrapped;
        m_bootstrapped = true;
        if (firstConvergence)
        {
            LOG_INFO("initial convergence complete (target_version={})", m_targetVersion);
        }

        if (m_isReload)
        {
            m_isReload = false;
            LOG_INFO("Tx ConfigReloadResponse(ok) to mgmtd");
            serviceManager.txRouter().handleIpcMessage(buildConfigReloadResponse(true));

            auto doneEvent = serviceManager.eventFactory()->create(
                EnginedEventDomain::Commit, static_cast<std::uint32_t>(CommitEventType::ReloadComplete));
            serviceManager.postEvent(std::move(doneEvent));
        }
        return;
    }

    case BootstrapActionType::SendReloadFailed:
    {
        LOG_INFO("Tx ConfigReloadResponse(failed) to mgmtd");
        serviceManager.txRouter().handleIpcMessage(buildConfigReloadResponse(false));

        auto failEvent = serviceManager.eventFactory()->create(
            EnginedEventDomain::Commit, static_cast<std::uint32_t>(CommitEventType::ReloadFailed));
        serviceManager.postEvent(std::move(failEvent));
        return;
    }

    default:
        LOG_WARN("unhandled action (type={})", static_cast<std::uint32_t>(action.type()));
        return;
    }

    serviceManager.txRouter().handleIpcMessage(std::move(msg));
}

void BootstrapService::onServerHello(EnginedServiceManager& serviceManager, const pz::ipc::IpcMessage& msg)
{
    (void)msg;

    if (m_state != State::WaitHandshake)
    {
        LOG_WARN("ServerHello in unexpected state (state={})", static_cast<int>(m_state));
        return;
    }

    m_state = State::Reconcile;
    m_lastSyncRequestSentAt = std::chrono::steady_clock::now();

    LOG_INFO("handshake complete, entering Reconcile (target_version={})", m_targetVersion);

    auto action = m_actionFactory->create(EnginedActionDomain::Bootstrap,
                                          static_cast<std::uint32_t>(BootstrapActionType::SendSyncRequest));

    serviceManager.postAction(std::move(action));
}

void BootstrapService::onSyncResponse(EnginedServiceManager& serviceManager, const pz::ipc::IpcMessage& msg)
{
    if (m_state != State::Reconcile)
    {
        LOG_WARN("SyncResponse in unexpected state (state={})", static_cast<int>(m_state));
        return;
    }

    if (!updateProcessMap(msg))
    {
        LOG_WARN("SyncResponse parse failed");
        dumpProcessMap();
        return;
    }

    if (!isAllProcessReady())
    {
        LOG_DEBUG("fleet not yet converged (target_version={})", m_targetVersion);
        dumpProcessMap();
        return;
    }

    bool anyUnblessed = false;
    for (const auto& [daemon, ps] : m_processMap)
    {
        if (ps.generation > ps.blessedGeneration)
        {
            anyUnblessed = true;
            break;
        }
    }

    if (!anyUnblessed)
    {
        return;
    }

    // Symmetric with the "fleet not yet converged" path above: dump the now all-ready readiness
    // so the log shows exactly which daemons converged at the moment RuntimeStart is sent, rather
    // than leaving the last not-ready snapshot as the most recent dump.
    LOG_DEBUG("fleet converged, sending RuntimeStart (target_version={})", m_targetVersion);
    dumpProcessMap();

    auto action = m_actionFactory->create(EnginedActionDomain::Bootstrap,
                                          static_cast<std::uint32_t>(BootstrapActionType::SendRuntimeStart));
    serviceManager.postAction(std::move(action));
}

void BootstrapService::warnIfBootSlow(std::chrono::steady_clock::time_point now, const char* stateName)
{
    if (now - m_startedAt < bootWarnInterval())
    {
        return;
    }

    if (m_lastBootWarnAt.time_since_epoch().count() != 0 && now - m_lastBootWarnAt < bootWarnInterval())
    {
        return;
    }

    m_lastBootWarnAt = now;
    LOG_WARN("still waiting on bootstrap, service daemons not yet converged, will keep "
             "retrying (state={}, waited_s={}, target_version={})",
             stateName, std::chrono::duration_cast<std::chrono::seconds>(now - m_startedAt).count(), m_targetVersion);
    dumpProcessMap();
}

void BootstrapService::initProcessMap()
{
    m_processMap.clear();

    m_processMap[pz::ipc::IpcDaemon::Authd] = {false, 0, 0};
    m_processMap[pz::ipc::IpcDaemon::Probed] = {false, 0, 0};
    m_processMap[pz::ipc::IpcDaemon::Collectord] = {false, 0, 0};
    m_processMap[pz::ipc::IpcDaemon::Topologyd] = {false, 0, 0};
    m_processMap[pz::ipc::IpcDaemon::Apid] = {false, 0, 0};
    // The assistant is deliberately absent. pretzel-ai consumes the running config like a service
    // daemon does, but it is not on this fabric — it is reached over gRPC and answers no SyncRequest,
    // so waiting on it here would be waiting forever. Its section is delivered by mgmtd over that
    // gRPC edge (ApplyConfig) instead, and the fleet converges without it.

    m_targetVersion = pz::config::Config::runningConfigVersion();

    LOG_INFO("cold-start target running-config (target_version={})", m_targetVersion);
}

void BootstrapService::scheduleServiceReload()
{
    m_targetVersion = pz::config::Config::runningConfigVersion();

    m_isReload = true;
    m_reloadStartedAt = std::chrono::steady_clock::now();

    LOG_INFO("service-layer reload, converging to running-config (target_version={})", m_targetVersion);
}

bool BootstrapService::updateProcessMap(const pz::ipc::IpcMessage& msg)
{
    const auto& payload = msg.getPayload();
    if (payload.empty())
    {
        LOG_WARN("SyncResponse payload is empty");
        return false;
    }

    try
    {
        const std::string jsonText(reinterpret_cast<const char*>(payload.data()), payload.size());

        const auto root = nlohmann::json::parse(jsonText);

        if (!root.contains("daemons") || !root["daemons"].is_array())
        {
            LOG_WARN("SyncResponse invalid json: missing daemons array");
            return false;
        }

        std::set<pz::ipc::IpcDaemon> reported;

        for (const auto& item : root["daemons"])
        {
            if (!item.contains("daemon") || !item["daemon"].is_string())
            {
                LOG_WARN("SyncResponse daemon item invalid (item={})", item.dump());
                continue;
            }

            const std::string daemonName = item["daemon"].get<std::string>();
            const uint64_t appliedVersion = item.value("applied_version", 0ull);
            const uint32_t generation = item.value("generation", 0u);
            const pz::ipc::IpcDaemon daemon = pz::ipc::IpcProtocol::strToDaemon(daemonName);

            reported.insert(daemon);

            auto it = m_processMap.find(daemon);
            if (it == m_processMap.end())
            {
                LOG_TRACE("ignore unknown daemon (daemon={})", daemonName);
                continue;
            }

            ProcessState& ps = it->second;
            ps.connected = true;
            ps.appliedVersion = appliedVersion;
            ps.generation = generation;
        }

        for (auto& [daemon, ps] : m_processMap)
        {
            if (reported.find(daemon) == reported.end())
            {
                ps.connected = false;
                ps.appliedVersion = 0;
            }
        }
    }
    catch (const std::exception& e)
    {
        LOG_ERROR("SyncResponse json parse failed (error={})", e.what());
        return false;
    }

    return true;
}

bool BootstrapService::isProcessReady(pz::ipc::IpcDaemon daemon) const
{
    const auto it = m_processMap.find(daemon);
    if (it == m_processMap.end())
    {
        return false;
    }

    return it->second.connected && it->second.appliedVersion >= m_targetVersion;
}

bool BootstrapService::isAllProcessReady() const
{
    if (m_processMap.empty())
    {
        LOG_WARN("process map is empty");
        return false;
    }

    for (const auto& [daemon, ps] : m_processMap)
    {
        if (!ps.connected || ps.appliedVersion < m_targetVersion)
        {
            return false;
        }
    }

    return true;
}

void BootstrapService::dumpProcessMap() const
{
    static const std::vector<pz::ipc::IpcDaemon> dumpOrder = {
        pz::ipc::IpcDaemon::Authd,
        pz::ipc::IpcDaemon::Probed,
        pz::ipc::IpcDaemon::Collectord,
        pz::ipc::IpcDaemon::Topologyd,
        pz::ipc::IpcDaemon::Apid
    };

    std::string dump;
    dump += "Process State dump:\n";

    for (const auto daemon : dumpOrder)
    {
        const auto it = m_processMap.find(daemon);
        if (it == m_processMap.end())
        {
            continue;
        }

        const bool converged = it->second.connected && it->second.appliedVersion >= m_targetVersion;
        dump += "  - ";
        dump += pz::ipc::IpcProtocol::daemonToStr(daemon);
        dump += " : ";
        dump += converged ? "ready" : "not-ready";
        dump += " (applied_version=";
        dump += std::to_string(it->second.appliedVersion);
        dump += " target=";
        dump += std::to_string(m_targetVersion);
        dump += " gen=";
        dump += std::to_string(it->second.generation);
        dump += ")\n";
    }

    LOG_DEBUG("{}", dump);
}

std::unique_ptr<pz::ipc::IpcMessage> BootstrapService::buildClientHelloMessage() const
{
    const std::string name = pz::ipc::IpcProtocol::daemonToStr(pz::ipc::IpcDaemon::Engined);

    const auto flag = pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request);

    pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Engined, pz::ipc::IpcDaemon::Ipcd,
                                                          pz::ipc::IpcCmd::ClientHello, 0, flag);

    auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));
    msg->setPayload(reinterpret_cast<const std::uint8_t*>(name.data()), name.size());

    return msg;
}

std::unique_ptr<pz::ipc::IpcMessage> BootstrapService::buildSyncRequestMessage() const
{
    const std::string name = pz::ipc::IpcProtocol::daemonToStr(pz::ipc::IpcDaemon::Engined);

    const auto flag = pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request);

    pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Engined, pz::ipc::IpcDaemon::Ipcd,
                                                          pz::ipc::IpcCmd::SyncRequest, 0, flag);

    auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));
    msg->setPayload(reinterpret_cast<const std::uint8_t*>(name.data()), name.size());

    return msg;
}

std::unique_ptr<pz::ipc::IpcMessage> BootstrapService::buildRuntimeStartMessage() const
{
    nlohmann::json payloadJson;
    payloadJson["daemon"] = pz::ipc::IpcProtocol::daemonToStr(pz::ipc::IpcDaemon::Engined);
    payloadJson["target_version"] = m_targetVersion;
    const std::string payload = payloadJson.dump();

    const auto flag = pz::ipc::IpcProtocol::orFlag(pz::ipc::IpcFlag::Request, pz::ipc::IpcFlag::Broadcast);

    pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Engined, pz::ipc::IpcDaemon::Broadcast,
                                                          pz::ipc::IpcCmd::RuntimeStart, 0, flag);

    auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));
    msg->setPayload(reinterpret_cast<const std::uint8_t*>(payload.data()), payload.size());

    return msg;
}

std::unique_ptr<pz::ipc::IpcMessage> BootstrapService::buildConfigReloadResponse(bool ok) const
{
    auto flag = pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Response);
    if (!ok)
    {
        flag = pz::ipc::IpcProtocol::orFlag(pz::ipc::IpcFlag::Response, pz::ipc::IpcFlag::Error);
    }

    pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Engined, pz::ipc::IpcDaemon::Mgmtd,
                                                          pz::ipc::IpcCmd::ConfigReloadResponse, 0, flag);

    auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));

    nlohmann::json payloadJson;
    payloadJson["ok"] = ok;
    payloadJson["target_version"] = m_targetVersion;
    const std::string payload = payloadJson.dump();
    msg->setPayload(reinterpret_cast<const std::uint8_t*>(payload.data()), payload.size());

    return msg;
}

}

#include "service/bootstrap/BootstrapService.h"

#include "action/ProbedActionFactory.h"
#include "event/ProbedEventFactory.h"
#include "router/ProbedTxRouter.h"
#include "service/ProbedServiceManager.h"

#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"

#include "config/Config.h"

#include "util/Logger.h"

#include <nlohmann/json.hpp>

namespace pz::probed
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

std::chrono::milliseconds runtimeReadyInterval()
{
    return std::chrono::seconds(bootstrapConfig().value("runtime_ready_interval_sec", 1));
}

std::chrono::milliseconds bootstrapTimeout()
{
    return std::chrono::seconds(bootstrapConfig().value("bootstrap_timeout_sec", 10));
}

}

BootstrapService::BootstrapService(ProbedEventFactory* eventFactory, ProbedActionFactory* actionFactory)
    : m_eventFactory(eventFactory), m_actionFactory(actionFactory)
{
}

void BootstrapService::start()
{
    m_state = State::Init;
    m_startedAt = std::chrono::steady_clock::now();
    m_lastClientHelloSentAt = {};
    m_lastRuntimeReadySentAt = {};
    m_bootSlowWarned = false;

    LOG_INFO("bootstrap started");
}

std::unique_ptr<ProbedEvent> BootstrapService::schedule(std::chrono::steady_clock::time_point now)
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
        if (checkTimeout(now, "Init"))
        {
            return nullptr;
        }

        m_state = State::WaitServerHello;
        m_lastClientHelloSentAt = now;

        LOG_DEBUG("scheduling ClientHello");

        return m_eventFactory->create(ProbedEventDomain::Bootstrap,
                                      static_cast<std::uint32_t>(BootstrapEventType::SendClientHello));
    }

    case State::WaitServerHello:
    {
        if (checkTimeout(now, "WaitServerHello"))
        {
            return nullptr;
        }

        if (now - m_lastClientHelloSentAt >= clientHelloInterval())
        {
            m_lastClientHelloSentAt = now;

            LOG_DEBUG("retrying ClientHello");

            return m_eventFactory->create(ProbedEventDomain::Bootstrap,
                                          static_cast<std::uint32_t>(BootstrapEventType::SendClientHello));
        }

        return nullptr;
    }

    case State::WaitRuntimeStart:
    {
        if (checkTimeout(now, "WaitRuntimeStart"))
        {
            return nullptr;
        }

        if (now - m_lastRuntimeReadySentAt >= runtimeReadyInterval())
        {
            m_lastRuntimeReadySentAt = now;

            LOG_DEBUG("retrying RuntimeReady");

            return m_eventFactory->create(ProbedEventDomain::Bootstrap,
                                          static_cast<std::uint32_t>(BootstrapEventType::SendRuntimeReady));
        }

        return nullptr;
    }

    case State::Ready:
    {
        m_state = State::Running;
        LOG_INFO("bootstrap complete (state=Running)");
        return nullptr;
    }

    case State::Running:
    case State::Failed:
        return nullptr;
    }

    return nullptr;
}

bool BootstrapService::isReady() const
{
    return m_state == State::Running;
}

void BootstrapService::handleEvent(ProbedServiceManager& serviceManager, const BootstrapEvent& event)
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
        auto action = m_actionFactory->create(ProbedActionDomain::Bootstrap,
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

    case BootstrapEventType::SendRuntimeReady:
    {
        auto action = m_actionFactory->create(ProbedActionDomain::Bootstrap,
                                              static_cast<std::uint32_t>(BootstrapActionType::SendRuntimeReady));

        serviceManager.postAction(std::move(action));
        break;
    }

    case BootstrapEventType::ReceiveRuntimeStart:
    {
        const auto* msg = event.message();
        if (!msg)
        {
            LOG_WARN("received empty RuntimeStart");
            return;
        }

        onRuntimeStart(*msg);
        break;
    }

    default:
        LOG_WARN("unhandled event (type={})", static_cast<std::uint32_t>(event.type()));
        break;
    }
}

void BootstrapService::handleAction(ProbedServiceManager& serviceManager, const BootstrapAction& action)
{
    std::unique_ptr<pz::ipc::IpcMessage> msg = nullptr;

    switch (action.type())
    {
    case BootstrapActionType::SendClientHello:
    {
        if (m_state != State::WaitServerHello)
        {
            LOG_DEBUG("skip SendClientHello action (state={})", static_cast<int>(m_state));
            return;
        }

        LOG_DEBUG("sent ClientHello, awaiting ServerHello");
        msg = buildClientHelloMessage();
        break;
    }

    case BootstrapActionType::SendRuntimeReady:
    {
        if (m_state != State::WaitRuntimeStart)
        {
            LOG_DEBUG("skip SendRuntimeReady action (state={})", static_cast<int>(m_state));
            return;
        }

        LOG_DEBUG("sent RuntimeReady, awaiting RuntimeStart");
        msg = buildRuntimeReadyMessage();
        break;
    }

    default:
        LOG_WARN("unhandled action (type={})", static_cast<std::uint32_t>(action.type()));
        return;
    }

    serviceManager.txRouter().handleIpcMessage(std::move(msg));
}

void BootstrapService::onServerHello(ProbedServiceManager& serviceManager, const pz::ipc::IpcMessage& msg)
{
    (void)msg;

    if (m_state != State::WaitServerHello)
    {
        LOG_WARN("ServerHello received in unexpected bootstrap state (state={})", static_cast<int>(m_state));
        return;
    }

    m_state = State::WaitRuntimeStart;
    m_lastRuntimeReadySentAt = std::chrono::steady_clock::now();

    LOG_DEBUG("state changed (state=WaitRuntimeStart)");

    auto action = m_actionFactory->create(ProbedActionDomain::Bootstrap,
                                          static_cast<std::uint32_t>(BootstrapActionType::SendRuntimeReady));

    serviceManager.postAction(std::move(action));
}

void BootstrapService::onRuntimeStart(const pz::ipc::IpcMessage& msg)
{
    (void)msg;

    if (m_state != State::WaitRuntimeStart)
    {
        LOG_TRACE("RuntimeStart ignored (already past handshake, state={})", static_cast<int>(m_state));
        return;
    }

    m_state = State::Ready;

    LOG_DEBUG("state changed (state=Ready)");
}

bool BootstrapService::checkTimeout(std::chrono::steady_clock::time_point now, const char* stateName)
{
    if (now - m_startedAt >= bootstrapTimeout() && !m_bootSlowWarned)
    {
        m_bootSlowWarned = true;
        LOG_WARN("still waiting on bootstrap, will keep retrying (state={}, waited_s={})", stateName,
                 std::chrono::duration_cast<std::chrono::seconds>(now - m_startedAt).count());
    }
    return false;
}

std::unique_ptr<pz::ipc::IpcMessage> BootstrapService::buildClientHelloMessage() const
{
    std::string name = pz::ipc::IpcProtocol::daemonToStr(pz::ipc::IpcDaemon::Probed);

    auto flag = pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request);

    pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Probed, pz::ipc::IpcDaemon::Ipcd,
                                                          pz::ipc::IpcCmd::ClientHello, 0, flag);

    auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));
    msg->setPayload(reinterpret_cast<const std::uint8_t*>(name.data()), name.size());

    return msg;
}

std::unique_ptr<pz::ipc::IpcMessage> BootstrapService::buildRuntimeReadyMessage() const
{
    nlohmann::json payloadJson;
    payloadJson["daemon"] = pz::ipc::IpcProtocol::daemonToStr(pz::ipc::IpcDaemon::Probed);
    payloadJson["applied_version"] = pz::config::Config::runningConfigVersion();
    const std::string payload = payloadJson.dump();

    auto flag = pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request);

    pz::ipc::IpcHeader header = pz::ipc::IpcHeader::build(pz::ipc::IpcDaemon::Probed, pz::ipc::IpcDaemon::Ipcd,
                                                          pz::ipc::IpcCmd::RuntimeReady, 0, flag);

    auto msg = std::make_unique<pz::ipc::IpcMessage>(std::move(header));
    msg->setPayload(reinterpret_cast<const std::uint8_t*>(payload.data()), payload.size());

    return msg;
}

}

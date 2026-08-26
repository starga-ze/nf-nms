#include "event/MgmtdEventFactory.h"

#include "service/bootstrap/BootstrapEvent.h"
#include "service/auth/AuthEvent.h"
#include "service/web/WebIpcEvent.h"
#include "service/heartbeat/HeartbeatEvent.h"

#include "util/Logger.h"

namespace pz::mgmtd
{

std::unique_ptr<MgmtdEvent> MgmtdEventFactory::create()
{
    return nullptr;
}

std::unique_ptr<MgmtdEvent> MgmtdEventFactory::create(MgmtdEventDomain domain, std::uint32_t type)
{
    switch (domain)
    {
    case MgmtdEventDomain::Bootstrap:
        return std::make_unique<BootstrapEvent>(static_cast<BootstrapEventType>(type));

    case MgmtdEventDomain::Heartbeat:
        return std::make_unique<HeartbeatEvent>(static_cast<HeartbeatEventType>(type));

    default:
        LOG_WARN("unhandled domain (domain={})", static_cast<std::uint32_t>(domain));
        return nullptr;
    }
}

std::unique_ptr<MgmtdEvent> MgmtdEventFactory::create(std::unique_ptr<pz::ipc::IpcMessage> msg)
{
    if (!msg)
    {
        LOG_DEBUG("received empty message — skipping");
        return nullptr;
    }

    switch (msg->getCmd())
    {
    case pz::ipc::IpcCmd::ServerHello:
        return std::make_unique<BootstrapEvent>(BootstrapEventType::ReceiveServerHello, std::move(msg));

    case pz::ipc::IpcCmd::RuntimeStart:
        return std::make_unique<BootstrapEvent>(BootstrapEventType::ReceiveRuntimeStart, std::move(msg));

    case pz::ipc::IpcCmd::HeartbeatRequest:
        return std::make_unique<HeartbeatEvent>(HeartbeatEventType::ReceiveHeartbeatRequest, std::move(msg));

    case pz::ipc::IpcCmd::HeartbeatResult:
        return std::make_unique<HeartbeatEvent>(HeartbeatEventType::ReceiveHeartbeatResult, std::move(msg));

    case pz::ipc::IpcCmd::ConfigReloadResponse:
        return std::make_unique<BootstrapEvent>(BootstrapEventType::ReceiveConfigReloadResponse, std::move(msg));

    case pz::ipc::IpcCmd::AuthSamlAcsResponse:
        return std::make_unique<AuthEvent>(AuthEventType::ReceiveSamlAcsResponse, std::move(msg));

    // Answers a web-domain controller is waiting on. Each carries on to the controller that owns the
    // route serving it, so the ask and the answer stay in one file.
    case pz::ipc::IpcCmd::TopologyResponse:
        return std::make_unique<WebIpcEvent>(WebIpcEventType::TopologyResponse, std::move(msg));

    case pz::ipc::IpcCmd::SettingsCommitStatus:
        return std::make_unique<WebIpcEvent>(WebIpcEventType::SettingsCommitStatus, std::move(msg));

    case pz::ipc::IpcCmd::ApiConnectorTestResponse:
        return std::make_unique<WebIpcEvent>(WebIpcEventType::ApiConnectorTestResponse, std::move(msg));

    default:
        LOG_WARN("unhandled cmd (cmd={})", static_cast<int>(msg->getCmd()));
        return nullptr;
    }
}

}

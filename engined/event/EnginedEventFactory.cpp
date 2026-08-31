#include "event/EnginedEventFactory.h"

#include "service/admin/AdminEvent.h"
#include "service/apicredential/ApiCredentialEvent.h"
#include "service/bootstrap/BootstrapEvent.h"
#include "service/collection/CollectionEvent.h"
#include "service/commit/CommitEvent.h"
#include "service/heartbeat/HeartbeatEvent.h"
#include "service/probe/ProbeEvent.h"

#include "util/Logger.h"

namespace pz::engined
{

std::unique_ptr<EnginedEvent> EnginedEventFactory::create()
{
    return nullptr;
}

std::unique_ptr<EnginedEvent> EnginedEventFactory::create(EnginedEventDomain domain, std::uint32_t type)
{
    switch (domain)
    {
    case EnginedEventDomain::Bootstrap:
        return std::make_unique<BootstrapEvent>(static_cast<BootstrapEventType>(type));

    case EnginedEventDomain::Heartbeat:
        return std::make_unique<HeartbeatEvent>(static_cast<HeartbeatEventType>(type));

    case EnginedEventDomain::Commit:
        return std::make_unique<CommitEvent>(static_cast<CommitEventType>(type));

    case EnginedEventDomain::Probe:
        return std::make_unique<ProbeEvent>(static_cast<ProbeEventType>(type));

    case EnginedEventDomain::Admin:
        return std::make_unique<AdminEvent>(static_cast<AdminEventType>(type));

    default:
        LOG_WARN("unhandled domain (domain={})", static_cast<std::uint32_t>(domain));
        return nullptr;
    }
}

std::unique_ptr<EnginedEvent> EnginedEventFactory::create(std::unique_ptr<pz::ipc::IpcMessage> msg)
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

    case pz::ipc::IpcCmd::SyncResponse:
        return std::make_unique<BootstrapEvent>(BootstrapEventType::ReceiveSyncResponse, std::move(msg));

    case pz::ipc::IpcCmd::RuntimeStart:
        return std::make_unique<BootstrapEvent>(BootstrapEventType::ReceiveRuntimeStart, std::move(msg));

    case pz::ipc::IpcCmd::HeartbeatResponse:
        return std::make_unique<HeartbeatEvent>(HeartbeatEventType::ReceiveHeartbeatResponse, std::move(msg));

    case pz::ipc::IpcCmd::SettingsCommitRequest:
        return std::make_unique<CommitEvent>(CommitEventType::ReceiveSettingsCommit, std::move(msg));

    case pz::ipc::IpcCmd::ProbeResult:
        return std::make_unique<ProbeEvent>(ProbeEventType::ReceiveProbeResult, std::move(msg));

    case pz::ipc::IpcCmd::SaseHealthResult:
        return std::make_unique<ProbeEvent>(ProbeEventType::ReceiveSaseHealthResult, std::move(msg));

    case pz::ipc::IpcCmd::AdminPasswordUpdate:
        return std::make_unique<AdminEvent>(AdminEventType::ReceivePasswordUpdate, std::move(msg));

    case pz::ipc::IpcCmd::ApiCredentialStateUpdate:
        return std::make_unique<ApiCredentialEvent>(ApiCredentialEventType::ReceiveStateUpdate, std::move(msg));

    case pz::ipc::IpcCmd::ApiCredentialStateRequest:
        return std::make_unique<ApiCredentialEvent>(ApiCredentialEventType::ReceiveStateRequest, std::move(msg));

    case pz::ipc::IpcCmd::ApiCollectionSample:
        return std::make_unique<CollectionEvent>(CollectionEventType::ReceiveSample, std::move(msg));

    case pz::ipc::IpcCmd::SaseApiKeyUpdate:
        return std::make_unique<ApiCredentialEvent>(ApiCredentialEventType::ReceiveSaseApiKey, std::move(msg));

    case pz::ipc::IpcCmd::AiCredentialStateUpdate:
        return std::make_unique<ApiCredentialEvent>(ApiCredentialEventType::ReceiveAiCredential, std::move(msg));

    default:
        LOG_WARN("unhandled cmd (cmd={})", static_cast<int>(msg->getCmd()));
        return nullptr;
    }
}

}

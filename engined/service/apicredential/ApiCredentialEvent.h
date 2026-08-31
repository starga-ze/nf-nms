#pragma once

#include "event/EnginedEvent.h"
#include "ipc/IpcMessage.h"

#include <cstdint>
#include <memory>

namespace pz::engined
{

enum class ApiCredentialEventType : std::uint32_t
{
    Unknown = 0,
    ReceiveStateUpdate = 1,
    ReceiveStateRequest = 2,
    ReceiveSaseApiKey = 3,
    // The assistant's vendor API key, sealed by mgmtd. Same concern as the three above — a
    // secret that arrives already encrypted and lands in a table rather than running_config — so
    // it rides this service instead of earning one of its own.
    ReceiveAiCredential = 4,
};

class ApiCredentialEvent final : public EnginedEvent
{
public:
    explicit ApiCredentialEvent(ApiCredentialEventType type);
    ApiCredentialEvent(ApiCredentialEventType type, std::unique_ptr<pz::ipc::IpcMessage> message);

    void dispatch(EnginedServiceManager& serviceManager) override;

    ApiCredentialEventType type() const;
    const pz::ipc::IpcMessage* message() const;

private:
    ApiCredentialEventType m_type{ApiCredentialEventType::Unknown};
    std::unique_ptr<pz::ipc::IpcMessage> m_message;
};

}

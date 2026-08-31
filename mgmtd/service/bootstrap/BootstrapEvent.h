#pragma once

#include "event/MgmtdEvent.h"
#include "ipc/IpcMessage.h"

#include <cstdint>
#include <memory>

namespace pz::mgmtd
{

enum class BootstrapEventType : std::uint32_t
{
    Unknown = 0,
    SendClientHello = 1,
    ReceiveServerHello = 2,
    ReceiveRuntimeStart = 3,
    // engined reports the fleet has converged onto the committed configuration — or has failed to.
    // The runtime lifecycle is this service's domain either way; a commit reload is the same
    // handshake the daemon already tracks, run again against a new target version.
    ReceiveConfigReloadResponse = 4,
    // This daemon is up and its configuration is loaded. Distinct from ReceiveRuntimeStart, which
    // is engined announcing that the FLEET converged: that one does not fire when mgmtd restarts
    // on its own, and the assistant's config is pushed from here — so relying on it alone left a
    // restarted mgmtd never delivering it.
    Ready = 5
};

class BootstrapEvent final : public MgmtdEvent
{
public:
    explicit BootstrapEvent(BootstrapEventType type);

    BootstrapEvent(BootstrapEventType type, std::unique_ptr<pz::ipc::IpcMessage> message);

    void dispatch(MgmtdServiceManager& serviceManager) override;

    BootstrapEventType type() const;
    const pz::ipc::IpcMessage* message() const;
    std::unique_ptr<pz::ipc::IpcMessage> takeMessage();

private:
    BootstrapEventType m_type{BootstrapEventType::Unknown};
    std::unique_ptr<pz::ipc::IpcMessage> m_message;
};

}

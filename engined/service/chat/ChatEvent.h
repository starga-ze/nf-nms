#pragma once

#include "event/EnginedEvent.h"
#include "ipc/IpcMessage.h"

#include <cstdint>
#include <memory>

namespace pz::engined
{

enum class ChatEventType : std::uint32_t
{
    Unknown = 0,
    ReceiveTurn = 1,
};

// A finished assistant turn arriving from mgmtd, to be persisted. Same shape as CollectionEvent:
// engined is the sole database writer, and mgmtd hands the rows over by IPC rather than writing
// them itself.
class ChatEvent final : public EnginedEvent
{
public:
    explicit ChatEvent(ChatEventType type);
    ChatEvent(ChatEventType type, std::unique_ptr<pz::ipc::IpcMessage> message);

    void dispatch(EnginedServiceManager& serviceManager) override;

    ChatEventType type() const;
    const pz::ipc::IpcMessage* message() const;

private:
    ChatEventType m_type{ChatEventType::Unknown};
    std::unique_ptr<pz::ipc::IpcMessage> m_message;
};

}

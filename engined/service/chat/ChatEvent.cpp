#include "service/chat/ChatEvent.h"

#include "service/EnginedServiceManager.h"

namespace pz::engined
{

ChatEvent::ChatEvent(ChatEventType type)
    : EnginedEvent(EnginedEventDomain::Chat), m_type(type)
{
}

ChatEvent::ChatEvent(ChatEventType type, std::unique_ptr<pz::ipc::IpcMessage> message)
    : EnginedEvent(EnginedEventDomain::Chat), m_type(type), m_message(std::move(message))
{
}

void ChatEvent::dispatch(EnginedServiceManager& serviceManager)
{
    serviceManager.chatService().handleEvent(serviceManager, *this);
}

ChatEventType ChatEvent::type() const
{
    return m_type;
}

const pz::ipc::IpcMessage* ChatEvent::message() const
{
    return m_message.get();
}

}

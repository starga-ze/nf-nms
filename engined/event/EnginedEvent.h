#pragma once

#include "event/Event.h"

#include <cstdint>
#include <memory>

namespace pz::engined
{

class EnginedServiceManager;

enum class EnginedEventDomain : std::uint32_t
{
    Unknown = 0,
    Bootstrap = 1,
    Heartbeat = 2,
    Commit = 3,
    Scan = 4,
    Admin = 5,
    Probe = 6,
    ApiCredential = 7,
    Collection = 8,
    Chat = 9,
};

class EnginedEvent : public pz::event::Event
{
public:
    explicit EnginedEvent(EnginedEventDomain domain);
    ~EnginedEvent() override = default;

    EnginedEventDomain domain() const;

    virtual void dispatch(EnginedServiceManager& serviceManager) = 0;

private:
    EnginedEventDomain m_domain{EnginedEventDomain::Unknown};
};

}

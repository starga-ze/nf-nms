#pragma once

#include "event/Event.h"

#include <cstdint>

namespace pz::apid
{

class ApidServiceManager;

enum class ApidEventDomain : std::uint32_t
{
    Unknown = 0,
    Bootstrap = 1,
    Ingest = 2,
    Heartbeat = 3,
    Reload = 4
};

class ApidEvent : public pz::event::Event
{
public:
    explicit ApidEvent(ApidEventDomain domain);
    ~ApidEvent() override = default;

    ApidEventDomain domain() const;

    virtual void dispatch(ApidServiceManager& serviceManager) = 0;

private:
    ApidEventDomain m_domain{ApidEventDomain::Unknown};
};

}

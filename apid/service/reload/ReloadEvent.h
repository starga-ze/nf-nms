#pragma once

#include "event/ApidEvent.h"

#include <cstdint>

namespace pz::apid
{

enum class ReloadEventType : std::uint32_t
{
    Unknown = 0,
    ReceiveConfigReload = 1,
};

class ReloadEvent final : public ApidEvent
{
public:
    explicit ReloadEvent(ReloadEventType type);

    void dispatch(ApidServiceManager& serviceManager) override;

    ReloadEventType type() const;

private:
    ReloadEventType m_type{ReloadEventType::Unknown};
};

}

#include "service/reload/ReloadService.h"

#include "core/Core.h"
#include "util/Logger.h"

namespace pz::apid
{

void ReloadService::handleEvent(ApidServiceManager&, const ReloadEvent& event)
{
    if (event.type() != ReloadEventType::ReceiveConfigReload)
    {
        return;
    }

    LOG_INFO("config reload received — scheduling daemon restart");
    pz::core::Core::scheduleReload();
}

}

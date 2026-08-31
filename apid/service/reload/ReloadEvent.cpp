#include "service/reload/ReloadEvent.h"

#include "service/ApidServiceManager.h"
#include "service/reload/ReloadService.h"

namespace pz::apid
{

ReloadEvent::ReloadEvent(ReloadEventType type) : ApidEvent(ApidEventDomain::Reload), m_type(type)
{
}

void ReloadEvent::dispatch(ApidServiceManager& serviceManager)
{
    serviceManager.reloadService().handleEvent(serviceManager, *this);
}

ReloadEventType ReloadEvent::type() const
{
    return m_type;
}

}

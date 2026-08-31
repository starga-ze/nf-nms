#pragma once

#include "service/reload/ReloadEvent.h"

namespace pz::apid
{

class ApidServiceManager;

// Adopt a newly committed running configuration.
//
// apid is in engined's convergence set, so a commit is not finished until this daemon reports the
// new version. Without this it never did: the ConfigApply reached the socket, the event factory had
// no case for it, and every settings commit on the appliance timed out after twenty seconds and
// reported a failed reload — while the configuration itself had been committed and was live. A
// convergence set is only as honest as its least responsive member.
class ReloadService
{
public:
    ReloadService() = default;
    ~ReloadService() = default;

    void handleEvent(ApidServiceManager& serviceManager, const ReloadEvent& event);
};

}

#pragma once

#include "service/ServiceManager.h"

#include "action/ApidAction.h"
#include "event/ApidEvent.h"

#include "service/bootstrap/BootstrapService.h"
#include "service/heartbeat/HeartbeatService.h"
#include "service/reload/ReloadService.h"
#include "service/ingest/IngestService.h"

#include "router/ApidTxRouter.h"

#include <memory>
#include <queue>

namespace pz::apid
{

class ApidEventFactory;
class ApidActionFactory;

class ApidServiceManager : public pz::service::ServiceManager<ApidEvent, ApidAction>
{
public:
    ApidServiceManager(ApidEventFactory* eventFactory, ApidActionFactory* actionFactory, ApidTxRouter* txRouter);
    ~ApidServiceManager() override = default;

    void start() override;
    void schedule() override;
    void postEvent(std::unique_ptr<ApidEvent> event) override;
    void postAction(std::unique_ptr<ApidAction> action) override;
    void execute() override;

    BootstrapService& bootstrapService();
    IngestService& ingestService();
    HeartbeatService& heartbeatService();
    ReloadService& reloadService();
    ApidTxRouter& txRouter();

private:
    ApidEventFactory* m_eventFactory{nullptr};
    ApidActionFactory* m_actionFactory{nullptr};
    ApidTxRouter* m_txRouter{nullptr};

    std::unique_ptr<BootstrapService> m_bootstrapService;
    IngestService m_ingestService;
    HeartbeatService m_heartbeatService;
    ReloadService m_reloadService;

    std::queue<std::unique_ptr<ApidEvent>> m_eventQueue;
    std::queue<std::unique_ptr<ApidAction>> m_actionQueue;
};

}

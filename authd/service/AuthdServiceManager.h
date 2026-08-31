#pragma once

#include "service/ServiceManager.h"

#include "service/auth/AuthService.h"
#include "service/bootstrap/BootstrapService.h"
#include "service/heartbeat/HeartbeatService.h"
#include "service/reload/ReloadService.h"

#include "router/AuthdTxRouter.h"

#include <nlohmann/json_fwd.hpp>

#include <queue>

namespace pz::authd
{

class AuthdEventFactory;
class AuthdActionFactory;

class AuthdServiceManager : public pz::service::ServiceManager<AuthdEvent, AuthdAction>
{
public:
    AuthdServiceManager(AuthdEventFactory* eventFactory, AuthdActionFactory* actionFactory, AuthdTxRouter* txRouter);
    ~AuthdServiceManager() override = default;

    void start() override;

    // The `auth` domain itself, not a document to dig through.
    void configure(const nlohmann::json& authConfig);

    void schedule() override;
    void postEvent(std::unique_ptr<AuthdEvent> event) override;
    void postAction(std::unique_ptr<AuthdAction> action) override;
    void execute() override;

    BootstrapService& bootstrapService();
    HeartbeatService& heartbeatService();
    ReloadService& reloadService();
    AuthService& authService();

    AuthdTxRouter& txRouter();

private:
    AuthdEventFactory* m_eventFactory;
    AuthdActionFactory* m_actionFactory;
    AuthdTxRouter* m_txRouter;

    std::unique_ptr<BootstrapService> m_bootstrapService;
    std::unique_ptr<HeartbeatService> m_heartbeatService;
    std::unique_ptr<ReloadService> m_reloadService;
    std::unique_ptr<AuthService> m_authService;

    std::queue<std::unique_ptr<AuthdEvent>> m_eventQueue;
    std::queue<std::unique_ptr<AuthdAction>> m_actionQueue;
};

}

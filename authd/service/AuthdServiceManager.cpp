#include "service/AuthdServiceManager.h"

#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <chrono>

namespace pz::authd
{

AuthdServiceManager::AuthdServiceManager(AuthdEventFactory* eventFactory, AuthdActionFactory* actionFactory,
                                         AuthdTxRouter* txRouter)
    : m_eventFactory(eventFactory), m_actionFactory(actionFactory), m_txRouter(txRouter),
      m_bootstrapService(std::make_unique<BootstrapService>(m_eventFactory, m_actionFactory)),
      m_heartbeatService(std::make_unique<HeartbeatService>()), m_reloadService(std::make_unique<ReloadService>()),
      m_authService(std::make_unique<AuthService>())
{
}

void AuthdServiceManager::start()
{
    m_bootstrapService->start();
}

void AuthdServiceManager::configure(const nlohmann::json& authConfig)
{
    m_authService->configure(authConfig.is_object() ? authConfig : nlohmann::json::object());
}

void AuthdServiceManager::schedule()
{
    const auto now = std::chrono::steady_clock::now();

    if (!m_bootstrapService->isReady())
    {
        postEvent(m_bootstrapService->schedule(now));
        return;
    }
}

void AuthdServiceManager::postEvent(std::unique_ptr<AuthdEvent> event)
{
    if (!event)
    {
        return;
    }

    m_eventQueue.push(std::move(event));
}

void AuthdServiceManager::postAction(std::unique_ptr<AuthdAction> action)
{
    if (!action)
    {
        return;
    }

    m_actionQueue.push(std::move(action));
}

void AuthdServiceManager::execute()
{
    while (!m_eventQueue.empty() or !m_actionQueue.empty())
    {
        if (!m_eventQueue.empty())
        {
            std::unique_ptr<AuthdEvent> event = std::move(m_eventQueue.front());
            m_eventQueue.pop();
            event->dispatch(*this);
        }
        else if (!m_actionQueue.empty())
        {
            std::unique_ptr<AuthdAction> action = std::move(m_actionQueue.front());
            m_actionQueue.pop();
            action->dispatch(*this);
        }
    }
}

BootstrapService& AuthdServiceManager::bootstrapService()
{
    return *m_bootstrapService;
}

HeartbeatService& AuthdServiceManager::heartbeatService()
{
    return *m_heartbeatService;
}

ReloadService& AuthdServiceManager::reloadService()
{
    return *m_reloadService;
}

AuthService& AuthdServiceManager::authService()
{
    return *m_authService;
}

AuthdTxRouter& AuthdServiceManager::txRouter()
{
    return *m_txRouter;
}

}

#include "service/ApidServiceManager.h"

#include "util/Logger.h"

#include <chrono>

namespace pz::apid
{

ApidServiceManager::ApidServiceManager(ApidEventFactory* eventFactory, ApidActionFactory* actionFactory,
                                       ApidTxRouter* txRouter)
    : m_eventFactory(eventFactory), m_actionFactory(actionFactory), m_txRouter(txRouter),
      m_bootstrapService(std::make_unique<BootstrapService>(m_eventFactory, m_actionFactory))
{
}

void ApidServiceManager::start()
{
    m_bootstrapService->start();
}

void ApidServiceManager::schedule()
{
    const auto now = std::chrono::steady_clock::now();

    if (!m_bootstrapService->isReady())
    {
        postEvent(m_bootstrapService->schedule(now));
        return;
    }
}

void ApidServiceManager::postEvent(std::unique_ptr<ApidEvent> event)
{
    if (!event)
    {
        return;
    }

    m_eventQueue.push(std::move(event));
}

void ApidServiceManager::postAction(std::unique_ptr<ApidAction> action)
{
    if (!action)
    {
        return;
    }

    m_actionQueue.push(std::move(action));
}

void ApidServiceManager::execute()
{
    while (!m_eventQueue.empty() || !m_actionQueue.empty())
    {
        if (!m_eventQueue.empty())
        {
            std::unique_ptr<ApidEvent> event = std::move(m_eventQueue.front());
            m_eventQueue.pop();
            event->dispatch(*this);
        }
        else if (!m_actionQueue.empty())
        {
            std::unique_ptr<ApidAction> action = std::move(m_actionQueue.front());
            m_actionQueue.pop();
            action->dispatch(*this);
        }
    }
}

BootstrapService& ApidServiceManager::bootstrapService()
{
    return *m_bootstrapService;
}

IngestService& ApidServiceManager::ingestService()
{
    return m_ingestService;
}

HeartbeatService& ApidServiceManager::heartbeatService()
{
    return m_heartbeatService;
}

ReloadService& ApidServiceManager::reloadService()
{
    return m_reloadService;
}

ApidTxRouter& ApidServiceManager::txRouter()
{
    return *m_txRouter;
}

}

#include "service/EnginedServiceManager.h"

#include "util/Logger.h"

#include <chrono>

namespace pz::engined
{

EnginedServiceManager::EnginedServiceManager(EnginedEventFactory* eventFactory, EnginedActionFactory* actionFactory,
                                             EnginedTxRouter* txRouter)
    : m_eventFactory(eventFactory), m_actionFactory(actionFactory), m_txRouter(txRouter),
      m_bootstrapService(std::make_unique<BootstrapService>(m_eventFactory, m_actionFactory)),
      m_commitService(std::make_unique<CommitService>()), m_heartbeatService(std::make_unique<HeartbeatService>()),
      m_probeService(std::make_unique<ProbeService>()), m_adminService(std::make_unique<AdminService>()),
      m_apiCredentialService(std::make_unique<ApiCredentialService>()),
      m_collectionService(std::make_unique<CollectionService>()),
      m_chatService(std::make_unique<ChatService>()),
      m_logTailService(std::make_unique<LogTailService>()),
      m_vendorResolver(std::make_unique<VendorResolver>())
{
}

void EnginedServiceManager::start()
{
    m_vendorResolver->loadOui();
    m_bootstrapService->start();
    m_heartbeatService->start();
    m_probeService->start();
    m_logTailService->start();
}

void EnginedServiceManager::schedule()
{
    const auto now = std::chrono::steady_clock::now();

    postEvent(m_bootstrapService->schedule(now));

    if (!m_bootstrapService->isReady())
    {
        return;
    }

    postEvent(m_heartbeatService->schedule(now));
    postEvent(m_probeService->schedule(now));

    // Self-contained: reads the daemon log files and writes system_log directly on this thread, so it
    // posts no event — just runs when the DB is up (guaranteed past the bootstrap gate above).
    m_logTailService->poll(now);
}

void EnginedServiceManager::postEvent(std::unique_ptr<EnginedEvent> event)
{
    if (!event)
    {
        return;
    }

    m_eventQueue.push(std::move(event));
}

void EnginedServiceManager::postAction(std::unique_ptr<EnginedAction> action)
{
    if (!action)
    {
        return;
    }

    m_actionQueue.push(std::move(action));
}

void EnginedServiceManager::execute()
{
    while (!m_eventQueue.empty() or !m_actionQueue.empty())
    {
        if (!m_eventQueue.empty())
        {
            std::unique_ptr<EnginedEvent> event = std::move(m_eventQueue.front());
            m_eventQueue.pop();
            event->dispatch(*this);
        }
        else if (!m_actionQueue.empty())
        {
            std::unique_ptr<EnginedAction> action = std::move(m_actionQueue.front());
            m_actionQueue.pop();
            action->dispatch(*this);
        }
    }
}

BootstrapService& EnginedServiceManager::bootstrapService()
{
    return *m_bootstrapService;
}

CommitService& EnginedServiceManager::commitService()
{
    return *m_commitService;
}

HeartbeatService& EnginedServiceManager::heartbeatService()
{
    return *m_heartbeatService;
}

ProbeService& EnginedServiceManager::probeService()
{
    return *m_probeService;
}

VendorResolver& EnginedServiceManager::vendorResolver()
{
    return *m_vendorResolver;
}

const std::vector<std::string>& EnginedServiceManager::aliveIps() const
{
    return m_aliveIps;
}

void EnginedServiceManager::setAliveIps(std::vector<std::string> ips)
{
    m_aliveIps = std::move(ips);
}

AdminService& EnginedServiceManager::adminService()
{
    return *m_adminService;
}

ApiCredentialService& EnginedServiceManager::apiCredentialService()
{
    return *m_apiCredentialService;
}

CollectionService& EnginedServiceManager::collectionService()
{
    return *m_collectionService;
}

ChatService& EnginedServiceManager::chatService()
{
    return *m_chatService;
}

LogTailService& EnginedServiceManager::logTailService()
{
    return *m_logTailService;
}

EnginedTxRouter& EnginedServiceManager::txRouter()
{
    return *m_txRouter;
}

EnginedEventFactory* EnginedServiceManager::eventFactory()
{
    return m_eventFactory;
}

EnginedActionFactory* EnginedServiceManager::actionFactory()
{
    return m_actionFactory;
}

}

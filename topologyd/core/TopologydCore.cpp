#include "TopologydCore.h"
#include "util/Logger.h"

namespace pz::topologyd
{

TopologydCore::TopologydCore() : Core("topologyd")
{
}

bool TopologydCore::onInit()
{
    LOG_INFO("topologyd: starting up");

    m_threadManager = std::make_unique<pz::util::ThreadManager>();
    if (!m_threadManager)
    {
        LOG_ERROR("failed to initialize thread manager");
        return false;
    }

    m_ipcClient = std::make_unique<pz::ipc::IpcClient>(ipcConfig(), pz::ipc::IpcDaemon::Topologyd);

    if (!m_ipcClient->init())
    {
        LOG_ERROR("failed to initialize IPC client");
        return false;
    }

    m_eventFactory = std::make_unique<TopologydEventFactory>();
    m_actionFactory = std::make_unique<TopologydActionFactory>();

    m_rxRouter = std::make_unique<TopologydRxRouter>(m_eventFactory.get());
    m_txRouter = std::make_unique<TopologydTxRouter>(m_ipcClient->handler());

    if (!m_txRouter or !m_rxRouter)
    {
        LOG_ERROR("failed to initialize IPC router");
        return false;
    }

    m_serviceManager =
        std::make_unique<TopologydServiceManager>(m_eventFactory.get(), m_actionFactory.get(), m_txRouter.get());

    if (!m_serviceManager)
    {
        LOG_ERROR("TopologydServiceManager init failed");
        return false;
    }

    m_process = std::make_unique<TopologydProcess>(m_ipcClient.get(), m_serviceManager.get());

    if (!m_process)
    {
        LOG_ERROR("TopologydProcess init failed");
        return false;
    }

    m_ipcClient->handler()->setRxRouter(m_rxRouter.get());
    m_rxRouter->setServiceManager(m_serviceManager.get());

    return true;
}

void TopologydCore::onLoop()
{
    if (!m_process->start())
    {
        LOG_ERROR("process failed to start");
        return;
    }

    while (!stopping())
    {
        checkReload();
        m_process->tick();
    }
}

void TopologydCore::onShutdown()
{
    LOG_INFO("shutting down");

    if (m_threadManager)
    {
        m_threadManager->stopAll();
    }

    LOG_INFO("all threads stopped");

    pz::util::Logger::Shutdown();
}

}

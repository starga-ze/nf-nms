#include "CollectordCore.h"
#include "util/Logger.h"

namespace pz::collectord
{

CollectordCore::CollectordCore() : Core("collectord")
{
}

bool CollectordCore::onInit()
{
    LOG_INFO("collectord: starting up");

    m_threadManager = std::make_unique<pz::util::ThreadManager>();
    if (!m_threadManager)
    {
        LOG_ERROR("failed to initialize thread manager");
        return false;
    }

    m_ipcClient = std::make_unique<pz::ipc::IpcClient>(ipcConfig(), pz::ipc::IpcDaemon::Collectord);

    if (!m_ipcClient->init())
    {
        LOG_ERROR("failed to initialize IPC client");
        return false;
    }

    m_eventFactory = std::make_unique<CollectordEventFactory>();
    m_actionFactory = std::make_unique<CollectordActionFactory>();

    m_rxRouter = std::make_unique<CollectordRxRouter>(m_eventFactory.get());
    m_txRouter = std::make_unique<CollectordTxRouter>(m_ipcClient->handler());

    if (!m_txRouter or !m_rxRouter)
    {
        LOG_ERROR("failed to initialize IPC router");
        return false;
    }

    m_ioContext = std::make_unique<boost::asio::io_context>();

    m_serviceManager = std::make_unique<CollectordServiceManager>(m_eventFactory.get(), m_actionFactory.get(),
                                                             m_txRouter.get(), m_ioContext.get());

    if (!m_serviceManager)
    {
        LOG_ERROR("failed to initialize service manager");
        return false;
    }

    m_process = std::make_unique<CollectordProcess>(m_ipcClient.get(), m_serviceManager.get(), m_ioContext.get());

    if (!m_process)
    {
        LOG_ERROR("failed to initialize process");
        return false;
    }

    m_ipcClient->handler()->setRxRouter(m_rxRouter.get());
    m_rxRouter->setServiceManager(m_serviceManager.get());

    return true;
}

void CollectordCore::onLoop()
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

void CollectordCore::onShutdown()
{
    LOG_INFO("shutting down");

    if (m_threadManager)
        m_threadManager->stopAll();

    LOG_INFO("all threads stopped");

    pz::util::Logger::Shutdown();
}

}

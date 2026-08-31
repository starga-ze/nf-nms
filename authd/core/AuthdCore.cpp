#include "AuthdCore.h"
#include "util/Logger.h"

namespace pz::authd
{

AuthdCore::AuthdCore() : Core("authd")
{
}

bool AuthdCore::onInit()
{
    LOG_INFO("authd: starting up");

    m_threadManager = std::make_unique<pz::util::ThreadManager>();
    if (!m_threadManager)
    {
        LOG_ERROR("failed to initialize thread manager");
        return false;
    }

    m_ipcClient = std::make_unique<pz::ipc::IpcClient>(ipcConfig(), pz::ipc::IpcDaemon::Authd);

    if (!m_ipcClient->init())
    {
        LOG_ERROR("failed to initialize IPC client");
        return false;
    }

    m_eventFactory = std::make_unique<AuthdEventFactory>();
    m_actionFactory = std::make_unique<AuthdActionFactory>();

    m_rxRouter = std::make_unique<AuthdRxRouter>(m_eventFactory.get());
    m_txRouter = std::make_unique<AuthdTxRouter>(m_ipcClient->handler());

    if (!m_txRouter or !m_rxRouter)
    {
        LOG_ERROR("failed to initialize IPC router");
        return false;
    }

    m_serviceManager =
        std::make_unique<AuthdServiceManager>(m_eventFactory.get(), m_actionFactory.get(), m_txRouter.get());

    if (!m_serviceManager)
    {
        LOG_ERROR("failed to initialize service manager");
        return false;
    }

    m_serviceManager->configure(pz::config::Config::section(pz::config::scope::kPretzel, "auth"));

    m_process = std::make_unique<AuthdProcess>(m_ipcClient.get(), m_serviceManager.get());

    if (!m_process)
    {
        LOG_ERROR("failed to initialize process");
        return false;
    }

    m_ipcClient->handler()->setRxRouter(m_rxRouter.get());

    m_rxRouter->setServiceManager(m_serviceManager.get());

    return true;
}

void AuthdCore::onLoop()
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

void AuthdCore::onShutdown()
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

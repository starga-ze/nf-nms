#include "ProbedCore.h"
#include "util/Logger.h"

namespace pz::probed
{

ProbedCore::ProbedCore() : Core("probed")
{
}

bool ProbedCore::onInit()
{
    LOG_INFO("probed: starting up");

    m_ipcClient = std::make_unique<pz::ipc::IpcClient>(ipcConfig(), pz::ipc::IpcDaemon::Probed);

    if (!m_ipcClient->init())
    {
        LOG_ERROR("failed to initialize IPC client");
        return false;
    }

    m_icmpEngine = std::make_unique<IcmpEngine>();

    if (!m_icmpEngine->init())
    {
        LOG_ERROR("IcmpEngine init failed");
        return false;
    }

    m_eventFactory = std::make_unique<ProbedEventFactory>();
    m_actionFactory = std::make_unique<ProbedActionFactory>();

    m_rxRouter = std::make_unique<ProbedRxRouter>(m_eventFactory.get());
    m_txRouter = std::make_unique<ProbedTxRouter>(m_ipcClient->handler(), m_icmpEngine->handler());

    if (!m_txRouter or !m_rxRouter)
    {
        LOG_ERROR("failed to initialize IPC router");
        return false;
    }

    m_ioContext = std::make_unique<boost::asio::io_context>();

    m_serviceManager = std::make_unique<ProbedServiceManager>(m_eventFactory.get(), m_actionFactory.get(),
                                                              m_txRouter.get(), m_ioContext.get());
    if (!m_serviceManager)
    {
        LOG_ERROR("failed to initialize service manager");
        return false;
    }

    m_process = std::make_unique<ProbedProcess>(m_ipcClient.get(), m_icmpEngine.get(), m_serviceManager.get(),
                                                m_ioContext.get());

    if (!m_process)
    {
        LOG_ERROR("failed to initialize process");
        return false;
    }

    m_ipcClient->handler()->setRxRouter(m_rxRouter.get());
    m_icmpEngine->handler()->setRxRouter(m_rxRouter.get());

    m_rxRouter->setServiceManager(m_serviceManager.get());

    return true;
}

void ProbedCore::onLoop()
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

void ProbedCore::onShutdown()
{
    LOG_INFO("shutting down");

    pz::util::Logger::Shutdown();
}

}

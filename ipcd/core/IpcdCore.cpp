#include "IpcdCore.h"
#include "util/Logger.h"

namespace pz::ipcd
{

IpcdCore::IpcdCore() : Core("ipcd")
{
}

bool IpcdCore::onInit()
{
    LOG_INFO("ipcd: starting up");

    m_ipcServer = std::make_unique<IpcServer>(ipcConfig(), pz::ipc::IpcDaemon::Ipcd);
    if (!m_ipcServer->init())
    {
        LOG_ERROR("failed to initialize IPC server");
        return false;
    }

    m_eventFactory = std::make_unique<IpcdEventFactory>();
    m_actionFactory = std::make_unique<IpcdActionFactory>();

    m_txRouter = std::make_unique<IpcdTxRouter>(m_ipcServer->handler());

    m_serviceManager = std::make_unique<IpcdServiceManager>(m_eventFactory.get(), m_actionFactory.get(),
                                                            m_ipcServer->handler(), m_txRouter.get());

    if (!m_serviceManager)
    {
        LOG_ERROR("failed to initialize service manager");
        return false;
    }

    m_rxRouter = std::make_unique<IpcdRxRouter>(m_eventFactory.get(), m_serviceManager.get(), m_txRouter.get());

    if (!m_rxRouter)
    {
        LOG_ERROR("failed to initialize RX router");
        return false;
    }

    m_process = std::make_unique<IpcdProcess>(m_ipcServer.get(), m_serviceManager.get());
    if (!m_process)
    {
        LOG_ERROR("failed to initialize process");
        return false;
    }

    m_ipcServer->handler()->setRxRouter(m_rxRouter.get());

    return true;
}

void IpcdCore::onLoop()
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

void IpcdCore::onShutdown()
{
    LOG_INFO("ipcd: shutting down");

    pz::util::Logger::Shutdown();
}

}

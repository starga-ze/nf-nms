#include "EnginedCore.h"
#include "util/Logger.h"

#include <iostream>

namespace pz::engined
{

EnginedCore::EnginedCore() : Core("engined")
{
}

void EnginedCore::onPreConfigLoad()
{
    m_preflighted = pz::config::Config::preflight();
    if (!m_preflighted)
    {
        std::cerr << "engined: config store preflight failed — continuing on "
                     "startup-config fallback; will retry once the DB is reachable"
                  << std::endl;
    }
}

bool EnginedCore::onInit()
{
    LOG_INFO("engined: starting up");

    m_ipcClient = std::make_unique<pz::ipc::IpcClient>(ipcConfig(), pz::ipc::IpcDaemon::Engined);

    if (!m_ipcClient->init())
    {
        LOG_ERROR("failed to initialize IPC client");
        return false;
    }

    m_eventFactory = std::make_unique<EnginedEventFactory>();
    m_actionFactory = std::make_unique<EnginedActionFactory>();

    m_txRouter = std::make_unique<EnginedTxRouter>(m_ipcClient->handler());

    m_serviceManager =
        std::make_unique<EnginedServiceManager>(m_eventFactory.get(), m_actionFactory.get(), m_txRouter.get());

    if (!m_serviceManager)
    {
        LOG_ERROR("failed to initialize service manager");
        return false;
    }

    m_rxRouter = std::make_unique<EnginedRxRouter>(m_eventFactory.get(), m_serviceManager.get());

    if (!m_rxRouter)
    {
        LOG_ERROR("failed to initialize RX router");
        return false;
    }

    m_process = std::make_unique<EnginedProcess>(m_ipcClient.get(), m_serviceManager.get());

    if (!m_process)
    {
        LOG_ERROR("failed to initialize process");
        return false;
    }

    m_ipcClient->handler()->setRxRouter(m_rxRouter.get());

    return true;
}

void EnginedCore::onLoop()
{
    if (!m_process->start())
    {
        LOG_ERROR("process failed to start");
        return;
    }

    while (!stopping())
    {
        checkReload();
        ensureStorePreflighted();
        m_process->tick();
    }
}

void EnginedCore::ensureStorePreflighted()
{
    if (m_preflighted)
    {
        return;
    }

    const auto now = std::chrono::steady_clock::now();
    if (m_lastPreflightAttempt != std::chrono::steady_clock::time_point{} &&
        now - m_lastPreflightAttempt < std::chrono::seconds(3))
    {
        return;
    }
    m_lastPreflightAttempt = now;

    if (!pz::config::Config::preflight())
    {
        LOG_WARN("config store preflight retry failed — DB still unavailable");
        return;
    }

    m_preflighted = true;

    pz::config::Config::invalidateConfigCache();

    LOG_INFO("config store preflighted after DB became reachable");
}

void EnginedCore::onShutdown()
{
    LOG_INFO("shutting down");

    pz::util::Logger::Shutdown();
}

}

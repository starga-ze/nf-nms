#include "core/ApidCore.h"

#include "http/HttpHandler.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <chrono>
#include <thread>

namespace pz::apid
{

ApidCore::ApidCore() : Core("apid")
{
}

bool ApidCore::onInit()
{
    LOG_INFO("apid: starting up");

    if (!loadHttpConfig())
    {
        return false;
    }

    m_ipcClient = std::make_unique<pz::ipc::IpcClient>(ipcConfig(), pz::ipc::IpcDaemon::Apid);
    if (!m_ipcClient->init())
    {
        LOG_WARN("IPC client unavailable — ingest edge runs, reports are not forwarded");
        m_ipcClient.reset();
    }

    m_eventFactory = std::make_unique<ApidEventFactory>();
    m_actionFactory = std::make_unique<ApidActionFactory>();

    auto httpHandler = std::make_shared<pz::http::HttpHandler>();

    m_txRouter = std::make_unique<ApidTxRouter>(m_ipcClient ? m_ipcClient->handler() : nullptr, httpHandler.get());

    m_serviceManager =
        std::make_unique<ApidServiceManager>(m_eventFactory.get(), m_actionFactory.get(), m_txRouter.get());

    m_rxRouter = std::make_unique<ApidRxRouter>(m_eventFactory.get(), m_serviceManager.get());

    if (m_ipcClient)
    {
        m_ipcClient->handler()->setRxRouter(m_rxRouter.get());
    }
    httpHandler->setRxRouter(m_rxRouter.get());

    m_httpServer = std::make_unique<pz::http::HttpServer>(m_httpConfig.listenAddress, m_httpConfig.listenPort,
                                                          m_httpConfig.tlsEnabled, m_httpConfig.certFile,
                                                          m_httpConfig.keyFile, "pz-apid", std::move(httpHandler));
    if (!m_httpServer || !m_httpServer->init())
    {
        LOG_ERROR("failed to initialize HTTP server");
        return false;
    }

    m_process = std::make_unique<ApidProcess>(m_ipcClient.get(), m_httpServer.get(), m_serviceManager.get());
    return true;
}

void ApidCore::onLoop()
{
    if (!m_process->start())
    {
        LOG_ERROR("failed to start process");
        return;
    }

    while (!stopping())
    {
        // Every other daemon's loop pumps this; apid's did not, which is why a ConfigApply here
        // set the reload flag and nothing ever consumed it. The daemon stayed on the version it
        // booted with and engined waited out the whole reload timeout on it.
        checkReload();
        m_process->tick();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void ApidCore::onShutdown()
{
    LOG_INFO("shutting down");

    if (m_httpServer)
    {
        m_httpServer->stop();
    }

    pz::util::Logger::Shutdown();
}

bool ApidCore::loadHttpConfig()
{
    // `api` rather than `http`: the appliance has two listeners, and naming them by protocol left
    // two domains called the same thing in two daemon sections. This one is the northbound API.
    const auto& http = pz::config::Config::section(pz::config::scope::kPretzel, "api");

    // Refused rather than defaulted, for the reason MgmtdCore::loadHttpConfig gives: a listener
    // bound to a guessed port is an ingest edge that nothing is sending to, reporting itself
    // healthy. Restart=always retries until engined has seeded the config.
    if (http.empty())
    {
        LOG_ERROR("no 'api' domain in the running configuration — refusing to start rather than "
                  "binding a guessed address. If engined is still seeding, the restart will pick "
                  "it up");
        return false;
    }
    m_httpConfig.listenAddress = http.value("listen_address", "0.0.0.0");
    m_httpConfig.listenPort = static_cast<std::uint16_t>(http.value("listen_port", 8443));
    m_httpConfig.tlsEnabled = http.value("tls_enabled", false);
    m_httpConfig.certFile = http.value("cert_file", "");
    m_httpConfig.keyFile = http.value("key_file", "");

    return true;
}

}

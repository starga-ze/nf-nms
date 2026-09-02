#include "core/MgmtdCore.h"
#include "service/ai/AiConfig.h"

#include "http/HttpHandler.h"
#include "http/StaticFileCache.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <chrono>
#include <cstdlib>
#include <thread>

namespace
{

std::string shareDir()
{
    const char* value = std::getenv("PRETZEL_SHARE_DIR");
    return (value && *value) ? std::string(value) : "/opt/pretzel/share";
}

}

namespace pz::mgmtd
{

MgmtdCore::MgmtdCore() : Core("mgmtd")
{
}

bool MgmtdCore::onInit()
{
    LOG_INFO("mgmtd: starting up");

    if (!loadHttpConfig())
    {
        return false;
    }

    m_ipcClient = std::make_unique<pz::ipc::IpcClient>(ipcConfig(), pz::ipc::IpcDaemon::Mgmtd);
    if (!m_ipcClient->init())
    {
        LOG_WARN("IPC client unavailable — running in metrics-only mode");
        m_ipcClient.reset();
    }

    m_eventFactory = std::make_unique<MgmtdEventFactory>();
    m_actionFactory = std::make_unique<MgmtdActionFactory>();

    auto httpHandler = std::make_shared<pz::http::HttpHandler>();

    // The pretzel-ai inference service address. An env override for labs and split deploys; the
    // loopback default is where the service runs when it is co-located with mgmtd.
    const char* aiTargetEnv = std::getenv("PZ_PRETZEL_AI_TARGET");
    const std::string aiTarget = (aiTargetEnv && *aiTargetEnv) ? aiTargetEnv : "127.0.0.1:50051";
    m_grpcClientHandler = std::make_unique<GrpcClientHandler>(aiTarget);

    m_txRouter = std::make_unique<MgmtdTxRouter>(m_ipcClient ? m_ipcClient->handler() : nullptr,
                                                 httpHandler.get(), m_grpcClientHandler.get());

    m_serviceManager =
        std::make_unique<MgmtdServiceManager>(m_eventFactory.get(), m_actionFactory.get(), m_txRouter.get());

    if (!m_serviceManager)
    {
        LOG_ERROR("failed to initialize service manager");
        return false;
    }

    if (!loadAuthConfig())
    {
        return false;
    }

    m_rxRouter = std::make_unique<MgmtdRxRouter>(m_eventFactory.get(), m_serviceManager.get());

    // pretzel-ai's answers enter through the rx router, exactly as an inbound IPC message does:
    // the transport reports (cmd, ticket, json) and the event it becomes decides what it means.
    // Invoked only from GrpcClientHandler::drain(), on this loop thread, so the ServiceManager
    // stays single-threaded — and every write to it now happens inside an event handler rather
    // than in a lambda wired up here.
    m_grpcClientHandler->setResultSink(
        [rx = m_rxRouter.get()](GrpcCmd cmd, std::uint32_t ticket, std::string json)
        { rx->handleGrpcMessage(cmd, ticket, std::move(json)); });

    // pretzel-ai came back. It caches what it was last pushed, so a restarted one usually
    // returns on the configuration it had — but a fresh install, or one whose cache was lost,
    // comes back with nothing and no other event would ever correct it: every other push is
    // triggered by something happening on THIS side.
    //
    // Delivered on the loop thread by GrpcClientHandler::poll(), which is what makes it safe to
    // read the running config and use the tx router from here.
    m_grpcClientHandler->setReconnectSink(
        [sm = m_serviceManager.get()] { pushAiConfig(*sm, "pretzel-ai reconnected"); });

    if (m_ipcClient)
    {
        m_ipcClient->handler()->setRxRouter(m_rxRouter.get());
    }
    httpHandler->setRxRouter(m_rxRouter.get());

    const char* reloadEnv = std::getenv("PRETZEL_MGMTD_STATIC_RELOAD");
    const bool staticReload = reloadEnv && *reloadEnv && std::string(reloadEnv) != "0";
    auto httpCache = std::make_shared<pz::http::StaticFileCache>(shareDir() + "/mgmtd/www", staticReload);
    m_serviceManager->setStaticCache(httpCache);

    m_httpServer = std::make_unique<pz::http::HttpServer>(m_httpConfig.listenAddress, m_httpConfig.listenPort,
                                                          m_httpConfig.tlsEnabled, m_httpConfig.certFile,
                                                          m_httpConfig.keyFile, "pz-mgmtd", std::move(httpHandler));
    if (!m_httpServer || !m_httpServer->init())
    {
        LOG_ERROR("failed to initialize HTTP server");
        return false;
    }

    m_process = std::make_unique<MgmtdProcess>(m_ipcClient.get(), m_httpServer.get(),
                                               m_grpcClientHandler.get(), m_serviceManager.get());
    if (!m_process)
    {
        LOG_ERROR("failed to initialize process");
        return false;
    }

    return true;
}

void MgmtdCore::onLoop()
{
    if (!m_process->start())
    {
        LOG_ERROR("failed to start process");
        return;
    }

    while (!stopping())
    {
        checkReload();
        ensureCredentialLoaded();
        m_process->tick();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

void MgmtdCore::ensureCredentialLoaded()
{
    if (!m_serviceManager || m_serviceManager->authService().credentialLoaded())
    {
        return;
    }

    const auto now = std::chrono::steady_clock::now();
    if (m_lastCredAttempt != std::chrono::steady_clock::time_point{} &&
        now - m_lastCredAttempt < std::chrono::seconds(1))
    {
        return;
    }
    m_lastCredAttempt = now;

    if (m_serviceManager->authService().loadCredential())
    {
        LOG_INFO("admin credential loaded from local_users");
    }
}

void MgmtdCore::onShutdown()
{
    LOG_INFO("shutting down");

    if (m_httpServer)
    {
        m_httpServer->stop();
    }

    pz::util::Logger::Shutdown();
}

bool MgmtdCore::loadHttpConfig()
{
    // `console` rather than `http`: the appliance has two listeners, and naming them by protocol
    // left two domains called the same thing in two daemon sections. This one is the web console.
    const auto& http = pz::config::Config::section(pz::config::scope::kPretzel, "console");

    // Refused, not defaulted. The listener is how an operator reaches this appliance at all, and a
    // compiled fallback for it is worse than no daemon: mgmtd came up "healthy" on a different port
    // with TLS off, and the only symptom was that the console had vanished.
    //
    // It is absent for one reason in practice — this process read the running config before engined
    // finished seeding or back-filling it, which is a race the unit ordering cannot close (After=
    // orders the start, not the readiness). Exiting is the right answer to that: Restart=always
    // brings mgmtd back in three seconds, by which time the config is there. A daemon that guessed
    // instead would still be guessing an hour later.
    if (http.empty())
    {
        LOG_ERROR("no 'console' domain in the running configuration — refusing to start rather "
                  "than binding a guessed address. If engined is still seeding, the restart will "
                  "pick it up");
        return false;
    }
    m_httpConfig.listenAddress = http.value("listen_address", "0.0.0.0");
    m_httpConfig.listenPort = static_cast<std::uint16_t>(http.value("listen_port", 9101));

    m_httpConfig.tlsEnabled = http.value("tls_enabled", false);
    m_httpConfig.certFile = http.value("cert_file", "");
    m_httpConfig.keyFile = http.value("key_file", "");

    return true;
}

bool MgmtdCore::loadAuthConfig()
{
    if (!m_serviceManager)
    {
        return true;
    }

    m_serviceManager->authService().loadCredential();
    return true;
}

}

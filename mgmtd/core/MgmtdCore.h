#pragma once

#include "core/Core.h"

#include "action/MgmtdActionFactory.h"
#include "config/ConfigTypes.h"
#include "event/MgmtdEventFactory.h"
#include "grpc/GrpcClientHandler.h"
#include "http/HttpServer.h"
#include "ipc/IpcClient.h"
#include "process/MgmtdProcess.h"
#include "router/MgmtdRxRouter.h"
#include "router/MgmtdTxRouter.h"
#include "service/MgmtdServiceManager.h"

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>

namespace pz::mgmtd
{

struct HttpConfig
{
    std::string listenAddress{"0.0.0.0"};
    std::uint16_t listenPort{9101};

    bool tlsEnabled{false};
    std::string certFile;
    std::string keyFile;
};

class MgmtdCore : public pz::core::Core
{
public:
    MgmtdCore();
    ~MgmtdCore() override = default;

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:
    bool loadHttpConfig();
    bool loadAuthConfig();

    void ensureCredentialLoaded();

private:
    std::chrono::steady_clock::time_point m_lastCredAttempt{};

    HttpConfig m_httpConfig;

    std::unique_ptr<pz::ipc::IpcClient> m_ipcClient;
    std::unique_ptr<MgmtdEventFactory> m_eventFactory;
    std::unique_ptr<MgmtdActionFactory> m_actionFactory;
    std::unique_ptr<GrpcClientHandler> m_grpcClientHandler;
    std::unique_ptr<MgmtdTxRouter> m_txRouter;
    std::unique_ptr<MgmtdServiceManager> m_serviceManager;
    std::unique_ptr<MgmtdRxRouter> m_rxRouter;
    std::unique_ptr<pz::http::HttpServer> m_httpServer;
    std::unique_ptr<MgmtdProcess> m_process;
};

}

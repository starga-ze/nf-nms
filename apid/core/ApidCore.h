#pragma once

#include "core/Core.h"

#include "action/ApidActionFactory.h"
#include "config/ConfigTypes.h"
#include "event/ApidEventFactory.h"
#include "http/HttpServer.h"
#include "ipc/IpcClient.h"
#include "process/ApidProcess.h"
#include "router/ApidRxRouter.h"
#include "router/ApidTxRouter.h"
#include "service/ApidServiceManager.h"

#include <cstdint>
#include <memory>
#include <string>

namespace pz::apid
{

struct HttpConfig
{
    std::string listenAddress{"0.0.0.0"};
    std::uint16_t listenPort{8443};

    bool tlsEnabled{false};
    std::string certFile;
    std::string keyFile;
};

class ApidCore : public pz::core::Core
{
public:
    ApidCore();
    ~ApidCore() override = default;

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:
    bool loadHttpConfig();

private:
    HttpConfig m_httpConfig;

    std::unique_ptr<pz::ipc::IpcClient> m_ipcClient;
    std::unique_ptr<ApidEventFactory> m_eventFactory;
    std::unique_ptr<ApidActionFactory> m_actionFactory;
    std::unique_ptr<ApidTxRouter> m_txRouter;
    std::unique_ptr<ApidServiceManager> m_serviceManager;
    std::unique_ptr<ApidRxRouter> m_rxRouter;
    std::unique_ptr<pz::http::HttpServer> m_httpServer;
    std::unique_ptr<ApidProcess> m_process;
};

}

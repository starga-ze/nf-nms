#pragma once

#include "core/Core.h"

#include "ipc/IpcClient.h"

#include "action/AuthdActionFactory.h"
#include "event/AuthdEventFactory.h"
#include "process/AuthdProcess.h"
#include "router/AuthdRxRouter.h"
#include "router/AuthdTxRouter.h"
#include "service/AuthdServiceManager.h"

#include "config/ConfigTypes.h"

#include <memory>

namespace pz::authd
{

class AuthdCore : public pz::core::Core
{
public:
    AuthdCore();

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:

    std::unique_ptr<pz::ipc::IpcClient> m_ipcClient;

    std::unique_ptr<AuthdProcess> m_process;

    std::unique_ptr<AuthdEventFactory> m_eventFactory;
    std::unique_ptr<AuthdActionFactory> m_actionFactory;

    std::unique_ptr<AuthdRxRouter> m_rxRouter;
    std::unique_ptr<AuthdTxRouter> m_txRouter;

    std::unique_ptr<AuthdServiceManager> m_serviceManager;
};

}

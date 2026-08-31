#pragma once

#include "core/Core.h"

#include "ipc/IpcClient.h"
#include "util/ThreadManager.h"

#include "action/TopologydActionFactory.h"
#include "event/TopologydEventFactory.h"
#include "process/TopologydProcess.h"
#include "router/TopologydRxRouter.h"
#include "router/TopologydTxRouter.h"
#include "service/TopologydServiceManager.h"

#include "config/ConfigTypes.h"

#include <memory>

namespace pz::topologyd
{

class TopologydCore : public pz::core::Core
{
public:
    TopologydCore();

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:

    std::unique_ptr<pz::util::ThreadManager> m_threadManager;
    std::unique_ptr<pz::ipc::IpcClient> m_ipcClient;

    std::unique_ptr<TopologydEventFactory> m_eventFactory;
    std::unique_ptr<TopologydActionFactory> m_actionFactory;

    std::unique_ptr<TopologydTxRouter> m_txRouter;
    std::unique_ptr<TopologydServiceManager> m_serviceManager;
    std::unique_ptr<TopologydRxRouter> m_rxRouter;

    std::unique_ptr<TopologydProcess> m_process;
};

}

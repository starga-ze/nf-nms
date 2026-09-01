#pragma once

#include "core/Core.h"

#include "ipc/IpcClient.h"

#include "action/EnginedActionFactory.h"
#include "event/EnginedEventFactory.h"
#include "process/EnginedProcess.h"
#include "router/EnginedRxRouter.h"
#include "router/EnginedTxRouter.h"
#include "service/EnginedServiceManager.h"

#include "config/ConfigTypes.h"

#include <chrono>
#include <memory>

namespace pz::engined
{

class EnginedCore : public pz::core::Core
{
public:
    EnginedCore();

protected:
    void onPreConfigLoad() override;

    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:
    void ensureStorePreflighted();

    bool m_preflighted{false};
    std::chrono::steady_clock::time_point m_lastPreflightAttempt{};


    std::unique_ptr<pz::ipc::IpcClient> m_ipcClient;

    std::unique_ptr<EnginedEventFactory> m_eventFactory;
    std::unique_ptr<EnginedActionFactory> m_actionFactory;

    std::unique_ptr<EnginedTxRouter> m_txRouter;
    std::unique_ptr<EnginedServiceManager> m_serviceManager;
    std::unique_ptr<EnginedRxRouter> m_rxRouter;

    std::unique_ptr<EnginedProcess> m_process;
};

}

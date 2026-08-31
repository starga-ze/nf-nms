#pragma once

#include "core/Core.h"

#include "icmp/IcmpEngine.h"
#include "ipc/IpcClient.h"
#include "util/ThreadManager.h"

#include "action/ProbedActionFactory.h"
#include "event/ProbedEventFactory.h"
#include "process/ProbedProcess.h"
#include "router/ProbedRxRouter.h"
#include "router/ProbedTxRouter.h"
#include "service/ProbedServiceManager.h"

#include "config/ConfigTypes.h"

#include <boost/asio/io_context.hpp>

#include <memory>

namespace pz::probed
{

class ProbedCore : public pz::core::Core
{
public:
    ProbedCore();

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:

    std::unique_ptr<pz::util::ThreadManager> m_threadManager;
    std::unique_ptr<pz::ipc::IpcClient> m_ipcClient;
    std::unique_ptr<IcmpEngine> m_icmpEngine;
    std::unique_ptr<boost::asio::io_context> m_ioContext;

    std::unique_ptr<ProbedProcess> m_process;

    std::unique_ptr<ProbedEventFactory> m_eventFactory;
    std::unique_ptr<ProbedActionFactory> m_actionFactory;

    std::unique_ptr<ProbedRxRouter> m_rxRouter;
    std::unique_ptr<ProbedTxRouter> m_txRouter;

    std::unique_ptr<ProbedServiceManager> m_serviceManager;
};

}

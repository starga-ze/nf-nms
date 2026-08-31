#pragma once

#include "core/Core.h"

#include "ipc/IpcClient.h"
#include "util/ThreadManager.h"

#include "action/CollectordActionFactory.h"
#include "event/CollectordEventFactory.h"
#include "process/CollectordProcess.h"
#include "router/CollectordRxRouter.h"
#include "router/CollectordTxRouter.h"
#include "service/CollectordServiceManager.h"

#include "config/ConfigTypes.h"

#include <boost/asio/io_context.hpp>

#include <memory>

namespace pz::collectord
{

class CollectordCore : public pz::core::Core
{
public:
    CollectordCore();

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:

    std::unique_ptr<pz::util::ThreadManager> m_threadManager;
    std::unique_ptr<pz::ipc::IpcClient> m_ipcClient;

    // Drives outbound device calls (pz::http::requestAsync). collectord serves no HTTP of its own,
    // so unlike mgmtd there is no HttpServer to host the context — it is pumped directly from
    // CollectordProcess::tick(), and every completion handler therefore runs on the main loop.
    std::unique_ptr<boost::asio::io_context> m_ioContext;

    std::unique_ptr<CollectordProcess> m_process;

    std::unique_ptr<CollectordEventFactory> m_eventFactory;
    std::unique_ptr<CollectordActionFactory> m_actionFactory;

    std::unique_ptr<CollectordRxRouter> m_rxRouter;
    std::unique_ptr<CollectordTxRouter> m_txRouter;

    std::unique_ptr<CollectordServiceManager> m_serviceManager;
};

}

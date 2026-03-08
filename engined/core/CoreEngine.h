#pragma once

#include "core/Core.h"
#include "util/ThreadManager.h"
#include "config/ConfigTypes.h"
#include "ipc/IpcClient.h"

#include <memory>

namespace nf::engined
{
    
using LoggerConfig = nf::config::LoggerConfig;
using IpcConfig = nf::config::IpcConfig;
using ThreadManager = nf::util::ThreadManager;
using IpcClient = nf::ipc::IpcClient;

class CoreEngine : public nf::core::Core
{
public:
    CoreEngine();

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:
    void initConfig();
    void initLogger();
    bool initThreadManager();

    void initIpcClient();

    void startThreads();

    void sendHello();

    LoggerConfig m_loggerConfig;
    IpcConfig m_ipcConfig;
    
    std::unique_ptr<ThreadManager> m_threadManager;
    std::unique_ptr<IpcClient> m_ipcClient;
};

} // namespace nf::engined

#pragma once

#include "core/Core.h"
#include "util/ThreadManager.h"
#include "ipc/IpcServer.h"
#include "config/ConfigTypes.h"

#include <memory>

namespace nf::ipcd
{
    
using LoggerConfig = nf::config::LoggerConfig;
using IpcConfig = nf::config::IpcConfig;
using ThreadManager = nf::util::ThreadManager;

class CoreIpc : public nf::core::Core
{
public:
    CoreIpc();

protected:
    bool onInit() override;
    void onLoop() override;
    void onShutdown() override;

private:
    void initConfig();
    void initLogger();
    bool initThreadManager();
    void initIpcServer();

    void startThreads();

    LoggerConfig m_loggerConfig;
    IpcConfig m_ipcConfig;
    
    std::unique_ptr<ThreadManager> m_threadManager;
    std::unique_ptr<IpcServer> m_ipcServer;
};

} // namespace nf::ipcd

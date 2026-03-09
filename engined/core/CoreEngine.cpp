#include "CoreEngine.h"
#include "util/Logger.h"


#include <thread>

namespace nf::engined
{

CoreEngine::CoreEngine() : Core("engined")
{
}

bool CoreEngine::onInit()
{
    initConfig();
    initLogger();

    LOG_INFO("CoreEngine init...");

    initThreadManager();

    initIpcHandler();

    return true;
}

void CoreEngine::onLoop()
{
    startThreads();

    while (!stopping())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

void CoreEngine::onShutdown()
{
    LOG_INFO("CoreEngine shutdown...");

    m_threadManager->stopAll();

    LOG_INFO("All threads terminated successfully");

    nf::util::Logger::Shutdown();
}

void CoreEngine::initConfig()
{
    const auto& cfg = m_config.json();

    const auto& log = cfg["logger"];

    m_loggerConfig.name = log["name"];
    m_loggerConfig.file = log["file"];
    m_loggerConfig.maxFileSize = log["max_file_size"];
    m_loggerConfig.maxFiles = log["max_files"];

    const auto& ipc = cfg["ipc"];

    m_ipcConfig.socketPath = ipc["socket_path"];
    m_ipcConfig.maxConnections = ipc["max_connections"];
    m_ipcConfig.maxFrameSize = ipc["max_frame_size"];
    m_ipcConfig.rxBufferSize = ipc["rx_buffer_size"];
    m_ipcConfig.txBufferSize = ipc["tx_buffer_size"];
}

void CoreEngine::initLogger()
{
    nf::util::Logger::Init(
            m_loggerConfig.name,
            m_loggerConfig.file,
            m_loggerConfig.maxFileSize,
            m_loggerConfig.maxFiles
            );
}

bool CoreEngine::initThreadManager()
{
    m_threadManager = std::make_unique<ThreadManager>();
    if (!m_threadManager)
    {
        LOG_FATAL("ThreadManager initialize failed");
        return false;
    }

    return true;
}

void CoreEngine::initIpcHandler()
{
    m_ipcHandler = std::make_unique<IpcHandler>(m_ipcConfig, nf::ipc::IpcDaemon::Engined);
}

void CoreEngine::startThreads()
{
    m_threadManager->addThread("ipc_handler",
            std::bind(&IpcHandler::start, m_ipcHandler.get()),
            std::bind(&IpcHandler::stop, m_ipcHandler.get()));
}

} // namespace nf::ipcd

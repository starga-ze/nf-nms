#include "CoreIpc.h"
#include "util/Logger.h"


#include <thread>

namespace nf::ipcd
{

CoreIpc::CoreIpc() : Core("ipcd")
{
}

bool CoreIpc::onInit()
{
    initConfig();
    initLogger();

    LOG_INFO("CoreIpc init...");

    initThreadManager();
    initIpcServer();

    return true;
}

void CoreIpc::onLoop()
{
    startThreads();

    while (!stopping())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

void CoreIpc::onShutdown()
{
    LOG_INFO("CoreIpc shutdown...");

    m_threadManager->stopAll();

    LOG_INFO("All threads terminated successfully");

    nf::util::Logger::Shutdown();
}

void CoreIpc::initConfig()
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

void CoreIpc::initLogger()
{
    nf::util::Logger::Init(
            m_loggerConfig.name,
            m_loggerConfig.file,
            m_loggerConfig.maxFileSize,
            m_loggerConfig.maxFiles
            );
}

bool CoreIpc::initThreadManager()
{
    m_threadManager = std::make_unique<ThreadManager>();
    if (!m_threadManager)
    {
        LOG_FATAL("ThreadManager initialize failed");
        return false;
    }

    return true;
}

void CoreIpc::initIpcServer()
{
    m_ipcServer = std::make_unique<IpcServer>(m_ipcConfig);
}

void CoreIpc::startThreads()
{
    m_threadManager->addThread("ipc_server",
            std::bind(&IpcServer::start, m_ipcServer.get()),
            std::bind(&IpcServer::stop, m_ipcServer.get()));
}

} // namespace nf::ipcd

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
    const auto& cfg = m_config.json();

    const auto& log = cfg["logger"];

    nf::util::Logger::Init(
            log["name"], 
            log["file"], 
            log["max_file_size"], 
            log["max_files"]
            );

    LOG_INFO("CoreIpc Init...");
    return true;
}

void CoreIpc::onLoop()
{
    while (!stopping())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

void CoreIpc::onShutdown()
{
    LOG_INFO("CoreIpc Shutdown...");
    nf::util::Logger::Shutdown();
}

} // namespace nf::ipcd

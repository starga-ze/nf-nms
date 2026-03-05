#include "CoreEngine.h"
#include "util/Logger.h"

#include <iostream>
#include <thread>

namespace nf::engined
{

CoreEngine::CoreEngine() : Core("engined")
{
}

bool CoreEngine::onInit()
{
    const auto& cfg = m_config.json();

    const auto& log = cfg["logger"];

    nf::util::Logger::Init(
            log["name"],
            log["file"],
            log["max_file_size"],
            log["max_files"]
            );

    LOG_INFO("CoreEngine Init...");
    return true;
}

void CoreEngine::onLoop()
{
    while (!stopping())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

void CoreEngine::onShutdown()
{
    LOG_INFO("CoreEngine Shutdown...");
    nf::util::Logger::Shutdown();
}

} // namespace nf::engined

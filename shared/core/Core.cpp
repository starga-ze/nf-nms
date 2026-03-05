#include "Core.h"
#include "util/Logger.h"

#include <csignal>
#include <iostream>

namespace nf::core
{

std::atomic<bool> Core::m_running{true};

Core::Core(std::string name) : m_name(std::move(name))
{
}

void Core::run()
{
    handleSignal();

    if (!m_config.loadStartupConfig(m_name))
    {
        std::cerr << "startup-config load failed for " << m_name << std::endl;
        return;
    }

    if (!onInit())
    {
        return;
    }

    onLoop();

    onShutdown();
}

void Core::handleSignal()
{
    std::signal(SIGINT, Core::signalHandler);
    std::signal(SIGTERM, Core::signalHandler);
}

void Core::signalHandler(int)
{
    m_running = false;
}

bool Core::stopping() const
{
    return !m_running.load();
}

} // namespace nf::core

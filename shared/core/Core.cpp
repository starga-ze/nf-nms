#include "Core.h"
#include "util/Logger.h"

#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <iostream>
#include <unistd.h>
#include <vector>

namespace pz::core
{

std::atomic<bool> Core::m_running{true};
std::atomic<bool> Core::m_reload{false};

Core::Core(std::string name) : m_name(std::move(name))
{
}

void Core::run()
{
    handleSignal();

    onPreConfigLoad();

    loadInfraConfig();

    // Before onInit, so a subclass's very first LOG_ line has somewhere to go. It used to be the
    // first thing every onInit did, which meant anything that failed ahead of it failed silently.
    pz::util::Logger::Init(m_loggerConfig.name, m_loggerConfig.file, m_loggerConfig.maxFileSize,
                           m_loggerConfig.maxFiles);

    writePidFile();

    if (!onInit())
    {
        removePidFile();
        return;
    }

    onLoop();

    onShutdown();

    removePidFile();
}

// Everything a daemon needs before it can say anything, derived rather than declared.
//
// The name is the only input. `pz-<name>` is the process name, `<dir>/<name>.log` the log file —
// both were written out per daemon in the config until they were nine chances to point a daemon at
// another one's file. What remains in the document is what genuinely differs between deployments:
// where the logs go, how big they get, and where the IPC socket is.
void Core::loadInfraConfig()
{
    const auto& logger = pz::config::Config::section(pz::config::scope::kGlobal, "logger");
    const auto& ipc = pz::config::Config::section(pz::config::scope::kGlobal, "ipc");

    m_loggerConfig.name = "pz-" + m_name;
    m_loggerConfig.file = logger.value("dir", std::string("/var/log/pretzel")) + "/" + m_name + ".log";
    m_loggerConfig.maxFileSize = logger.value("max_file_size", 5u * 1024u * 1024u);
    m_loggerConfig.maxFiles = logger.value("max_files", 100u);

    m_ipcConfig.socketPath = ipc.value("socket_path", std::string("/run/pretzel/ipcd.sock"));
    m_ipcConfig.maxConnections = ipc.value("max_connections", m_ipcConfig.maxConnections);
    m_ipcConfig.maxFrameSize = ipc.value("max_frame_size", m_ipcConfig.maxFrameSize);
    m_ipcConfig.rxBufferSize = ipc.value("rx_buffer_size", m_ipcConfig.rxBufferSize);
    m_ipcConfig.txBufferSize = ipc.value("tx_buffer_size", m_ipcConfig.txBufferSize);
}

const std::string& Core::name() const
{
    return m_name;
}

const pz::config::LoggerConfig& Core::loggerConfig() const
{
    return m_loggerConfig;
}

const pz::config::IpcConfig& Core::ipcConfig() const
{
    return m_ipcConfig;
}

void Core::handleSignal()
{
    std::signal(SIGINT, Core::signalHandler);
    std::signal(SIGTERM, Core::signalHandler);
    std::signal(SIGHUP, Core::signalHandler);
}

void Core::signalHandler(int signum)
{
    if (signum == SIGHUP)
    {
        m_reload = true;
        return;
    }
    m_running = false;
}

bool Core::stopping() const
{
    return !m_running.load();
}

void Core::scheduleReload()
{
    ::kill(::getpid(), SIGHUP);
}

void Core::checkReload()
{
    if (!m_reload.exchange(false))
    {
        return;
    }

    std::cout << "SIGHUP received, reloading config (daemon={})" << m_name << std::endl;
    pz::config::Config::invalidateConfigCache();
    onReload();
}

void Core::onReload()
{
    std::cout << "config reload, restarting process (daemon={})" << m_name << std::endl;

    std::vector<std::string> argStrings;
    {
        std::ifstream f("/proc/self/cmdline");
        std::string token;
        while (std::getline(f, token, '\0'))
        {
            if (!token.empty())
                argStrings.push_back(std::move(token));
        }
    }

    if (argStrings.empty())
    {
        LOG_ERROR("restart aborted — could not read /proc/self/cmdline (daemon={})", m_name);
        return;
    }

    std::vector<char*> argv;
    argv.reserve(argStrings.size() + 1);
    for (auto& s : argStrings)
        argv.push_back(s.data());
    argv.push_back(nullptr);

    removePidFile();

    if (DIR* dir = ::opendir("/proc/self/fd"))
    {
        const int dfd = ::dirfd(dir);
        struct dirent* ent;
        while ((ent = ::readdir(dir)) != nullptr)
        {
            if (ent->d_name[0] == '.')
                continue;
            const int fd = std::atoi(ent->d_name);
            if (fd > 2 && fd != dfd)
                ::close(fd);
        }
        ::closedir(dir);
    }
    else
    {
        for (int fd = 3; fd < 1024; ++fd)
            ::close(fd);
    }

    ::execv("/proc/self/exe", argv.data());

    LOG_ERROR("execv failed (daemon={}, error={})", m_name, std::strerror(errno));
}

void Core::writePidFile()
{
    m_pidFilePath = "/run/pretzel/" + m_name + ".pid";

    FILE* f = std::fopen(m_pidFilePath.c_str(), "w");
    if (!f)
    {
        std::cerr << m_name << ": failed to write pid file " << m_pidFilePath << ": " << std::strerror(errno)
                  << std::endl;
        m_pidFilePath.clear();
        return;
    }
    std::fprintf(f, "%d\n", static_cast<int>(getpid()));
    std::fclose(f);
}

void Core::removePidFile()
{
    if (m_pidFilePath.empty())
    {
        return;
    }
    std::remove(m_pidFilePath.c_str());
    m_pidFilePath.clear();
}

}

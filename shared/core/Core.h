#pragma once

#include "config/Config.h"
#include "config/ConfigTypes.h"

#include <atomic>
#include <string>

namespace pz::core
{

class Core
{
public:
    explicit Core(std::string name);
    virtual ~Core() = default;

    void run();

    static void scheduleReload();

protected:
    virtual void onPreConfigLoad()
    {
    }

    virtual bool onInit() = 0;
    virtual void onLoop() = 0;
    virtual void onShutdown() = 0;

    virtual void onReload();

    bool stopping() const;

    void checkReload();

    // The daemon's own name, as it appears in a log line and a pid file. Every subclass used to
    // read this back out of its own config section; it is the one thing Core has always known.
    const std::string& name() const;

    // Logger and IPC, derived from `name` and the `global` scope, and already applied: run() calls
    // Logger::Init before onInit(), so a subclass's first log line lands in the right file without
    // it having to arrange that. Exposed because a few subclasses pass the IPC settings on to a
    // client they build.
    //
    // These were nine copies of the same twelve lines, each reading a per-daemon section that
    // existed only to repeat the daemon's own name back at it. The section is gone and so are the
    // copies: `pz-<name>` and `<global.logger.dir>/<name>.log` are derivable, and deriving them
    // means a daemon cannot be configured to log to another daemon's file.
    const pz::config::LoggerConfig& loggerConfig() const;
    const pz::config::IpcConfig& ipcConfig() const;

private:
    static void signalHandler(int signum);
    void handleSignal();

    void loadInfraConfig();

    void writePidFile();
    void removePidFile();

    std::string m_name;
    pz::config::LoggerConfig m_loggerConfig;
    pz::config::IpcConfig m_ipcConfig;
    std::string m_pidFilePath;

    static std::atomic<bool> m_running;
    static std::atomic<bool> m_reload;
};

}

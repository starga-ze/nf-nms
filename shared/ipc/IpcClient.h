#pragma once

#include "ipc/IpcConnection.h"
#include "ipc/IpcFraming.h"
#include "config/ConfigTypes.h"
#include "io/Epoll.h"

#include <atomic>
#include <memory>
#include <vector>

namespace nf::ipc
{

class IpcClient
{
public:
    explicit IpcClient(const nf::config::IpcConfig& cfg);
    ~IpcClient();

    void start();
    void stop();

    bool sendFrame(const std::vector<uint8_t>& frame);

private:
    bool connectServer();
    bool setNonBlocking(int fd);

    void handleReadable();
    void handleWritable();

private:
    const nf::config::IpcConfig& m_cfg;

    nf::io::Epoll m_epoll;
    std::vector<epoll_event> m_events;

    std::unique_ptr<IpcConnection> m_conn;

    std::atomic<bool> m_running{false};
};

}

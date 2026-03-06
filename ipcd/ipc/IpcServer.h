#pragma once

#include "config/ConfigTypes.h"
#include "io/Epoll.h"

#include <atomic>
#include <memory>
#include <unordered_map>
#include <vector>

#include <sys/epoll.h>

namespace nf::ipc
{
class IpcConnection;
class IpcFraming;
}

namespace nf::ipcd
{
class IpcRouter;
class IpcServer
{
public:
    explicit IpcServer(const nf::config::IpcConfig& cfg);
    ~IpcServer();

    bool init();
    void start();
    void stop();

    bool sendFrameTo(int dstFd, const std::vector<uint8_t>& frame);
    void broadcastFrame(int srcFd, const std::vector<uint8_t>& frame);

private:
    bool createListenSocket();
    bool bindAndListen();
    bool setNonBlocking(int fd);

    void acceptLoop();
    void closeConn(int fd);

    void handleReadable(int fd);
    void handleWritable(int fd);

    bool enqueueTx(int fd, const uint8_t* data, size_t len);

private:
    const nf::config::IpcConfig& m_cfg;

    nf::io::Epoll m_epoll;
    int m_listenFd{-1};

    std::atomic<bool> m_running{false};

    std::vector<epoll_event> m_events;

    std::unordered_map<int, std::unique_ptr<nf::ipc::IpcConnection>> m_conns;

    std::unique_ptr<IpcRouter> m_router;
};

} // namespace nf::ipcd

#pragma once

#include "config/ConfigTypes.h"
#include "io/Epoll.h"

#include <unordered_map>
#include <memory>
#include <vector>
#include <functional>
#include <string>

namespace nf::ipcd
{
    
using IpcConfig = nf::config::IpcConfig;
using Epoll = nf::io::Epoll;

class IpcConnection;
class IpcRouter;
    
class IpcServer
{
public:
    explicit IpcServer(const IpcConfig& cfg);
    ~IpcServer();

    bool init();

    void start();
    void stop();

    void broadcastFrame(int srcFd, const std::vector<uint8_t>& frame);
    bool sendFrameTo(int dstFd, const std::vector<uint8_t>& frame);

private:
    bool createListenSocket();
    bool bindAndListen();
    bool setNonBlocking(int fd);

    void acceptLoop();
    void closeConn(int fd);

    void handleReadable(int fd);
    void handleWritable(int fd);

    bool enqueueTx(int fd, const uint8_t* data, size_t len);

    const IpcConfig& m_cfg;

    Epoll m_epoll;

    int m_listenFd{-1};
    bool m_running{false};

    std::unordered_map<int, std::unique_ptr<IpcConnection>> m_conns;
    std::unique_ptr<IpcRouter> m_router;

    std::vector<epoll_event> m_events;
};

} // namespace nf::ipcd

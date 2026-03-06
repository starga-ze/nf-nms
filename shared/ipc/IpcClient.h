#pragma once

#include "config/ConfigTypes.h"
#include "algorithm/ByteRingBuffer.h"

#include <atomic>
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

private:
    bool connectServer();
    void closeSocket();

    void recvLoop();
    void sendHeartbeat();

    bool setNonBlocking(int fd);

private:
    const nf::config::IpcConfig& m_cfg;

    int m_fd{-1};
    std::atomic<bool> m_running{false};

    nf::algorithm::ByteRingBuffer m_rxRing;
};

}

#pragma once

#include "config/ConfigTypes.h"
#include "ipc/IpcConnection.h"
#include "ipc/IpcFraming.h"
#include "ipc/IpcProtocol.h"
#include "io/Epoll.h"

#include <atomic>
#include <queue>
#include <mutex>
#include <vector>

namespace nf::ipc
{

struct IpcMessage
{
    IpcHeader header;
    std::vector<uint8_t> payload;
};

class IpcClient
{
public:

    IpcClient(const nf::config::IpcConfig& cfg, IpcDaemon selfId);
    ~IpcClient();

    bool init();

    void start();
    void stop();

    bool send(IpcDaemon dst, IpcCmd cmd, const uint8_t* payload, size_t len);
    bool send(IpcDaemon dst, IpcCmd cmd, const std::vector<uint8_t>& payload);
    bool sendString(IpcDaemon dst, IpcCmd cmd, const std::string& s);

    bool pollMessage(IpcMessage& msg);

    bool isConnected() const;

private:

    enum class State
    {
        Disconnected,
        Connecting,
        Connected
    };

private:

    bool tryConnect();
    bool finishConnect();

    bool setNonBlocking(int fd);

    void handleReadable();
    void handleWritable();

    void cleanupConnection();
    void handleDisconnect(const char* reason);

private:

    nf::config::IpcConfig m_cfg;
    IpcDaemon m_selfId;

    std::atomic<bool> m_running{false};
    std::atomic<State> m_state{State::Disconnected};

    std::unique_ptr<IpcConnection> m_conn;

    nf::io::Epoll m_epoll;
    std::vector<epoll_event> m_events;

    std::mutex m_txMutex;

    std::mutex m_rxMutex;
    std::queue<IpcMessage> m_inbox;
};

}

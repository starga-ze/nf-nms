#pragma once

#include "config/ConfigTypes.h"
#include "io/Epoll.h"
#include "ipc/IpcConnection.h"
#include "ipc/IpcProtocol.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <sys/epoll.h>

namespace nf::ipc
{

class IpcClientListener
{
public:
    virtual ~IpcClientListener() = default;

    virtual void onIpcClientFrame(const IpcHeader& header,
                                  const uint8_t* payload,
                                  size_t payloadLen) = 0;

    virtual void onIpcClientConnected(IpcDaemon selfId) = 0;
    virtual void onIpcClientDisconnected(IpcDaemon selfId) = 0;
};

class IpcClient
{
public:
    IpcClient(const nf::config::IpcConfig& cfg, IpcDaemon selfId);
    ~IpcClient();

    void setListener(IpcClientListener* listener);

    void start();
    void stop();

    bool send(IpcDaemon dst, IpcCmd cmd, const uint8_t* payload, size_t payloadLen);
    bool send(IpcDaemon dst, IpcCmd cmd, const std::vector<uint8_t>& payload);
    bool sendString(IpcDaemon dst, IpcCmd cmd, const std::string& s);

    bool isConnected() const;
    IpcDaemon selfId() const;

private:
    enum class State
    {
        Disconnected,
        Connecting,
        Connected
    };

private:
    bool init();
    bool tryConnect();
    bool finishConnect();

    bool sendClientHello();
    bool queueFrameLocked(const std::vector<uint8_t>& frame);
    bool queueFrame(const std::vector<uint8_t>& frame);

    bool setNonBlocking(int fd);

    void runLoop();
    void pollOnce(int timeoutMs);

    void handleReadable();
    void handleWritable();

    void handleDisconnect(const char* reason);
    void cleanupConnection(bool notifyDisconnect);

    void notifyConnected();
    void notifyDisconnected();

private:
    nf::config::IpcConfig m_cfg;
    IpcDaemon m_selfId {IpcDaemon::Unknown};

    nf::io::Epoll m_epoll;
    std::vector<epoll_event> m_events;

    std::unique_ptr<IpcConnection> m_conn;

    std::atomic<bool> m_running {false};
    std::atomic<bool> m_initialized {false};

    State m_state {State::Disconnected};
    bool m_helloSent {false};

    mutable std::mutex m_txMutex;

    IpcClientListener* m_listener {nullptr};
};

} // namespace nf::ipc

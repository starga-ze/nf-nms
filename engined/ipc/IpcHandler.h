#pragma once

#include "config/Config.h"

#include "ipc/IpcClient.h"
#include "ipc/IpcProtocol.h"

#include <memory>
#include <string>
#include <vector>

namespace nf::engined
{

class IpcHandlerListener
{
public:
    virtual ~IpcHandlerListener() = default;

    virtual void onIpcFrame(const nf::ipc::IpcHeader& header, const uint8_t* payload, size_t payloadLen) = 0;
    virtual void onIpcConnected(nf::ipc::IpcDaemon selfId) = 0;
    virtual void onIpcDisconnected(nf::ipc::IpcDaemon selfId) = 0;
};

class IpcHandler : public nf::ipc::IpcClientListener
{
public:
    IpcHandler(const nf::config::IpcConfig& cfg, nf::ipc::IpcDaemon selfId);

    ~IpcHandler();

    void setListener(IpcHandlerListener* listener);

    void start();
    void stop();

    bool send(nf::ipc::IpcDaemon dst, nf::ipc::IpcCmd cmd, const uint8_t* payload, size_t payloadLen);

    bool send(nf::ipc::IpcDaemon dst, nf::ipc::IpcCmd cmd, const std::vector<uint8_t>& payload);

    bool sendString(nf::ipc::IpcDaemon dst, nf::ipc::IpcCmd cmd, const std::string& s);

    bool isConnected() const;

    nf::ipc::IpcDaemon selfId() const;

public:
    void onIpcClientFrame(const nf::ipc::IpcHeader& header, const uint8_t* payload, size_t payloadLen) override;

    void onIpcClientConnected(nf::ipc::IpcDaemon selfId) override;

    void onIpcClientDisconnected(nf::ipc::IpcDaemon selfId) override;

private:
    nf::ipc::IpcClient m_client;

    IpcHandlerListener* m_listener{nullptr};
};

} // namespace nf::engined

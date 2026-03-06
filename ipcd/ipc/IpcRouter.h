#pragma once

#include "ipc/IpcMessage.h"

#include <cstdint>
#include <unordered_map>
#include <vector>

namespace nf::ipcd
{

class IpcServer;

class IpcRouter
{
public:
    explicit IpcRouter(IpcServer& server);

    // called by server upon receiving a full frame
    void onFrame(int srcFd, const std::vector<uint8_t>& frame);

    // called by server when connection closes
    void onDisconnect(int fd);

private:
    void handleHello(int fd, const nf::ipc::IpcHeader& h, const uint8_t* payload, size_t payloadLen);
    void route(int srcFd, const nf::ipc::IpcHeader& h, const std::vector<uint8_t>& frame);

private:
    IpcServer& m_server;

    // daemonId <-> fd mapping
    std::unordered_map<uint16_t, int> m_daemonToFd;
    std::unordered_map<int, uint16_t> m_fdToDaemon;
};

} // namespace nf::ipcd

#include "ipc/IpcRouter.h"
#include "ipc/IpcServer.h"
#include "util/Logger.h"

using namespace nf::ipc;

namespace nf::ipcd
{

IpcRouter::IpcRouter(IpcServer& server)
    : m_server(server)
{
}

void IpcRouter::onDisconnect(int fd)
{
    auto it = m_fdToDaemon.find(fd);
    if (it == m_fdToDaemon.end())
        return;

    uint16_t daemonId = it->second;
    m_fdToDaemon.erase(it);

    auto it2 = m_daemonToFd.find(daemonId);
    if (it2 != m_daemonToFd.end() && it2->second == fd)
        m_daemonToFd.erase(it2);

    LOG_INFO("IpcRouter: unregistered fd={} daemonId={}", fd, daemonId);
}

void IpcRouter::onFrame(int srcFd, const std::vector<uint8_t>& frame)
{
    IpcHeader h{};
    const uint8_t* payload = nullptr;
    size_t payloadLen = 0;

    if (!parseFrame(frame, h, payload, payloadLen))
    {
        LOG_WARN("IpcRouter: invalid frame from fd={}", srcFd);
        return;
    }

    const auto cmd = static_cast<IpcCmd>(h.cmd);

    if (cmd == IpcCmd::Hello)
    {
        handleHello(srcFd, h, payload, payloadLen);
        return;
    }

    route(srcFd, h, frame);
}

void IpcRouter::handleHello(int fd, const IpcHeader& h, const uint8_t* payload, size_t payloadLen)
{
    // Minimal HELLO payload: u16 daemonId (network order)
    if (payloadLen < sizeof(uint16_t))
    {
        LOG_WARN("IpcRouter: HELLO too short fd={}", fd);
        return;
    }

    uint16_t daemonIdNet = 0;
    std::memcpy(&daemonIdNet, payload, sizeof(uint16_t));
    uint16_t daemonId = ntohs(daemonIdNet);

    m_daemonToFd[daemonId] = fd;
    m_fdToDaemon[fd] = daemonId;

    LOG_INFO("IpcRouter: registered fd={} daemonId={}", fd, daemonId);

    // optional: ACK back (Heartbeat cmd used as quick ACK here, change later)
    auto ack = buildFrame(/*src*/0, /*dst*/daemonId, IpcCmd::Heartbeat,
                          reinterpret_cast<const uint8_t*>("hello-ack"),
                          sizeof("hello-ack") - 1);

    m_server.sendFrameTo(fd, ack);
}

void IpcRouter::route(int srcFd, const IpcHeader& h, const std::vector<uint8_t>& frame)
{
    if (h.dst == IPC_DST_BROADCAST)
    {
        m_server.broadcastFrame(srcFd, frame);
        return;
    }

    // dst is daemonId
    auto it = m_daemonToFd.find(h.dst);
    if (it == m_daemonToFd.end())
    {
        LOG_WARN("IpcRouter: unknown dst daemonId={} from fd={}", h.dst, srcFd);
        return;
    }

    const int dstFd = it->second;
    m_server.sendFrameTo(dstFd, frame);
}

} // namespace nf::ipcd

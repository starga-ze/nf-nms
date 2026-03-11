#include "ipc/IpcRouter.h"
#include "ipc/IpcServer.h"

#include "util/Logger.h"

#include <cstdint>
#include <vector>

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

    IpcDaemon daemonId = it->second;
    m_fdToDaemon.erase(it);

    auto it2 = m_daemonToFd.find(daemonId);
    if (it2 != m_daemonToFd.end() && it2->second == fd)
        m_daemonToFd.erase(it2);

    LOG_INFO("IpcRouter: unregistered fd={} daemonId={}",
             fd,
             static_cast<int>(daemonId));
}


void IpcRouter::onFrame(int srcFd, const std::vector<uint8_t>& frame)
{
    LOG_DEBUG("IPC Server Rx Dump\n{}", dumpFrame(frame));

    IpcHeader h{};
    const uint8_t* payload = nullptr;
    size_t payloadLen = 0;

    if (!parseFrame(frame, h, payload, payloadLen))
    {
        LOG_WARN("IpcRouter: invalid frame from fd={}", srcFd);
        return;
    }

    const auto cmd = static_cast<IpcCmd>(h.cmd);

    if (cmd == IpcCmd::ClientHello)
    {
        handleHello(srcFd, h, payload, payloadLen);
        return;
    }

    route(srcFd, h, frame);
}


void IpcRouter::handleHello(int fd,
                            const IpcHeader& h,
                            const uint8_t* payload,
                            size_t payloadLen)
{
    (void)payload;
    (void)payloadLen;

    IpcDaemon daemonId = static_cast<IpcDaemon>(h.src);

    /* reconnect handling */
    auto it = m_daemonToFd.find(daemonId);
    if (it != m_daemonToFd.end())
    {
        int oldFd = it->second;

        if (oldFd != fd)
        {
            LOG_WARN("IpcRouter: daemon {} reconnect, oldFd={} newFd={}",
                     static_cast<int>(daemonId),
                     oldFd,
                     fd);

            m_server.closeConn(oldFd);
        }
        else
        {
            LOG_WARN("daemon {} already exist on map", static_cast<int>(daemonId));
        }
    }
    m_daemonToFd[daemonId] = fd;
    m_fdToDaemon[fd] = daemonId;

    LOG_INFO("IpcRouter: registered fd={} daemonId={}", fd, static_cast<int>(daemonId));
    
    /* ACK back */
    auto frame = buildFrame(
            IpcDaemon::Ipcd,
            daemonId,
            IpcCmd::ServerHello,
            reinterpret_cast<const uint8_t*>("hello-ack"),
            sizeof("hello-ack") - 1);

    LOG_DEBUG("IPC Server Tx Dump\n{}", dumpFrame(frame));

    m_server.sendFrameTo(fd, frame);
}


void IpcRouter::route(int srcFd,
                      const IpcHeader& h,
                      const std::vector<uint8_t>& frame)
{
    if (static_cast<IpcDaemon>(h.dst) == IpcDaemon::Broadcast)
    {
        m_server.broadcastFrame(srcFd, frame);
        return;
    }

    IpcDaemon dstDaemon = static_cast<IpcDaemon>(h.dst);

    auto it = m_daemonToFd.find(dstDaemon);
    if (it == m_daemonToFd.end())
    {
        LOG_WARN("IpcRouter: unknown dst daemonId={} from fd={}",
                 static_cast<int>(dstDaemon),
                 srcFd);
        return;
    }

    int dstFd = it->second;

    LOG_DEBUG("IPC Server Tx Dump\n{}", dumpFrame(frame));

    m_server.sendFrameTo(dstFd, frame);
}

} // namespace nf::ipcd

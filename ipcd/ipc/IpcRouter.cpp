#include "ipc/IpcRouter.h"
#include "ipc/IpcServer.h"

namespace nf::ipcd
{

IpcRouter::IpcRouter(IpcServer& server)
    : m_server(server)
{
}

void IpcRouter::routeBroadcast(int srcFd, const std::vector<uint8_t>& frame)
{
    m_server.broadcastFrame(srcFd, frame);
}

} // namespace nf::ipcd

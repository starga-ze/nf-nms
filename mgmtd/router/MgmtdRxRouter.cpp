#include "router/MgmtdRxRouter.h"

#include "service/web/WebEvent.h"
#include "service/web/WebGrpcEvent.h"

#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <memory>

namespace pz::mgmtd
{

MgmtdRxRouter::MgmtdRxRouter(MgmtdEventFactory* eventFactory, MgmtdServiceManager* serviceManager)
    : m_eventFactory(eventFactory), m_serviceManager(serviceManager)
{
}

void MgmtdRxRouter::handleIpcMessage(std::unique_ptr<pz::ipc::IpcMessage> msg)
{
    if (!m_serviceManager)
    {
        LOG_ERROR("service manager is not initialized");
        return;
    }

    if (!msg)
    {
        LOG_WARN("received null IPC message — skipping");
        return;
    }

    LOG_TRACE("recv (cmd={}, src={})", pz::ipc::IpcProtocol::cmdToStr(msg->getCmd()),
              pz::ipc::IpcProtocol::daemonToStr(msg->getSrc()));

    std::unique_ptr<MgmtdEvent> event = m_eventFactory->create(std::move(msg));

    m_serviceManager->postEvent(std::move(event));
}

void MgmtdRxRouter::handleHttpMessage(pz::http::HttpRequest req, pz::http::SessionId id)
{
    m_serviceManager->postEvent(std::make_unique<WebEvent>(std::move(req), id));
}

void MgmtdRxRouter::handleGrpcMessage(GrpcCmd cmd, std::uint32_t ticket, std::string json)
{
    LOG_TRACE("recv (rpc={}, ticket={})", grpcCmdToStr(cmd), ticket);

    // ApplyConfig is the one call that answers to nobody: mgmtd states the configuration and the
    // reply is an acknowledgement, with no ticket and no browser holding a screen open on it. The
    // outcome is already in the log (GrpcClientHandler reports a failure there), so filing it as
    // an event would only be looking for a consumer that should not exist.
    if (cmd == GrpcCmd::ApplyConfig)
        return;

    const WebGrpcEventType type = webGrpcEventFor(cmd);
    if (type == WebGrpcEventType::Unknown)
    {
        LOG_WARN("no event maps to rpc {} (ticket={})", grpcCmdToStr(cmd), ticket);
        return;
    }

    m_serviceManager->postEvent(std::make_unique<WebGrpcEvent>(type, ticket, std::move(json)));
}

}

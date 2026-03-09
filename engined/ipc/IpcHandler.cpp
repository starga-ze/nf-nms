#include "ipc/IpcHandler.h"

#include "util/Logger.h"

using namespace nf::ipc;

namespace nf::engined
{

IpcHandler::IpcHandler(const nf::config::IpcConfig& cfg, nf::ipc::IpcDaemon selfId) : 
    m_client(cfg, selfId)
{
    m_client.setListener(this);
}

IpcHandler::~IpcHandler()
{
    stop();
}

void IpcHandler::setListener(IpcHandlerListener* listener)
{
    m_listener = listener;
}

void IpcHandler::start()
{
    LOG_INFO("IpcHandler start daemon={}", daemonToStr((uint8_t)m_client.selfId()));

    m_client.start();
}

void IpcHandler::stop()
{
    m_client.stop();
}

bool IpcHandler::send(nf::ipc::IpcDaemon dst, nf::ipc::IpcCmd cmd, const uint8_t* payload, size_t payloadLen)
{
    return m_client.send(dst, cmd, payload, payloadLen);
}

bool IpcHandler::send(nf::ipc::IpcDaemon dst, nf::ipc::IpcCmd cmd, const std::vector<uint8_t>& payload)
{
    return m_client.send(dst, cmd, payload);
}

bool IpcHandler::sendString(nf::ipc::IpcDaemon dst, nf::ipc::IpcCmd cmd, const std::string& s)
{
    return m_client.sendString(dst, cmd, s);
}

bool IpcHandler::isConnected() const
{
    return m_client.isConnected();
}

nf::ipc::IpcDaemon IpcHandler::selfId() const
{
    return m_client.selfId();
}

void IpcHandler::onIpcClientFrame(const nf::ipc::IpcHeader& header, const uint8_t* payload, size_t payloadLen)
{
    if (m_listener)
        m_listener->onIpcFrame(header, payload, payloadLen);
}

void IpcHandler::onIpcClientConnected(nf::ipc::IpcDaemon selfId)
{
    LOG_INFO("IPC connected daemon={}", daemonToStr((uint8_t)selfId));

    if (m_listener)
        m_listener->onIpcConnected(selfId);
}

void IpcHandler::onIpcClientDisconnected(nf::ipc::IpcDaemon selfId)
{
    LOG_WARN("IPC disconnected daemon={}", daemonToStr((uint8_t)selfId));

    if (m_listener)
        m_listener->onIpcDisconnected(selfId);
}

} // namespace nf::engined

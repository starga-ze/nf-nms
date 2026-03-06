#include "ipc/IpcClient.h"
#include "util/Logger.h"
#include "ipc/IpcFraming.h"
#include "ipc/IpcMessage.h"

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <fcntl.h>
#include <cstring>
#include <chrono>
#include <thread>
#include <arpa/inet.h>

namespace nf::ipc
{

static void dump(const uint8_t* data, size_t len)
{
    std::string hex;
    char buf[4];

    for (size_t i = 0; i < len; ++i)
    {
        snprintf(buf, sizeof(buf), "%02X ", data[i]);
        hex += buf;
    }

    LOG_INFO("IPC RX [{} bytes] {}", len, hex);
}

IpcClient::IpcClient(const nf::config::IpcConfig& cfg)
    : m_cfg(cfg),
      m_rxRing(cfg.rxBufferSize)
{
}

IpcClient::~IpcClient()
{
    stop();
}

bool IpcClient::setNonBlocking(int fd)
{
    int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0)
        return false;

    return ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

bool IpcClient::connectServer()
{
    m_fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (m_fd < 0)
    {
        LOG_ERROR("IpcClient: socket failed");
        return false;
    }

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;

    std::strncpy(addr.sun_path,
                 m_cfg.socketPath.c_str(),
                 sizeof(addr.sun_path) - 1);

    if (::connect(m_fd, (sockaddr*)&addr, sizeof(addr)) != 0)
    {
        LOG_ERROR("IpcClient: connect failed errno={}", errno);
        ::close(m_fd);
        m_fd = -1;
        return false;
    }

    setNonBlocking(m_fd);

    LOG_INFO("IpcClient: connected to {}", m_cfg.socketPath);
    return true;
}

void IpcClient::closeSocket()
{
    if (m_fd >= 0)
    {
        ::close(m_fd);
        m_fd = -1;
    }
}

void IpcClient::start()
{
    m_running = true;

    while (m_running)
    {
        if (m_fd < 0)
        {
            if (!connectServer())
            {
                std::this_thread::sleep_for(std::chrono::seconds(1));
                continue;
            }
        }

        recvLoop();

        sendHeartbeat();

        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    closeSocket();
}

void IpcClient::stop()
{
    m_running = false;
}

void IpcClient::recvLoop()
{
    while (true)
    {
        uint8_t* wptr = m_rxRing.writePtr();
        size_t wlen = m_rxRing.writeLen();

        if (wlen == 0)
            return;

        ssize_t r = ::recv(m_fd, wptr, wlen, 0);

        if (r > 0)
        {
            m_rxRing.produce(static_cast<size_t>(r));

            while (true)
            {
                size_t frameLen = 0;

                auto fr = IpcFraming::tryExtractFrame(m_rxRing, frameLen);

                if (fr == IpcFramingResult::NeedMoreData)
                    break;

                if (fr != IpcFramingResult::Ok)
                {
                    LOG_WARN("IpcClient: framing error");
                    closeSocket();
                    return;
                }

                std::vector<uint8_t> frame(frameLen);

                size_t got = m_rxRing.read(frame.data(), frameLen);

                LOG_INFO("Ipc Client recv frame : {}", got);
                if (got != frameLen)
                    return;

                dump(frame.data(), frame.size());
            }

            continue;
        }

        if (r == 0)
        {
            LOG_WARN("IpcClient: server closed");
            closeSocket();
            return;
        }

        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return;

        if (errno == EINTR)
            continue;

        LOG_ERROR("IpcClient: recv error errno={}", errno);
        closeSocket();
        return;
    }
}

void IpcClient::sendHeartbeat()
{
    if (m_fd < 0)
        return;

    auto frame = nf::ipc::buildFrame(
        2,
        nf::ipc::IPC_DST_BROADCAST,
        nf::ipc::IpcCmd::Heartbeat,
        reinterpret_cast<const uint8_t*>("heartbeat"),
        9
    );

    ssize_t r = ::send(m_fd, frame.data(), frame.size(), MSG_NOSIGNAL);

    if (r < 0)
    {
        LOG_ERROR("IpcClient: send failed errno={}", errno);
        closeSocket();
        return;
    }

    LOG_INFO("IpcClient: heartbeat sent");
}
}

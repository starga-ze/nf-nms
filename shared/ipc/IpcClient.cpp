#include "ipc/IpcClient.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <cstring>
#include <fcntl.h>

using namespace nf::ipc;

static constexpr int MAX_EVENTS = 16;

IpcClient::IpcClient(const nf::config::IpcConfig& cfg)
    : m_cfg(cfg), m_events(MAX_EVENTS)
{
}

IpcClient::~IpcClient()
{
    stop();
}

bool IpcClient::connectServer()
{
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        return false;

    if (!setNonBlocking(fd))
        return false;

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path,
                 m_cfg.socketPath.c_str(),
                 sizeof(addr.sun_path) - 1);

    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0)
    {
        if (errno != EINPROGRESS)
            return false;
    }

    m_conn = std::make_unique<IpcConnection>(
        fd,
        m_cfg.rxBufferSize,
        m_cfg.txBufferSize);

    m_epoll.add(fd, EPOLLIN | EPOLLRDHUP);

    return true;
}

void IpcClient::start()
{
    if (!m_epoll.init())
        return;

    if (!connectServer())
        return;

    m_running = true;

    while (m_running)
    {
        int n = m_epoll.wait(m_events, -1);
        if (n <= 0)
            continue;

        for (int i = 0; i < n; ++i)
        {
            uint32_t ev = m_events[i].events;

            if (ev & EPOLLIN)
                handleReadable();

            if (ev & EPOLLOUT)
                handleWritable();
        }
    }
}

void IpcClient::stop()
{
    m_running = false;

    if (m_conn)
    {
        ::close(m_conn->fd());
        m_conn.reset();
    }
}

bool IpcClient::setNonBlocking(int fd)
{
    int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0)
        return false;

    if (::fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
        return false;

    return true;
}

bool IpcClient::sendFrame(const std::vector<uint8_t>& frame)
{
    if (!m_conn)
        return false;

    auto& tx = m_conn->tx();

    if (tx.writable() < frame.size())
        return false;

    tx.write(frame.data(), frame.size());

    m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLOUT | EPOLLRDHUP);

    return true;
}

void IpcClient::handleReadable()
{
    auto& rx = m_conn->rx();

    while (true)
    {
        uint8_t* wptr = rx.writePtr();
        size_t wlen = rx.writeLen();

        ssize_t r = ::recv(m_conn->fd(), wptr, wlen, 0);

        if (r > 0)
        {
            rx.produce(r);

            while (true)
            {
                size_t frameLen = 0;

                auto fr = IpcFraming::tryExtractFrame(rx, frameLen);

                if (fr == IpcFramingResult::NeedMoreData)
                    break;

                if (fr != IpcFramingResult::Ok)
                {
                    LOG_ERROR("IPC client framing error");
                    return;
                }

                std::vector<uint8_t> frame(frameLen);
                rx.read(frame.data(), frameLen);

                LOG_DEBUG("IPC client Rx\n{}",
                          dumpFrame(frame));
            }

            continue;
        }

        if (r == 0)
            return;

        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return;

        return;
    }
}

void IpcClient::handleWritable()
{
    auto& tx = m_conn->tx();

    while (tx.readable() > 0)
    {
        const uint8_t* rptr = tx.readPtr();
        size_t rlen = tx.readLen();

        ssize_t sent =
            ::send(m_conn->fd(), rptr, rlen, MSG_NOSIGNAL);

        if (sent < 0)
        {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                return;

            return;
        }

        tx.consume(sent);

        if ((size_t)sent < rlen)
            return;
    }

    m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLRDHUP);
}

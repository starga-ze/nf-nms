#include "ipc/IpcRouter.h"
#include "ipc/IpcServer.h"

#include "ipc/IpcConnection.h"
#include "ipc/IpcFraming.h"

#include "util/Logger.h"

#include <cstring>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

#include <sys/socket.h>
#include <sys/un.h>

using namespace nf::ipc;

namespace nf::ipcd
{

static constexpr int MAX_EVENTS = 64;
static constexpr int LISTEN_BACKLOG = 64;

IpcServer::IpcServer(const nf::config::IpcConfig& cfg) : m_cfg(cfg), m_events(MAX_EVENTS)
{
    m_router = std::make_unique<IpcRouter>(*this);
}

IpcServer::~IpcServer()
{
    stop();

    if (m_listenFd >= 0)
    {
        ::close(m_listenFd);
        m_listenFd = -1;
    }

    ::unlink(m_cfg.socketPath.c_str());
}

bool IpcServer::init()
{
    if (!m_epoll.init())
    {
        LOG_ERROR("IpcServer: epoll init failed");
        return false;
    }

    if (!createListenSocket())
        return false;

    if (!bindAndListen())
        return false;

    if (!m_epoll.add(m_listenFd, EPOLLIN))
    {
        LOG_ERROR("IpcServer: epoll add listen failed");
        return false;
    }

    LOG_INFO("IpcServer: listen ready path={}", m_cfg.socketPath);
    return true;
}

void IpcServer::start()
{
    if (!init())
        return;

    m_running = true;

    while (m_running)
    {
        int n = m_epoll.wait(m_events, -1);
        if (n < 0)
            continue;

        for (int i = 0; i < n; ++i)
        {
            int fd = m_events[i].data.fd;
            uint32_t ev = m_events[i].events;

            if (fd == m_epoll.getWakeupFd())
            {
                m_epoll.drainWakeup();
                continue;
            }

            if (fd == m_listenFd)
            {
                acceptLoop();
                continue;
            }

            if (ev & (EPOLLERR | EPOLLHUP | EPOLLRDHUP))
            {
                closeConn(fd);
                continue;
            }

            if (ev & EPOLLIN)
                handleReadable(fd);

            if (ev & EPOLLOUT)
                handleWritable(fd);
        }
    }

    for (auto& [fd, _] : m_conns)
    {
        m_epoll.del(fd);
        ::close(fd);
    }

    m_conns.clear();

    m_epoll.del(m_listenFd);
}

void IpcServer::stop()
{
    m_running = false;
    m_epoll.wakeup();
}

bool IpcServer::createListenSocket()
{
    ::unlink(m_cfg.socketPath.c_str());

    m_listenFd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (m_listenFd < 0)
    {
        LOG_ERROR("IpcServer: socket(AF_UNIX) failed errno={}", errno);
        return false;
    }

    if (!setNonBlocking(m_listenFd))
    {
        LOG_ERROR("IpcServer: setNonBlocking listen failed errno={}", errno);
        return false;
    }

    return true;
}

bool IpcServer::bindAndListen()
{
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;

    if (m_cfg.socketPath.size() >= sizeof(addr.sun_path))
    {
        LOG_ERROR("IpcServer: socket path too long: {}", m_cfg.socketPath);
        return false;
    }

    std::strncpy(addr.sun_path, m_cfg.socketPath.c_str(), sizeof(addr.sun_path) - 1);

    if (::bind(m_listenFd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0)
    {
        LOG_ERROR("IpcServer: bind failed path={} errno={}", m_cfg.socketPath, errno);
        return false;
    }

    if (::listen(m_listenFd, LISTEN_BACKLOG) != 0)
    {
        LOG_ERROR("IpcServer: listen failed errno={}", errno);
        return false;
    }

    return true;
}

bool IpcServer::setNonBlocking(int fd)
{
    int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0)
        return false;

    return ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

void IpcServer::acceptLoop()
{
    while (true)
    {
        int fd = ::accept(m_listenFd, nullptr, nullptr);
        if (fd < 0)
        {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                break;

            LOG_ERROR("IpcServer: accept failed errno={}", errno);
            return;
        }

        setNonBlocking(fd);

        m_conns.emplace(fd, 
                std::make_unique<IpcConnection>(fd, m_cfg.rxBufferSize,m_cfg.txBufferSize));

        m_epoll.add(fd, EPOLLIN | EPOLLRDHUP);

        LOG_INFO("IpcServer: client connected fd={}", fd);
    }
}

void IpcServer::closeConn(int fd)
{
    auto it = m_conns.find(fd);
    if (it == m_conns.end())
    {
        LOG_WARN("fd={} not exist on connection map", fd);
        return;
    }

    m_epoll.del(fd);
    ::close(fd);

    m_conns.erase(fd);
    
    m_router->onDisconnect(fd);

    LOG_INFO("IpcServer: client disconnected fd={}", fd);
}

void IpcServer::handleReadable(int fd)
{
    auto it = m_conns.find(fd);
    if (it == m_conns.end())
        return;

    auto& conn = *it->second;
    auto& rxRing = conn.rx();

    while (true)
    {
        uint8_t* wptr = rxRing.writePtr();
        size_t wlen = rxRing.writeLen();

        if (wlen == 0)
        {
            LOG_WARN("IpcServer: rx ring full, closing fd={}", fd);
            closeConn(fd);
            return;
        }

        ssize_t r = ::recv(fd, wptr, wlen, 0);

        if (r > 0)
        {
            rxRing.produce(static_cast<size_t>(r));

            while (true)
            {
                size_t frameLen = 0;

                auto fr = IpcFraming::tryExtractFrame(rxRing, frameLen);

                if (fr == IpcFramingResult::NeedMoreData)
                    break;

                if (fr != IpcFramingResult::Ok)
                {
                    LOG_WARN("IpcServer: framing error, closing fd={}", fd);
                    closeConn(fd);
                    return;
                }

                std::vector<uint8_t> frame(frameLen);

                size_t got = rxRing.read(frame.data(), frameLen);
                if (got != frameLen)
                {
                    LOG_ERROR("IpcServer: rxRing read invariant violation fd={}", fd);
                    closeConn(fd);
                    return;
                }

                m_router->onFrame(fd, frame);
            }

            continue;
        }

        if (r == 0)
        {
            closeConn(fd);
            return;
        }

        if (errno == EINTR)
            continue;

        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return;

        LOG_ERROR("IpcServer: recv error fd={} errno={}", fd, errno);
        closeConn(fd);
        return;
    }
}

void IpcServer::handleWritable(int fd)
{
    auto it = m_conns.find(fd);
    if (it == m_conns.end())
        return;

    auto& conn = *it->second;
    auto& txRing = conn.tx();

    while (txRing.readable() > 0)
    {
        const uint8_t* rptr = txRing.readPtr();
        size_t rlen = txRing.readLen();

        ssize_t sent = ::send(fd, rptr, rlen, MSG_NOSIGNAL);

        if (sent < 0)
        {
            if (errno == EINTR)
                continue;

            if (errno == EAGAIN || errno == EWOULDBLOCK)
            {
                m_epoll.mod(fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP);
                return;
            }

            LOG_ERROR("IpcServer: send error fd={} errno={}", fd, errno);
            closeConn(fd);
            return;
        }

        txRing.consume(static_cast<size_t>(sent));

        if (static_cast<size_t>(sent) < rlen)
        {
            m_epoll.mod(fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP);
            return;
        }
    }

    m_epoll.mod(fd, EPOLLIN | EPOLLRDHUP);
}

bool IpcServer::enqueueTx(int fd, const uint8_t* data, size_t len)
{
    auto it = m_conns.find(fd);
    if (it == m_conns.end())
        return false;

    auto& txRing = it->second->tx();

    if (txRing.writable() < len)
        return false;

    txRing.write(data, len);

    m_epoll.mod(fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP);
    return true;
}

bool IpcServer::sendFrameTo(int dstFd, const std::vector<uint8_t>& frame)
{
    if (frame.empty())
        return true;

    if (!enqueueTx(dstFd, frame.data(), frame.size()))
    {
        LOG_WARN("IpcServer: tx ring full, drop frame dstFd={}", dstFd);
        return false;
    }

    handleWritable(dstFd);
    return true;
}

void IpcServer::broadcastFrame(int srcFd, const std::vector<uint8_t>& frame)
{
    for (auto& [fd, _] : m_conns)
    {
        if (fd == srcFd)
            continue;

        sendFrameTo(fd, frame);
    }
}

} // namespace nf::ipcd

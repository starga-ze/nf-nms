#include "ipc/IpcClient.h"

#include "ipc/IpcFraming.h"
#include "util/Logger.h"

#include <cerrno>
#include <cstring>

#include <fcntl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static constexpr int MAX_EVENTS = 16;
static constexpr int RECONNECT_INTERVAL_MS = 1000;

namespace nf::ipc
{

IpcClient::IpcClient(const nf::config::IpcConfig& cfg, IpcDaemon selfId)
    : m_cfg(cfg), m_selfId(selfId), m_events(MAX_EVENTS)
{
}

IpcClient::~IpcClient()
{
    stop();
    cleanupConnection(false);
}

void IpcClient::setListener(IpcClientListener* listener)
{
    m_listener = listener;
}

bool IpcClient::isConnected() const
{
    return m_state == State::Connected && m_conn != nullptr;
}

IpcDaemon IpcClient::selfId() const
{
    return m_selfId;
}

bool IpcClient::init()
{
    if (m_initialized.load())
        return true;

    if (!m_epoll.init())
    {
        LOG_ERROR("IpcClient: epoll init failed");
        return false;
    }

    m_initialized = true;
    return true;
}

bool IpcClient::setNonBlocking(int fd)
{
    int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0)
    {
        LOG_ERROR("IpcClient: fcntl(F_GETFL) failed fd={} errno={}", fd, errno);
        return false;
    }

    if (::fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0)
    {
        LOG_ERROR("IpcClient: fcntl(F_SETFL,O_NONBLOCK) failed fd={} errno={}", fd, errno);
        return false;
    }

    return true;
}

bool IpcClient::tryConnect()
{
    if (m_conn)
        return true;

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
    {
        LOG_ERROR("IpcClient: socket(AF_UNIX) failed errno={}", errno);
        return false;
    }

    if (!setNonBlocking(fd))
    {
        ::close(fd);
        return false;
    }

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;

    if (m_cfg.socketPath.size() >= sizeof(addr.sun_path))
    {
        LOG_ERROR("IpcClient: socket path too long path={}", m_cfg.socketPath);
        ::close(fd);
        return false;
    }

    std::strncpy(addr.sun_path, m_cfg.socketPath.c_str(), sizeof(addr.sun_path) - 1);

    int rc = ::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    if (rc == 0)
    {
        m_conn = std::make_unique<IpcConnection>(fd, m_cfg.rxBufferSize, m_cfg.txBufferSize);

        m_state = State::Connected;
        m_helloSent = false;

        if (!m_epoll.add(fd, EPOLLIN | EPOLLRDHUP))
        {
            LOG_ERROR("IpcClient: epoll add failed fd={} errno={}", fd, errno);
            ::close(fd);
            m_conn.reset();
            m_state = State::Disconnected;
            return false;
        }

        LOG_INFO("IpcClient: connected immediately path={}", m_cfg.socketPath);

        if (!sendClientHello())
        {
            LOG_ERROR("IpcClient: sendClientHello failed");
            cleanupConnection(false);
            return false;
        }

        notifyConnected();
        return true;
    }

    if (errno != EINPROGRESS)
    {
        LOG_ERROR("IpcClient: connect failed path={} errno={}", m_cfg.socketPath, errno);
        ::close(fd);
        return false;
    }

    m_conn = std::make_unique<IpcConnection>(fd, m_cfg.rxBufferSize, m_cfg.txBufferSize);

    m_state = State::Connecting;
    m_helloSent = false;

    if (!m_epoll.add(fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP))
    {
        LOG_ERROR("IpcClient: epoll add(connecting) failed fd={} errno={}", fd, errno);
        ::close(fd);
        m_conn.reset();
        m_state = State::Disconnected;
        return false;
    }

    LOG_INFO("IpcClient: connecting path={}", m_cfg.socketPath);
    return true;
}

bool IpcClient::finishConnect()
{
    if (!m_conn)
        return false;

    int err = 0;
    socklen_t len = sizeof(err);

    if (::getsockopt(m_conn->fd(), SOL_SOCKET, SO_ERROR, &err, &len) != 0)
    {
        LOG_ERROR("IpcClient: getsockopt(SO_ERROR) failed errno={}", errno);
        return false;
    }

    if (err != 0)
    {
        LOG_ERROR("IpcClient: async connect failed err={}", err);
        return false;
    }

    m_state = State::Connected;

    if (!m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLRDHUP))
    {
        LOG_ERROR("IpcClient: epoll mod(after connect) failed fd={} errno={}", m_conn->fd(), errno);
        return false;
    }

    LOG_INFO("IpcClient: connect completed path={}", m_cfg.socketPath);

    if (!sendClientHello())
    {
        LOG_ERROR("IpcClient: sendClientHello failed after connect");
        return false;
    }

    notifyConnected();
    return true;
}

bool IpcClient::queueFrameLocked(const std::vector<uint8_t>& frame)
{
    if (!m_conn)
        return false;

    if (m_state != State::Connected)
        return false;

    auto& tx = m_conn->tx();

    if (tx.writable() < frame.size())
    {
        LOG_WARN("IpcClient: tx ring full need={} writable={}", frame.size(), tx.writable());
        return false;
    }

    LOG_DEBUG("IPC Client Tx Dump\n{}", dumpFrame(frame));

    tx.write(frame.data(), frame.size());

    if (!m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLOUT | EPOLLRDHUP))
    {
        LOG_ERROR("IpcClient: epoll mod(EPOLLOUT) failed fd={} errno={}", m_conn->fd(), errno);
        return false;
    }

    return true;
}

bool IpcClient::queueFrame(const std::vector<uint8_t>& frame)
{
    std::lock_guard<std::mutex> lock(m_txMutex);

    bool ok = queueFrameLocked(frame);
    if (!ok)
        return false;

    m_epoll.wakeup();
    return true;
}

bool IpcClient::sendClientHello()
{
    const std::string name = daemonToStr(static_cast<uint8_t>(m_selfId));

    auto frame = buildFrameString(m_selfId, IpcDaemon::Ipcd, IpcCmd::ClientHello, name);

    if (frame.empty())
        return false;

    {
        std::lock_guard<std::mutex> lock(m_txMutex);

        if (!m_conn)
            return false;

        if (m_state != State::Connected)
            return false;

        if (m_helloSent)
            return true;

        if (!queueFrameLocked(frame))
            return false;

        m_helloSent = true;
    }

    m_epoll.wakeup();

    LOG_INFO("IpcClient: ClientHello queued daemon={}", name);
    return true;
}

bool IpcClient::send(IpcDaemon dst, IpcCmd cmd, const uint8_t* payload, size_t payloadLen)
{
    auto frame = buildFrame(m_selfId, dst, cmd, payload, payloadLen);
    if (frame.empty())
        return false;

    return queueFrame(frame);
}

bool IpcClient::send(IpcDaemon dst, IpcCmd cmd, const std::vector<uint8_t>& payload)
{
    return send(dst, cmd, payload.data(), payload.size());
}

bool IpcClient::sendString(IpcDaemon dst, IpcCmd cmd, const std::string& s)
{
    return send(dst, cmd, reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

void IpcClient::notifyConnected()
{
    if (m_listener)
        m_listener->onIpcClientConnected(m_selfId);
}

void IpcClient::notifyDisconnected()
{
    if (m_listener)
        m_listener->onIpcClientDisconnected(m_selfId);
}

void IpcClient::cleanupConnection(bool notifyDisconnect)
{
    int fd = -1;
    bool hadConn = false;

    {
        std::lock_guard<std::mutex> lock(m_txMutex);

        if (m_conn)
        {
            fd = m_conn->fd();
            m_conn.reset();
            hadConn = true;
        }

        m_state = State::Disconnected;
        m_helloSent = false;
    }

    if (fd >= 0)
    {
        m_epoll.del(fd);
        ::close(fd);
    }

    if (notifyDisconnect && hadConn)
        notifyDisconnected();
}

void IpcClient::handleDisconnect(const char* reason)
{
    LOG_WARN("IpcClient: disconnect reason={}", reason ? reason : "unknown");
    cleanupConnection(true);
}

void IpcClient::handleReadable()
{
    if (!m_conn)
        return;

    auto& rx = m_conn->rx();

    while (true)
    {
        uint8_t* wptr = rx.writePtr();
        size_t wlen = rx.writeLen();

        if (wlen == 0)
        {
            LOG_ERROR("IpcClient: rx ring full");
            handleDisconnect("rx ring full");
            return;
        }

        ssize_t r = ::recv(m_conn->fd(), wptr, wlen, 0);

        if (r > 0)
        {
            rx.produce(static_cast<size_t>(r));

            while (true)
            {
                size_t frameLen = 0;
                IpcFramingResult fr = IpcFraming::tryExtractFrame(rx, frameLen);

                if (fr == IpcFramingResult::NeedMoreData)
                    break;

                if (fr != IpcFramingResult::Ok)
                {
                    LOG_ERROR("IpcClient: framing error");
                    handleDisconnect("framing error");
                    return;
                }

                std::vector<uint8_t> frame(frameLen);

                size_t got = rx.read(frame.data(), frameLen);
                if (got != frameLen)
                {
                    LOG_ERROR("IpcClient: rx read invariant violation");
                    handleDisconnect("rx read invariant violation");
                    return;
                }

                IpcHeader header{};
                const uint8_t* payload = nullptr;
                size_t payloadLen = 0;

                if (!parseFrame(frame, header, payload, payloadLen))
                {
                    LOG_ERROR("IpcClient: parseFrame failed");
                    handleDisconnect("parseFrame failed");
                    return;
                }

                LOG_DEBUG("Ipc Client Rx Dump\n{}", dumpFrame(frame));

                if (m_listener)
                    m_listener->onIpcClientFrame(header, payload, payloadLen);
            }

            continue;
        }

        if (r == 0)
        {
            handleDisconnect("peer closed");
            return;
        }

        if (errno == EINTR)
            continue;

        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return;

        LOG_ERROR("IpcClient: recv failed errno={}", errno);
        handleDisconnect("recv failed");
        return;
    }
}

void IpcClient::handleWritable()
{
    bool needDisconnect = false;
    const char* disconnectReason = nullptr;

    {
        std::lock_guard<std::mutex> lock(m_txMutex);

        if (!m_conn)
            return;

        auto& tx = m_conn->tx();

        while (tx.readable() > 0)
        {
            const uint8_t* rptr = tx.readPtr();
            size_t rlen = tx.readLen();

            ssize_t sent = ::send(m_conn->fd(), rptr, rlen, MSG_NOSIGNAL);
            if (sent < 0)
            {
                if (errno == EINTR)
                    continue;

                if (errno == EAGAIN || errno == EWOULDBLOCK)
                {
                    if (!m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLOUT | EPOLLRDHUP))
                    {
                        needDisconnect = true;
                        disconnectReason = "epoll mod failed after EAGAIN";
                    }
                    return;
                }

                LOG_ERROR("IpcClient: send failed errno={}", errno);
                needDisconnect = true;
                disconnectReason = "send failed";
                break;
            }

            tx.consume(static_cast<size_t>(sent));

            if (static_cast<size_t>(sent) < rlen)
            {
                if (!m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLOUT | EPOLLRDHUP))
                {
                    needDisconnect = true;
                    disconnectReason = "epoll mod failed after partial send";
                }
                break;
            }
        }

        if (!needDisconnect && m_conn)
        {
            if (!m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLRDHUP))
            {
                needDisconnect = true;
                disconnectReason = "epoll mod failed after tx drain";
            }
        }
    }

    if (needDisconnect)
        handleDisconnect(disconnectReason);
}

void IpcClient::pollOnce(int timeoutMs)
{
    int n = m_epoll.wait(m_events, timeoutMs);
    if (n <= 0)
        return;

    for (int i = 0; i < n; ++i)
    {
        int fd = m_events[i].data.fd;
        uint32_t ev = m_events[i].events;

        if (fd == m_epoll.getEventFd())
        {
            m_epoll.drainWakeup();
            continue;
        }

        if (!m_conn || fd != m_conn->fd())
            continue;

        if (ev & (EPOLLERR | EPOLLHUP | EPOLLRDHUP))
        {
            handleDisconnect("epoll hangup/error");
            continue;
        }

        if (m_state == State::Connecting && (ev & EPOLLOUT))
        {
            if (!finishConnect())
            {
                handleDisconnect("finishConnect failed");
                continue;
            }
        }

        if (!m_conn)
            continue;

        if (ev & EPOLLIN)
        {
            handleReadable();
            if (!m_conn)
                continue;
        }

        if (ev & EPOLLOUT)
        {
            handleWritable();
            if (!m_conn)
                continue;
        }
    }
}

void IpcClient::runLoop()
{
    while (m_running)
    {
        if (!m_conn)
        {
            tryConnect();
            pollOnce(RECONNECT_INTERVAL_MS);
            continue;
        }

        pollOnce(-1);
    }
}

void IpcClient::start()
{
    if (m_running.exchange(true))
        return;

    if (!init())
    {
        m_running = false;
        return;
    }

    LOG_INFO("IpcClient: start daemon={}", daemonToStr(static_cast<uint8_t>(m_selfId)));

    runLoop();

    cleanupConnection(false);

    LOG_INFO("IpcClient: stopped daemon={}", daemonToStr(static_cast<uint8_t>(m_selfId)));
}

void IpcClient::stop()
{
    m_running = false;

    if (m_initialized.load())
        m_epoll.wakeup();
}

} // namespace nf::ipc

#include "ipc/IpcClient.h"

#include "util/Logger.h"

#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <cstring>

#include <sys/socket.h>
#include <sys/un.h>

static constexpr int MAX_EVENTS = 16;
static constexpr int RECONNECT_INTERVAL_MS = 1000;

namespace nf::ipc
{

IpcClient::IpcClient(const nf::config::IpcConfig& cfg, IpcDaemon selfId)
    : m_cfg(cfg),
      m_selfId(selfId),
      m_events(MAX_EVENTS)
{
}

IpcClient::~IpcClient()
{
    stop();
}

bool IpcClient::init()
{
    if (!m_epoll.init())
    {
        LOG_ERROR("IpcClient: epoll init failed");
        return false;
    }

    return true;
}

void IpcClient::start()
{
    if (!init())
        return;

    m_running = true;

    LOG_INFO("IpcClient start daemon={}", daemonToStr((uint8_t)m_selfId));

    while (m_running)
    {
        if (!m_conn)
        {
            tryConnect();
        }

        int n = m_epoll.wait(m_events, m_conn ? -1 : RECONNECT_INTERVAL_MS);

        if (n <= 0)
            continue;

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
                handleReadable();

            if (ev & EPOLLOUT)
                handleWritable();
        }
    }

    cleanupConnection();

    LOG_INFO("IpcClient stopped daemon={}", daemonToStr((uint8_t)m_selfId));
}

void IpcClient::stop()
{
    m_running = false;
    m_epoll.wakeup();
}

bool IpcClient::setNonBlocking(int fd)
{
    int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0)
        return false;

    return ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

bool IpcClient::tryConnect()
{
    if (m_conn)
        return true;

    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
    {
        LOG_ERROR("IpcClient: socket failed errno={}", errno);
        return false;
    }

    setNonBlocking(fd);

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;

    std::strncpy(addr.sun_path,
                 m_cfg.socketPath.c_str(),
                 sizeof(addr.sun_path)-1);

    int rc = ::connect(fd, (sockaddr*)&addr, sizeof(addr));

    if (rc == 0 || errno == EINPROGRESS)
    {
        m_conn = std::make_unique<IpcConnection>(
            fd,
            m_cfg.rxBufferSize,
            m_cfg.txBufferSize);

        m_state = rc == 0 ? State::Connected : State::Connecting;

        m_epoll.add(fd, EPOLLIN | EPOLLOUT | EPOLLRDHUP);

        LOG_INFO("IpcClient connecting path={}", m_cfg.socketPath);

        return true;
    }

    ::close(fd);
    return false;
}

bool IpcClient::finishConnect()
{
    int err = 0;
    socklen_t len = sizeof(err);

    if (::getsockopt(m_conn->fd(), SOL_SOCKET, SO_ERROR, &err, &len) != 0)
        return false;

    if (err != 0)
        return false;

    m_state = State::Connected;

    m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLRDHUP);

    LOG_INFO("IpcClient connected path={}", m_cfg.socketPath);

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

        if (r <= 0)
        {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                return;

            handleDisconnect("recv failed");
            return;
        }

        rx.produce(r);

        while (true)
        {
            size_t frameLen = 0;

            auto fr = IpcFraming::tryExtractFrame(rx, frameLen);

            if (fr == IpcFramingResult::NeedMoreData)
                break;

            if (fr != IpcFramingResult::Ok)
            {
                handleDisconnect("framing error");
                return;
            }

            std::vector<uint8_t> frame(frameLen);
            rx.read(frame.data(), frameLen);

            IpcHeader header{};
            const uint8_t* payload{};
            size_t payloadLen{};

            if (!parseFrame(frame, header, payload, payloadLen))
                continue;

            IpcMessage msg;
            msg.header = header;
            msg.payload.assign(payload, payload + payloadLen);

            std::lock_guard lock(m_rxMutex);
            m_inbox.push(std::move(msg));
        }
    }
}

void IpcClient::handleWritable()
{
    std::lock_guard lock(m_txMutex);

    auto& tx = m_conn->tx();

    while (tx.readable() > 0)
    {
        const uint8_t* rptr = tx.readPtr();
        size_t rlen = tx.readLen();

        ssize_t sent = ::send(m_conn->fd(), rptr, rlen, MSG_NOSIGNAL);

        if (sent < 0)
        {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                return;

            handleDisconnect("send failed");
            return;
        }

        tx.consume(sent);
    }

    m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLRDHUP);
}

bool IpcClient::send(IpcDaemon dst, IpcCmd cmd, const uint8_t* payload, size_t len)
{
    if (!m_conn or m_state != State::Connected)
    {
        return false;
    }

    auto frame = buildFrame(m_selfId, dst, cmd, payload, len);

    std::lock_guard lock(m_txMutex);

    auto& tx = m_conn->tx();

    if (tx.writable() < frame.size())
        return false;

    tx.write(frame.data(), frame.size());

    m_epoll.mod(m_conn->fd(), EPOLLIN | EPOLLOUT | EPOLLRDHUP);

    return true;
}

bool IpcClient::send(IpcDaemon dst, IpcCmd cmd, const std::vector<uint8_t>& payload)
{
    return send(dst, cmd, payload.data(), payload.size());
}

bool IpcClient::sendString(IpcDaemon dst, IpcCmd cmd, const std::string& s)
{
    return send(dst, cmd, (uint8_t*)s.data(), s.size());
}

bool IpcClient::pollMessage(IpcMessage& msg)
{
    std::lock_guard lock(m_rxMutex);

    if (m_inbox.empty())
        return false;

    msg = std::move(m_inbox.front());
    m_inbox.pop();

    return true;
}

bool IpcClient::isConnected() const
{
    return m_state == State::Connected && m_conn != nullptr;
}

void IpcClient::cleanupConnection()
{
    if (!m_conn)
        return;

    int fd = m_conn->fd();

    m_epoll.del(fd);
    ::close(fd);

    m_conn.reset();

    m_state = State::Disconnected;
}

void IpcClient::handleDisconnect(const char* reason)
{
    LOG_WARN("IpcClient disconnect reason={}", reason);

    cleanupConnection();
}

}

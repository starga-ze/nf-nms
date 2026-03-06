#include "ipc/IpcConnection.h"

#include <sys/socket.h>
#include <unistd.h>
#include <errno.h>

namespace nf::ipc
{

IpcConnection::IpcConnection(int fd, size_t rxBuf, size_t txBuf)
    : m_fd(fd), m_rx(rxBuf), m_tx(txBuf)
{
}

bool IpcConnection::recvIntoRing(bool& outPeerClosed, int& outErrno)
{
    outPeerClosed = false;
    outErrno = 0;

    while (true)
    {
        uint8_t* wptr = m_rx.writePtr();
        size_t wlen = m_rx.writeLen();

        if (wlen == 0)
        {
            outErrno = ENOBUFS;
            return false;
        }

        ssize_t r = ::recv(m_fd, wptr, wlen, 0);

        if (r > 0)
        {
            m_rx.produce(static_cast<size_t>(r));
            continue;
        }

        if (r == 0)
        {
            outPeerClosed = true;
            return false;
        }

        if (errno == EINTR)
            continue;

        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return true;

        outErrno = errno;
        return false;
    }
}

bool IpcConnection::flushTx(bool& outPeerClosed, int& outErrno, bool& outWouldBlock)
{
    outPeerClosed = false;
    outErrno = 0;
    outWouldBlock = false;

    while (m_tx.readable() > 0)
    {
        const uint8_t* rptr = m_tx.readPtr();
        size_t rlen = m_tx.readLen();

        ssize_t sent = ::send(m_fd, rptr, rlen, MSG_NOSIGNAL);

        if (sent > 0)
        {
            m_tx.consume(static_cast<size_t>(sent));
            if (static_cast<size_t>(sent) < rlen)
            {
                outWouldBlock = true;
                return true;
            }
            continue;
        }

        if (sent == 0)
        {
            outPeerClosed = true;
            return false;
        }

        if (errno == EINTR)
            continue;

        if (errno == EAGAIN || errno == EWOULDBLOCK)
        {
            outWouldBlock = true;
            return true;
        }

        outErrno = errno;
        return false;
    }

    return true;
}

bool IpcConnection::enqueueTx(const uint8_t* data, size_t len)
{
    if (m_tx.writable() < len)
        return false;
    m_tx.write(data, len);
    return true;
}

bool IpcConnection::enqueueTx(const std::vector<uint8_t>& data)
{
    if (data.empty())
        return true;
    return enqueueTx(data.data(), data.size());
}

} // namespace nf::ipc

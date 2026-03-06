#include "ipc/IpcConnection.h"

namespace nf::ipcd
{

IpcConnection::IpcConnection(int fd, size_t rxSize, size_t txSize)
    : m_fd(fd),
      m_rx(rxSize),
      m_tx(txSize)
{
}

int IpcConnection::fd() const
{
    return m_fd;
}

nf::algorithm::ByteRingBuffer& IpcConnection::rx()
{
    return m_rx;
}

nf::algorithm::ByteRingBuffer& IpcConnection::tx()
{
    return m_tx;
}

} // namespace nf::ipcd

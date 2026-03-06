#pragma once

#include "algorithm/ByteRingBuffer.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace nf::ipc
{

class IpcConnection
{
public:
    IpcConnection(int fd, size_t rxBuf, size_t txBuf);
    ~IpcConnection() = default;

    int fd() const { return m_fd; }

    nf::algorithm::ByteRingBuffer& rx() { return m_rx; }
    nf::algorithm::ByteRingBuffer& tx() { return m_tx; }
    const nf::algorithm::ByteRingBuffer& rx() const { return m_rx; }
    const nf::algorithm::ByteRingBuffer& tx() const { return m_tx; }

    // read from socket into rx ring (non-blocking)
    // returns false on fatal / disconnect
    bool recvIntoRing(bool& outPeerClosed, int& outErrno);

    // attempt to flush tx ring to socket (non-blocking)
    // returns false on fatal / disconnect
    bool flushTx(bool& outPeerClosed, int& outErrno, bool& outWouldBlock);

    // enqueue tx bytes into tx ring (returns false if insufficient space)
    bool enqueueTx(const uint8_t* data, size_t len);
    bool enqueueTx(const std::vector<uint8_t>& data);

private:
    int m_fd{-1};
    nf::algorithm::ByteRingBuffer m_rx;
    nf::algorithm::ByteRingBuffer m_tx;
};

} // namespace nf::ipc

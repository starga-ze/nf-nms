#pragma once

#include "algorithm/ByteRingBuffer.h"

#include <cstddef>
#include <cstdint>

namespace nf::ipcd
{

class IpcConnection
{
    using ByteRingBuffer = nf::algorithm::ByteRingBuffer;

public:
    IpcConnection(int fd, size_t rxSize, size_t txSize);

    int fd() const;

    ByteRingBuffer& rx();
    ByteRingBuffer& tx();

private:
    int m_fd{-1};
    ByteRingBuffer m_rx;
    ByteRingBuffer m_tx;
};

} // namespace nf::ipcd

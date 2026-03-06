#include "algorithm/ByteRingBuffer.h"
#include "ipc/IpcFraming.h"

#include <cstring>

namespace nf::ipc
{

static constexpr size_t IPC_HEADER_SIZE = 2;
static constexpr size_t IPC_MAX_BODY_LEN = 64 * 1024;

uint16_t IpcFraming::readBodyLen(const uint8_t hdr[2])
{
    return (static_cast<uint16_t>(hdr[0]) << 8) | static_cast<uint16_t>(hdr[1]);
}

IpcFramingResult IpcFraming::tryExtractFrame(const ByteRingBuffer& rxRing, size_t& outFrameLen)
{
    if (rxRing.readable() < IPC_HEADER_SIZE)
    {
        return IpcFramingResult::NeedMoreData;
    }

    uint8_t hdr[IPC_HEADER_SIZE];

    rxRing.peek(hdr, IPC_HEADER_SIZE);

    uint16_t bodyLen = readBodyLen(hdr);

    if (bodyLen > IPC_MAX_BODY_LEN)
    {
        return IpcFramingResult::InvalidBodyLen;
    }

    size_t frameLen = bodyLen + IPC_HEADER_SIZE;

    if (rxRing.readable() < frameLen)
    {
        return IpcFramingResult::NeedMoreData;
    }

    outFrameLen = frameLen;

    return IpcFramingResult::Ok;
}

void IpcFraming::buildFrame(const uint8_t* body, size_t bodyLen, std::vector<uint8_t>& outFrame)
{
    if (bodyLen > IPC_MAX_BODY_LEN)
    {
        outFrame.clear();
        return;
    }

    outFrame.resize(bodyLen + IPC_HEADER_SIZE);

    uint8_t* ptr = outFrame.data();

    ptr[0] = static_cast<uint8_t>((bodyLen >> 8) & 0xff);
    ptr[1] = static_cast<uint8_t>(bodyLen & 0xff);

    if (bodyLen > 0)
    {
        std::memcpy(ptr + IPC_HEADER_SIZE, body, bodyLen);
    }
}

void IpcFraming::buildFrame(const std::vector<uint8_t>& body, std::vector<uint8_t>& outFrame)
{
    buildFrame(body.data(), body.size(), outFrame);
}

} // namespace nf::ipc

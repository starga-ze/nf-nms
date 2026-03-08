#include "ipc/IpcFraming.h"
#include "algorithm/ByteRingBuffer.h"

#include <cstdint>
#include <cstring>
#include <arpa/inet.h>

static constexpr size_t IPC_LEN_FIELD_SIZE = 2;
static constexpr size_t IPC_MAX_BODY_LEN   = 64 * 1024; // adjust if needed

namespace nf::ipc
{

IpcFramingResult IpcFraming::tryExtractFrame(const nf::algorithm::ByteRingBuffer& rxRing,
                                            size_t& outFrameLen)
{
    outFrameLen = 0;

    if (rxRing.readable() < IPC_LEN_FIELD_SIZE)
        return IpcFramingResult::NeedMoreData;

    uint16_t bodyLenNet = 0;

    if (!rxRing.peek(reinterpret_cast<uint8_t*>(&bodyLenNet), IPC_LEN_FIELD_SIZE))
        return IpcFramingResult::NeedMoreData;

    const uint16_t bodyLen = ntohs(bodyLenNet);

    if (bodyLen == 0)
        return IpcFramingResult::Invalid;

    if (bodyLen > IPC_MAX_BODY_LEN)
        return IpcFramingResult::TooLarge;

    const size_t frameLen = IPC_LEN_FIELD_SIZE + bodyLen;

    if (rxRing.readable() < frameLen)
        return IpcFramingResult::NeedMoreData;

    outFrameLen = frameLen;
    return IpcFramingResult::Ok;
}

} // namespace nf::ipc

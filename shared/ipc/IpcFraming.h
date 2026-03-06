#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace nf::ipc
{

using ByteRingBuffer = nf::algorithm::ByteRingBuffer;

enum class IpcFramingResult
{
    Ok,
    NeedMoreData,
    InvalidBodyLen
};

class IpcFraming
{
public:
    static IpcFramingResult tryExtractFrame(const ByteRingBuffer& rxRing, size_t& outFrameLen);
    static void buildFrame(const uint8_t* body, size_t bodyLen, std::vector<uint8_t>& outFrame);
    static void buildFrame(const std::vector<uint8_t>& body, std::vector<uint8_t>& outFrame);

private:
    static uint16_t readBodyLen(const uint8_t hdr[2]);
};

} // namespace nf::ipc

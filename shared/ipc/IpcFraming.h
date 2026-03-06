#pragma once

#include <cstddef>

namespace nf::algorithm { class ByteRingBuffer; }

namespace nf::ipc
{

enum class IpcFramingResult
{
    Ok,
    NeedMoreData,
    TooLarge,
    Invalid,
};

class IpcFraming
{
public:
    static IpcFramingResult tryExtractFrame(const nf::algorithm::ByteRingBuffer& rxRing,
                                            size_t& outFrameLen);
};

} // namespace nf::ipc

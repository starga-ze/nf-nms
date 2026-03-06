#pragma once

#include <cstdint>
#include <vector>
#include <string>
#include <cstring>
#include <arpa/inet.h>

namespace nf::ipc
{

// special dst for broadcast
static constexpr uint16_t IPC_DST_BROADCAST = 0xFFFF;

// command ids (extend as you like)
enum class IpcCmd : uint16_t
{
    Hello     = 1,
    Heartbeat = 2,
    UserBase  = 1000,
};

// header (network byte order on wire)
#pragma pack(push, 1)
struct IpcHeader
{
    uint16_t src;   // daemon id
    uint16_t dst;   // daemon id or IPC_DST_BROADCAST
    uint16_t cmd;   // IpcCmd
    uint32_t len;   // payload length
};
#pragma pack(pop)

static_assert(sizeof(IpcHeader) == 10, "IpcHeader size must be 10");

inline IpcHeader hostToNet(IpcHeader h)
{
    h.src = htons(h.src);
    h.dst = htons(h.dst);
    h.cmd = htons(h.cmd);
    h.len = htonl(h.len);
    return h;
}

inline IpcHeader netToHost(IpcHeader h)
{
    h.src = ntohs(h.src);
    h.dst = ntohs(h.dst);
    h.cmd = ntohs(h.cmd);
    h.len = ntohl(h.len);
    return h;
}

// Build a frame: [u16 bodyLen][IpcHeader][payload]
// bodyLen = sizeof(IpcHeader) + payload.size()
inline std::vector<uint8_t> buildFrame(uint16_t src, uint16_t dst, IpcCmd cmd,
                                       const uint8_t* payload, size_t payloadLen)
{
    const size_t bodyLen = sizeof(IpcHeader) + payloadLen;
    if (bodyLen > 0xFFFF)
        return {};

    const uint16_t bodyLenNet = htons(static_cast<uint16_t>(bodyLen));

    std::vector<uint8_t> out;
    out.resize(sizeof(uint16_t) + bodyLen);

    std::memcpy(out.data(), &bodyLenNet, sizeof(uint16_t));

    IpcHeader h{};
    h.src = src;
    h.dst = dst;
    h.cmd = static_cast<uint16_t>(cmd);
    h.len = static_cast<uint32_t>(payloadLen);
    h = hostToNet(h);

    std::memcpy(out.data() + sizeof(uint16_t), &h, sizeof(IpcHeader));

    if (payloadLen > 0)
        std::memcpy(out.data() + sizeof(uint16_t) + sizeof(IpcHeader), payload, payloadLen);

    return out;
}

inline std::vector<uint8_t> buildFrame(uint16_t src, uint16_t dst, IpcCmd cmd,
                                       const std::vector<uint8_t>& payload)
{
    return buildFrame(src, dst, cmd, payload.data(), payload.size());
}

inline std::vector<uint8_t> buildFrameString(uint16_t src, uint16_t dst, IpcCmd cmd,
                                             const std::string& s)
{
    return buildFrame(src, dst, cmd,
                      reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

// Parse frame (expects full frame including u16 length).
// Returns false if invalid.
inline bool parseFrame(const std::vector<uint8_t>& frame,
                       IpcHeader& outHeaderHost,
                       const uint8_t*& outPayload,
                       size_t& outPayloadLen)
{
    if (frame.size() < sizeof(uint16_t) + sizeof(IpcHeader))
        return false;

    uint16_t bodyLenNet = 0;
    std::memcpy(&bodyLenNet, frame.data(), sizeof(uint16_t));
    const uint16_t bodyLen = ntohs(bodyLenNet);

    if (frame.size() != sizeof(uint16_t) + bodyLen)
        return false;

    IpcHeader hNet{};
    std::memcpy(&hNet, frame.data() + sizeof(uint16_t), sizeof(IpcHeader));
    IpcHeader h = netToHost(hNet);

    const size_t payloadLen = bodyLen - sizeof(IpcHeader);
    if (h.len != payloadLen)
        return false;

    outHeaderHost = h;
    outPayload = frame.data() + sizeof(uint16_t) + sizeof(IpcHeader);
    outPayloadLen = payloadLen;
    return true;
}

} // namespace nf::ipc

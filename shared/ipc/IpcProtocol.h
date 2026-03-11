#pragma once

#include <cstdint>
#include <vector>
#include <string>
#include <cstring>
#include <sstream>
#include <iomanip>
#include <arpa/inet.h>

namespace nf::ipc
{

enum class IpcDaemon : uint8_t
{
    Unknown   = 0,
    Ipcd      = 1,
    Engined   = 2,
    Topologyd = 3,
    Mgmtd     = 4,

    Broadcast = 255
};


enum class IpcCmd : uint16_t
{
    Unknown     = 0,
    ClientHello = 1,
    ServerHello = 2,
    HeartBeatReq = 3,
    HeartBeatRes = 4,

    API = 255
};


#pragma pack(push, 1)
struct IpcHeader
{
    uint8_t  src;
    uint8_t  dst;
    uint16_t cmd;
    uint32_t len;
};
#pragma pack(pop)

static_assert(sizeof(IpcHeader) == 8, "IpcHeader must be 8 bytes");

static IpcHeader hostToNet(IpcHeader h)
{
    h.cmd = htons(h.cmd);
    h.len = htonl(h.len);
    return h;
}

static IpcHeader netToHost(IpcHeader h)
{
    h.cmd = ntohs(h.cmd);
    h.len = ntohl(h.len);
    return h;
}


static const char* daemonToStr(uint8_t id)
{
    switch (static_cast<IpcDaemon>(id))
    {
        case IpcDaemon::Ipcd:      return "ipcd";
        case IpcDaemon::Engined:   return "engined";
        case IpcDaemon::Topologyd: return "topologyd";
        case IpcDaemon::Mgmtd:     return "mgmtd";
        case IpcDaemon::Broadcast: return "broadcast";
        default:                   return "unknown";
    }
}


static const char* cmdToStr(uint16_t cmd)
{
    switch (static_cast<IpcCmd>(cmd))
    {
        case IpcCmd::ClientHello:   return "ClientHello";
        case IpcCmd::ServerHello:     return "ServerHello";
        case IpcCmd::API:           return "API";
        default:                    return "Unknown";
    }
}

static std::vector<uint8_t> buildFrame(
        IpcDaemon src,
        IpcDaemon dst,
        IpcCmd cmd,
        const uint8_t* payload,
        size_t payloadLen)
{
    const size_t frameLen = sizeof(IpcHeader) + payloadLen;

    if (frameLen > 0xFFFF)
        return {};

    const uint16_t frameLenNet = htons(static_cast<uint16_t>(frameLen));

    std::vector<uint8_t> out;
    out.resize(sizeof(uint16_t) + frameLen);

    std::memcpy(out.data(), &frameLenNet, sizeof(uint16_t));

    IpcHeader h{};
    h.src = static_cast<uint8_t>(src);
    h.dst = static_cast<uint8_t>(dst);
    h.cmd = static_cast<uint16_t>(cmd);
    h.len = static_cast<uint32_t>(payloadLen);

    h = hostToNet(h);

    std::memcpy(out.data() + sizeof(uint16_t), &h, sizeof(IpcHeader));

    if (payloadLen > 0)
    {
        std::memcpy(
            out.data() + sizeof(uint16_t) + sizeof(IpcHeader),
            payload,
            payloadLen);
    }

    return out;
}


static std::vector<uint8_t> buildFrame(
        IpcDaemon src,
        IpcDaemon dst,
        IpcCmd cmd,
        const std::vector<uint8_t>& payload)
{
    return buildFrame(src, dst, cmd, payload.data(), payload.size());
}


static std::vector<uint8_t> buildFrameString(
        IpcDaemon src,
        IpcDaemon dst,
        IpcCmd cmd,
        const std::string& s)
{
    return buildFrame(
        src,
        dst,
        cmd,
        reinterpret_cast<const uint8_t*>(s.data()),
        s.size());
}

static bool parseFrame(
        const std::vector<uint8_t>& frame,
        IpcHeader& outHeaderHost,
        const uint8_t*& outPayload,
        size_t& outPayloadLen)
{
    if (frame.size() < sizeof(uint16_t) + sizeof(IpcHeader))
        return false;

    uint16_t frameLenNet = 0;
    std::memcpy(&frameLenNet, frame.data(), sizeof(uint16_t));

    const uint16_t frameLen = ntohs(frameLenNet);

    if (frame.size() != sizeof(uint16_t) + frameLen)
        return false;

    IpcHeader hNet{};
    std::memcpy(
        &hNet,
        frame.data() + sizeof(uint16_t),
        sizeof(IpcHeader));

    IpcHeader h = netToHost(hNet);

    const size_t payloadLen = frameLen - sizeof(IpcHeader);

    if (h.len != payloadLen)
        return false;

    outHeaderHost = h;
    outPayload = frame.data() + sizeof(uint16_t) + sizeof(IpcHeader);
    outPayloadLen = payloadLen;

    return true;
}


static std::string dumpFrame(const std::vector<uint8_t>& frame)
{
    std::ostringstream oss;

    oss << "[IPC FRAME]\n";
    oss << "  FrameSize : " << frame.size() << " bytes\n";

    IpcHeader h{};
    const uint8_t* payload = nullptr;
    size_t payloadLen = 0;

    if (!parseFrame(frame, h, payload, payloadLen))
    {
        oss << "  Invalid frame\n";
        return oss.str();
    }

    oss << "  Src       : "
        << daemonToStr(h.src)
        << " (" << (int)h.src << ")\n";

    oss << "  Dst       : "
        << daemonToStr(h.dst)
        << " (" << (int)h.dst << ")\n";

    oss << "  Cmd       : "
        << cmdToStr(h.cmd)
        << " (" << h.cmd << ")\n";

    oss << "  Payload   : "
        << payloadLen << " bytes\n";

    oss << std::hex << std::setfill('0');

    for (size_t i = 0; i < payloadLen; ++i)
    {
        if (i % 16 == 0)
            oss << "    ";

        oss << std::setw(2)
            << static_cast<int>(payload[i])
            << " ";

        if (i % 16 == 15 || i + 1 == payloadLen)
            oss << "\n";
    }

    return oss.str();
}

} // namespace nf::ipc

#pragma once

#include <cstdint>
#include <vector>

namespace nf::ipcd
{

class IpcServer;

class IpcRouter
{
public:
    explicit IpcRouter(IpcServer& server);

    // 현재는 “브로드캐스트”만 제공 (추후: dst-daemon-id lookup 추가 가능)
    void routeBroadcast(int srcFd, const std::vector<uint8_t>& frame);

private:
    IpcServer& m_server;
};

} // namespace nf::ipcd

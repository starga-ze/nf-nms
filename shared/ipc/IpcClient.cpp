#include "ipc/IpcClient.h"

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <cstring>

namespace nf::ipc
{

IpcClient::IpcClient(const std::string& path)
    : m_path(path)
{
}

IpcClient::~IpcClient()
{
    if (m_fd >= 0)
        ::close(m_fd);
}

bool IpcClient::connect()
{
    m_fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (m_fd < 0)
        return false;

    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;

    std::strncpy(addr.sun_path, m_path.c_str(), sizeof(addr.sun_path) - 1);

    if (::connect(m_fd, (sockaddr*)&addr, sizeof(addr)) < 0)
    {
        ::close(m_fd);
        m_fd = -1;
        return false;
    }

    return true;
}

bool IpcClient::send(const void* data, size_t len)
{
    if (m_fd < 0)
        return false;

    const char* p = (const char*)data;
    size_t sent = 0;

    while (sent < len)
    {
        ssize_t n = ::write(m_fd, p + sent, len - sent);
        if (n <= 0)
            return false;

        sent += n;
    }

    return true;
}

}

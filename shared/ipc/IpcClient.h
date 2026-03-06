#pragma once

#include <string>
#include <vector>

namespace nf::ipc
{

class IpcClient
{
public:
    IpcClient(const std::string& path);
    ~IpcClient();

    bool connect();
    bool send(const void* data, size_t len);

private:
    std::string m_path;
    int m_fd{-1};
};

}

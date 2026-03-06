#pragma once

#include <string>
#include <cstdint>

namespace nf::config
{

struct LoggerConfig
{
    std::string name;
    std::string file;

    uint32_t maxFileSize{0};
    uint32_t maxFiles{0};
};

struct IpcConfig
{
    std::string socketPath;

    uint32_t maxConnections{128};
    uint32_t maxFrameSize{65536};

    uint32_t rxBufferSize{65536};
    uint32_t txBufferSize{65536};
};

}

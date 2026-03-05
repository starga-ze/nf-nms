#include "Config.h"

#include <fstream>
#include <iostream>

namespace nf::config
{

bool Config::loadStartupConfig(const std::string& daemonName)
{
    std::string path =
        std::string(PROJECT_ROOT) + "/database/" + daemonName + "/" + daemonName + "-startup-config.json";

    std::ifstream file(path);

    if (!file.is_open())
    {
        std::cerr << "File open failed, config path: " << path << std::endl;
        return false;
    }

    file >> m_json;

    return true;
}

const nlohmann::json& Config::json() const
{
    return m_json;
}

}

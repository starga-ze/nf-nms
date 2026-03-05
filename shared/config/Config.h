#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace nf::config
{

class Config
{
public:
    bool loadStartupConfig(const std::string& daemonName);
    const nlohmann::json& json() const;

private:
    nlohmann::json m_json;

};

}

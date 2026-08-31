#pragma once

#include <cstdint>
#include <nlohmann/json.hpp>
#include <string>

namespace pz::config
{

// The running configuration, addressed by scope and domain.
//
// A domain is what is being configured — sites, the console's listener, the probe's timeouts. The
// scope says who owns it:
//
//   global      infrastructure every daemon shares (ipc, logger). Not operator-facing.
//   pretzel     the appliance.
//   pretzel-ai  the assistant, which deploys and versions on its own clock.
//
// It used to be addressed by DAEMON — engined.service.site, collectord.service.api — and that was
// wrong in a way that only showed up over time: which daemon reads a domain is a fact about the
// code, and it changed twice (probed to collectord, inferd to pretzel-ai) without one operator's
// intent changing with it. Both times a section of operator config had to be moved because a
// process boundary moved underneath it. The scope names the owner instead, and an owner is
// something that survives a refactor.
namespace scope
{
constexpr const char* kGlobal = "global";
constexpr const char* kPretzel = "pretzel";
constexpr const char* kPretzelAi = "pretzel-ai";
}

class Config
{
public:
    // One scope's domain, or an empty object when it is absent. Absent is a legitimate answer,
    // not an error: internal tuning (bootstrap, heartbeat) is deliberately not in the document
    // and is read through this with compiled defaults behind it.
    static const nlohmann::json& section(const std::string& scopeName, const std::string& domain);

    // A whole scope. For the two callers that project rather than read one setting: the settings
    // API, which renders every domain it is allowed to show, and the SSO endpoint.
    static const nlohmann::json& scopeConfig(const std::string& scopeName);

    static nlohmann::json runningConfigRoot();

    static std::uint64_t runningConfigVersion();

    static bool preflight();

    static bool seedStore();

    static bool commitConfig(const nlohmann::json& fullRoot);

    static void invalidateConfigCache();
};

}

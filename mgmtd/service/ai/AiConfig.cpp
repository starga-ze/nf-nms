#include "service/ai/AiConfig.h"

#include "service/MgmtdServiceManager.h"

#include "router/MgmtdTxRouter.h"

#include "config/Config.h"
#include "db/Database.h"
#include "grpc/GrpcMessage.h"
#include "util/Logger.h"
#include "util/Secret.h"

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <utility>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// The sealed vendor keys, opened. Read here and nowhere else on this path: the plaintext exists
// for the length of one push, in the process that already holds the master key, and is handed
// straight to the transport.
//
// A row that will not open is reported and skipped rather than failing the push. A key sealed
// under a master key that has since been replaced is unreadable for good, and the useful outcome
// is an assistant running with the vendors that still work plus a log line naming the one that
// does not — not an assistant that refuses to start.
std::map<std::string, std::string> unsealedKeys()
{
    std::map<std::string, std::string> out;

    if (!pz::util::secret::available())
    {
        LOG_WARN("no credentials.key on this appliance — the assistant's vendor keys cannot be "
                 "opened, and the deployment will be pushed without them");
        return out;
    }

    try
    {
        for (const auto& row : pz::db::Database::instance().queryRows(
                 "SELECT id, key_enc FROM ai_provider_credential_state WHERE key_enc IS NOT NULL"))
        {
            if (row.size() < 2 || row[0].empty())
                continue;
            if (auto opened = pz::util::secret::decrypt(row[1]))
                out.emplace(row[0], std::move(*opened));
            else
                LOG_WARN("the stored key for '{}' could not be opened — it was sealed with a "
                         "different credentials.key", row[0]);
        }
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("ai credential read failed: {}", ex.what());
    }

    return out;
}

// The body of both entry points. `override` is empty for the ordinary push; when it names a
// provider, that vendor's key is taken from it instead of from the store — see the header.
void push(MgmtdServiceManager& sm, const char* reason, const std::string* overrideId,
          const std::string* overrideKey)
{
    const json& providers = pz::config::Config::section(pz::config::scope::kPretzelAi, "providers");

    auto keys = unsealedKeys();
    if (overrideId && !overrideId->empty())
    {
        if (overrideKey && !overrideKey->empty())
            keys[*overrideId] = *overrideKey;
        else
            keys.erase(*overrideId);
    }

    // uint64 in the proto, and protobuf's JSON mapping carries 64-bit integers as strings. Written
    // that way here rather than discovered as a parse failure at the transport.
    json doc = {{"version", std::to_string(pz::config::Config::runningConfigVersion())},
                {"providers", json::array()}};

    int keyed = 0;
    for (const auto& p : providers.value("list", json::array()))
    {
        if (!p.is_object())
            continue;
        const std::string id = p.value("id", std::string());
        if (id.empty())
            continue;

        json entry = {{"id", id}, {"models", p.value("models", json::array())}};
        if (const auto it = keys.find(id); it != keys.end())
        {
            entry["api_key"] = it->second;
            ++keyed;
        }
        doc["providers"].push_back(std::move(entry));
    }

    const std::size_t count = doc["providers"].size();

    // An empty roster is pushed, not skipped. "No providers" is a configuration an operator can
    // arrive at — by removing the last one — and a push that declined to say so would leave the
    // service serving a vendor the console no longer lists.
    //
    // Counted, never logged: which vendors are configured is operational information, the keys
    // themselves are not, and not even their lengths go to the log.
    LOG_INFO("pushing assistant deployment to pretzel-ai (reason={}, version={}, providers={}, keyed={})",
             reason, pz::config::Config::runningConfigVersion(), count, keyed);

    if (count > static_cast<std::size_t>(keyed))
        LOG_WARN("{} provider(s) have no stored API key — their turns will fail until one is "
                 "entered in the console", count - static_cast<std::size_t>(keyed));

    sm.txRouter().handleGrpcMessage(GrpcMessage::applyConfig(doc.dump()));
}

}

void pushAiConfig(MgmtdServiceManager& sm, const char* reason)
{
    push(sm, reason, nullptr, nullptr);
}

void pushAiConfig(MgmtdServiceManager& sm, const char* reason, const std::string& providerId,
                  const std::string& key)
{
    push(sm, reason, &providerId, &key);
}

}

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
void unsealInto(std::map<std::string, std::string>& out, const char* table)
{
    try
    {
        for (const auto& row : pz::db::Database::instance().queryRows(
                 std::string("SELECT id, key_enc FROM ") + table + " WHERE key_enc IS NOT NULL"))
        {
            if (row.size() < 2 || row[0].empty())
                continue;
            if (auto opened = pz::util::secret::decrypt(row[1]))
                out.insert_or_assign(row[0], std::move(*opened));
            else
                LOG_WARN("the stored key for '{}' could not be opened — it was sealed with a "
                         "different credentials.key", row[0]);
        }
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("{} read failed: {}", table, ex.what());
    }
}

std::map<std::string, std::string> unsealedKeys()
{
    std::map<std::string, std::string> out;

    if (!pz::util::secret::available())
    {
        LOG_WARN("no credentials.key on this appliance — the assistant's keys cannot be opened, "
                 "and the deployment will be pushed without them");
        return out;
    }

    // Two stores, one map. The vendors are keyed by their own slug and the guardrail's row is
    // 'airs', so they cannot collide — and the callers below pick the one they mean by name rather
    // than by knowing which table it came from.
    unsealInto(out, "ai_provider_credential_state");
    unsealInto(out, "ai_guardrail_credential_state");

    return out;
}

// The two subscription keys, in the same sealed store under reserved ids. Neither is a vendor that
// serves turns, but both are the same kind of thing: a key an operator pastes in, that mgmtd seals,
// that engined writes, and that travels to pretzel-ai on the next push.
constexpr const char* kAirsCredentialId = "airs";
constexpr const char* kGatewayCredentialId = "portkey";

// The two engines pretzel-ai runs. Fixed, not an open list: each is a different code path over
// there, and a third name arriving in a commit would configure nothing.
constexpr const char* kServices[] = {"chat", "agent"};

// One entry as the proto's ServiceConfig.
//
// Every field, defaults included. proto3 cannot tell an absent field from a zero one, so a document
// that sent only what the operator had set could never express "the system prompt is now empty" or
// "stop inspecting tool results" — the receiving side would read the absence as "unchanged" and go
// on enforcing a setting the console says is off.
//
// What is NOT sent, and deliberately: the endpoints. Each is a fact about the service being called
// — the scan API's, the gateway's — and is compiled into pretzel-ai, which has to speak their
// dialects anyway. A console field for either only ever bought the chance to point one of them at
// something that is not it.
json serviceDoc(const json& entry)
{
    const json cp = entry.value("checkpoints", json::object());
    const json airs = entry.value("airs", json::object());
    const json gw = entry.value("gateway", json::object());
    const json shape = entry.value("shape", json::object());

    return {{"service", entry.value("service", std::string())},
            {"guardrail", entry.value("guardrail", std::string("none"))},
            // Absent means the console did not store the point, and it does not store one this
            // service and guardrail cannot reach — so absent is `false` on the wire, not `true`.
            // Defaulting the other way put "tool_call: true" in a chat push, which pretzel-ai then
            // intersected away: the behaviour was right and the log line was a lie, and the log is
            // the thing an operator reads a scan report against.
            {"checkpoints", {{"prompt", cp.value("prompt", false)},
                             {"response", cp.value("response", false)},
                             {"tool_call", cp.value("tool_call", false)},
                             {"tool_result", cp.value("tool_result", false)}}},
            {"airs_profile_name", airs.value("profile_name", std::string())},
            {"airs_timeout_sec", airs.value("timeout_sec", 30.0)},
            {"airs_fail_open", airs.value("fail_open", false)},
            {"gateway_require_verdict", gw.value("require_verdict", false)},
            {"gateway_timeout_sec", gw.value("timeout_sec", 45.0)},
            {"system_prompt", shape.value("system_prompt", std::string())},
            {"max_tokens", shape.value("max_tokens", 4096)}};
}

// One line an operator can read a scan report against. Which checkpoints are live is the fact that
// matters most there: a point that is off produces no findings, and "no findings" and "nobody
// looked" are the same line in a report that does not say which.
//
// No key and no key length. A length alone narrows a guess.
std::string describeService(const json& svc)
{
    const json& cp = svc["checkpoints"];
    std::string points;
    for (const auto& [field, name] : {std::pair{"prompt", "prompt"},
                                      std::pair{"response", "response"},
                                      std::pair{"tool_call", "tool-call"},
                                      std::pair{"tool_result", "tool-result"}})
    {
        if (cp.value(field, false))
            points += (points.empty() ? "" : "+") + std::string(name);
    }
    return svc.value("service", std::string("?")) + "=" + svc.value("guardrail", std::string("?"))
           + "(" + (points.empty() ? "none" : points) + ")";
}

// The body of both entry points. `override` is empty for the ordinary push; when it names a
// provider, that vendor's key is taken from it instead of from the store — see the header.
void push(MgmtdServiceManager& sm, const char* reason, const std::string* overrideId,
          const std::string* overrideKey)
{
    // First read of the run, and the one that reloads the cache engined's commit just invalidated.
    // Everything below reads from the document it loaded, so the providers, the guardrail and the
    // shape in one push are guaranteed to come from a single running-config version rather than
    // from two that a commit landed between.
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
                {"providers", json::array()},
                {"services", json::array()}};

    // The subscription keys, appliance-wide. One AIRS account and one gateway account, drawn on by
    // whichever services reference them — so they sit beside the service list rather than inside
    // each entry, where two copies of one key would be two things to keep in step.
    if (const auto it = keys.find(kAirsCredentialId); it != keys.end())
        doc["airs_api_key"] = it->second;
    if (const auto it = keys.find(kGatewayCredentialId); it != keys.end())
        doc["gateway_api_key"] = it->second;

    // The running-config domain is `guardrail` and the proto field is `services`, and the
    // difference is deliberate. A domain is named for the page an operator opens — they come here
    // to configure the guardrail — while the field is named for what it carries: one entry per
    // engine. Naming both the same would have made one of the two read wrong.
    //
    // In a fixed order, not the order the list happens to be stored in: the push is compared
    // against the last one by eye in a log, and a document whose entries move around is one nobody
    // can diff. An entry naming neither service is dropped rather than forwarded — pretzel-ai has
    // no engine to give it to.
    const json& services = pz::config::Config::section(pz::config::scope::kPretzelAi, "guardrail");
    for (const auto* want : kServices)
    {
        for (const auto& entry : services.value("list", json::array()))
        {
            if (entry.is_object() && entry.value("service", std::string()) == want)
            {
                doc["services"].push_back(serviceDoc(entry));
                break;
            }
        }
    }

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
    // What each engine is configured to do, in one line. See describeService above for why the
    // checkpoint list is the part worth printing.
    std::string shape;
    for (const auto& svc : doc["services"])
        shape += (shape.empty() ? "" : ", ") + describeService(svc);

    LOG_INFO("pushing assistant deployment to pretzel-ai (reason={}, version={}, providers={}, "
             "keyed={}, services=[{}], airs_key={}, gateway_key={})",
             reason, pz::config::Config::runningConfigVersion(), count, keyed,
             shape.empty() ? "none configured" : shape,
             doc.contains("airs_api_key") ? "stored" : "none",
             doc.contains("gateway_api_key") ? "stored" : "none");

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

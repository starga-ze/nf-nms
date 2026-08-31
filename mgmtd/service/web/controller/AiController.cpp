#include "service/web/controller/AiController.h"

#include "service/MgmtdServiceManager.h"

#include "service/ai/AiConfig.h"

#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"

#include "db/Database.h"
#include "http/HttpMessage.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"
#include "util/Secret.h"

#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// The three vendors, same fixed list the commit schema enforces (SettingsController). A key slot
// exists per vendor id rather than per model, because a key is issued by the vendor and works for
// every model they serve — which is also why the id is the vendor's name and not a model family's.
constexpr const char* kAiProviders[] = {"openai", "google", "anthropic"};

bool knownProvider(const std::string& id)
{
    for (const auto* known : kAiProviders)
    {
        if (id == known)
            return true;
    }
    return false;
}

}

void AiController::credentials(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)sm;
    (void)req;

    // Every vendor is reported, stored or not: the console renders one card per vendor and needs an
    // answer for each of them, and "no row yet" and "a row with no key" are the same fact to a
    // reader — nothing to serve with.
    json out = json::object();
    for (const auto* id : kAiProviders)
        out[id] = {{"stored", false}};

    try
    {
        const auto rows = pz::db::Database::instance().queryRows(
            "SELECT id, (key_enc IS NOT NULL)::int, "
            "COALESCE(to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF'), ''), "
            "COALESCE(to_char(last_test_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF'), ''), "
            "COALESCE(last_test_ok::int::text, ''), COALESCE(last_test_note, '') "
            "FROM ai_provider_credential_state");

        for (const auto& r : rows)
        {
            if (r.size() < 6 || !knownProvider(r[0]))
                continue;
            json e;
            e["stored"] = (r[1] == "1");
            if (!r[2].empty())
                e["updated_at"] = r[2];
            if (!r[3].empty())   // a test has run
                e["last_test"] = {{"at", r[3]}, {"ok", r[4] == "1"}, {"detail", r[5]}};
            out[r[0]] = std::move(e);
        }
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("ai credential state query failed: {}", ex.what());
    }

    // Whether the appliance can seal anything at all. Without the master key a store would fail
    // silently at write time; the console would rather say "not configured" up front.
    json body = {{"providers", std::move(out)}, {"sealing_available", pz::util::secret::available()}};
    fill(resp, 200, body.dump());
}

void AiController::credentialStore(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                   pz::http::HttpResponse& resp)
{
    json input;
    try
    {
        input = json::parse(req.body);
    }
    catch (const std::exception&)
    {
        return fill(resp, 400, R"({"error":"invalid JSON body"})");
    }

    const std::string id = input.value("id", std::string());
    if (!knownProvider(id))
        return fill(resp, 400, R"({"error":"id must be one of openai, google, anthropic"})");

    json payload = {{"id", id}};
    // Kept for the push below, which cannot read it back out of the store in time. Empty means
    // the key was removed, which is what the push takes a clear to mean.
    std::string apiKey;

    if (input.value("clear", false))
    {
        payload["clear"] = true;
        LOG_INFO("ai credential cleared (id={})", id);
    }
    else
    {
        apiKey = input.value("api_key", std::string());
        if (apiKey.empty())
            return fill(resp, 400, R"({"error":"api_key is required"})");

        if (!pz::util::secret::available())
            return fill(resp, 503, R"({"error":"the appliance has no credentials.key — a key cannot be sealed"})");

        const auto sealed = pz::util::secret::encrypt(apiKey);
        if (!sealed)
            return fill(resp, 500, R"({"error":"the key could not be sealed"})");

        payload["key_enc"] = *sealed;
        // Neither the key nor its length is logged — a length alone narrows a guess.
        LOG_INFO("ai credential sealed, handing to engined (id={})", id);
    }

    const std::string body = payload.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Mgmtd);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::AiCredentialStateUpdate);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(body.begin(), body.end()));

    sm.txRouter().handleIpcMessage(std::move(msg));

    // The configuration did not change, but what it can do did: an enabled vendor that had no key
    // now has one, or has lost the one it had. pretzel-ai holds the deployment it was last pushed,
    // so without this the key would not reach it until the next settings commit.
    //
    // The key is handed to the push rather than left to be read back: engined is the only database
    // writer and the message above is one-way, so at this instant the table still holds the value
    // being replaced. Reading it here would push the old key and leave the assistant failing until
    // something else triggered a push. If engined's write did fail, the log says so and the next
    // push reconciles from the table.
    pushAiConfig(sm, "vendor key stored", id, apiKey);

    // A Write is fire-and-forget by design — engined answers no one. The console refetches
    // /api/ai/credentials to see the outcome rather than being told one here, which is the honest
    // shape: what it reads back is the stored state, not this handler's optimism.
    fill(resp, 202, json{{"id", id}, {"status", "pending"}}.dump());
}

}

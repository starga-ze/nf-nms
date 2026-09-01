#include "service/admin/AdminService.h"

#include "service/EnginedServiceManager.h"

#include "db/Database.h"
#include "ipc/IpcMessage.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <string>

namespace pz::engined
{

void AdminService::handleEvent(EnginedServiceManager&, const AdminEvent& event)
{
    if (event.type() != AdminEventType::ReceivePasswordUpdate)
    {
        return;
    }

    const pz::ipc::IpcMessage* in = event.message();
    if (!in || in->getPayload().empty())
    {
        LOG_WARN("empty LocalUserUpdate — dropping");
        return;
    }

    const auto& pl = in->getPayload();
    updatePassword(std::string(reinterpret_cast<const char*>(pl.data()), pl.size()));
}

void AdminService::updatePassword(const std::string& payloadJson)
{
    nlohmann::json root;
    try
    {
        root = nlohmann::json::parse(payloadJson);
    }
    catch (const std::exception& e)
    {
        LOG_WARN("failed to parse LocalUserUpdate payload (error={})", e.what());
        return;
    }

    const std::string username = root.value("username", "");
    if (username.empty())
    {
        LOG_WARN("LocalUserUpdate without a username — dropping");
        return;
    }

    // Removal is its own instruction rather than an empty hash: the columns below are COALESCEd so
    // that a message carrying only a password leaves everything else alone, which means "" cannot
    // also mean "delete the account".
    //
    // The console publishes the account's removal from running_config in the same batch, so both
    // halves of "this person is gone" land together. What is NOT deleted here is anything that
    // referenced them — the schema's foreign keys decide that, and they cascade.
    if (root.value("remove", false))
    {
        const bool gone = pz::db::Database::instance().exec(
            "DELETE FROM local_users WHERE username = $1", {username});
        if (gone)
            LOG_INFO("local account removed (user={})", username);
        else
            LOG_WARN("local_users delete failed (user={})", username);
        return;
    }

    const std::string hash = root.value("password_hash", "");
    const std::string salt = root.value("salt", "");
    if (hash.empty() || salt.empty())
    {
        LOG_WARN("LocalUserUpdate for '{}' carries no credential and is not a removal — dropping",
                 username);
        return;
    }

    // An upsert, because this one message now creates an account as well as re-credentialling one.
    // `oid` is the console's — it declared the account in running_config under that id before this
    // arrived, and the two have to agree or nothing the person owns can be found. It is written
    // only on insert: an account's identity is issued once, and an UPDATE that reset it would
    // orphan everything keyed on it while looking like a password change.
    //
    // `must_change` is only ever true for the account the seeder created, and only until someone
    // signs in as it and replaces the factory password. Nothing that arrives here sets it: the
    // console does not, and a caller that tried would be claiming an appliance is unconfigured.
    const std::string oid = root.value("oid", "");
    const bool mustChange = false;
    (void)root.value("must_change", false);

    const bool ok = pz::db::Database::instance().exec(
        "INSERT INTO local_users (username, password_hash, salt, must_change, oid) "
        "VALUES ($1, $2, $3, $4, COALESCE(NULLIF($5,''), gen_random_uuid()::text)) "
        "ON CONFLICT (username) DO UPDATE SET "
        "password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt, "
        "must_change = EXCLUDED.must_change, updated_at = now()",
        {username, hash, salt, mustChange ? "true" : "false", oid});

    if (ok)
        LOG_INFO("local account credential stored (user={}, must_change={})", username, mustChange);
    else
        LOG_WARN("local_users write failed (user={})", username);
}

}

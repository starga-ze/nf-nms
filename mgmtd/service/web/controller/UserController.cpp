#include "service/web/controller/UserController.h"

#include "service/MgmtdServiceManager.h"
#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"

#include "db/Database.h"
#include "http/HttpMessage.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"
#include "util/PasswordHash.h"

#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// Short enough to type by mistake is short enough to guess. Not a policy engine — an appliance that
// demanded a symbol and a digit would be an appliance whose operators keep the password on a note.
constexpr std::size_t kMinPasswordChars = 8;

}

void UserController::credentials(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)req;

    json out = json::object();
    try
    {
        for (const auto& r : pz::db::Database::instance().queryRows(
                 "SELECT oid, username, (password_hash <> '')::int, must_change::int, "
                 "COALESCE(to_char(updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF'), '') "
                 "FROM local_users"))
        {
            if (r.size() < 5 || r[0].empty())
                continue;
            out[r[0]] = {{"username", r[1]},
                         {"stored", r[2] == "1"},
                         {"must_change", r[3] == "1"},
                         {"updated_at", r[4]}};
        }
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("local account state query failed: {}", ex.what());
    }

    // Which account is asking. The console greys out its own row's delete: an operator removing the
    // account they are signed in as would be locked out of the appliance by their own edit, and the
    // browser has no other way to know which row is theirs.
    const std::string me = sm.authService().sessionUser(sessionCookie(req));

    fill(resp, 200, json{{"users", std::move(out)},
                         {"self", me},
                         {"role", sm.authService().sessionRole(sessionCookie(req))}}.dump());
}

void UserController::credentialStore(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
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

    const std::string oid = input.value("oid", std::string());
    const std::string username = input.value("username", std::string());
    if (oid.empty() || username.empty())
        return fill(resp, 400, R"({"error":"oid and username are required"})");

    // Adding, removing and setting someone's password are the admin's to do. Refused here and not
    // only in the console: the console hides the controls, and a request that arrives without
    // pressing one still has to meet the rule.
    if (!sm.authService().sessionIsAdmin(sessionCookie(req)))
    {
        LOG_WARN("account change refused — not an admin (user={})",
                 sm.authService().sessionUser(sessionCookie(req)));
        return fill(resp, 403, R"({"error":"only an admin may change accounts","code":"FORBIDDEN"})");
    }

    const bool remove = input.value("remove", false);
    const std::string me = sm.authService().sessionUser(sessionCookie(req));

    // Refused here rather than left to the console's greyed-out button. The button is a courtesy;
    // this is the rule, and a request that arrives without going through the button still has to
    // meet it — signing out of the appliance permanently is not an outcome a stray POST may reach.
    if (remove && username == me)
        return fill(resp, 409, R"({"error":"you cannot remove the account you are signed in as"})");

    json payload = {{"oid", oid}, {"username", username}};

    if (remove)
    {
        // The last account is the appliance's only way in. Counted at the moment of the request
        // rather than trusted from the console, which may be looking at a list that has moved.
        try
        {
            const auto rows = pz::db::Database::instance().queryRows("SELECT count(*) FROM local_users");
            if (!rows.empty() && !rows.front().empty() && rows.front()[0] == "1")
                return fill(resp, 409, R"({"error":"this is the last local account — the appliance would have no way in"})");
        }
        catch (const std::exception& ex)
        {
            LOG_WARN("local account count failed ({}) — refusing the removal", ex.what());
            return fill(resp, 503, R"({"error":"the account list could not be read"})");
        }

        payload["remove"] = true;
        LOG_INFO("local account removal handed to engined (user={})", username);
    }
    else
    {
        const std::string password = input.value("password", std::string());
        if (password.size() < kMinPasswordChars)
            return fill(resp, 400,
                        json{{"error", "the password must be at least " + std::to_string(kMinPasswordChars)
                                       + " characters"}}.dump());

        const auto cred = sm.authService().makeCredential(password);
        payload["password_hash"] = cred.passwordHash;
        payload["salt"] = cred.salt;
        // Never set from here. A forced change means one thing on this appliance — the seeded admin
        // is still on the password the factory gave it — and that is the only state anyone should
        // read it as. It used to be set for every account an admin created, which made "must
        // change" mean two different things and turned a routine account creation into the same
        // signal as an unconfigured appliance.
        payload["must_change"] = false;
        // Neither the password nor its length is logged — a length alone narrows a guess.
        LOG_INFO("local account credential sealed, handing to engined (user={})", username);
    }

    const std::string body = payload.dump();
    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Mgmtd);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::LocalUserUpdate);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(body.begin(), body.end()));
    sm.txRouter().handleIpcMessage(std::move(msg));

    // A Write is fire-and-forget by design — engined answers no one. The console refetches
    // /api/user/credentials to see the outcome rather than being told one here, which is the honest
    // shape: what it reads back is the stored state, not this handler's optimism.
    fill(resp, 202, json{{"oid", oid}, {"status", "pending"}}.dump());
}

}

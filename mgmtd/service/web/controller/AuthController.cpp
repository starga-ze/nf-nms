#include "service/web/controller/AuthController.h"

#include "service/MgmtdServiceManager.h"

#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"

#include "http/HttpMessage.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <memory>
#include <string>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// Hands a new local credential to engined, the only database writer. Shared by the explicit
// password change and by the transparent upgrade a login performs when it meets an
// old-format hash.
void persistCredential(MgmtdServiceManager& sm, const std::string& username,
                       const AuthService::Credential& cred)
{
    // `must_change` false: this is someone setting their own password, which is the act that
    // clears a forced change rather than one that imposes it. An operator setting a password FOR
    // someone else goes through UserController, which sets it true.
    const json payload = {{"username", username},
                          {"password_hash", cred.passwordHash},
                          {"salt", cred.salt},
                          {"must_change", false}};
    const std::string payloadStr = payload.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Mgmtd);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::LocalUserUpdate);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(payloadStr.begin(), payloadStr.end()));

    sm.txRouter().handleIpcMessage(std::move(msg));
}

}

void AuthController::login(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    try
    {
        const auto body = json::parse(req.body);
        const auto username = body.at("username").get<std::string>();
        const auto password = body.at("password").get<std::string>();

        const auto result = sm.authService().login(username, password);
        if (result.throttled)
            return fill(resp, 429, R"({"error":"too many failed attempts — try again shortly"})");
        if (!result.success)
            return fill(resp, 401, R"({"error":"invalid credentials"})");

        // The credential verified against an outdated hash format. This is the only moment the
        // plaintext exists, so it is re-stored now rather than left to expire on its own — the
        // operator sees nothing, and the old-format row is gone after one login.
        if (result.rehashNeeded)
        {
            const auto cred = sm.authService().makeCredential(password);
            if (cred.passwordHash.empty())
            {
                LOG_WARN("credential upgrade skipped — rehash failed (user={})", username);
            }
            else
            {
                // Nothing to update in memory: the credential is read from the table when it is
                // needed, so engined's write is the whole of it.
                persistCredential(sm, username, cred);
                LOG_INFO("credential upgraded to the current hash format (user={})", username);
            }
        }

        const json okBody = {{"status", "ok"}, {"must_change", result.mustChange}};
        fill(resp, 200, okBody.dump());
        resp.setCookie = "session=" + result.sessionId + "; HttpOnly; Path=/; SameSite=Strict";
    }
    catch (const std::exception& e)
    {
        LOG_WARN("login bad request (error={})", e.what());
        fill(resp, 400, R"({"error":"bad request"})");
    }
}

void AuthController::logout(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    sm.authService().logout(sessionCookie(req));

    fill(resp, 200, R"({"status":"logged_out"})");
    resp.setCookie = "session=; Path=/; Max-Age=0";
}

void AuthController::changePassword(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    try
    {
        const auto body = json::parse(req.body);
        const auto oldPass = body.at("old_password").get<std::string>();
        const auto newPass = body.at("new_password").get<std::string>();

        if (newPass.empty())
            return fill(resp, 400, R"({"error":"new password must not be empty"})");

        // The session's account, not "the" account. This used to read a cached username, which
        // was always the seeded admin — so a second person changing their password checked the
        // admin's current one and then overwrote the admin's.
        const std::string user = sm.authService().sessionUser(sessionCookie(req));
        if (user.empty())
            return fill(resp, 401, R"({"error":"unauthorized"})");
        if (!sm.authService().checkPassword(user, oldPass))
            return fill(resp, 401, R"({"error":"current password is incorrect"})");

        const auto cred = sm.authService().makeCredential(newPass);
        if (cred.passwordHash.empty())
        {
            // The CSPRNG or the KDF failed. Reporting success here would leave the old password
            // in place while telling the operator it had changed.
            LOG_ERROR("password change aborted — credential could not be generated (user={})", user);
            return fill(resp, 500, R"({"error":"could not generate the new credential"})");
        }

        persistCredential(sm, user, cred);

        LOG_INFO("password change sent to engined (user={})", user);
        fill(resp, 200, R"({"status":"ok"})");
    }
    catch (const std::exception& e)
    {
        LOG_WARN("change-password bad request (error={})", e.what());
        fill(resp, 400, R"({"error":"bad request"})");
    }
}

void AuthController::whoami(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    const std::string user = sm.authService().sessionUser(sessionCookie(req));
    const json out = {{"username", user},
                      {"role", sm.authService().sessionRole(sessionCookie(req))}};
    fill(resp, 200, out.dump());
}

// Push the idle timeout out by a full TTL. The router has already answered 401 for a session that
// expired, so reaching here means the operator is still signed in and has just done something.
// The new lifetime is echoed back: the frontend does not need it today, but a client that wants to
// warn before a session goes should read it rather than hardcode what this daemon considers 30
// minutes.
void AuthController::keepalive(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                               pz::http::HttpResponse& resp)
{
    if (!sm.authService().renewSession(sessionCookie(req)))
        return fill(resp, 401, R"({"error":"unauthorized","code":"UNAUTHENTICATED"})");

    const json out = {{"expires_in", sm.authService().sessionTtlSec()}};
    fill(resp, 200, out.dump());
}

}

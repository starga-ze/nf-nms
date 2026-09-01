#include "service/auth/AuthService.h"

#include "service/MgmtdServiceManager.h"
#include "service/auth/AuthEvent.h"

#include "config/Config.h"
#include "db/Database.h"
#include "util/Logger.h"
#include "util/PasswordHash.h"

#include <nlohmann/json.hpp>

#include <openssl/rand.h>

#include <algorithm>
#include <chrono>

namespace pz::mgmtd
{

// Every account, read where it is needed rather than cached here.
//
// This used to hold one row — `WHERE username = 'admin'` — and login compared the name against it
// before checking anything else, so an account created in the console could be written correctly to
// local_users and still be refused at the door. There is more than one account now, and the table
// is the only thing that knows them all.
AuthService::Stored AuthService::readAccount(const std::string& username)
{
    Stored out;
    try
    {
        const auto rows = pz::db::Database::instance().queryRows(
            "SELECT username, password_hash, salt, must_change FROM local_users "
            "WHERE username = $1 LIMIT 1",
            {username});
        if (rows.empty() || rows.front().size() < 4)
            return out;

        out.username = rows.front()[0];
        out.passwordHash = rows.front()[1];
        out.salt = rows.front()[2];
        out.mustChange = (rows.front()[3] == "t");
        out.found = true;
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("local account read failed: {}", ex.what());
    }
    return out;
}

// The role is a declaration, so it comes from running_config and not from the credential table.
// An account with a row and no declaration is one the appliance cannot say anything about, and the
// safe reading of that is the lesser role.
std::string AuthService::declaredRole(const std::string& username)
{
    const auto& users = pz::config::Config::section(pz::config::scope::kPretzel, "user");
    for (const auto& u : users.value("list", nlohmann::json::array()))
    {
        if (u.is_object() && u.value("username", std::string()) == username)
        {
            const std::string role = u.value("role", std::string());
            return role == kRoleAdmin ? kRoleAdmin : kRoleUser;
        }
    }
    return kRoleUser;
}

bool AuthService::loadCredential()
{
    try
    {
        const auto rows = pz::db::Database::instance().queryRows(
            "SELECT count(*) FROM local_users WHERE password_hash <> ''");
        m_loaded = !rows.empty() && !rows.front().empty() && rows.front()[0] != "0";
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("local account count failed: {}", ex.what());
        m_loaded = false;
    }

    if (!m_loaded)
        LOG_WARN("no readable local account — refusing logins until one is available (retrying)");
    return m_loaded;
}

bool AuthService::adminSetupPending() const
{
    try
    {
        // Any account still on the password the seeder gave it. Only the seeded admin can be in
        // that state — nothing else sets the flag — so this is the appliance asking whether its own
        // first run is finished, which is why federated sign-in is not offered until it is.
        const auto rows = pz::db::Database::instance().queryRows(
            "SELECT count(*) FROM local_users WHERE must_change");
        return !rows.empty() && !rows.front().empty() && rows.front()[0] != "0";
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("admin setup check failed: {}", ex.what());
    }
    return false;
}

AuthService::LoginResult AuthService::login(const std::string& username, const std::string& password)
{
    // Checked before the hash so a blocked attempt costs nothing. Per username rather than per
    // appliance: a global window meant one account being guessed at locked everyone else out.
    if (throttled(username))
    {
        LoginResult blocked;
        blocked.throttled = true;
        return blocked;
    }

    const Stored account = readAccount(username);
    if (!account.found || account.passwordHash.empty())
    {
        // Deliberately not throttled and deliberately silent about which half was wrong. An
        // unknown username never reaches the KDF, so it costs nothing to answer and there is
        // nothing to rate-limit; saying so would also tell a caller which names exist.
        return {};
    }

    if (!pz::util::verifyPassword(password, account.salt, account.passwordHash))
    {
        noteLoginFailure(username);
        return {};
    }

    m_throttles.erase(username);

    const auto sessionId = generateSessionId();
    if (sessionId.empty())
    {
        LOG_ERROR("session id generation failed — refusing the login");
        return {};
    }

    Session session;
    session.expiresAt = now() + m_sessionTtlSec;
    session.username = account.username;
    session.role = declaredRole(account.username);
    session.mustChange = account.mustChange;
    m_sessions[sessionId] = session;

    LOG_INFO("sign-in (user={}, role={})", account.username, session.role);

    LoginResult result;
    result.success = true;
    result.sessionId = sessionId;
    result.mustChange = account.mustChange;
    result.rehashNeeded = pz::util::needsRehash(account.passwordHash);
    return result;
}

bool AuthService::throttled(const std::string& username)
{
    const auto it = m_throttles.find(username);
    return it != m_throttles.end() && now() < it->second.nextAllowedAt;
}

void AuthService::noteLoginFailure(const std::string& username)
{
    // Bounded. Only names that got as far as the KDF land here — an unknown one returns before
    // this — but an attacker who knows several real names could still grow the map, so the oldest
    // window is dropped rather than letting it run.
    if (m_throttles.size() >= kMaxThrottled && m_throttles.find(username) == m_throttles.end())
        m_throttles.erase(m_throttles.begin());

    Throttle& t = m_throttles[username];
    ++t.failures;

    if (t.failures <= kFreeAttempts)
        return;

    // Doubles per failure past the free allowance, capped — enough to make guessing
    // impractical without locking a fat-fingered operator out for the rest of the day.
    std::uint64_t delay = 1;
    for (int i = kFreeAttempts + 1; i < t.failures && delay < kMaxBackoffSec; ++i)
        delay *= 2;
    delay = std::min(delay, kMaxBackoffSec);

    t.nextAllowedAt = now() + delay;

    LOG_WARN("login throttled for '{}' after {} consecutive failures (retry in {}s)", username,
             t.failures, delay);
}

std::string AuthService::createSsoSession(const std::string& username)
{
    const auto sessionId = generateSessionId();
    Session session;
    session.expiresAt = now() + m_sessionTtlSec;
    session.username = username;
    // Federated accounts are declared the same way local ones are, so the role comes from the
    // same place. One that is not declared gets the lesser role rather than none at all.
    session.role = declaredRole(username);
    m_sessions[sessionId] = session;
    return sessionId;
}

std::string AuthService::sessionUser(const std::string& sessionId) const
{
    auto it = m_sessions.find(sessionId);
    if (it == m_sessions.end() || now() > it->second.expiresAt)
        return {};
    return it->second.username;
}

std::string AuthService::sessionRole(const std::string& sessionId) const
{
    const auto it = m_sessions.find(sessionId);
    if (it == m_sessions.end() || now() > it->second.expiresAt)
        return {};
    return it->second.role;
}

bool AuthService::mustChangePassword(const std::string& sessionId) const
{
    const auto it = m_sessions.find(sessionId);
    if (it == m_sessions.end() || now() > it->second.expiresAt)
        return false;
    return it->second.mustChange;
}

bool AuthService::checkPassword(const std::string& username, const std::string& password) const
{
    const Stored account = readAccount(username);
    if (!account.found || account.passwordHash.empty())
        return false;
    return pz::util::verifyPassword(password, account.salt, account.passwordHash);
}

AuthService::Credential AuthService::makeCredential(const std::string& newPassword) const
{
    Credential cred;
    cred.salt = pz::util::generateSalt();
    if (cred.salt.empty())
    {
        LOG_ERROR("salt generation failed — credential not created");
        return {};
    }

    cred.passwordHash = pz::util::hashPassword(newPassword, cred.salt);
    if (cred.passwordHash.empty())
    {
        LOG_ERROR("password hashing failed — credential not created");
        return {};
    }

    return cred;
}

bool AuthService::validateSession(const std::string& sessionId)
{
    if (sessionId.empty())
    {
        return false;
    }

    auto it = m_sessions.find(sessionId);
    if (it == m_sessions.end())
    {
        return false;
    }

    if (now() > it->second.expiresAt)
    {
        m_sessions.erase(it);
        return false;
    }

    return true;
}

bool AuthService::renewSession(const std::string& sessionId)
{
    // The router already validated the session before routing here, so an expired one cannot
    // reach this — but the check is repeated rather than assumed: resurrecting a dead session
    // is the one mistake this function could make.
    if (!validateSession(sessionId))
    {
        return false;
    }

    m_sessions[sessionId].expiresAt = now() + m_sessionTtlSec;
    return true;
}

void AuthService::logout(const std::string& sessionId)
{
    m_sessions.erase(sessionId);
}

std::uint64_t AuthService::now()
{
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// 256 bits from the CSPRNG. The previous implementation seeded mt19937_64 from a single
// random_device draw, so despite emitting a long string the whole session space was the 32 bits
// of that seed — enumerable, and the timestamp prefix only narrowed it further. A session id is
// a bearer token: guessing one is the same as stealing it.
std::string AuthService::generateSessionId()
{
    unsigned char buf[32];
    if (RAND_bytes(buf, static_cast<int>(sizeof(buf))) != 1)
    {
        return {};
    }

    static const char* hex = "0123456789abcdef";
    std::string out;
    out.reserve(sizeof(buf) * 2);
    for (unsigned char c : buf)
    {
        out.push_back(hex[(c >> 4) & 0xF]);
        out.push_back(hex[c & 0xF]);
    }
    return out;
}


// authd verified (or rejected) a SAML assertion. seqNo is the ticket SsoController handed the
// browser, so the answer is filed under it and drained there.
void AuthService::handleEvent(MgmtdServiceManager& serviceManager, const AuthEvent& event)
{
    if (event.type() != AuthEventType::ReceiveSamlAcsResponse)
    {
        LOG_WARN("unhandled auth event (type={})", static_cast<std::uint32_t>(event.type()));
        return;
    }

    const auto* msg = event.message();
    if (!msg)
    {
        LOG_WARN("received empty AuthSamlAcsResponse");
        return;
    }

    const auto& pl = msg->getPayload();
    if (pl.empty())
    {
        // A browser is mid-login on this ticket. Dropping the message would leave it polling until
        // its own timeout with nothing to show, so the ticket is failed explicitly instead.
        LOG_WARN("empty SAML ACS response (seq={}) — failing the ticket", msg->getSeqNo());
        serviceManager.setSsoResult(msg->getSeqNo(), R"({"ok":false,"error":"authd returned an empty result"})");
        return;
    }

    serviceManager.setSsoResult(msg->getSeqNo(), std::string(pl.begin(), pl.end()));
}

}

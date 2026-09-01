#pragma once

#include <cstdint>
#include <string>
#include <unordered_map>

namespace pz::mgmtd
{

class MgmtdServiceManager;
class AuthEvent;

class AuthService
{
public:
    // The one asynchronous part of this domain: authd verified a SAML assertion and answered on the
    // ticket the browser is polling. Everything else here answers inside the request that asked.
    void handleEvent(MgmtdServiceManager& serviceManager, const AuthEvent& event);

    struct LoginResult
    {
        bool success{false};
        std::string sessionId;
        bool mustChange{false};
        // The stored credential verified, but in an outdated format. The caller has the
        // plaintext at exactly this moment and nowhere else, so this is the only opportunity to
        // re-store it — see WebService::handleLogin.
        bool rehashNeeded{false};
        // Refused before the password was even checked, because too many attempts failed
        // recently. Distinguished from a wrong password so the UI can say so.
        bool throttled{false};
    };

    AuthService() = default;

    struct Credential
    {
        std::string passwordHash;
        std::string salt;
    };

    // Whether any account exists to sign in as. Retried at boot until the database answers —
    // it does not cache a credential, because there is no longer one account to cache.
    bool loadCredential();

    LoginResult login(const std::string& username, const std::string& password);

    std::string createSsoSession(const std::string& username);

    bool checkPassword(const std::string& username, const std::string& password) const;

    Credential makeCredential(const std::string& newPassword) const;

    // The role the account signed in on this session holds, or "" for a session that is not
    // live. Read from running_config, where the account is declared — not from local_users, which
    // holds only what proves an account rather than what it may do. That split is what puts a
    // change of role in the review diff.
    std::string sessionRole(const std::string& sessionId) const;

    bool sessionIsAdmin(const std::string& sessionId) const
    {
        return sessionRole(sessionId) == kRoleAdmin;
    }

    // Whether the person on this session still has to replace their password. Per session, not per
    // appliance: it used to be a single flag about the seeded admin, which meant one account's
    // pending change locked every other account out of every route.
    bool mustChangePassword(const std::string& sessionId) const;

    // Whether the appliance's own first-run setup is still pending — any admin account that has
    // not replaced its seeded password. Distinct from the per-session question above: this is what
    // decides whether federated sign-in may be offered at all.
    bool adminSetupPending() const;

    bool credentialLoaded() const
    {
        return m_loaded;
    }

    static constexpr const char* kRoleAdmin = "admin";
    static constexpr const char* kRoleUser = "user";

    std::uint64_t sessionTtlSec() const
    {
        return m_sessionTtlSec;
    }

    // Checks a session without touching its lifetime. Every authenticated request goes through
    // this, and most of them are not the operator doing anything — the Home dashboard, the
    // Infrastructure and API Collection live views and the log tail all poll on timers. If those
    // extended the session, leaving a browser tab open on any of them would keep it alive for
    // ever and the timeout would mean nothing.
    bool validateSession(const std::string& sessionId);

    // Extends a live session by the full TTL. Called only from the keepalive route, which the
    // frontend fires only after real operator input (see the heartbeat in www/js/main.js) — that
    // is what makes the TTL an idle timeout rather than a fixed session lifetime.
    bool renewSession(const std::string& sessionId);

    void logout(const std::string& sessionId);

    std::string sessionUser(const std::string& sessionId) const;

private:
    struct Session
    {
        std::uint64_t expiresAt{0};
        std::string username;
        // Snapshotted at sign-in. A session does not re-read the account on every request: the
        // role is a declaration that changes at a commit, and a person whose role is taken away
        // mid-session keeps it until they sign in again — which is the same bargain the session
        // TTL already makes about an account being removed.
        std::string role;
        bool mustChange{false};
    };

    // One account's stored credential, read at the moment it is needed.
    struct Stored
    {
        std::string username;
        std::string passwordHash;
        std::string salt;
        bool mustChange{false};
        bool found{false};
    };

    static Stored readAccount(const std::string& username);
    static std::string declaredRole(const std::string& username);

    static std::uint64_t now();
    static std::string generateSessionId();

    // Password verification is deliberately expensive (PBKDF2), and this daemon runs one
    // cooperative loop — so an unauthenticated caller guessing in a loop would both brute-force
    // the password and stall the daemon. Consecutive failures against a known username back
    // off; a correct password clears the counter. Unknown usernames never reach the hash, so
    // they cost nothing and need no throttle.
    struct Throttle
    {
        int failures{0};
        std::uint64_t nextAllowedAt{0};
    };

    static constexpr int kFreeAttempts = 5;
    static constexpr std::uint64_t kMaxBackoffSec = 30;
    // Per username, so one account being guessed at does not lock the others out — and bounded,
    // so an attacker cycling usernames cannot grow this map instead.
    static constexpr std::size_t kMaxThrottled = 64;

    bool throttled(const std::string& username);
    void noteLoginFailure(const std::string& username);

private:
    std::unordered_map<std::string, Session> m_sessions;
    std::unordered_map<std::string, Throttle> m_throttles;

    bool m_loaded{false};
    // Idle timeout: 30 minutes with no operator input. Set at login and pushed forward by
    // renewSession(); nothing else moves it.
    std::uint64_t m_sessionTtlSec{1800};
};

}

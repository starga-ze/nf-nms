#include "Config.h"

#include "db/Database.h"
#include "util/PasswordHash.h"

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <optional>
#include <thread>

namespace pz::config
{

namespace
{

constexpr const char* kDefaultAdminUser = "admin";
constexpr const char* kDefaultAdminPassword = "admin";

std::string envOr(const char* envVar, const std::string& fallback)
{
    const char* value = std::getenv(envVar);
    return (value && *value) ? std::string(value) : fallback;
}

std::string configDir()
{
    return envOr("PRETZEL_CONFIG_DIR", "/etc/pretzel");
}

std::string startupConfigPath()
{
    return configDir() + "/startup-config.json";
}

nlohmann::json readStartupFile()
{
    try
    {
        std::ifstream file(startupConfigPath());
        if (!file.is_open())
        {
            std::cerr << "config: cannot open startup-config: " << startupConfigPath() << std::endl;
            return nlohmann::json::object();
        }
        nlohmann::json json;
        file >> json;
        return json.is_object() ? json : nlohmann::json::object();
    }
    catch (const std::exception& e)
    {
        std::cerr << "config: failed to parse startup-config: " << e.what() << std::endl;
        return nlohmann::json::object();
    }
}

bool bootstrapDatabase()
{
    static bool s_ready = false;

    if (s_ready)
        return true;

    pz::db::ConnParams params;
    try
    {
        const nlohmann::json root = readStartupFile();
        const nlohmann::json db = root.value("pretzel", nlohmann::json::object())
                                      .value("database", nlohmann::json::object());
        if (db.is_object())
        {
            params.host = db.value("host", params.host);
            params.name = db.value("name", params.name);
            params.user = db.value("user", params.user);
            params.password = db.value("password", params.password);
            if (db.contains("port"))
            {
                const auto& p = db["port"];
                params.port = p.is_string() ? p.get<std::string>() : std::to_string(p.get<long long>());
            }
        }
    }
    catch (const std::exception& e)
    {
        std::cerr << "config: database block parse failed (" << e.what() << "), using defaults" << std::endl;
    }

    if (!pz::db::Database::instance().connect(params))
    {
        std::cerr << "config: database unavailable (host=" << params.host << " port=" << params.port
                  << " db=" << params.name << ")" << std::endl;
        return false;
    }

    s_ready = true;
    return true;
}

std::optional<std::pair<std::uint64_t, nlohmann::json>> latestRunningConfig()
{
    const auto rows = pz::db::Database::instance().queryRows("SELECT version, config_json FROM running_config "
                                                             "WHERE state = 'active' ORDER BY version DESC LIMIT 1");
    if (rows.empty() || rows.front().size() < 2)
        return std::nullopt;

    std::uint64_t version = 0;
    try
    {
        version = std::stoull(rows.front()[0]);
    }
    catch (const std::exception&)
    {
        return std::nullopt;
    }

    auto parsed = nlohmann::json::parse(rows.front()[1], nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object())
        return std::nullopt;
    return std::make_pair(version, std::move(parsed));
}

nlohmann::json redactSecretsForPersist(nlohmann::json root)
{
    if (!root.is_object())
        return root;

    auto s = root.find("pretzel");
    if (s == root.end() || !s->is_object())
        return root;

    if (auto d = s->find("database"); d != s->end() && d->is_object())
        d->erase("password");

    if (auto c = s->find("console"); c != s->end() && c->is_object())
        c->erase("admin");

    return root;
}

std::uint64_t& runningConfigVersionCache()
{
    static std::uint64_t s_version = 0;
    return s_version;
}

bool& seederProcess()
{
    static bool s_seeder = false;
    return s_seeder;
}

constexpr int kSeedWaitMaxAttempts = 30;
constexpr int kSeedWaitDelayMs = 500;

nlohmann::json loadRunningConfigRoot()
{
    runningConfigVersionCache() = 0;

    if (!bootstrapDatabase())
        return readStartupFile();

    if (auto latest = latestRunningConfig())
    {
        runningConfigVersionCache() = latest->first;
        return std::move(latest->second);
    }

    if (!seederProcess())
    {
        for (int attempt = 1; attempt <= kSeedWaitMaxAttempts; ++attempt)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(kSeedWaitDelayMs));

            if (auto latest = latestRunningConfig())
            {
                runningConfigVersionCache() = latest->first;
                std::cerr << "config: running_config appeared after " << attempt * kSeedWaitDelayMs
                          << "ms (version=" << latest->first << ")" << std::endl;
                return std::move(latest->second);
            }
        }
        std::cerr << "config: running_config still empty after " << kSeedWaitMaxAttempts * kSeedWaitDelayMs
                  << "ms — falling back to startup-config (version 0, degraded)" << std::endl;
    }

    return readStartupFile();
}

nlohmann::json& runningConfigCache()
{
    static nlohmann::json s_root = nlohmann::json::object();
    return s_root;
}

bool& runningConfigLoaded()
{
    static bool s_loaded = false;
    return s_loaded;
}

const nlohmann::json& cachedRunningConfig()
{
    if (!runningConfigLoaded())
    {
        runningConfigCache() = loadRunningConfigRoot();
        runningConfigLoaded() = true;
    }
    return runningConfigCache();
}

}

const nlohmann::json& Config::scopeConfig(const std::string& scopeName)
{
    static const nlohmann::json kEmpty = nlohmann::json::object();

    const nlohmann::json& root = cachedRunningConfig();
    auto it = root.find(scopeName);
    return (it != root.end() && it->is_object()) ? *it : kEmpty;
}

const nlohmann::json& Config::section(const std::string& scopeName, const std::string& domain)
{
    static const nlohmann::json kEmpty = nlohmann::json::object();

    const nlohmann::json& scope = scopeConfig(scopeName);
    auto it = scope.find(domain);
    return (it != scope.end() && it->is_object()) ? *it : kEmpty;
}

nlohmann::json Config::runningConfigRoot()
{
    return cachedRunningConfig();
}

bool Config::preflight()
{
    seederProcess() = true;

    if (!bootstrapDatabase())
    {
        std::cerr << "preflight: database unavailable" << std::endl;
        return false;
    }

    if (!pz::db::Database::instance().ensureSchema())
    {
        std::cerr << "preflight: ensureSchema failed" << std::endl;
        return false;
    }

    return seedStore();
}

bool Config::seedStore()
{
    if (!bootstrapDatabase())
    {
        std::cerr << "seedStore: database unavailable" << std::endl;
        return false;
    }

    const nlohmann::json startup = readStartupFile();
    if (startup.empty())
    {
        std::cerr << "seedStore: startup-config empty/unreadable: " << startupConfigPath() << std::endl;
        return false;
    }

    auto& dbi = pz::db::Database::instance();

    const std::string persist = redactSecretsForPersist(startup).dump();

    if (!dbi.exec("INSERT INTO startup_config (oid, config_json) VALUES (1, $1::jsonb) "
                  "ON CONFLICT (oid) DO UPDATE SET config_json = EXCLUDED.config_json, "
                  "updated_at = now()",
                  {persist}))
    {
        std::cerr << "seedStore: startup_config upsert failed" << std::endl;
    }

    if (!dbi.exec("INSERT INTO running_config (version, config_json) "
                  "SELECT 1, $1::jsonb WHERE NOT EXISTS (SELECT 1 FROM running_config)",
                  {persist}))
    {
        std::cerr << "seedStore: running_config v1 seed failed" << std::endl;
        return false;
    }

    // Back-fill daemon sections that the running config has never heard of.
    //
    // The seed above only fires on an empty table, which is right: the running config is the
    // operator's, and re-seeding it would throw their work away on every start. But it means an
    // appliance that has been running since before a daemon existed has no section for it — and a
    // daemon reading a section that is not there gets nothing but the merged `global` block. When
    // that daemon is part of the bootstrap convergence set, a config gap becomes a fleet that never
    // starts.
    //
    // So: add the missing top-level sections from startup-config, and touch nothing else. Never an
    // update of an existing key — an operator who changed a value meant it, and a "helpful" merge
    // that reverted it on restart would be indistinguishable from the setting not working. Adding
    // an absent section cannot revert anything, because there was nothing there to revert.
    //
    // Applied in place, without a version bump: the daemons that already converged on this version
    // are unaffected (their sections are untouched), and the new daemon reads it fresh at its own
    // startup. A bump would restart the fleet to deliver defaults nobody else is waiting for.
    {
        const nlohmann::json activeRoot = loadRunningConfigRoot();
        const nlohmann::json startupRoot = redactSecretsForPersist(startup);

        nlohmann::json additions = nlohmann::json::object();
        if (activeRoot.is_object() && startupRoot.is_object())
        {
            for (auto it = startupRoot.begin(); it != startupRoot.end(); ++it)
            {
                // "//"-prefixed keys are the template's comments; they are stripped on deploy and
                // have no business being reintroduced here.
                if (it.key().rfind("//", 0) == 0)
                    continue;

                if (!activeRoot.contains(it.key()))
                {
                    additions[it.key()] = it.value();
                    continue;
                }

                // The scope is there; a domain inside it may not be. Added one at a time, so an
                // operator's edits to the domains that DO exist are untouched — the whole point of
                // the back-fill is that it can only ever add.
                const nlohmann::json& activeScope = activeRoot[it.key()];
                if (!activeScope.is_object() || !it.value().is_object())
                    continue;

                nlohmann::json missing = nlohmann::json::object();
                for (auto d = it.value().begin(); d != it.value().end(); ++d)
                {
                    if (d.key().rfind("//", 0) == 0)
                        continue;
                    if (!activeScope.contains(d.key()))
                        missing[d.key()] = d.value();
                }
                if (!missing.empty())
                    additions[it.key()] = std::move(missing);
            }
        }

        if (!additions.empty())
        {
            std::string names;
            for (auto it = additions.begin(); it != additions.end(); ++it)
            {
                if (!names.empty())
                    names += ", ";
                names += it.key();
            }

            // Deep by one level. A bare `config_json || $1` at the top level would replace a
            // whole scope OBJECT with the handful of domains being added, taking every domain the
            // operator has edited with it. So the added scopes are rebuilt first — each as
            // (what is stored) || (what is being added) — and only those keys are concatenated
            // in. Scopes not named in $1 are never touched.
            if (dbi.exec("UPDATE running_config SET config_json = config_json || COALESCE(("
                         "  SELECT jsonb_object_agg(a.k, COALESCE(config_json -> a.k, '{}'::jsonb) || a.v) "
                         "  FROM jsonb_each($1::jsonb) AS a(k, v)), '{}'::jsonb) "
                         "WHERE state = 'active'",
                         {additions.dump()}))
            {
                std::cerr << "seedStore: back-filled running_config sections: " << names << std::endl;
            }
            else
            {
                std::cerr << "seedStore: running_config back-fill failed for: " << names << std::endl;
            }
        }
    }

    {
        const std::string salt = pz::util::generateSalt();
        const std::string hash = salt.empty() ? std::string() : pz::util::hashPassword(kDefaultAdminPassword, salt);
        if (hash.empty())
        {
            // Seeding an account nobody can log into is worse than seeding none: the daemon
            // would look healthy while the only local credential is unusable.
            std::cerr << "seedStore: default admin credential could not be hashed — not seeded" << std::endl;
        }
        else if (!dbi.exec("INSERT INTO local_users (username, password_hash, salt, must_change) "
                           "VALUES ($1, $2, $3, true) ON CONFLICT (username) DO NOTHING",
                           {kDefaultAdminUser, hash, salt}))
        {
            std::cerr << "seedStore: local_users default seed failed" << std::endl;
        }
    }

    return true;
}

bool Config::commitConfig(const nlohmann::json& fullRoot)
{
    if (!fullRoot.is_object())
    {
        std::cerr << "commitConfig: root is not an object" << std::endl;
        return false;
    }

    if (!bootstrapDatabase())
    {
        std::cerr << "commitConfig: database unavailable" << std::endl;
        return false;
    }

    auto& db = pz::db::Database::instance();

    if (!db.exec("BEGIN"))
    {
        std::cerr << "commitConfig: BEGIN failed" << std::endl;
        return false;
    }

    const bool ok = db.exec("UPDATE running_config SET state = 'superseded' WHERE state = 'active'") &&
                    db.exec("INSERT INTO running_config (version, config_json, state) "
                            "VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM running_config), "
                            "$1::jsonb, 'active')",
                            {redactSecretsForPersist(fullRoot).dump()});

    if (!ok || !db.exec("COMMIT"))
    {
        db.exec("ROLLBACK");
        std::cerr << "commitConfig: transaction failed, rolled back" << std::endl;
        return false;
    }

    invalidateConfigCache();
    return true;
}

void Config::invalidateConfigCache()
{
    runningConfigLoaded() = false;
}

std::uint64_t Config::runningConfigVersion()
{
    cachedRunningConfig();
    return runningConfigVersionCache();
}

}

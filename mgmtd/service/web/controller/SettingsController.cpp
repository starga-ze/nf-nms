#include "service/web/controller/SettingsController.h"

#include "service/MgmtdServiceManager.h"

#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"

#include "config/ApiRefs.h"
#include "config/Config.h"
#include "db/Database.h"
#include "http/HttpMessage.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <sys/stat.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// The daemon sections a commit may address, and the ones GET /api/settings projects for the
// editors. "pretzel-ai" is in the list without being an IPC daemon: it is a separate service
// reached over gRPC, but its deployment is operator-declared configuration and belongs in the same
// versioned document as everything else. What differs is delivery — engined's ConfigApply broadcast
// cannot reach it, so the new section is pushed to the service over the gRPC edge instead.
constexpr const char* kSettingsDaemons[] = {
    "engined", "authd", "probed", "collectord", "topologyd", "pretzel-ai",
};

constexpr const char* kHiddenDomains[] = {
    "bootstrap",
    "auth",
};

// ── Commit schema ────────────────────────────────────────────────────────────
// The commit endpoint is generic — any domain of a known daemon passes through — but the
// domains the UI publishes carry a declared schema, validated here so a malformed entry never
// reaches the running_config. One schema per (daemon, domain, key); everything else is opaque.
//
// Every configuration object is identified by exactly one field, `oid`: a UUID string issued at
// creation and immutable for the object's lifetime. Cross-references (site, auth_profile,
// object) carry the referent's oid.

// engined.site.ngfw_devices / sase_devices — Devices (www/js/config.js). The array is the type,
// so there is no device_type field. Both kinds need an oid and an access target:
//   ngfw: { oid, name, description?, site?, target, fingerprint? }   fingerprint from the API Key test
//   sase: { oid, name, description?, site?, target, health:{url,body}? }   api-key lives in the DB, not here
bool validDevice(const json& d)
{
    if (!d.is_object())
        return false;
    return !d.value("oid", std::string()).empty() && !d.value("target", std::string()).empty();
}

// engined.site.sites — Sites, one per customer (www/js/sites.js).
//   { oid, name, description? }
bool validSite(const json& s)
{
    if (!s.is_object())
        return false;
    return !s.value("oid", std::string()).empty() && !s.value("name", std::string()).empty();
}

// collectord.api.api_credentials — API Keys (www/js/api-keys.js). Bound to a device because a PAN-OS key is
// issued by one box and worthless on another. The password and the issued key are NOT here:
// running_config is append-versioned and shown verbatim in the review diff, so a secret written
// there would be permanent and visible. They stay in the operator's browser until the encrypted
// credential store exists, and a commit carrying one is refused below.
//   { oid, name, device, endpoint, username? }
bool validApiKey(const json& k)
{
    if (!k.is_object())
        return false;
    if (k.value("oid", std::string()).empty() || k.value("name", std::string()).empty() ||
        k.value("device", std::string()).empty())
        return false;

    // The endpoint is operator-entered and interpreted per device type — an NGFW device path
    // ("/api/…") or a SASE auth host+path ("auth.…/oauth2/access_token"). Both shapes (and empty) are
    // accepted here; the frontend validates the shape per type and collectord parses it.

    for (const auto* secret : {"password", "secret", "api_key", "key"})
    {
        if (k.contains(secret))
            return false;
    }
    return true;
}

// collectord.api.endpoints — API Endpoints (www/js/endpoints.js). Device-independent on purpose: the
// definition is reusable, and a test names an API Key, which carries the device it was issued by.
// The release sits inside the path (/restapi/v10.2/…) and pretzel does not rewrite it.
//
// Path AND parameters together: an endpoint is a complete, callable request, which is why this
// page can test one on its own. Two firewalls needing different arguments (vsys1 vs vsys2) are
// two endpoints rather than one endpoint parameterised at every use — that keeps a connector a
// pure schedule, and makes a PAN-OS upgrade a matter of publishing the new release's path as a
// second endpoint and re-pointing the collections that moved.
//   { oid, name, description?, path, api_type?, params?: [{name, value}] }
bool validApiEndpoint(const json& e)
{
    if (!e.is_object())
        return false;
    if (e.value("oid", std::string()).empty() || e.value("name", std::string()).empty())
        return false;

    const std::string path = e.value("path", std::string());
    if (path.empty() || path.front() != '/')
        return false;

    // name/value lists — query parameters and (SASE) request headers share the shape.
    auto validPairs = [&e](const char* key) {
        if (!e.contains(key))
            return true;
        if (!e[key].is_array())
            return false;
        for (const auto& p : e[key])
        {
            if (!p.is_object() || p.value("name", std::string()).empty())
                return false;
        }
        return true;
    };

    if (!validPairs("params"))
        return false;

    // The device type an endpoint was written for. Everything below it is disjoint: an NGFW endpoint
    // is a path on the operator's own firewall, a SASE endpoint is an absolute URL on a Palo Alto
    // cloud product. Absent means ngfw — every endpoint written before SASE support was one.
    const std::string deviceType = e.value("device_type", std::string("ngfw"));
    if (deviceType != "ngfw" && deviceType != "sase")
        return false;

    // `subtype` is the one sub-choice under the device type — the PAN-OS API for ngfw, the cloud
    // product for sase. It replaced the old api_type/product pair; both are still accepted so an
    // endpoint committed before the merge stays valid.
    const std::string subtype = e.value(
        "subtype", deviceType == "sase" ? e.value("product", std::string("ztna"))
                                        : e.value("api_type", std::string()));

    if (deviceType == "sase")
    {
        // Only ZTNA is served today. The other products are refused rather than accepted-and-ignored
        // so a commit cannot leave an endpoint that looks configured and never collects.
        if (subtype != "ztna")
            return false;

        // The host belongs to the endpoint, not the device: a SASE "device" is a tenant (the tsg_id
        // the token is scoped to), and one tenant is read through several product hosts.
        const std::string host = e.value("host", std::string());
        if (host.empty() || host.find('/') != std::string::npos)
            return false;

        if (!validPairs("headers"))
            return false;

        // The bearer token is minted per call and must never be configuration.
        for (const auto& h : e.value("headers", json::array()))
        {
            std::string name = h.value("name", std::string());
            std::transform(name.begin(), name.end(), name.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (name == "authorization")
                return false;
        }
        return true;
    }

    if (!subtype.empty() && subtype != "xml" && subtype != "rest")
        return false;
    return true;
}

// collectord.api.connectors — API Connectors (www/js/api-connectors.js).
//   { oid, name, description?, object, auth_profile,
//     items: [{ endpoint, poll_interval_sec, enabled }] }
//
// The collection policy for one inventory object: which credential to use against it, and which
// endpoints to poll how often. One connector per object, so a device's whole schedule is in one
// place. `object`, `auth_profile` and each item's `endpoint` are oid references; the targets are
// checked in validateApiReferences, which can see the other arrays.
bool validApiConnector(const json& c)
{
    if (!c.is_object())
        return false;

    if (c.value("oid", std::string()).empty() || c.value("object", std::string()).empty() ||
        c.value("auth_profile", std::string()).empty())
        return false;

    // Rejected explicitly rather than ignored: before connectors became schedules they carried a
    // single endpoint and its parameters inline, and silently accepting that shape would leave a
    // connector that collects nothing while looking configured.
    if (c.contains("endpoint") || c.contains("params") || c.contains("poll_interval_sec"))
        return false;

    if (!c.contains("items"))
        return false;

    if (!c["items"].is_array())
        return false;

    for (const auto& item : c["items"])
    {
        if (!item.is_object())
            return false;

        if (item.value("endpoint", std::string()).empty())
            return false;

        if (item.contains("poll_interval_sec"))
        {
            if (!item["poll_interval_sec"].is_number_integer() ||
                item["poll_interval_sec"].get<std::int64_t>() < 1)
                return false;
        }

        if (item.contains("enabled") && !item["enabled"].is_boolean())
            return false;
    }

    return true;
}

// Referential integrity across the three api arrays.
//
// A commit usually carries only one of them — the endpoints page publishes just `endpoints` —
// so the rule runs against the EFFECTIVE post-commit view: what is already stored, overlaid
// with what is arriving. That catches both directions at once: deleting an endpoint a stored
// connector still points at, and adding a connector that points at nothing.
//
// The rule itself is pz::config::checkApiReferences, which takes the assembled section and
// nothing else; only the assembling belongs here.
bool validateApiReferences(const json& values, std::string& error)
{
    json effective = pz::config::Config::serviceSection("collectord", "api");
    if (!effective.is_object())
        effective = json::object();

    for (auto it = values.begin(); it != values.end(); ++it)
        effective[it.key()] = it.value();

    return pz::config::checkApiReferences(effective, error);
}

// pretzel-ai.route — the deployment matrix (www/js/ai-assistant.js).
//   { llm: gateway|direct, guardrail: gateway|airs|none, require_guardrail?: bool }
//
// Two independent axes. Five of the six combinations are deployments somebody runs; the sixth is
// refused here for the same reason pretzel-ai refuses it at startup — inspection cannot be
// delegated to a gateway that is not on the path, and an appliance that accepted it would serve
// turns nobody checks. Checked against the EFFECTIVE post-commit view (stored, overlaid with what
// is arriving), because an editor may publish one axis without the other.
bool validateAiRoute(const json& values, std::string& error)
{
    json effective = pz::config::Config::serviceSection("pretzel-ai", "route");
    if (!effective.is_object())
        effective = json::object();
    for (auto it = values.begin(); it != values.end(); ++it)
        effective[it.key()] = it.value();

    const std::string llm = effective.value("llm", std::string("gateway"));
    const std::string guardrail = effective.value("guardrail", std::string("gateway"));

    if (llm != "gateway" && llm != "direct")
    {
        error = "route.llm must be 'gateway' or 'direct'";
        return false;
    }
    if (guardrail != "gateway" && guardrail != "airs" && guardrail != "none")
    {
        error = "route.guardrail must be 'gateway', 'airs' or 'none'";
        return false;
    }
    if (effective.contains("require_guardrail") && !effective["require_guardrail"].is_boolean())
    {
        error = "route.require_guardrail must be true or false";
        return false;
    }
    if (guardrail == "gateway" && llm == "direct")
    {
        error = "route.guardrail 'gateway' needs route.llm 'gateway' — there is no gateway on this "
                "path to defer to";
        return false;
    }
    return true;
}

// No key, token or password may be committed. running_config is append-versioned, rendered verbatim
// in the review diff and written out by Save-to-file, so a secret written here would be permanent
// and readable by every reviewer. The AI gateway's own subscription key is held sealed in
// ai_gateway_credential_state instead; these domains carry only the declaration around it.
bool rejectSecrets(const json& values, const char* domain, std::string& error)
{
    for (const auto* secret : {"api_key", "key", "token", "password", "secret"})
    {
        if (!values.contains(secret))
            continue;
        error = std::string(domain) + "." + secret + " is a credential and cannot be committed to "
                "the running configuration";
        return false;
    }
    return true;
}

// pretzel-ai.gateway — where the completions leg points, and how a turn is shaped. The model
// catalog is deliberately NOT here: which models exist is a fact about the gateway account, read
// back over ListModels, not a declaration that could be rolled back like a policy.
bool validateAiGateway(const json& values, std::string& error)
{
    if (!rejectSecrets(values, "gateway", error))
        return false;

    if (values.contains("port"))
    {
        const auto& p = values["port"];
        if (!p.is_number_integer() || p.get<std::int64_t>() < 1 || p.get<std::int64_t>() > 65535)
        {
            error = "gateway.port must be 1-65535";
            return false;
        }
    }
    if (values.contains("tls") && !values["tls"].is_boolean())
    {
        error = "gateway.tls must be true or false";
        return false;
    }
    if (values.contains("path"))
    {
        const std::string path = values.value("path", std::string());
        if (path.empty() || path.front() != '/')
        {
            error = "gateway.path must begin with '/'";
            return false;
        }
    }
    for (const auto* positive : {"max_tokens", "timeout_sec"})
    {
        if (!values.contains(positive))
            continue;
        const auto& v = values[positive];
        if (!v.is_number_integer() || v.get<std::int64_t>() < 1)
        {
            error = std::string("gateway.") + positive + " must be a positive integer";
            return false;
        }
    }
    return true;
}

// pretzel-ai.airs — the scan service, when this appliance owns the verdict. Either profile_name or
// profile_id identifies the security profile; the scan API takes one of them, and which one is the
// operator's to choose, so neither is required here on its own.
bool validateAiAirs(const json& values, std::string& error)
{
    if (!rejectSecrets(values, "airs", error))
        return false;

    if (values.contains("fail_open") && !values["fail_open"].is_boolean())
    {
        error = "airs.fail_open must be true or false";
        return false;
    }
    if (values.contains("timeout_sec"))
    {
        const auto& v = values["timeout_sec"];
        if (!v.is_number_integer() || v.get<std::int64_t>() < 1)
        {
            error = "airs.timeout_sec must be a positive integer";
            return false;
        }
    }
    return true;
}

// pretzel-ai.providers — the direct leg's endpoints, one per provider slug (the part of a model id
// before the slash). A list rather than an object keyed by slug: a commit merges values into the
// stored document, and a merged object can only ever gain keys — removing a provider would be
// unexpressible. An array is replaced wholesale, which is what an editable list needs.
//   { list: [{ id, url }] }
bool validateAiProviders(const json& values, std::string& error)
{
    if (!rejectSecrets(values, "providers", error))
        return false;
    if (!values.contains("list"))
        return true;
    if (!values["list"].is_array())
    {
        error = "providers.list must be an array";
        return false;
    }

    std::size_t idx = 0;
    for (const auto& p : values["list"])
    {
        const std::string at = "providers.list[" + std::to_string(idx++) + "]";
        if (!p.is_object())
        {
            error = at + " is not an object";
            return false;
        }
        if (p.value("id", std::string()).empty())
        {
            error = at + " has no provider id";
            return false;
        }
        const std::string url = p.value("url", std::string());
        if (url.rfind("http://", 0) != 0 && url.rfind("https://", 0) != 0)
        {
            error = at + " (\"" + p.value("id", std::string()) + "\") needs an http(s) url";
            return false;
        }
        std::string secretError;
        if (!rejectSecrets(p, at.c_str(), secretError))
        {
            error = secretError;
            return false;
        }
    }
    return true;
}

// Shape only: every entry in every array this domain owns is well-formed on its own. Deliberately
// says nothing about references — those cannot be judged one change at a time, see below.
bool validateCommitShape(const std::string& daemon, const std::string& domain, const json& values,
                         std::string& error)
{
    auto validateArray = [&](const char* key, bool (*validEntry)(const json&))
    {
        if (!values.contains(key))
            return true;
        if (!values[key].is_array())
        {
            error = std::string(key) + " must be an array";
            return false;
        }
        std::size_t idx = 0;
        for (const auto& entry : values[key])
        {
            if (!validEntry(entry))
            {
                const std::string name = entry.is_object() ? entry.value("name", std::string()) : std::string();
                error = "invalid " + std::string(key) + " entry #" + std::to_string(idx) +
                        (name.empty() ? "" : " (\"" + name + "\")");
                return false;
            }
            ++idx;
        }
        return true;
    };

    if (daemon == "engined" && domain == "site")
        return validateArray("sites", validSite) && validateArray("ngfw_devices", validDevice) &&
               validateArray("sase_devices", validDevice);

    if (daemon == "collectord" && domain == "api")
        return validateArray("api_credentials", validApiKey) && validateArray("endpoints", validApiEndpoint) &&
               validateArray("connectors", validApiConnector);

    if (daemon == "pretzel-ai")
    {
        if (domain == "route")
            return validateAiRoute(values, error);
        if (domain == "gateway")
            return validateAiGateway(values, error);
        if (domain == "airs")
            return validateAiAirs(values, error);
        if (domain == "providers")
            return validateAiProviders(values, error);
    }

    return true;
}

// Referential integrity, run once per (daemon, domain) over the MERGED values of every change in
// the batch that targets it — never per change. The three API editors each publish their own slice
// of collectord.api (endpoints.js sends `endpoints`, api-connectors.js sends `connectors`,
// api-keys.js sends `api_credentials`), so one operator action routinely arrives as several sibling
// entries. Checking a connector entry against the stored config alone would reject the commonest
// edit there is — add an endpoint and attach it — because the endpoint it points at is sitting in
// the sibling entry, not yet in the database.
bool validateCommitRefs(const std::string& daemon, const std::string& domain, const json& values,
                        std::string& error)
{
    if (daemon == "collectord" && domain == "api")
        return validateApiReferences(values, error);

    return true;
}

}

void SettingsController::get(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)sm;
    (void)req;
    json daemons = json::object();

    for (const auto* name : kSettingsDaemons)
    {
        const auto& root = pz::config::Config::daemonConfig(name);
        const auto& allService = root.value("service", json::object());

        json service = json::object();
        for (const auto& [domain, values] : allService.items())
        {
            const bool hidden = std::any_of(std::begin(kHiddenDomains), std::end(kHiddenDomains),
                                            [&](const char* d) { return domain == d; });
            if (hidden)
                continue;

            json v = values;
            if (domain == "http" && v.is_object())
                v.erase("admin");

            service[domain] = std::move(v);
        }

        daemons[name] = std::move(service);
    }

    json body;
    body["daemons"] = std::move(daemons);

    // Version of the active running-config these values came from. The browser stamps its staged
    // edits with it: if the version later goes backwards, those drafts belong to a configuration
    // lineage that no longer exists (a reset or a rollback) and must not be published.
    body["version"] = 0;
    try
    {
        const auto rows = pz::db::Database::instance().queryRows(
            "SELECT version FROM running_config WHERE state = 'active' ORDER BY version DESC LIMIT 1");
        if (!rows.empty() && !rows.front().empty())
            body["version"] = std::stoll(rows.front()[0]);
    }
    catch (const std::exception&)
    {
    }

    fill(resp, 200, body.dump());
}

// The whole active running-config, verbatim, as stored. /api/settings is a per-daemon,
// hidden-domain-filtered projection for the editors; this is the raw document the operator sees
// behind the topbar's View button. Secrets are already stripped on the way in (Config's
// redactSecretsForPersist runs at persist time), so the stored copy is safe to return as-is.
void SettingsController::runningConfig(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)sm;
    (void)req;

    json body;
    try
    {
        auto& db = pz::db::Database::instance();
        const auto rows = db.queryRows("SELECT version, committed_at, config_json FROM running_config "
                                       "WHERE state = 'active' ORDER BY version DESC LIMIT 1");
        if (rows.empty() || rows.front().size() < 3)
            return fill(resp, 404, R"({"error":"no active running-config"})");

        const auto& row = rows.front();
        auto parsed = json::parse(row[2], nullptr, false);
        if (parsed.is_discarded())
            return fill(resp, 500, R"({"error":"stored running-config is not valid JSON"})");

        body["version"] = row[0];
        body["committed_at"] = row[1];
        body["config"] = std::move(parsed);
    }
    catch (const std::exception& e)
    {
        LOG_WARN("running-config query failed: {}", e.what());
        return fill(resp, 500, R"({"error":"query failed"})");
    }

    fill(resp, 200, body.dump());
}

void SettingsController::commit(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    auto badRequest = [&](const char* error) { fill(resp, 400, json{{"error", error}}.dump()); };

    json input;
    try
    {
        input = json::parse(req.body);
    }
    catch (const std::exception&)
    {
        return badRequest("invalid JSON body");
    }

    if (!input.contains("changes") || !input["changes"].is_array())
        return badRequest("expected {changes: [{daemon, domain, values}]}");

    const json& changes = input["changes"];

    json validChanges = json::array();
    json results = json::array();   // per-change outcome, returned to the browser and used below
    std::vector<std::size_t> resultOf;   // parallel to validChanges: where its result entry lives
    int failed = 0;

    // Record a per-change rejection: logged (so the reason survives in mgmtd.log) and returned.
    auto reject = [&](const std::string& daemon, const std::string& domain, const std::string& why) {
        LOG_WARN("settings-commit rejected (daemon={}, domain={}, reason={})", daemon, domain, why);
        results.push_back({{"daemon", daemon}, {"domain", domain}, {"ok", false}, {"error", why}});
        failed++;
    };

    for (const auto& change : changes)
    {
        if (!change.contains("daemon") || !change.contains("domain") || !change.contains("values"))
        {
            reject(change.value("daemon", ""), change.value("domain", ""), "entry is missing daemon/domain/values");
            continue;
        }

        const std::string daemon = change.value("daemon", "");
        const std::string domain = change.value("domain", "");
        const json& values = change["values"];

        if (!values.is_object())
        {
            reject(daemon, domain, "values is not an object");
            continue;
        }

        const bool knownDaemon = std::any_of(std::begin(kSettingsDaemons), std::end(kSettingsDaemons),
                                             [&](const char* d) { return daemon == d; });

        if (!knownDaemon)
        {
            reject(daemon, domain, "unknown daemon");
            continue;
        }

        std::string schemaError;
        if (!validateCommitShape(daemon, domain, values, schemaError))
        {
            reject(daemon, domain, schemaError.empty() ? "schema validation failed" : schemaError);
            continue;
        }

        results.push_back({{"daemon", daemon}, {"domain", domain}, {"ok", true}});
        resultOf.push_back(results.size() - 1);
        validChanges.push_back(change);
    }

    // Reference pass, on the merged view of each domain — see validateCommitRefs. Only worth running
    // on a batch that is otherwise sound: merging values from an entry already known to be malformed
    // would report a dangling reference the operator cannot act on.
    if (failed == 0)
    {
        std::map<std::pair<std::string, std::string>, json> mergedByDomain;
        for (const auto& c : validChanges)
        {
            json& dst = mergedByDomain[{c.value("daemon", std::string()), c.value("domain", std::string())}];
            if (!dst.is_object())
                dst = json::object();
            // Key-level replacement, matching how the values are assembled for the check itself: an
            // editor publishes a whole array under its own key and owns that key completely.
            for (const auto& [key, value] : c["values"].items())
                dst[key] = value;
        }

        for (const auto& [target, values] : mergedByDomain)
        {
            std::string refError;
            if (validateCommitRefs(target.first, target.second, values, refError))
                continue;

            if (refError.empty())
                refError = "reference check failed";

            LOG_WARN("settings-commit rejected (daemon={}, domain={}, reason={})", target.first, target.second,
                     refError);

            // It is the combination that broke the reference, not one entry in it, so every change
            // aimed at this domain is marked — the operator needs to see all the parts involved to
            // know which one to correct.
            for (std::size_t i = 0; i < validChanges.size(); ++i)
            {
                if (validChanges[i].value("daemon", std::string()) != target.first ||
                    validChanges[i].value("domain", std::string()) != target.second)
                    continue;

                results[resultOf[i]]["ok"] = false;
                results[resultOf[i]]["error"] = refError;
                failed++;
            }
        }
    }

    const int applied = static_cast<int>(validChanges.size());

    // All or nothing. A batch is one operator action spread across several editors and the parts are
    // not independent — a connector references an endpoint staged beside it. Publishing only the half
    // that validated leaves a configuration nobody asked for, and because the browser clears every
    // staged draft the moment anything is applied, the rejected half is gone with no way to retry it.
    // That is how a commit could appear to succeed and silently lose an edit.
    const bool accepted = (failed == 0 && applied > 0);

    if (failed > 0)
        LOG_WARN("settings-commit: {} change(s) rejected of {} — batch not published", failed,
                 static_cast<int>(changes.size()));

    if (accepted)
    {
        const std::string payload = validChanges.dump();
        auto msg = std::make_unique<pz::ipc::IpcMessage>();
        msg->setSrc(pz::ipc::IpcDaemon::Mgmtd);
        msg->setDst(pz::ipc::IpcDaemon::Engined);
        msg->setCmd(pz::ipc::IpcCmd::SettingsCommitRequest);
        msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
        msg->setPayload(std::vector<uint8_t>(payload.begin(), payload.end()));

        sm.txRouter().handleIpcMessage(std::move(msg));
        sm.startReload();
        LOG_INFO("SettingsCommitRequest sent to engined (changes={})", applied);
    }

    // 409, not 200: the request was understood but conflicts with the configuration it would have
    // produced. The browser reads `results` for the per-change reason either way — the code only has
    // to be un-2xx so a rejection can never be mistaken for a publish.
    const int status = accepted ? 200 : 409;

    json body;
    body["applied"] = accepted ? applied : 0;
    body["failed"] = failed;
    body["results"] = std::move(results);
    body["reloading"] = accepted;
    if (!accepted)
        body["error"] = (failed > 0) ? "no change was published — the batch is applied whole or not at all"
                                     : "nothing to commit";

    fill(resp, status, body.dump());
}

void SettingsController::reloadStatus(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)req;
    json body;

    const auto s = sm.reloadStatus();

    if (s == MgmtdServiceManager::ReloadStatus::Reloading)
        body["status"] = "reloading";
    else if (s == MgmtdServiceManager::ReloadStatus::Complete)
        body["status"] = "complete";
    else if (s == MgmtdServiceManager::ReloadStatus::Failed)
        body["status"] = "failed";
    else
        body["status"] = "idle";

    body["elapsed_ms"] = sm.reloadElapsedMs();

    fill(resp, 200, body.dump());
}

void SettingsController::commitQueue(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)req;
    fill(resp, 200, sm.commitQueueSnapshot());
}

namespace
{

// ── Saved configurations (named running-config snapshots on the appliance) ─────────────────
// Plain files under <config-dir>/saved-configs. They survive `pretzel reset` (which only drops DB
// tables) and a redeploy (which rewrites only startup-config.json), so they are the durable on-box
// backup. No secrets involved — the running-config is already redacted at persist time.

std::string savedConfigDir()
{
    const char* env = std::getenv("PRETZEL_CONFIG_DIR");
    return std::string(env && *env ? env : "/etc/pretzel") + "/saved-configs";
}

// A safe "<name>.json" path, or "" if the operator's name is unusable. Guards against path
// traversal: only [A-Za-z0-9._-], no leading dot, length-capped, no directory separators.
std::string savedConfigFile(std::string name)
{
    const std::string ext = ".json";
    if (name.size() >= ext.size() && name.compare(name.size() - ext.size(), ext.size(), ext) == 0)
        name.erase(name.size() - ext.size());   // tolerate an entered ".json"
    if (name.empty() || name.size() > 100 || name.front() == '.')
        return "";
    for (char c : name)
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' || c == '-'))
            return "";
    return savedConfigDir() + "/" + name + ext;
}

std::string activeRunningConfigJson()
{
    const auto rows = pz::db::Database::instance().queryRows(
        "SELECT config_json FROM running_config WHERE state='active' ORDER BY version DESC LIMIT 1");
    if (rows.empty() || rows.front().empty())
        return "";
    return rows.front()[0];
}

}

void SettingsController::saveConfig(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)sm;
    json input;
    try
    {
        input = json::parse(req.body);
    }
    catch (const std::exception&)
    {
        return fill(resp, 400, R"({"error":"invalid JSON body"})");
    }

    const std::string path = savedConfigFile(input.value("name", std::string()));
    if (path.empty())
        return fill(resp, 400, R"({"error":"invalid name — use letters, digits, dot, dash or underscore"})");

    // Two callers: Save persists the live running-config (no "content"); Import persists a document
    // the browser uploaded (its raw text in "content"). An uploaded document is validated as JSON so
    // a saved file is always loadable later.
    std::string cfg;
    if (input.contains("content"))
    {
        cfg = input.value("content", std::string());
        if (json::parse(cfg, nullptr, false).is_discarded())
            return fill(resp, 400, R"({"error":"uploaded content is not valid JSON"})");
    }
    else
    {
        cfg = activeRunningConfigJson();
        if (cfg.empty())
            return fill(resp, 404, R"({"error":"no active running-config to save"})");
    }

    std::error_code ec;
    std::filesystem::create_directories(savedConfigDir(), ec);

    // Write to a temp then rename so a reader never sees a half-written document.
    const std::string tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::trunc);
        if (!f)
            return fill(resp, 500, R"({"error":"could not open file for writing"})");
        f << cfg;
        if (!f)
        {
            std::filesystem::remove(tmp, ec);
            return fill(resp, 500, R"({"error":"write failed"})");
        }
    }
    std::filesystem::rename(tmp, path, ec);
    if (ec)
    {
        std::filesystem::remove(tmp, ec);
        return fill(resp, 500, R"({"error":"rename failed"})");
    }

    LOG_INFO("running-config saved to {}", path);
    fill(resp, 200, json{{"ok", true}}.dump());
}

void SettingsController::savedConfigs(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)sm;
    (void)req;

    json out = json::array();
    std::error_code ec;
    for (const auto& entry : std::filesystem::directory_iterator(savedConfigDir(), ec))
    {
        if (ec)
            break;
        const auto& p = entry.path();
        if (!entry.is_regular_file() || p.extension() != ".json")
            continue;
        struct ::stat st{};
        std::uint64_t mtime = 0, bytes = 0;
        if (::stat(p.c_str(), &st) == 0)
        {
            mtime = static_cast<std::uint64_t>(st.st_mtime);
            bytes = static_cast<std::uint64_t>(st.st_size);
        }
        out.push_back({{"name", p.stem().string()}, {"saved_at", mtime}, {"bytes", bytes}});
    }
    std::sort(out.begin(), out.end(),
              [](const json& a, const json& b) { return a.value("saved_at", 0ull) > b.value("saved_at", 0ull); });

    fill(resp, 200, out.dump());
}

// Returns the raw saved document so the browser can apply it through the same commit path Import
// uses. Selected from the list, so the name is already one of ours; still validated defensively.
void SettingsController::savedConfigContent(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)sm;

    std::string name;
    if (auto pos = req.target.find("name="); pos != std::string::npos)
    {
        name = req.target.substr(pos + 5);
        if (auto amp = name.find('&'); amp != std::string::npos)
            name.erase(amp);
    }

    const std::string path = savedConfigFile(name);
    if (path.empty())
        return fill(resp, 400, R"({"error":"invalid name"})");

    std::ifstream f(path);
    if (!f)
        return fill(resp, 404, R"({"error":"not found"})");

    std::string content((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
    fill(resp, 200, content);   // already a JSON config document
}


void SettingsController::onCommitStatus(MgmtdServiceManager& sm, const pz::ipc::IpcMessage& msg)
{
    const auto& pl = msg.getPayload();
    if (pl.empty())
    {
        // An empty payload is not an empty queue — it is a message that lost its body. Overwriting a
        // good snapshot with "[]" would tell the browser every task finished.
        LOG_WARN("empty commit-queue snapshot — keeping the last one");
        return;
    }

    sm.setCommitQueue(std::string(pl.begin(), pl.end()));
}

}

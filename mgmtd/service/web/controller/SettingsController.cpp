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
#include <iterator>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// The scopes a commit may address, and the ones GET /api/settings projects for the editors.
// `global` is deliberately absent: it is infrastructure (the IPC socket, where logs go), not
// something an operator decides, and a console that offered to edit it would be offering to break
// the fabric the console itself answers on.
//
// "pretzel-ai" is here without being on the IPC fabric at all: it is a separate service reached
// over gRPC, but its deployment is operator-declared configuration and belongs in the same
// versioned document as everything else. What differs is delivery — engined's ConfigApply
// broadcast cannot reach it, so the section is pushed over the gRPC edge instead (ApplyConfig),
// and it is therefore absent from engined's bootstrap convergence set too: the fleet does not
// wait on a peer that is not on the bus.
constexpr const char* kSettingsScopes[] = {
    pz::config::scope::kPretzel,
    pz::config::scope::kPretzelAi,
};

// Domains the settings API does not project. `bootstrap` is internal tuning that lives in compiled
// defaults rather than the document; `auth` is served by its own endpoint (SsoController), which
// knows which of its fields may be shown.
constexpr const char* kHiddenDomains[] = {
    "bootstrap",
    "auth",
};

// ── Commit schema ────────────────────────────────────────────────────────────
// The commit endpoint is generic — any domain of a known scope passes through — but the
// domains the UI publishes carry a declared schema, validated here so a malformed entry never
// reaches the running_config. One schema per (scope, domain, key); everything else is opaque.
//
// Every configuration object is identified by exactly one field, `oid`: a UUID string issued at
// creation and immutable for the object's lifetime. Cross-references (site, auth_profile,
// object) carry the referent's oid.

// pretzel.site.ngfw_devices / sase_devices — Devices (www/js/config.js). The array is the type,
// so there is no device_type field. Both kinds need an oid and an access target:
//   ngfw: { oid, name, description?, site?, target, fingerprint? }   fingerprint from the API Key test
//   sase: { oid, name, description?, site?, target, health:{url,body}? }   api-key lives in the DB, not here
bool validDevice(const json& d)
{
    if (!d.is_object())
        return false;
    return !d.value("oid", std::string()).empty() && !d.value("target", std::string()).empty();
}

// pretzel.site.sites — Sites, one per customer (www/js/sites.js).
//   { oid, name, description? }
bool validSite(const json& s)
{
    if (!s.is_object())
        return false;
    return !s.value("oid", std::string()).empty() && !s.value("name", std::string()).empty();
}

// pretzel.connector.api_credentials — API Keys (www/js/api-keys.js). Bound to a device because a PAN-OS key is
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

// pretzel.connector.endpoints — API Endpoints (www/js/endpoints.js). Device-independent on purpose: the
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

// pretzel.connector.connectors — API Connectors (www/js/api-connectors.js).
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
    json effective = pz::config::Config::section(pz::config::scope::kPretzel, "connector");
    if (!effective.is_object())
        effective = json::object();

    for (auto it = values.begin(); it != values.end(); ++it)
        effective[it.key()] = it.value();

    return pz::config::checkApiReferences(effective, error);
}

// No key, token or password may be committed. running_config is append-versioned, rendered verbatim
// in the review diff and written out by Save-to-file, so a secret written here would be permanent
// and readable by every reviewer. Each vendor's API key is held sealed in
// ai_provider_credential_state under the provider's own id instead; these domains carry only the
// declaration around it.
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

// The three vendors the assistant may be pointed at. Fixed, not an open list: each one is a
// deliberate integration — an endpoint that speaks the OpenAI chat-completions shape, a sealed key
// slot under the same id, and a console row — and a fourth id arriving in a commit would name a
// provider nothing downstream knows how to serve.
//
// Named for the VENDOR, not the model family. The key belongs to Anthropic and the endpoint answers
// for Anthropic; "claude" is what they serve, and using it here made every qualified model name say
// it twice ("claude/claude-opus-5") while naming the wrong thing.
constexpr const char* kAiProviders[] = {"openai", "google", "anthropic"};

bool knownAiProvider(const std::string& id)
{
    for (const auto* known : kAiProviders)
    {
        if (id == known)
            return true;
    }
    return false;
}

// pretzel-ai.providers — the vendors this appliance has an account with, and which of their models
// it may ask for.
//   { list: [{ id, models: [{ id, label? }] }] }
//
// An entry carries exactly what an operator chooses. It does NOT carry:
//   the endpoint  a fact about the vendor, not a setting. Compiled in on the pretzel-ai side, so
//                 an operator cannot point "openai" at something that is not OpenAI, and so a new
//                 vendor is a code change on the side that has to speak its dialect anyway.
//   the API key   sealed in ai_provider_credential_state under this same id. running_config is
//                 append-versioned and rendered verbatim in the review diff.
//   enabled       removing the entry is how a vendor is taken out of service, the same as every
//                 other list in this document. A second way to say "off" is a second state to keep
//                 in step with the first.
//
// The list may be empty and may hold one, two or three entries — a fresh appliance has none. What
// it may not do is name a vendor twice, or name one nothing downstream can serve.
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

    std::set<std::string> seen;
    std::size_t idx = 0;
    for (const auto& p : values["list"])
    {
        const std::string at = "providers.list[" + std::to_string(idx++) + "]";
        if (!p.is_object())
        {
            error = at + " is not an object";
            return false;
        }

        const std::string id = p.value("id", std::string());
        if (!knownAiProvider(id))
        {
            error = at + " has an unknown provider id '" + id + "' — one of openai, google, anthropic";
            return false;
        }
        if (!seen.insert(id).second)
        {
            error = at + " repeats provider '" + id + "'";
            return false;
        }

        if (!p.contains("models"))
            continue;

        if (!p["models"].is_array())
        {
            error = at + " (\"" + id + "\") models must be an array";
            return false;
        }

        std::set<std::string> models;
        std::size_t midx = 0;
        for (const auto& m : p["models"])
        {
            const std::string mat = at + ".models[" + std::to_string(midx++) + "]";
            if (!m.is_object() || m.value("id", std::string()).empty())
            {
                error = mat + " has no model id";
                return false;
            }
            const std::string mid = m.value("id", std::string());
            // The vendor is the entry this sits under. A qualified name here would go out to the
            // vendor with the prefix still on it, and refusing it is how that stays visible —
            // stripping it would hide that the two halves disagreed about who serves the model.
            if (mid.find('/') != std::string::npos)
            {
                error = mat + " (\"" + mid + "\") must be the bare model name — the provider is "
                        "the entry it sits under";
                return false;
            }
            if (!models.insert(mid).second)
            {
                error = mat + " repeats model '" + mid + "'";
                return false;
            }
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

// pretzel-ai.guardrail — one entry per engine pretzel-ai runs, and how its turns are inspected.
//   { list: [{ service, guardrail, checkpoints{...}, airs{...}, gateway{...}, shape{...} }] }
//
// Two engines, each configurable once. Chat calls a model and returns; Agent loops through tool
// calls. They are separate entries because the question "what should be inspected here" has
// different answers — Agent has two checkpoints Chat does not.
//
// No api_key anywhere in here: both subscriptions are sealed in ai_guardrail_credential_state and
// a commit carrying one is refused by rejectSecrets, same as a vendor's.
//
// No endpoint either, and that is not an omission the operator can correct: each is a fact about
// the service being called, compiled into pretzel-ai, which has to speak its dialect anyway.
constexpr const char* kAiServices[] = {"chat", "agent"};
constexpr const char* kGuardrailKinds[] = {"none", "api_application", "ai_gateway"};

bool inList(const std::string& v, const char* const* list, std::size_t n)
{
    for (std::size_t i = 0; i < n; ++i)
        if (v == list[i])
            return true;
    return false;
}

bool validateServiceEntry(const json& e, const std::string& at, std::string& error)
{
    if (!e.is_object())
    {
        error = at + " must be an object";
        return false;
    }
    if (!rejectSecrets(e, at.c_str(), error))
        return false;

    const std::string service = e.value("service", std::string());
    if (!inList(service, kAiServices, std::size(kAiServices)))
    {
        error = at + ".service must be one of chat, agent — got '" + service + "'";
        return false;
    }

    // The one field with a fixed vocabulary that decides whether anything inspects at all. Checked
    // here because a typo that fell through would reach pretzel-ai as an unbuildable configuration
    // and refuse the whole push — which reports as "the assistant stopped working" rather than as
    // "guardrail is misspelt".
    const std::string guardrail = e.value("guardrail", std::string());
    if (!inList(guardrail, kGuardrailKinds, std::size(kGuardrailKinds)))
    {
        error = at + ".guardrail must be one of none, api_application, ai_gateway — got '"
              + guardrail + "'";
        return false;
    }

    if (const auto cp = e.find("checkpoints"); cp != e.end())
    {
        if (!cp->is_object())
        {
            error = at + ".checkpoints must be an object";
            return false;
        }
        for (const auto* f : {"prompt", "response", "tool_call", "tool_result"})
        {
            if (const auto it = cp->find(f); it != cp->end() && !it->is_boolean())
            {
                error = at + ".checkpoints." + f + " must be a boolean";
                return false;
            }
        }
    }

    // The two blocks carry only what their guardrail needs. Neither is required — an entry that
    // has not been given a profile yet is a configuration in progress, and refusing to store it
    // would mean an operator cannot save half the form.
    for (const auto& [key, secretName] : {std::pair{"airs", "airs"}, std::pair{"gateway", "gateway"}})
    {
        const auto blk = e.find(key);
        if (blk == e.end())
            continue;
        if (!blk->is_object())
        {
            error = at + "." + key + " must be an object";
            return false;
        }
        std::string secretError;
        if (!rejectSecrets(*blk, (at + "." + secretName).c_str(), secretError))
        {
            error = secretError;
            return false;
        }
        if (const auto t = blk->find("timeout_sec");
            t != blk->end() && (!t->is_number() || t->get<double>() <= 0))
        {
            error = at + "." + key + ".timeout_sec must be a positive number";
            return false;
        }
    }

    if (const auto sh = e.find("shape"); sh != e.end())
    {
        if (!sh->is_object())
        {
            error = at + ".shape must be an object";
            return false;
        }
        if (const auto sp = sh->find("system_prompt"); sp != sh->end() && !sp->is_string())
        {
            error = at + ".shape.system_prompt must be a string";
            return false;
        }
        // Nothing is checked beyond the type. What a reasonable token cap is depends on the model,
        // and an appliance that refused 200000 because it looked large would be wrong the week a
        // model shipped with a larger window.
        if (const auto mt = sh->find("max_tokens");
            mt != sh->end() && (!mt->is_number() || mt->get<double>() < 0))
        {
            error = at + ".shape.max_tokens must be a non-negative number";
            return false;
        }
    }

    return true;
}

bool validateAiServices(const json& values, std::string& error)
{
    if (!rejectSecrets(values, "guardrail", error))
        return false;
    if (!values.contains("list"))
        return true;
    if (!values["list"].is_array())
    {
        error = "guardrail.list must be an array";
        return false;
    }

    std::set<std::string> seen;
    std::size_t idx = 0;
    for (const auto& e : values["list"])
    {
        const std::string at = "guardrail.list[" + std::to_string(idx++) + "]";
        if (!validateServiceEntry(e, at, error))
            return false;
        // One entry per engine. A second would leave which of the two is deployed to whichever the
        // assembler happened to reach first.
        if (!seen.insert(e.value("service", std::string())).second)
        {
            error = at + " repeats service '" + e.value("service", std::string()) + "'";
            return false;
        }
    }
    return true;
}

// pretzel.user — the local accounts, declared. Passwords are NOT here.
//   { list: [{ oid, username, role, description? }] }
//
// Two roles, and the difference is account management: an admin may add, remove and set passwords
// for other accounts, and a user may not. Everything else on this appliance is open to both — the
// role says what it says and no more, which is why it is not called "viewer".
//
// At least one admin must remain, for the same reason at least one account must: an appliance whose
// accounts nobody can manage is one that cannot be recovered from the console.
//
// Same split as connector.api_credentials: this document says which accounts exist, and
// local_users holds what proves one. A commit carrying a password is refused by rejectSecrets
// below, which is what keeps a hash out of a document that is append-versioned, rendered verbatim
// in the review diff and written out by Save-to-file.
//
// The username is the login handle and has to be unique. It is also immutable once published —
// enforced in the console rather than here, because this endpoint sees one commit and not the
// history that would make a rename visible.
bool validUserEntry(const json& u, const std::string& at, std::string& error)
{
    if (!u.is_object())
    {
        error = at + " must be an object";
        return false;
    }
    if (!rejectSecrets(u, at.c_str(), error))
        return false;
    if (u.value("oid", std::string()).empty())
    {
        error = at + " has no oid";
        return false;
    }

    const std::string role = u.value("role", std::string());
    if (role != "admin" && role != "user")
    {
        error = at + ".role must be admin or user — got '" + role + "'";
        return false;
    }

    const std::string name = u.value("username", std::string());
    if (name.empty())
    {
        error = at + " has no username";
        return false;
    }
    // What a login form and a database key can both carry without surprises. Refused rather than
    // trimmed: an account whose name is not what the operator typed is one they cannot sign in as.
    if (name.size() > 64)
    {
        error = at + ".username is longer than 64 characters";
        return false;
    }
    for (const unsigned char c : name)
    {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                     || c == '.' || c == '-' || c == '_';
        if (!ok)
        {
            error = at + ".username may use letters, digits, dot, dash and underscore only";
            return false;
        }
    }
    return true;
}

bool validateUsers(const json& values, std::string& error)
{
    if (!rejectSecrets(values, "user", error))
        return false;
    if (!values.contains("list"))
        return true;
    if (!values["list"].is_array())
    {
        error = "user.list must be an array";
        return false;
    }
    if (values["list"].empty())
    {
        // The appliance would have no way in. Refused at the commit rather than left to the
        // console's disabled button: the button is a courtesy and this is the rule.
        error = "at least one local account must remain — the appliance would have no way in";
        return false;
    }

    const bool anyAdmin = std::any_of(values["list"].begin(), values["list"].end(),
                                      [](const json& u)
                                      {
                                          return u.is_object()
                                              && u.value("role", std::string()) == "admin";
                                      });
    if (!anyAdmin)
    {
        error = "at least one account must be an admin — nobody could manage accounts otherwise";
        return false;
    }

    std::set<std::string> names, oids;
    std::size_t idx = 0;
    for (const auto& u : values["list"])
    {
        const std::string at = "user.list[" + std::to_string(idx++) + "]";
        if (!validUserEntry(u, at, error))
            return false;
        if (!oids.insert(u.value("oid", std::string())).second)
        {
            error = at + " repeats an oid";
            return false;
        }
        // Case-insensitively: two accounts an operator cannot tell apart are two accounts one of
        // them will sign in to by mistake.
        std::string lower = u.value("username", std::string());
        for (auto& c : lower)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (!names.insert(lower).second)
        {
            error = at + " repeats the username '" + u.value("username", std::string()) + "'";
            return false;
        }
    }
    return true;
}

// Shape only: every entry in every array this domain owns is well-formed on its own. Deliberately
// says nothing about references — those cannot be judged one change at a time, see below.
bool validateCommitShape(const std::string& scopeName, const std::string& domain, const json& values,
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

    if (scopeName == pz::config::scope::kPretzel && domain == "site")
        return validateArray("sites", validSite) && validateArray("ngfw_devices", validDevice) &&
               validateArray("sase_devices", validDevice);

    if (scopeName == pz::config::scope::kPretzel && domain == "connector")
        return validateArray("api_credentials", validApiKey) && validateArray("endpoints", validApiEndpoint) &&
               validateArray("connectors", validApiConnector);

    if (scopeName == pz::config::scope::kPretzelAi && domain == "providers")
        return validateAiProviders(values, error);

    if (scopeName == pz::config::scope::kPretzelAi && domain == "guardrail")
        return validateAiServices(values, error);

    if (scopeName == pz::config::scope::kPretzel && domain == "user")
        return validateUsers(values, error);

    return true;
}

// Referential integrity, run once per (scope, domain) over the MERGED values of every change in
// the batch that targets it — never per change. The three API editors each publish their own slice
// of pretzel.connector (endpoints.js sends `endpoints`, api-connectors.js sends `connectors`,
// api-keys.js sends `api_credentials`), so one operator action routinely arrives as several sibling
// entries. Checking a connector entry against the stored config alone would reject the commonest
// edit there is — add an endpoint and attach it — because the endpoint it points at is sitting in
// the sibling entry, not yet in the database.
bool validateCommitRefs(const std::string& scopeName, const std::string& domain, const json& values,
                        std::string& error)
{
    if (scopeName == pz::config::scope::kPretzel && domain == "connector")
        return validateApiReferences(values, error);

    return true;
}

}

void SettingsController::get(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    (void)sm;
    (void)req;
    json scopes = json::object();

    for (const auto* scopeName : kSettingsScopes)
    {
        const auto& stored = pz::config::Config::scopeConfig(scopeName);

        json projected = json::object();
        for (const auto& [domain, values] : stored.items())
        {
            if (domain.rfind("//", 0) == 0)
                continue;

            const bool hidden = std::any_of(std::begin(kHiddenDomains), std::end(kHiddenDomains),
                                            [&](const char* d) { return domain == d; });
            if (hidden)
                continue;

            json v = values;
            if (domain == "console" && v.is_object())
                v.erase("admin");

            projected[domain] = std::move(v);
        }

        scopes[scopeName] = std::move(projected);
    }

    json body;
    body["scopes"] = std::move(scopes);

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

// The whole active running-config, verbatim, as stored. /api/settings is a per-scope,
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

    // Accounts are the one domain a commit may not carry unless the person publishing it may
    // manage accounts. Everything else on this appliance is open to both roles; this is not,
    // because a user who could publish `pretzel.user` could make themselves an admin.
    //
    // Refused for the whole batch rather than by dropping the entry: a partial publish is exactly
    // what the batch rule below exists to prevent, and an operator who staged an account change
    // they may not make should be told, not quietly given the rest.
    if (input.contains("changes") && input["changes"].is_array()
        && !sm.authService().sessionIsAdmin(sessionCookie(req)))
    {
        for (const auto& c : input["changes"])
        {
            if (c.is_object() && c.value("scope", std::string()) == pz::config::scope::kPretzel
                && c.value("domain", std::string()) == "user")
            {
                LOG_WARN("settings-commit rejected: accounts may only be published by an admin "
                         "(user={})", sm.authService().sessionUser(sessionCookie(req)));
                return fill(resp, 403,
                            R"({"error":"only an admin may change accounts","code":"FORBIDDEN"})");
            }
        }
    }

    if (!input.contains("changes") || !input["changes"].is_array())
        return badRequest("expected {changes: [{scope, domain, values}]}");

    const json& changes = input["changes"];

    json validChanges = json::array();
    json results = json::array();   // per-change outcome, returned to the browser and used below
    std::vector<std::size_t> resultOf;   // parallel to validChanges: where its result entry lives
    int failed = 0;

    // Record a per-change rejection: logged (so the reason survives in mgmtd.log) and returned.
    auto reject = [&](const std::string& scopeName, const std::string& domain, const std::string& why) {
        LOG_WARN("settings-commit rejected (scope={}, domain={}, reason={})", scopeName, domain, why);
        results.push_back({{"scope", scopeName}, {"domain", domain}, {"ok", false}, {"error", why}});
        failed++;
    };

    for (const auto& change : changes)
    {
        if (!change.contains("scope") || !change.contains("domain") || !change.contains("values"))
        {
            reject(change.value("scope", ""), change.value("domain", ""), "entry is missing scope/domain/values");
            continue;
        }

        const std::string scopeName = change.value("scope", "");
        const std::string domain = change.value("domain", "");
        const json& values = change["values"];

        if (!values.is_object())
        {
            reject(scopeName, domain, "values is not an object");
            continue;
        }

        const bool knownScope = std::any_of(std::begin(kSettingsScopes), std::end(kSettingsScopes),
                                            [&](const char* s) { return scopeName == s; });

        if (!knownScope)
        {
            reject(scopeName, domain, "unknown scope");
            continue;
        }

        std::string schemaError;
        if (!validateCommitShape(scopeName, domain, values, schemaError))
        {
            reject(scopeName, domain, schemaError.empty() ? "schema validation failed" : schemaError);
            continue;
        }

        results.push_back({{"scope", scopeName}, {"domain", domain}, {"ok", true}});
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
            json& dst = mergedByDomain[{c.value("scope", std::string()), c.value("domain", std::string())}];
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

            LOG_WARN("settings-commit rejected (scope={}, domain={}, reason={})", target.first, target.second,
                     refError);

            // It is the combination that broke the reference, not one entry in it, so every change
            // aimed at this domain is marked — the operator needs to see all the parts involved to
            // know which one to correct.
            for (std::size_t i = 0; i < validChanges.size(); ++i)
            {
                if (validChanges[i].value("scope", std::string()) != target.first ||
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

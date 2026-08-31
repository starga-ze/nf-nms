#include "service/api/controller/StatusController.h"

#include "service/CollectordServiceManager.h"
#include "service/api/ApiService.h"
#include "service/api/controller/ConnectorTest.h"
#include "service/api/ApiUtil.h"

#include "http/HttpClient.h"

#include "config/Config.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"
#include "util/Secret.h"

#include <memory>

#include <nlohmann/json.hpp>

namespace pz::collectord
{

using json = nlohmann::json;

namespace
{

constexpr auto kInterval = std::chrono::seconds(60);

// Split "https://host[:port]/path" into its parts. Requires https; defaults port 443, path "/".
struct ParsedUrl
{
    std::string host;
    std::uint16_t port{443};
    std::string path{"/"};
    bool ok{false};
};

ParsedUrl parseUrl(const std::string& url)
{
    ParsedUrl r;
    if (url.rfind("https://", 0) != 0)
        return r;   // require TLS — the api-key must never cross a plaintext hop

    const std::string rest = url.substr(8);
    const auto slash = rest.find('/');
    const std::string hostport = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    r.path = (slash == std::string::npos) ? "/" : rest.substr(slash);

    if (const auto colon = hostport.find(':'); colon != std::string::npos)
    {
        r.host = hostport.substr(0, colon);
        try
        {
            r.port = static_cast<std::uint16_t>(std::stoi(hostport.substr(colon + 1)));
        }
        catch (const std::exception&)
        {
            return r;
        }
    }
    else
    {
        r.host = hostport;
    }

    r.ok = !r.host.empty();
    return r;
}

// Seal an api-key with the credential store and hand it to engined for sase_device.api_key_enc.
// Returns false when the store is unavailable, so the caller can say so rather than reporting a save
// that did not happen. The plaintext never crosses the socket — only the sealed blob.
bool sealAndStoreApiKey(CollectordServiceManager& sm, const std::string& oid, const std::string& apiKey)
{
    auto sealed = pz::util::secret::encrypt(apiKey);
    if (!sealed)
        return false;

    json state;
    state["oid"] = oid;
    state["api_key_enc"] = *sealed;
    const std::string payload = state.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Collectord);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::SaseApiKeyUpdate);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(payload.begin(), payload.end()));
    sm.txRouter().handleIpcMessage(std::move(msg));
    return true;
}

}

StatusController::StatusController(boost::asio::io_context& ioc) : m_ioc(ioc)
{
}

void StatusController::tick(std::chrono::steady_clock::time_point now, const ApiService& api, 
        CollectordServiceManager& sm)
{
    if (m_lastRun.time_since_epoch().count() != 0 && now - m_lastRun < kInterval)
        return;
    m_lastRun = now;

    // Report the previous cycle's outcome to engined before firing the new probes (which complete
    // asynchronously and are reported on the next tick). This is the SASE counterpart of probed's
    // ProbeResult — a target is in exactly one of alive/down once probed; unconfigured ones are in
    // neither, so engined leaves their status untouched.
    {
        json payload;
        payload["sase_alive"] = aliveTargets();
        payload["sase_down"] = downTargets();
        json egress = json::object();
        for (const auto& [target, result] : m_egress)
            egress[target] = result;
        payload["sase_egress"] = std::move(egress);

        const std::string payloadStr = payload.dump();
        auto msg = std::make_unique<pz::ipc::IpcMessage>();
        msg->setSrc(pz::ipc::IpcDaemon::Collectord);
        msg->setDst(pz::ipc::IpcDaemon::Engined);
        msg->setCmd(pz::ipc::IpcCmd::SaseHealthResult);
        msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Response));
        msg->setPayload(reinterpret_cast<const std::uint8_t*>(payloadStr.data()), payloadStr.size());
        sm.txRouter().handleIpcMessage(std::move(msg));
    }

    const auto& site = pz::config::Config::section(pz::config::scope::kPretzel, "site");
    const auto devices = site.value("sase_devices", json::array());

    for (const auto& d : devices)
    {
        if (!d.is_object())
            continue;

        const std::string oid = d.value("oid", std::string());
        const std::string target = d.value("target", std::string());
        if (oid.empty() || target.empty())
            continue;

        const auto health = d.value("health", json::object());
        const std::string url = health.value("url", std::string());
        // The api-key is not in config — it comes sealed from engined, opened into ApiService's cache
        // keyed by the device oid (same fetch as issued keys).
        const std::string apiKey = api.issuedKey(oid);
        if (url.empty() || apiKey.empty())
            continue;   // not configured for health yet, or the key fetch has not landed — unknown

        if (m_inFlight[target])
            continue;   // a probe from a previous slow cycle is still running

        const ParsedUrl u = parseUrl(url);
        if (!u.ok)
        {
            m_result[target] = false;
            LOG_WARN("sase probe url is not a valid https url (target={})", target);
            continue;
        }

        // Body defaults to {} but is normally {"serviceType":"all","addrType":"all","location":"all"}.
        std::string body = "{}";
        if (health.contains("body"))
            body = health["body"].is_string() ? health["body"].get<std::string>() : health["body"].dump();

        pz::http::ClientRequest req;
        req.host = u.host;
        req.port = u.port;
        req.method = "POST";
        req.target = u.path;
        req.headers = {{"header-api-key", apiKey}, {"Content-Type", "application/json"}};
        req.body = std::move(body);
        req.verifyCa = true;   // Prisma Access serves a CA-signed cert — verify the chain, no pinning
        // getPrismaAccessIP is slow (~8s observed); the default 8s deadline races it, so give it room.
        req.timeout = std::chrono::seconds(25);

        m_inFlight[target] = true;
        LOG_DEBUG("sase probe start (target={}, host={})", target, u.host);

        pz::http::requestAsync(m_ioc, std::move(req), [this, target](pz::http::ClientResponse res) {
            m_inFlight[target] = false;
            bool ok = false;
            if (res.status == 200)
            {
                const auto parsed = json::parse(res.body, nullptr, false);
                ok = parsed.is_object() && parsed.value("status", std::string()) == "success";
                if (ok)
                    m_egress[target] = parsed;   // cache the egress-IP payload for engined to store
            }
            m_result[target] = ok;
            LOG_DEBUG("sase probe result (target={}, status={}, ok={})", target, res.status, ok);
        });
    }
}

std::vector<std::string> StatusController::aliveTargets() const
{
    std::vector<std::string> out;
    for (const auto& [target, ok] : m_result)
        if (ok)
            out.push_back(target);
    return out;
}

std::vector<std::string> StatusController::downTargets() const
{
    std::vector<std::string> out;
    for (const auto& [target, ok] : m_result)
        if (!ok)
            out.push_back(target);
    return out;
}

const std::unordered_map<std::string, nlohmann::json>& StatusController::egressResults() const
{
    return m_egress;
}

// On-demand SASE device health test: run getPrismaAccessIP with the operator's api-key, and on
// success seal the api-key and hand it to engined for sase_device.api_key_enc. This is both the
// "does it work?" check and how the api-key gets persisted (it never touches running_config),
// mirroring how a keygen test both validates and stores an NGFW key.
void StatusController::runSaseTest(ApiService& api, CollectordServiceManager& sm, std::uint32_t seqNo,
                                   const json& input)
{
    auto ctx = std::make_shared<ConnectorTest>();
    ctx->api = &api;
    ctx->sm = &sm;
    ctx->seqNo = seqNo;
    ctx->input = input;

    // Backstop: mgmtd holds a browser on this seqNo, so a throw must not leave the ticket pending.
    try
    {
    const std::string oid = input.value("oid", std::string());
    const std::string url = input.value("url", std::string());
    // The browser carries the plaintext key only in the moment it was pasted; from then on it renders
    // bullets and sends none, so fall back to the key already stored for this device. A key that came
    // from the operator is (re-)sealed on success below; a stored one is already where it belongs.
    std::string apiKey = input.value("api_key", std::string());
    const bool keyFromOperator = !apiKey.empty();
    if (apiKey.empty())
        apiKey = api.issuedKey(oid);
    std::string body = input.value("body", std::string());
    if (body.empty())
        body = R"({"serviceType":"all","addrType":"all","location":"all"})";

    ctx->out["steps"] = json::object();
    if (oid.empty() || url.empty())
        return rejectTest(ctx, "the device and probe URL are both required");
    if (apiKey.empty())
        return rejectTest(ctx, "no api-key is stored for this device — paste the command again");
    if (url.rfind("https://", 0) != 0)
        return rejectTest(ctx, "the probe URL must be https");

    const std::string rest = url.substr(8);
    const auto slash = rest.find('/');
    const std::string hostport = (slash == std::string::npos) ? rest : rest.substr(0, slash);
    const std::string path = (slash == std::string::npos) ? "/" : rest.substr(slash);
    std::string host = hostport;
    std::uint16_t port = 443;
    if (const auto colon = hostport.find(':'); colon != std::string::npos)
    {
        host = hostport.substr(0, colon);
        try
        {
            port = static_cast<std::uint16_t>(std::stoi(hostport.substr(colon + 1)));
        }
        catch (const std::exception&)
        {
        }
    }

    pz::http::ClientRequest req;
    req.host = host;
    req.port = port;
    req.method = "POST";
    req.target = path;
    req.headers = {{"header-api-key", apiKey}, {"Content-Type", "application/json"}};
    req.body = std::move(body);
    req.verifyCa = true;   // Prisma Access serves a CA-signed cert
    req.timeout = std::chrono::seconds(25);

    pz::http::requestAsync(ctx->sm->ioContext(), std::move(req),
                           [ctx, oid, apiKey, keyFromOperator](pz::http::ClientResponse res) {
        bool ok = false;
        std::string note;
        const auto parsed = json::parse(res.body, nullptr, false);

        if (res.status == 200)
        {
            ok = parsed.is_object() && parsed.value("status", std::string()) == "success";
            if (!ok)
                note = "reached the API but the response was not a success";
        }
        else if (res.status == 401 || res.status == 403)
            note = "the api-key was rejected (HTTP " + std::to_string(res.status) + ")";
        else if (res.status != 0)
            note = "the API answered HTTP " + std::to_string(res.status);
        else
            note = res.error.empty() ? "could not reach the SASE API" : res.error;

        ctx->out["ok"] = ok;
        ctx->out["message"] = ok ? "SASE health check passed — api-key saved" : note;

        // Hand back what the tenant actually answered — the same document the periodic probe caches
        // in sase_device.egress_result (the egress IP list is the point of the call, so the operator
        // wants to read it, not just see a green tick). A non-JSON body travels as raw text so an
        // error page is still visible rather than silently dropped.
        ctx->out["http_status"] = res.status;
        if (!parsed.is_discarded())
            ctx->out["egress"] = parsed;
        else if (!res.body.empty())
            ctx->out["egress_raw"] = res.body;

        // A key the operator just entered is proven by this call, so persist it now. One that came
        // from the store is already there.
        if (ok && keyFromOperator && !sealAndStoreApiKey(*ctx->sm, oid, apiKey))
            ctx->out["message"] = "health check passed, but the credential store is unavailable to save the key";

        sendTestResponse(*ctx->sm, ctx->seqNo, ctx->out);
    });
    }
    catch (const std::exception& e)
    {
        LOG_WARN("sase test failed to start (seq={}, error={})", seqNo, e.what());
        json out;
        out["ok"] = false;
        out["steps"] = json::object();
        out["message"] = std::string("test could not be started: ") + e.what();
        sendTestResponse(sm, seqNo, out);
    }
}

// Store a SASE device's health api-key without calling the device. The operator pastes the api-key
// while creating the device and saves; the key must not sit in the browser waiting for someone to
// press Test, and it must never reach running_config (append-versioned and shown verbatim in the
// review diff). So it is sealed here and stored in sase_device.api_key_enc, the same column a passing
// test writes — engined upserts, so this works before the device projection exists.
void StatusController::storeApiKey(CollectordServiceManager& sm, std::uint32_t seqNo, const json& input)
{
    json out;
    out["steps"] = json::object();

    try
    {
        const std::string oid = input.value("oid", std::string());
        const std::string apiKey = input.value("api_key", std::string());

        if (oid.empty() || apiKey.empty())
        {
            out["ok"] = false;
            out["message"] = "the device and api-key are both required";
        }
        else if (!sealAndStoreApiKey(sm, oid, apiKey))
        {
            LOG_WARN("sase api-key not stored — credential store unavailable (oid={})", oid);
            out["ok"] = false;
            out["message"] = "the credential store is unavailable — the api-key was not saved";
        }
        else
        {
            LOG_INFO("sase api-key sealed and sent to engined (oid={})", oid);   // never log the key
            out["ok"] = true;
            out["message"] = "api-key saved";
        }
    }
    catch (const std::exception& e)
    {
        LOG_WARN("sase api-key store failed (seq={}, error={})", seqNo, e.what());
        out["ok"] = false;
        out["message"] = std::string("the api-key could not be saved: ") + e.what();
    }

    sendTestResponse(sm, seqNo, out);
}

}

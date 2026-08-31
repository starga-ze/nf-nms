#include "service/api/controller/ConnectorController.h"

#include "service/CollectordServiceManager.h"
#include "service/api/ApiService.h"
#include "service/api/ApiUtil.h"

#include "config/Config.h"
#include "http/HttpClient.h"
#include "http/UrlEncode.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <boost/asio/steady_timer.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <strings.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace pz::collectord
{

// One connector item's repeating schedule, plus the back-pointers a completion needs. `sm`/`api`
// live for the process (owned by the core), so the raw pointers are safe for the job's lifetime.
struct CollectorJob
{
    CollectordServiceManager* sm{nullptr};
    ApiService* api{nullptr};
    std::string connectorOid;
    std::string endpointOid;
    std::string authProfileOid;   // which issued key authenticates the call
    std::string objectOid;        // inventory object → device host + pinned fingerprint
    std::chrono::seconds interval{60};
    boost::asio::steady_timer timer;

    explicit CollectorJob(boost::asio::io_context& ioc) : timer(ioc) {}
};

namespace
{

using json = nlohmann::json;

// The first poll fires this soon after start rather than a full interval later, so a fresh commit
// (a reload restarts the daemon) shows data within seconds instead of after minutes. The small
// delay lets the issued keys arrive first; it is capped at the interval so a sub-delay interval
// still fires on schedule.
constexpr std::chrono::seconds kInitialDelay{3};

// Resolves an inventory object to the device it names: host, port and the pinned TLS fingerprint.
// The devices live in engined's config domain, which collectord can read because Config is the whole
// running-config, not just this daemon's slice. Returns false when the object is unknown or has no
// target — the caller then skips the poll rather than calling nowhere.
bool resolveDevice(const std::string& objectOid, std::string& host, std::uint16_t& port,
                   std::string& fingerprint)
{
    const auto& site = pz::config::Config::section(pz::config::scope::kPretzel, "site");
    // A connector's object may name either device kind; both arrays are searched by oid.
    json devices = json::array();
    for (const char* key : {"ngfw_devices", "sase_devices"})
        for (const auto& d : site.value(key, json::array()))
            devices.push_back(d);

    for (const auto& d : devices)
    {
        if (!d.is_object() || d.value("oid", std::string()) != objectOid)
            continue;

        std::string target = d.value("target", std::string());
        if (target.empty())
            return false;

        // target is host[:port]; IPv6 literals are bracketed and left to the client as-is.
        port = 443;
        if (target.front() != '[')
        {
            const auto colon = target.rfind(':');
            if (colon != std::string::npos && target.find(':') == colon)
            {
                try
                {
                    port = static_cast<std::uint16_t>(std::stoi(target.substr(colon + 1)));
                    target.erase(colon);
                }
                catch (const std::exception&)
                {
                }
            }
        }

        host = target;
        fingerprint = d.value("fingerprint", std::string());
        return true;
    }
    return false;
}

// The stages call one another across the timer and the async device call; forward-declared so the
// definitions read in run order.
void armJob(std::shared_ptr<CollectorJob> job, std::chrono::seconds delay);
void collectOnce(std::shared_ptr<CollectorJob> job);
void collectSaseOnce(std::shared_ptr<CollectorJob> job, const ApiEndpoint& ep, const std::string& token);
void onResponse(std::shared_ptr<CollectorJob> job, std::chrono::steady_clock::time_point startedAt,
                pz::http::ClientResponse res);

void sendSample(CollectordServiceManager& sm, const json& sample)
{
    const std::string payload = sample.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Collectord);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::ApiCollectionSample);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(payload.begin(), payload.end()));

    sm.txRouter().handleIpcMessage(std::move(msg));
}

void armJob(std::shared_ptr<CollectorJob> job, std::chrono::seconds delay)
{
    job->timer.expires_after(delay);
    job->timer.async_wait(
        [job](const boost::system::error_code& ec)
        {
            if (ec)   // cancelled — the daemon is shutting down
                return;
            collectOnce(job);
        });
}

void collectOnce(std::shared_ptr<CollectorJob> job)
{
    ApiService& api = *job->api;

    const ApiEndpoint* ep = api.findEndpoint(job->endpointOid);
    if (!ep)
    {
        LOG_WARN("collection skipped — unknown endpoint (connector={}, endpoint={})", job->connectorOid,
                 job->endpointOid);
        return armJob(job, job->interval);
    }

    // The call rides on a credential already issued for this profile — an NGFW key or a SASE bearer
    // token, whichever this profile holds. There is no password to fall back on here, so a
    // not-yet-issued one just defers this poll to the next interval.
    const std::string key = api.issuedKey(job->authProfileOid);
    if (key.empty())
    {
        LOG_WARN("collection skipped — no issued key yet (connector={}, profile={})", job->connectorOid,
                 job->authProfileOid);
        return armJob(job, job->interval);
    }

    // A SASE endpoint names its own host — the tenant is who you are, not where you connect — so
    // there is no device address to resolve and no certificate to pin. The sample it produces is the
    // same shape as any other, which is why both vendors land in one api_collection.
    if (ep->vendor == ApiVendor::Sase)
        return collectSaseOnce(std::move(job), *ep, key);

    std::string host;
    std::string fingerprint;
    std::uint16_t port = 443;
    if (!resolveDevice(job->objectOid, host, port, fingerprint))
    {
        LOG_WARN("collection skipped — device not resolved (connector={}, object={})", job->connectorOid,
                 job->objectOid);
        return armJob(job, job->interval);
    }

    pz::http::ClientRequest req;
    req.host = host;
    req.port = port;
    req.expectedFingerprint = fingerprint;
    req.timeout = std::chrono::seconds(10);

    // Path + endpoint parameters, percent-encoded here exactly as the connector test builds them.
    std::string path = ep->path;
    for (const auto& p : ep->params)
    {
        if (p.name.empty())
            continue;
        path += (path.find('?') == std::string::npos) ? '?' : '&';
        path += pz::http::urlEncode(p.name) + "=" + pz::http::urlEncode(p.value);
    }

    // The two PAN-OS APIs carry the key differently: XML API as a query parameter, REST as a header.
    if (ep->subtype == ApiSubtype::Xml)
    {
        const char sep = (path.find('?') == std::string::npos) ? '?' : '&';
        path += sep + std::string("key=") + pz::http::urlEncode(key);
    }
    else
    {
        req.headers.emplace_back("X-PAN-KEY", key);
    }
    req.target = path;

    const auto startedAt = std::chrono::steady_clock::now();
    pz::http::requestAsync(job->sm->ioContext(), std::move(req),
                           [job, startedAt](pz::http::ClientResponse res)
                           { onResponse(job, startedAt, std::move(res)); });
}

// One scheduled poll of a SASE endpoint. Deliberately converges on the same onResponse as the NGFW
// path: what a sample records — did it answer, how fast, how big, what came back — is a fact about
// the exchange, not about the vendor, so there is nothing here for the sample shape to branch on.
void collectSaseOnce(std::shared_ptr<CollectorJob> job, const ApiEndpoint& ep, const std::string& token)
{
    std::string path = ep.path;
    for (const auto& p : ep.params)
    {
        if (p.name.empty())
            continue;
        path += (path.find('?') == std::string::npos) ? '?' : '&';
        path += pz::http::urlEncode(p.name) + "=" + pz::http::urlEncode(p.value);
    }

    pz::http::ClientRequest req;
    req.host = ep.host;
    req.port = 443;
    req.verifyCa = true;   // Palo Alto's cloud — a CA chain, not a pinned self-signed device cert
    req.target = path;
    req.timeout = std::chrono::seconds(30);
    req.headers.emplace_back("Authorization", "Bearer " + token);

    for (const auto& h : ep.headers)
    {
        // The token is minted by the daemon; an endpoint must not be able to replace it.
        if (h.name.empty() || ::strcasecmp(h.name.c_str(), "authorization") == 0)
            continue;
        req.headers.emplace_back(h.name, h.value);
    }

    LOG_TRACE("SASE collection request (connector={}, GET https://{}{})", job->connectorOid, ep.host, path);

    const auto startedAt = std::chrono::steady_clock::now();
    pz::http::requestAsync(job->sm->ioContext(), std::move(req),
                           [job, startedAt](pz::http::ClientResponse res)
                           { onResponse(job, startedAt, std::move(res)); });
}

void onResponse(std::shared_ptr<CollectorJob> job, std::chrono::steady_clock::time_point startedAt,
                pz::http::ClientResponse res)
{
    const auto latencyMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - startedAt).count();

    const json sample = buildCollectionSample(job->connectorOid, job->endpointOid, res, latencyMs, kMaxSampleBody);

    if (sample.value("ok", false))
        LOG_INFO("collection sample (connector={}, endpoint={}, status={}, bytes={}, {}ms)", job->connectorOid,
                 job->endpointOid, res.status, res.body.size(), latencyMs);
    else
        LOG_WARN("collection sample failed (connector={}, endpoint={}, error={})", job->connectorOid,
                 job->endpointOid, sample.value("error", std::string()));

    sendSample(*job->sm, sample);
    armJob(job, job->interval);
}

}

ConnectorController::ConnectorController() = default;
ConnectorController::~ConnectorController() = default;

void ConnectorController::start(CollectordServiceManager& sm, ApiService& api)
{
    int armed = 0;
    for (const auto& conn : api.connectors())
    {
        for (const auto& item : conn.items)
        {
            if (!item.enabled)
                continue;

            auto job = std::make_shared<CollectorJob>(sm.ioContext());
            job->sm = &sm;
            job->api = &api;
            job->connectorOid = conn.oid;
            job->endpointOid = item.endpointOid;
            job->authProfileOid = conn.authProfileOid;
            job->objectOid = conn.objectOid;
            job->interval = std::chrono::seconds(item.pollIntervalSec < 1 ? 60 : item.pollIntervalSec);

            m_jobs.push_back(job);
            armJob(job, std::min(kInitialDelay, job->interval));
            ++armed;
        }
    }

    LOG_INFO("api collector started (jobs={})", armed);
}

}

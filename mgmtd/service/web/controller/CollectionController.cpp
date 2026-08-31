#include "service/web/controller/CollectionController.h"

#include "service/web/WebUtil.h"

#include "config/Config.h"
#include "db/Database.h"
#include "http/HttpMessage.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// The one timestamp format the whole web surface emits. Postgres prints a whole-hour zone as `+09`,
// which is not what ISO 8601 asks for — the frontend pads it back before parsing (NMS.utils.parseTs).
constexpr const char* kTs = "YYYY-MM-DD\"T\"HH24:MI:SSOF";

// Aggregate window. A day is long enough to show a daily pattern and short enough that the counts
// still move visibly when something breaks.
constexpr int kDefaultWindowHours = 24;
constexpr int kMaxWindowHours = 24 * 14;   // engined's metadata retention — asking for more is empty

// Points in a stream's spark series. Enough to read a rhythm at a glance; small enough that a few
// hundred streams stay a modest response.
constexpr int kSparkPoints = 30;

int intParam(const std::string& target, const char* key, int fallback, int lo, int hi)
{
    const auto s = queryParam(target, key);
    if (s.empty())
        return fallback;
    try
    {
        return std::clamp(std::stoi(s), lo, hi);
    }
    catch (...)
    {
        return fallback;
    }
}

// A stream is keyed by the pair, everywhere.
std::string streamKey(const std::string& connector, const std::string& endpoint)
{
    return connector + '\x1f' + endpoint;
}

// Optional numeric columns come back as '' when NULL; JSON should carry null, not 0 — a missing
// latency is not a zero-millisecond call.
json numOrNull(const std::string& s)
{
    if (s.empty())
        return nullptr;
    try
    {
        return json(std::stoll(s));
    }
    catch (...)
    {
        return nullptr;
    }
}

// The request line an endpoint stands for: its path with the operator's parameters appended. Shown
// so a stream is identifiable without opening the API Endpoint page — two streams can share a name
// and differ only in a query argument. A SASE endpoint carries its own host, and there the whole URL
// is the identifying thing: the same path on two products is two different calls.
std::string endpointDisplayPath(const json& ep)
{
    std::string path = ep.value("path", std::string());
    if (ep.value("device_type", std::string("ngfw")) == "sase")
    {
        const std::string host = ep.value("host", std::string());
        if (!host.empty())
            path = "https://" + host + path;
    }

    const auto params = ep.value("params", json::array());
    if (!params.is_array() || params.empty())
        return path;

    std::string qs;
    for (const auto& p : params)
    {
        if (!p.is_object())
            continue;
        const std::string name = p.value("name", std::string());
        if (name.empty())
            continue;
        qs += (qs.empty() ? "?" : "&");
        qs += name + "=" + p.value("value", std::string());
    }
    return path + qs;
}

// What the grid's type column says. NGFW endpoints are told apart by which PAN-OS API they speak;
// SASE ones by which product they belong to, since they all speak the same JSON over the same OAuth.
std::string endpointKind(const json& ep)
{
    const bool sase = ep.value("device_type", std::string("ngfw")) == "sase";
    // `subtype` replaced api_type/product; both are read so a stream whose endpoint predates the
    // merge still labels itself rather than showing a blank column.
    return ep.value("subtype", sase ? ep.value("product", std::string("ztna"))
                                    : ep.value("api_type", std::string()));
}

}

void CollectionController::overview(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                    pz::http::HttpResponse& resp)
{
    (void)sm;

    const int windowHours = intParam(req.target, "window", kDefaultWindowHours, 1, kMaxWindowHours);
    const std::string windowArg = std::to_string(windowHours);

    // The site is a SCOPE, not a filter the browser applies afterwards: on a large estate the
    // difference is whether the answer carries one site's streams or every site's. Empty means no
    // site has been chosen yet — the page asks for one, so only the selector's contents are needed.
    const std::string siteOid = queryParam(req.target, "site");

    json out;
    out["window_hours"] = windowHours;
    out["site"] = siteOid;
    out["scoped"] = !siteOid.empty();
    out["spark_points"] = kSparkPoints;
    out["sites"] = json::array();
    out["streams"] = json::array();
    out["orphan_streams"] = 0;

    try
    {
        auto& db = pz::db::Database::instance();

        // ── The declaration ───────────────────────────────────────────────────────────────────
        const auto& site = pz::config::Config::section(pz::config::scope::kPretzel, "site");
        const auto& api = pz::config::Config::section(pz::config::scope::kPretzel, "connector");

        std::unordered_map<std::string, std::string> siteName;
        for (const auto& s : site.value("sites", json::array()))
        {
            if (!s.is_object())
                continue;
            const std::string oid = s.value("oid", std::string());
            if (oid.empty())
                continue;
            siteName[oid] = s.value("name", std::string());
            out["sites"].push_back({{"oid", oid}, {"name", s.value("name", std::string())}});
        }

        // Device type is which array the device is declared in — the column was dropped when the
        // inventory split into ngfw_device / sase_device.
        struct Device
        {
            std::string name, target, site, type;
        };
        std::unordered_map<std::string, Device> devices;
        for (const auto& [key, type] : {std::pair{"ngfw_devices", "ngfw"}, std::pair{"sase_devices", "sase"}})
            for (const auto& d : site.value(key, json::array()))
            {
                if (!d.is_object())
                    continue;
                const std::string oid = d.value("oid", std::string());
                if (!oid.empty())
                    devices[oid] = Device{d.value("name", std::string()), d.value("target", std::string()),
                                          d.value("site", std::string()), type};
            }

        std::unordered_map<std::string, json> endpoints;
        for (const auto& e : api.value("endpoints", json::array()))
        {
            if (!e.is_object())
                continue;
            const std::string oid = e.value("oid", std::string());
            if (!oid.empty())
                endpoints[oid] = e;
        }

        std::unordered_map<std::string, std::string> credentialName;
        for (const auto& c : api.value("api_credentials", json::array()))
        {
            if (!c.is_object())
                continue;
            const std::string oid = c.value("oid", std::string());
            if (!oid.empty())
                credentialName[oid] = c.value("name", std::string());
        }

        // ── What actually happened ────────────────────────────────────────────────────────────
        // Three reads, each one pass over the stream index, none of them touching `body`.
        struct Last
        {
            std::string oid, at, status, latency, bytes, error;
            bool ok{false};
            bool truncated{false};
            bool bodyAged{false};
        };
        std::unordered_map<std::string, Last> last;
        for (const auto& r : db.queryRows(
                 std::string("SELECT DISTINCT ON (connector_oid, endpoint_oid) connector_oid, endpoint_oid, "
                             "oid::text, to_char(collected_at, '")
                 + kTs
                 + "'), ok::int, COALESCE(http_status::text,''), COALESCE(latency_ms::text,''), "
                   "COALESCE(bytes::text,''), truncated::int, COALESCE(error,''), body_aged::int "
                   "FROM api_collection ORDER BY connector_oid, endpoint_oid, collected_at DESC"))
        {
            if (r.size() < 11)
                continue;
            Last l;
            l.oid = r[2];
            l.at = r[3];
            l.ok = (r[4] == "1");
            l.status = r[5];
            l.latency = r[6];
            l.bytes = r[7];
            l.truncated = (r[8] == "1");
            l.error = r[9];
            l.bodyAged = (r[10] == "1");
            last[streamKey(r[0], r[1])] = std::move(l);
        }

        struct Window
        {
            std::string total, ok, p50, max, avgBytes, first, lastAt;
        };
        std::unordered_map<std::string, Window> window;
        for (const auto& r : db.queryRows(
                 std::string("SELECT connector_oid, endpoint_oid, count(*)::text, "
                             "count(*) FILTER (WHERE ok)::text, "
                             "COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms)::text,''), "
                             "COALESCE(max(latency_ms)::text,''), COALESCE(round(avg(bytes))::text,''), "
                             "to_char(min(collected_at), '")
                 + kTs + "'), to_char(max(collected_at), '" + kTs
                 + "') FROM api_collection WHERE collected_at > now() - ($1 || ' hours')::interval "
                   "GROUP BY connector_oid, endpoint_oid",
                 {windowArg}))
        {
            if (r.size() < 9)
                continue;
            window[streamKey(r[0], r[1])] = Window{r[2], r[3], r[4], r[5], r[6], r[7], r[8]};
        }

        // Spark: the newest kSparkPoints per stream, oldest first so the series reads left to right.
        // The inner select names its columns rather than `*` — `body` must not be dragged through a
        // window function it is not needed by.
        std::unordered_map<std::string, json> spark;
        for (const auto& r : db.queryRows(
                 std::string("SELECT connector_oid, endpoint_oid, to_char(collected_at, '") + kTs
                     + "'), ok::int, COALESCE(latency_ms::text,'') FROM ("
                       "  SELECT connector_oid, endpoint_oid, collected_at, ok, latency_ms, "
                       "         row_number() OVER (PARTITION BY connector_oid, endpoint_oid "
                       "                            ORDER BY collected_at DESC) AS rn "
                       "  FROM api_collection "
                       "  WHERE collected_at > now() - ($1 || ' hours')::interval"
                       ") ranked WHERE rn <= $2::int "
                       "ORDER BY connector_oid, endpoint_oid, collected_at",
                 {windowArg, std::to_string(kSparkPoints)}))
        {
            if (r.size() < 5)
                continue;
            auto& arr = spark[streamKey(r[0], r[1])];
            if (!arr.is_array())
                arr = json::array();
            arr.push_back({{"at", r[2]}, {"ok", r[3] == "1"}, {"latency_ms", numOrNull(r[4])}});
        }

        // ── The join ──────────────────────────────────────────────────────────────────────────
        std::vector<std::string> declared;   // stream keys config knows about
        for (const auto& c : (siteOid.empty() ? json::array() : api.value("connectors", json::array())))
        {
            if (!c.is_object())
                continue;
            const std::string connectorOid = c.value("oid", c.value("uuid", std::string()));
            if (connectorOid.empty())
                continue;

            const std::string deviceOid = c.value("object", std::string());
            const std::string credOid = c.value("auth_profile", std::string());
            const auto dev = devices.find(deviceOid);

            // A connector belongs to a device, and the device to a site — that chain is what scopes
            // a table with no site column of its own. A connector whose device is gone has no site
            // either, so it cannot belong to the one being asked for.
            if (!siteOid.empty() && (dev == devices.end() || dev->second.site != siteOid))
                continue;

            // The same conditions collectord refuses a connector on, reported rather than left to
            // present as a stream that mysteriously never produces a sample.
            std::string configError;
            if (c.contains("endpoint") || c.contains("params"))
                configError = "connector still has the pre-policy single-endpoint shape — rebuild it";
            else if (credOid.empty())
                configError = "no API credential bound — collectord will not run this connector";
            else if (dev == devices.end())
                configError = "bound device no longer exists";

            for (const auto& i : c.value("items", json::array()))
            {
                if (!i.is_object())
                    continue;
                const std::string endpointOid = i.value("endpoint", std::string());
                if (endpointOid.empty())
                    continue;

                const auto ep = endpoints.find(endpointOid);
                const std::string key = streamKey(connectorOid, endpointOid);
                declared.push_back(key);

                json s;
                s["key"] = key;
                s["connector_oid"] = connectorOid;
                s["connector_name"] = c.value("name", std::string());
                s["endpoint_oid"] = endpointOid;
                s["endpoint_name"] = ep != endpoints.end() ? ep->second.value("name", std::string()) : std::string();
                s["endpoint_path"] = ep != endpoints.end() ? endpointDisplayPath(ep->second) : std::string();
                s["api_type"] = ep != endpoints.end() ? endpointKind(ep->second) : std::string();
                s["device_type"] = ep != endpoints.end()
                                       ? ep->second.value("device_type", std::string("ngfw"))
                                       : std::string();
                s["device_oid"] = deviceOid;
                s["device_name"] = dev != devices.end() ? dev->second.name : std::string();
                s["device_target"] = dev != devices.end() ? dev->second.target : std::string();
                s["device_type"] = dev != devices.end() ? dev->second.type : std::string();
                s["site_oid"] = dev != devices.end() ? dev->second.site : std::string();
                s["site_name"] = (dev != devices.end() && siteName.count(dev->second.site))
                                     ? siteName[dev->second.site]
                                     : std::string();
                s["credential_oid"] = credOid;
                s["credential_name"] = credentialName.count(credOid) ? credentialName[credOid] : std::string();
                s["interval_sec"] = i.value("poll_interval_sec", 60);
                s["enabled"] = i.value("enabled", true);
                s["orphan"] = false;
                if (!configError.empty())
                    s["config_error"] = configError;
                if (ep == endpoints.end())
                    s["config_error"] = "the endpoint this item points at no longer exists";

                const auto l = last.find(key);
                if (l == last.end())
                {
                    s["last"] = nullptr;
                }
                else
                {
                    s["last"] = {{"oid", l->second.oid},
                                 {"at", l->second.at},
                                 {"ok", l->second.ok},
                                 {"http_status", numOrNull(l->second.status)},
                                 {"latency_ms", numOrNull(l->second.latency)},
                                 {"bytes", numOrNull(l->second.bytes)},
                                 {"truncated", l->second.truncated},
                                 {"body_aged", l->second.bodyAged},
                                 {"error", l->second.error}};
                }

                const auto w = window.find(key);
                if (w == window.end())
                {
                    s["window"] = {{"total", 0}, {"ok", 0}};
                }
                else
                {
                    s["window"] = {{"total", numOrNull(w->second.total)},
                                   {"ok", numOrNull(w->second.ok)},
                                   {"p50_latency_ms", numOrNull(w->second.p50)},
                                   {"max_latency_ms", numOrNull(w->second.max)},
                                   {"avg_bytes", numOrNull(w->second.avgBytes)},
                                   {"first_at", w->second.first},
                                   {"last_at", w->second.lastAt}};
                }

                const auto sp = spark.find(key);
                s["spark"] = sp == spark.end() ? json::array() : sp->second;

                out["streams"].push_back(std::move(s));
            }
        }

        // ── Per-site census ───────────────────────────────────────────────────────────────────
        // What the scope prompt shows on each site's card. Deliberately facts, not judgements: how
        // many streams, how many devices, and when the site last collected anything. The health
        // rules (live / stale / failing) live in one place — the grid — and are not restated here in
        // another language where they could drift.
        struct Census
        {
            std::set<std::string> ngfw;
            std::set<std::string> sase;
            std::set<std::string> endpoints;
        };
        std::map<std::string, Census> census;

        for (const auto& c : api.value("connectors", json::array()))
        {
            if (!c.is_object())
                continue;
            const std::string connectorOid = c.value("oid", c.value("uuid", std::string()));
            const std::string deviceOid = c.value("object", std::string());
            const auto dev = devices.find(deviceOid);
            if (connectorOid.empty() || dev == devices.end())
                continue;

            auto& cs = census[dev->second.site];
            (dev->second.type == "sase" ? cs.sase : cs.ngfw).insert(deviceOid);

            // Distinct endpoints, not streams: two devices in a site collecting the same endpoint are
            // two streams but one endpoint, and the count is labelled "API Endpoints".
            for (const auto& i : c.value("items", json::array()))
            {
                if (!i.is_object())
                    continue;
                const std::string endpointOid = i.value("endpoint", std::string());
                if (!endpointOid.empty())
                    cs.endpoints.insert(endpointOid);
            }
        }

        for (auto& site : out["sites"])
        {
            const auto it = census.find(site.value("oid", std::string()));
            const int ngfw = it == census.end() ? 0 : static_cast<int>(it->second.ngfw.size());
            const int sase = it == census.end() ? 0 : static_cast<int>(it->second.sase.size());
            site["ngfw"] = ngfw;
            site["sase"] = sase;
            site["devices"] = ngfw + sase;
            site["endpoints"] = it == census.end() ? 0 : static_cast<int>(it->second.endpoints.size());
        }

        // Rows whose stream is no longer declared. They are not listed — an undeclared stream has no
        // device, no site and no schedule to report — but they are counted, because they are what the
        // table is holding that the page cannot otherwise account for.
        for (const auto& kv : last)
            if (std::find(declared.begin(), declared.end(), kv.first) == declared.end())
                out["orphan_streams"] = out["orphan_streams"].get<int>() + 1;
    }
    catch (const std::exception& e)
    {
        LOG_WARN("collection overview failed: {}", e.what());
        return fill(resp, 500, json{{"error", "collection overview unavailable"}}.dump());
    }

    fill(resp, 200, out.dump());
}

// GET /api/collection/samples?connector=&endpoint=&status=&before=&limit=
//   connector/endpoint : narrow to one stream (both empty = every stream, newest first)
//   status             : ''=all · 'ok' · 'fail'
//   before             : keyset cursor — rows strictly older (smaller oid) than this
//   limit              : 1..200 (default 50)
// Metadata only. Bodies are fetched one at a time by sample().
void CollectionController::samples(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                   pz::http::HttpResponse& resp)
{
    (void)sm;

    const std::string connector = queryParam(req.target, "connector");
    const std::string endpoint = queryParam(req.target, "endpoint");
    const std::string status = queryParam(req.target, "status");
    const std::string before = queryParam(req.target, "before");
    const int limit = intParam(req.target, "limit", 50, 1, 200);

    if (!status.empty() && status != "ok" && status != "fail")
        return fill(resp, 400, json{{"error", "status must be ok or fail"}}.dump());

    json body;
    body["rows"] = json::array();
    body["next_cursor"] = nullptr;

    try
    {
        // Every predicate collapses to TRUE when its parameter is empty, so one statement shape
        // serves each filter combination; NULLIF guards the casts an empty string would fail.
        const auto rows = pz::db::Database::instance().queryRows(
            std::string("SELECT oid::text, connector_oid, endpoint_oid, to_char(collected_at, '") + kTs
                + "'), ok::int, COALESCE(http_status::text,''), COALESCE(latency_ms::text,''), "
                  "COALESCE(bytes::text,''), truncated::int, COALESCE(error,''), "
                  "(body IS NOT NULL)::int, body_aged::int "
                  "FROM api_collection "
                  "WHERE ($1 = '' OR connector_oid = $1) "
                  "AND ($2 = '' OR endpoint_oid = $2) "
                  "AND ($3 = '' OR ok = ($3 = 'ok')) "
                  "AND ($4 = '' OR oid < NULLIF($4,'')::bigint) "
                  "ORDER BY oid DESC LIMIT $5::int",
            {connector, endpoint, status, before, std::to_string(limit)});

        for (const auto& r : rows)
        {
            if (r.size() < 12)
                continue;
            body["rows"].push_back({{"oid", r[0]},
                                    {"connector_oid", r[1]},
                                    {"endpoint_oid", r[2]},
                                    {"at", r[3]},
                                    {"ok", r[4] == "1"},
                                    {"http_status", numOrNull(r[5])},
                                    {"latency_ms", numOrNull(r[6])},
                                    {"bytes", numOrNull(r[7])},
                                    {"truncated", r[8] == "1"},
                                    {"error", r[9]},
                                    {"has_body", r[10] == "1"},
                                    {"body_aged", r[11] == "1"}});
        }

        // A full page implies more may follow; the cursor is the oldest oid returned.
        if (!rows.empty() && static_cast<int>(rows.size()) == limit)
            body["next_cursor"] = rows.back()[0];
    }
    catch (const std::exception& e)
    {
        LOG_WARN("collection samples query failed: {}", e.what());
        return fill(resp, 500, json{{"error", "samples unavailable"}}.dump());
    }

    fill(resp, 200, body.dump());
}

// GET /api/collection/sample?oid=<id>
// The raw response exactly as the device sent it — pretzel stores it unparsed and returns it
// unparsed, because the operator's question here is what the API actually said, and any reshaping on
// the way out would be pretzel's answer rather than the device's.
void CollectionController::sample(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                  pz::http::HttpResponse& resp)
{
    (void)sm;

    const std::string oid = queryParam(req.target, "oid");
    if (oid.empty() || !std::all_of(oid.begin(), oid.end(), [](unsigned char c) { return std::isdigit(c); }))
        return fill(resp, 400, json{{"error", "oid required"}}.dump());

    try
    {
        const auto rows = pz::db::Database::instance().queryRows(
            std::string("SELECT oid::text, connector_oid, endpoint_oid, to_char(collected_at, '") + kTs
                + "'), ok::int, COALESCE(http_status::text,''), COALESCE(latency_ms::text,''), "
                  "COALESCE(bytes::text,''), truncated::int, COALESCE(error,''), COALESCE(body,''), "
                  "(body IS NOT NULL)::int, body_aged::int "
                  "FROM api_collection WHERE oid = $1::bigint",
            {oid});

        if (rows.empty() || rows[0].size() < 13)
            return fill(resp, 404, json{{"error", "no such sample"}}.dump());

        const auto& r = rows[0];
        json out = {{"oid", r[0]},
                    {"connector_oid", r[1]},
                    {"endpoint_oid", r[2]},
                    {"at", r[3]},
                    {"ok", r[4] == "1"},
                    {"http_status", numOrNull(r[5])},
                    {"latency_ms", numOrNull(r[6])},
                    {"bytes", numOrNull(r[7])},
                    {"truncated", r[8] == "1"},
                    {"error", r[9]},
                    {"has_body", r[11] == "1"},
                    {"body_aged", r[12] == "1"}};
        out["body"] = (r[11] == "1") ? json(r[10]) : json(nullptr);

        fill(resp, 200, out.dump());
    }
    catch (const std::exception& e)
    {
        LOG_WARN("collection sample query failed: {}", e.what());
        fill(resp, 500, json{{"error", "sample unavailable"}}.dump());
    }
}

}

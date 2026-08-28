#include "service/web/controller/BenchtestController.h"

#include "service/MgmtdServiceManager.h"
#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"
#include "grpc/GrpcMessage.h"

#include "http/HttpMessage.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <cstdlib>
#include <string>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// The filter values reaching pretzel-ai are used in a WHERE clause there, against a closed set of
// column names. They are bounded and character-checked here anyway: a value this daemon forwards
// without looking at is a value this daemon cannot say anything about, and "the other side checks
// it" is the sentence every injection bug is written under.
constexpr std::size_t kMaxFilterChars = 64;
constexpr std::size_t kMaxSearchChars = 200;
constexpr std::size_t kMaxFilenameChars = 200;

// Matches pretzel-ai's own MAX_UPLOAD_BYTES. Checked here so an oversized body is refused before
// it is copied into a gRPC message, rather than after.
constexpr std::size_t kMaxUploadBytes = 32ull * 1024 * 1024;

bool validFilter(const std::string& value)
{
    if (value.size() > kMaxFilterChars)
        return false;
    for (char c : value)
    {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                        || (c >= '0' && c <= '9') || c == '-' || c == '_';
        if (!ok)
            return false;
    }
    return true;
}

// A dataset id is a positive integer or nothing. 0 is "absent", which every caller treats as an
// error rather than as a set — there is no set 0.
std::int64_t datasetIdOf(const pz::http::HttpRequest& req)
{
    const std::string raw = queryParam(req.target, "id");
    if (raw.empty())
        return 0;
    char* end = nullptr;
    const long long value = std::strtoll(raw.c_str(), &end, 10);
    if (end == raw.c_str() || (end && *end != '\0') || value <= 0)
        return 0;
    return static_cast<std::int64_t>(value);
}

std::int32_t intParam(const pz::http::HttpRequest& req, const char* key, std::int32_t fallback)
{
    const std::string raw = queryParam(req.target, key);
    if (raw.empty())
        return fallback;
    char* end = nullptr;
    const long value = std::strtol(raw.c_str(), &end, 10);
    if (end == raw.c_str() || value < 0)
        return fallback;
    return static_cast<std::int32_t>(value);
}

void accepted(pz::http::HttpResponse& resp, std::uint32_t ticket)
{
    fill(resp, 202, json{{"ticket", ticket}, {"status", "pending"}}.dump());
}

}

void BenchtestController::datasets(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                   pz::http::HttpResponse& resp)
{
    const std::string search = queryParam(req.target, "q");
    if (search.size() > kMaxSearchChars)
        return fill(resp, 400, R"({"error":"search too long"})");

    const std::uint32_t ticket = sm.nextChatTicket();
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtest(GrpcCmd::BenchtestDatasets, ticket, 0, search));
    accepted(resp, ticket);
}

void BenchtestController::upload(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                 pz::http::HttpResponse& resp)
{
    if (req.body.empty())
        return fill(resp, 400, R"({"error":"the upload is empty"})");
    if (req.body.size() > kMaxUploadBytes)
        return fill(resp, 413, R"({"error":"the file is larger than 32 MB"})");

    // The filename is a label for the stored set and for the eventual download name — it is never
    // opened, joined to a path, or used to address anything, so it needs bounding rather than
    // sanitising. queryParam percent-decodes, so it arrives as the browser sent it.
    std::string filename = queryParam(req.target, "filename");
    if (filename.size() > kMaxFilenameChars)
        filename.resize(kMaxFilenameChars);

    std::string note = queryParam(req.target, "note");
    if (note.size() > 2000)
        note.resize(2000);

    const std::uint32_t ticket = sm.nextChatTicket();
    LOG_INFO("benchtest upload accepted (ticket={}, {} bytes, file={})",
             ticket, req.body.size(), filename.empty() ? "(unnamed)" : filename.c_str());
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtestUpload(ticket, req.body, filename, std::string{}, note,
                                     std::string{}));
    accepted(resp, ticket);
}

void BenchtestController::remove(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                 pz::http::HttpResponse& resp)
{
    const std::int64_t datasetId = datasetIdOf(req);
    if (datasetId == 0)
        return fill(resp, 400, R"({"error":"bad dataset id"})");

    const std::uint32_t ticket = sm.nextChatTicket();
    LOG_INFO("benchtest delete accepted (ticket={}, set={})", ticket, datasetId);
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtest(GrpcCmd::BenchtestDelete, ticket, datasetId));
    accepted(resp, ticket);
}

void BenchtestController::summary(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                  pz::http::HttpResponse& resp)
{
    const std::int64_t datasetId = datasetIdOf(req);
    if (datasetId == 0)
        return fill(resp, 400, R"({"error":"bad dataset id"})");

    const std::uint32_t ticket = sm.nextChatTicket();
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtest(GrpcCmd::BenchtestSummary, ticket, datasetId));
    accepted(resp, ticket);
}

void BenchtestController::rows(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                               pz::http::HttpResponse& resp)
{
    const std::int64_t datasetId = datasetIdOf(req);
    if (datasetId == 0)
        return fill(resp, 400, R"({"error":"bad dataset id"})");

    const std::string category = queryParam(req.target, "category");
    const std::string verdict = queryParam(req.target, "verdict");
    const std::string language = queryParam(req.target, "language");
    const std::string technique = queryParam(req.target, "technique");
    // 검사 시점 값은 "tool_event (output)" 처럼 공백과 괄호를 포함한다. validFilter는
    // 컬럼 이름을 위한 검사라 여기에 쓰면 정상 값을 거부하므로, 길이만 본다.
    const std::string checkpoint = queryParam(req.target, "checkpoint");
    if (!validFilter(category) || !validFilter(verdict) || !validFilter(language)
        || !validFilter(technique))
        return fill(resp, 400, R"({"error":"invalid filter"})");
    if (checkpoint.size() > kMaxSearchChars)
        return fill(resp, 400, R"({"error":"invalid filter"})");

    const std::string search = queryParam(req.target, "q");
    if (search.size() > kMaxSearchChars)
        return fill(resp, 400, R"({"error":"search too long"})");

    // The ordering names a column on the far side, so it is checked here the same way the filters
    // are. An unknown one falls back to the file's own order rather than refusing the table.
    const std::string orderBy = validFilter(queryParam(req.target, "sort"))
                                    ? queryParam(req.target, "sort") : std::string();

    const std::uint32_t ticket = sm.nextChatTicket();
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtestRows(ticket, datasetId, category, verdict, language, technique,
                                   checkpoint,
                                   search, intParam(req, "offset", 0), intParam(req, "limit", 50),
                                   orderBy, queryParam(req.target, "desc") == "1"));
    accepted(resp, ticket);
}

void BenchtestController::exportSet(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                    pz::http::HttpResponse& resp)
{
    const std::int64_t datasetId = datasetIdOf(req);
    if (datasetId == 0)
        return fill(resp, 400, R"({"error":"bad dataset id"})");

    const std::uint32_t ticket = sm.nextChatTicket();
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtest(GrpcCmd::BenchtestExport, ticket, datasetId));
    accepted(resp, ticket);
}

namespace
{

std::int64_t idParam(const pz::http::HttpRequest& req, const char* key)
{
    const std::string raw = queryParam(req.target, key);
    if (raw.empty())
        return 0;
    char* end = nullptr;
    const long long value = std::strtoll(raw.c_str(), &end, 10);
    if (end == raw.c_str() || (end && *end != '\0') || value <= 0)
        return 0;
    return static_cast<std::int64_t>(value);
}

}

void BenchtestController::runStart(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                   pz::http::HttpResponse& resp)
{
    const std::int64_t datasetId = datasetIdOf(req);
    if (datasetId == 0)
        return fill(resp, 400, R"({"error":"bad dataset id"})");

    const std::string category = queryParam(req.target, "category");
    const std::string verdict = queryParam(req.target, "verdict");
    const std::string language = queryParam(req.target, "language");
    const std::string technique = queryParam(req.target, "technique");
    if (!validFilter(category) || !validFilter(verdict) || !validFilter(language)
        || !validFilter(technique))
        return fill(resp, 400, R"({"error":"invalid filter"})");

    const std::string search = queryParam(req.target, "q");
    if (search.size() > kMaxSearchChars)
        return fill(resp, 400, R"({"error":"search too long"})");

    // Single-flight. pretzel-ai enforces it too, in the schema — but a console told "started"
    // for a run that was refused downstream would poll a slot that never fills.
    if (!sm.beginBenchtestRun())
        return fill(resp, 409, R"({"error":"a benchtest run is already in flight"})");

    LOG_INFO("benchtest run accepted (set={}, filter={}/{}/{}/{})",
             datasetId, category, verdict, language, technique);
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtestRun(0, datasetId, category, verdict, language, technique,
                                  search, intParam(req, "workers", 0),
                                  queryParam(req.target, "name").substr(0, 200),
                                  queryParam(req.target, "note").substr(0, 2000)));
    fill(resp, 202, json{{"started", true}}.dump());
}

void BenchtestController::runProgress(MgmtdServiceManager& sm, const pz::http::HttpRequest&,
                                      pz::http::HttpResponse& resp)
{
    const std::string& latest = sm.benchtestProgress();
    json body = latest.empty() ? json::object() : json::parse(latest, nullptr, false);
    if (body.is_discarded())
        body = json::object();
    body["running"] = sm.benchtestRunning();

    // Every case since the last poll, drained. The slot above still carries the latest message
    // for the header's totals; this is the part that must not lose anything.
    json cases = json::array();
    for (auto& one : sm.takeBenchtestCases())
    {
        json parsed = json::parse(one, nullptr, false);
        if (!parsed.is_discarded() && parsed.contains("last_case"))
            cases.push_back(parsed["last_case"]);
    }
    body["cases"] = std::move(cases);
    fill(resp, 200, body.dump());
}

void BenchtestController::runCancel(MgmtdServiceManager& sm, const pz::http::HttpRequest&,
                                    pz::http::HttpResponse& resp)
{
    LOG_INFO("benchtest run cancel requested");
    sm.txRouter().handleGrpcMessage(GrpcMessage::benchtest(GrpcCmd::BenchtestCancel, 0));
    fill(resp, 202, R"({"cancelling":true})");
}

void BenchtestController::runs(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                               pz::http::HttpResponse& resp)
{
    const std::uint32_t ticket = sm.nextChatTicket();
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtestRunRead(GrpcCmd::BenchtestRunList, ticket, 0, datasetIdOf(req),
                                      std::string{}, 0, 0, intParam(req, "limit", 50)));
    accepted(resp, ticket);
}

void BenchtestController::runInfo(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                  pz::http::HttpResponse& resp)
{
    const std::int64_t runId = idParam(req, "run");
    if (runId == 0)
        return fill(resp, 400, R"({"error":"bad run id"})");

    // The rates follow whatever the table is showing, so the scope travels with this read too.
    GrpcMessage message = GrpcMessage::benchtestRunRead(
        GrpcCmd::BenchtestRunInfo, sm.nextChatTicket(), runId);
    message.category = queryParam(req.target, "category");
    message.verdict = queryParam(req.target, "verdict");
    message.language = queryParam(req.target, "language");
    message.technique = queryParam(req.target, "technique");
    // 공백과 괄호를 포함하므로 rows() 와 같이 길이만 본다 — validFilter 는 컬럼 이름용이다.
    message.checkpoint = queryParam(req.target, "checkpoint");
    message.search = queryParam(req.target, "q");
    if (!validFilter(message.category) || !validFilter(message.verdict)
        || !validFilter(message.language) || !validFilter(message.technique)
        || message.search.size() > kMaxSearchChars
        || message.checkpoint.size() > kMaxSearchChars)
        return fill(resp, 400, R"({"error":"invalid filter"})");

    const std::uint32_t ticket = message.ticket;
    sm.txRouter().handleGrpcMessage(std::move(message));
    accepted(resp, ticket);
}

void BenchtestController::cases(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                pz::http::HttpResponse& resp)
{
    const std::int64_t runId = idParam(req, "run");
    if (runId == 0)
        return fill(resp, 400, R"({"error":"bad run id"})");

    // The cause is a scored outcome in Korean ("정탐(오분류)"), so it cannot go through
    // validFilter — that one is ASCII-only. Bounded instead, and it reaches an equality
    // comparison rather than a column name on the far side.
    const std::string cause = queryParam(req.target, "cause");
    if (cause.size() > kMaxSearchChars)
        return fill(resp, 400, R"({"error":"cause too long"})");

    const std::string category = queryParam(req.target, "category");
    const std::string verdict = queryParam(req.target, "verdict");
    const std::string language = queryParam(req.target, "language");
    const std::string technique = queryParam(req.target, "technique");
    const std::string checkpoint = queryParam(req.target, "checkpoint");
    if (!validFilter(category) || !validFilter(verdict) || !validFilter(language)
        || !validFilter(technique))
        return fill(resp, 400, R"({"error":"invalid filter"})");
    if (checkpoint.size() > kMaxSearchChars)
        return fill(resp, 400, R"({"error":"invalid filter"})");

    const std::string search = queryParam(req.target, "q");
    if (search.size() > kMaxSearchChars)
        return fill(resp, 400, R"({"error":"search too long"})");

    GrpcMessage message = GrpcMessage::benchtestRunRead(
        GrpcCmd::BenchtestCases, sm.nextChatTicket(), runId, 0, cause, 0,
        intParam(req, "offset", 0), intParam(req, "limit", 50));
    message.category = category;
    message.verdict = verdict;
    message.language = language;
    message.technique = technique;
    message.checkpoint = checkpoint;
    message.search = search;
    message.orderBy = validFilter(queryParam(req.target, "sort"))
                          ? queryParam(req.target, "sort") : std::string();
    message.descending = queryParam(req.target, "desc") == "1";

    const std::uint32_t ticket = message.ticket;
    sm.txRouter().handleGrpcMessage(std::move(message));
    accepted(resp, ticket);
}

void BenchtestController::caseDetail(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                     pz::http::HttpResponse& resp)
{
    const std::int64_t runId = idParam(req, "run");
    const std::int32_t seq = intParam(req, "seq", 0);
    if (runId == 0 || seq <= 0)
        return fill(resp, 400, R"({"error":"bad run or case"})");

    const std::uint32_t ticket = sm.nextChatTicket();
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::benchtestRunRead(GrpcCmd::BenchtestCase, ticket, runId, 0, std::string{},
                                      seq));
    accepted(resp, ticket);
}

void BenchtestController::result(MgmtdServiceManager& sm, const pz::http::HttpRequest& req,
                                 pz::http::HttpResponse& resp)
{
    const std::string raw = queryParam(req.target, "ticket");
    const auto ticket = static_cast<std::uint32_t>(std::strtoul(raw.c_str(), nullptr, 10));
    if (ticket == 0)
        return fill(resp, 400, R"({"error":"bad ticket"})");

    auto answer = sm.takeChatResult(ticket);
    if (!answer)
        return fill(resp, 200, json{{"status", "pending"}}.dump());

    json body = json::parse(*answer, nullptr, false);
    if (body.is_discarded())
        return fill(resp, 500, R"({"status":"done","error":"malformed answer from pretzel-ai"})");

    // An export's answer is a file. Unwrapped here so the browser receives the bytes with the
    // right content-type and filename, rather than a JSON envelope it would have to unpack and
    // then guess at — the download's identity belongs to the server that produced it.
    if (body.contains("content") && body.contains("filename"))
    {
        const std::string error = body.value("error", std::string());
        if (!error.empty())
            return fill(resp, 502, json{{"status", "done"}, {"error", error}}.dump());

        std::string filename = body.value("filename", std::string("benchtest.jsonl"));
        // Quotes and control characters would break out of the Content-Disposition value; the
        // name is a label from a stored row, so it is trimmed rather than rejected.
        for (char& c : filename)
            if (c == '"' || c == '\\' || static_cast<unsigned char>(c) < 0x20)
                c = '_';

        resp.status = 200;
        resp.contentType = "application/x-ndjson; charset=utf-8";
        resp.body = body.value("content", std::string());
        resp.contentDisposition = "attachment; filename=\"" + filename + "\"";
        return;
    }

    body["status"] = "done";
    fill(resp, 200, body.dump());
}

}

#include "service/web/controller/ChatController.h"

#include "service/MgmtdServiceManager.h"
#include "service/web/WebUtil.h"

#include "router/MgmtdTxRouter.h"
#include "grpc/GrpcMessage.h"

#include "db/Database.h"
#include "http/HttpMessage.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <openssl/rand.h>

#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

namespace pz::mgmtd
{

using json = nlohmann::json;

namespace
{

// A turn is a person typing, not a file upload. The cap is here rather than in pretzel-ai because a
// request this size should never have crossed the IPC socket in the first place — and IPC frames
// are bounded (IPC_MAX_FRAME_SIZE), so an oversized turn would fail as a transport error rather
// than as the "too long" the operator needs to read.
constexpr std::size_t kMaxMessageChars = 32 * 1024;

// How far back a turn may carry its own conversation. Two caps, not one: a thread grows without
// bound while the model's context does not, and the guardrail scans whatever is sent, so an
// unbounded replay is a bill and a latency problem before it is a correctness one. Oldest turns
// are dropped rather than newest — recent context is what a follow-up question depends on.
constexpr std::size_t kMaxHistoryTurns = 20;
constexpr std::size_t kMaxHistoryChars = 64 * 1024;

// One operator request, named so it can be followed across everything pretzel-ai does to satisfy
// it. Minted here rather than on the pretzel-ai side because "a request" is a fact about what a
// person asked, and only this end knows where that began: with tool calls, one request becomes
// several model calls, and pretzel-ai issues its own per-call id underneath this one.
//
// Random rather than a counter. The chat ticket is a counter and restarts with the process, which
// is fine for a value only mgmtd dereferences, and wrong for one that leaves the appliance and
// lands in someone else's scan logs beside other tenants' traffic.
std::string newTransactionId()
{
    unsigned char buf[16];
    if (RAND_bytes(buf, static_cast<int>(sizeof(buf))) != 1)
    {
        // Not fatal. The id is a tracing aid; a turn that cannot be traced is still a turn the
        // operator asked for, and refusing it would trade a real answer for a log field.
        LOG_WARN("transaction id generation failed — the turn proceeds without one");
        return {};
    }

    static const char* hex = "0123456789abcdef";
    std::string out = "txn_";
    out.reserve(4 + sizeof(buf) * 2);
    for (unsigned char c : buf)
    {
        out.push_back(hex[(c >> 4) & 0xF]);
        out.push_back(hex[c & 0xF]);
    }
    return out;
}

// The browser sends the thread it is showing. It is not trusted to send it well: a role outside
// user/assistant is dropped rather than forwarded, because a mislabelled turn replayed as the
// other party rewrites what the model believes was already said.
std::vector<GrpcMessage::Turn> parseHistory(const json& input)
{
    std::vector<GrpcMessage::Turn> out;
    const auto it = input.find("history");
    if (it == input.end() || !it->is_array())
        return out;

    std::size_t chars = 0;
    for (const auto& entry : *it)
    {
        if (!entry.is_object())
            continue;

        GrpcMessage::Turn turn;
        turn.role = entry.value("role", std::string());
        turn.content = entry.value("content", std::string());

        if (turn.content.empty() || (turn.role != "user" && turn.role != "assistant"))
            continue;
        if (turn.content.size() > kMaxMessageChars)
            continue;

        chars += turn.content.size();
        out.push_back(std::move(turn));
    }

    // Trim from the front: the cap is reached by an old conversation, and the turns that matter to
    // the question being asked now are the ones at the end.
    while (out.size() > kMaxHistoryTurns)
        out.erase(out.begin());
    while (chars > kMaxHistoryChars && !out.empty())
    {
        chars -= out.front().content.size();
        out.erase(out.begin());
    }

    return out;
}

// The signed-in account's identity, as the conversations are owned by. Empty when the session has
// gone, which is what stops a turn being filed under nobody.
std::string ownerOf(MgmtdServiceManager& sm, const pz::http::HttpRequest& req)
{
    const std::string user = sm.authService().sessionUser(sessionCookie(req));
    if (user.empty())
        return {};
    try
    {
        const auto rows = pz::db::Database::instance().queryRows(
            "SELECT oid FROM local_users WHERE username = $1 LIMIT 1", {user});
        if (!rows.empty() && !rows.front().empty())
            return rows.front()[0];
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("owner lookup failed for '{}': {}", user, ex.what());
    }
    return {};
}

// Hands a finished turn to engined, the only database writer. Both halves in one message: a turn is
// one thing, and a pair that could half-land would leave a question on screen with no answer under
// it.
void storeTurn(MgmtdServiceManager& sm, const MgmtdServiceManager::ChatContext& ctx,
               const json& answer)
{
    if (ctx.sessionOid.empty() || ctx.ownerOid.empty() || ctx.questionOid.empty())
        return;

    json question = {{"oid", ctx.questionOid},
                     {"seq", ctx.seq},
                     {"role", "user"},
                     {"content", ctx.question}};

    // On a turn that failed there is no reply, and the content is the reason — the same text the
    // live thread shows on its error card. Storing the empty reply instead left the row with
    // nothing in it, so a conversation read back later showed a question answered by a blank
    // bubble and no way to tell a blocked turn from an unreachable vendor.
    const bool answered = answer.value("ok", false);
    json reply = {{"oid", ctx.answerOid},
                  {"seq", ctx.seq + 1},
                  {"role", "assistant"},
                  {"content", answered ? answer.value("reply", std::string())
                                       : answer.value("error", std::string())},
                  {"model", answer.value("model", ctx.model)},
                  {"ok", answered},
                  {"code", answer.value("code", std::string())},
                  {"latency_ms", answer.value("latency_ms", 0)}};
    // The verdict, whole. It is most of the reason the conversation is kept at all — a blocked
    // turn's findings used to vanish with the browser that held them.
    if (answer.contains("scan"))
        reply["scan"] = answer["scan"];

    json payload = {{"session", ctx.sessionOid},
                    {"owner", ctx.ownerOid},
                    {"service", ctx.service},
                    {"title", ctx.title},
                    {"model", ctx.model},
                    {"draft", ctx.draft},
                    {"messages", json::array({std::move(question), std::move(reply)})}};

    const std::string body = payload.dump();
    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Mgmtd);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::ChatTurnStore);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(body.begin(), body.end()));
    sm.txRouter().handleIpcMessage(std::move(msg));
}

}

void ChatController::models(MgmtdServiceManager& sm, const pz::http::HttpRequest&, pz::http::HttpResponse& resp)
{
    const std::uint32_t ticket = sm.nextChatTicket();
    sm.txRouter().handleGrpcMessage(GrpcMessage::models(ticket));
    fill(resp, 202, json{{"ticket", ticket}, {"status", "pending"}}.dump());
}

void ChatController::send(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    json input;
    try
    {
        input = json::parse(req.body);
    }
    catch (const std::exception&)
    {
        return fill(resp, 400, R"({"error":"invalid JSON body"})");
    }

    const std::string message = input.value("message", std::string());
    if (message.empty())
        return fill(resp, 400, R"({"error":"message is required"})");

    if (message.size() > kMaxMessageChars)
        return fill(resp, 413, R"({"error":"message is too long"})");

    const std::string model = input.value("model", std::string());
    const std::string sessionId = input.value("session_id", std::string());
    auto history = parseHistory(input);

    const std::uint32_t ticket = sm.nextChatTicket();
    const std::string transactionId = newTransactionId();

    // Held for the poll that collects the answer. The browser sends the conversation's own fields
    // — its id, its name, what is typed and not yet sent — because those are its to know; it does
    // NOT send the owner, which is resolved from the cookie below. A client that could name the
    // owner could write into someone else's conversation.
    MgmtdServiceManager::ChatContext ctx;
    ctx.sessionOid = sessionId;
    ctx.ownerOid = ownerOf(sm, req);
    ctx.service = input.value("service", std::string("chat"));
    ctx.title = input.value("title", std::string());
    ctx.model = model;
    ctx.draft = input.value("draft", std::string());
    ctx.question = message;
    ctx.questionOid = input.value("question_oid", std::string());
    ctx.answerOid = input.value("answer_oid", std::string());
    ctx.seq = input.value("seq", 0);
    sm.setChatContext(ticket, std::move(ctx));

    // Delegated through the router, same as the old IPC path — the controller does not know or
    // care that the transport underneath is now gRPC to the pretzel-ai service. The turn is
    // fire-and-forget: the answer is filed under `ticket` when it lands (GrpcClientHandler), and
    // result() below hands it back on the next poll. No system prompt is sent; the gateway uses
    // its configured default.
    const std::size_t historyTurns = history.size();
    sm.txRouter().handleGrpcMessage(
        GrpcMessage::chat(ticket, model, message, std::string(), std::move(history), sessionId,
                          transactionId));

    // The message itself is not logged. It is whatever an employee typed, and this log is read by
    // people who have no business reading that; the ticket is enough to follow a turn through.
    // The history is not logged either, and for the same reason — only how much of it there was.
    // The transaction id IS logged, unlike the message and the history: it carries no content,
    // and it is the only way to line this log up with a scan report someone is asking about.
    LOG_DEBUG("chat turn delegated to pretzel-ai (ticket={}, model={}, chars={}, history={}, "
             "session={}, txn={})",
             ticket, model.empty() ? "default" : model, message.size(), historyTurns,
             sessionId.empty() ? "none" : sessionId,
             transactionId.empty() ? "none" : transactionId);

    fill(resp, 202, json{{"ticket", ticket}, {"status", "pending"}}.dump());
}

void ChatController::result(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    const std::string raw = queryParam(req.target, "ticket");
    const auto ticket = static_cast<std::uint32_t>(std::strtoul(raw.c_str(), nullptr, 10));

    if (ticket == 0)
        return fill(resp, 400, R"({"error":"bad ticket"})");

    // The turn is filed under its ticket by GrpcClientHandler::drain() once pretzel-ai answers;
    // until then the poll returns pending. Grounding/retrieval is no longer part of this path.
    auto result = sm.takeChatResult(ticket);
    if (!result)
    {
        // Still pending, but not necessarily silent: once the answer starts arriving the poll
        // carries what has been written so far. `text` is cumulative rather than incremental —
        // a poll can be missed or arrive out of order, and a client that appended deltas would
        // end up with a mangled answer, while one that replaces its buffer cannot.
        return fill(resp, 200, json{{"status", "pending"},
                                    {"text", sm.chatPartial(ticket)}}.dump());
    }

    json body = json::parse(*result, nullptr, false);
    if (body.is_discarded())
    {
        return fill(resp, 500, R"({"status":"done","ok":false,"code":"BAD_RESPONSE",)"
                               R"("error":"malformed answer from pretzel-ai"})");
    }

    // Filed on the way past. The browser gets the same document it always did — storing it is not
    // something it waits on, and a failure here must not cost the operator their answer.
    if (auto ctx = sm.takeChatContext(ticket))
        storeTurn(sm, *ctx, body);

    body["status"] = "done";
    fill(resp, 200, body.dump());
}

void ChatController::sessions(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    const std::string owner = ownerOf(sm, req);
    if (owner.empty())
        return fill(resp, 401, R"({"error":"unauthorized"})");

    json out = json::array();
    try
    {
        // Filtered on the owner in the query, not after it. There is no path here that reads
        // someone else's row and then decides not to return it.
        for (const auto& r : pz::db::Database::instance().queryRows(
                 "SELECT s.oid, s.service, s.title, s.model, s.draft, "
                 "       to_char(s.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF'), "
                 "       to_char(s.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF'), "
                 "       (SELECT count(*) FROM chat_message m WHERE m.session = s.oid) "
                 "FROM chat_session s WHERE s.owner = $1 ORDER BY s.updated_at DESC",
                 {owner}))
        {
            if (r.size() < 8)
                continue;
            out.push_back({{"oid", r[0]}, {"service", r[1]}, {"title", r[2]}, {"model", r[3]},
                           {"draft", r[4]}, {"created_at", r[5]}, {"updated_at", r[6]},
                           {"messages", std::strtol(r[7].c_str(), nullptr, 10)}});
        }
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("chat session list failed: {}", ex.what());
        return fill(resp, 503, R"({"error":"the conversations could not be read"})");
    }

    fill(resp, 200, json{{"sessions", std::move(out)}}.dump());
}

void ChatController::session(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    const std::string owner = ownerOf(sm, req);
    if (owner.empty())
        return fill(resp, 401, R"({"error":"unauthorized"})");

    const std::string oid = queryParam(req.target, "oid");
    if (oid.empty())
        return fill(resp, 400, R"({"error":"oid is required"})");

    json out = json::array();
    try
    {
        // The owner is joined in rather than checked afterwards: knowing a conversation's id must
        // not be enough to read it.
        for (const auto& r : pz::db::Database::instance().queryRows(
                 "SELECT m.oid, m.seq, m.role, m.content, COALESCE(m.model,''), "
                 "       COALESCE(m.ok::int::text,''), COALESCE(m.code,''), "
                 "       COALESCE(m.latency_ms::text,''), COALESCE(m.scan::text,''), "
                 "       to_char(m.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') "
                 "FROM chat_message m JOIN chat_session s ON s.oid = m.session "
                 "WHERE m.session = $1 AND s.owner = $2 ORDER BY m.seq",
                 {oid, owner}))
        {
            if (r.size() < 10)
                continue;
            json m = {{"oid", r[0]}, {"seq", std::strtol(r[1].c_str(), nullptr, 10)},
                      {"role", r[2]}, {"content", r[3]}, {"created_at", r[9]}};
            if (!r[4].empty()) m["model"] = r[4];
            if (!r[5].empty()) m["ok"] = (r[5] == "1");
            if (!r[6].empty()) m["code"] = r[6];
            if (!r[7].empty()) m["latency_ms"] = std::strtol(r[7].c_str(), nullptr, 10);
            if (!r[8].empty())
            {
                json scan = json::parse(r[8], nullptr, false);
                if (!scan.is_discarded())
                    m["scan"] = std::move(scan);
            }
            out.push_back(std::move(m));
        }
    }
    catch (const std::exception& ex)
    {
        LOG_WARN("chat message read failed: {}", ex.what());
        return fill(resp, 503, R"({"error":"the conversation could not be read"})");
    }

    fill(resp, 200, json{{"oid", oid}, {"messages", std::move(out)}}.dump());
}

void ChatController::sessionDelete(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    const std::string owner = ownerOf(sm, req);
    if (owner.empty())
        return fill(resp, 401, R"({"error":"unauthorized"})");

    json input = json::parse(req.body, nullptr, false);
    if (input.is_discarded())
        return fill(resp, 400, R"({"error":"invalid JSON body"})");

    const std::string oid = input.value("oid", std::string());
    if (oid.empty())
        return fill(resp, 400, R"({"error":"oid is required"})");

    // The owner travels with it. engined matches on both, so the check is made twice — once here
    // where the session is known, and once at the write where the row is.
    const json payload = {{"delete", true}, {"session", oid}, {"owner", owner}};
    const std::string body = payload.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Mgmtd);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::ChatTurnStore);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(body.begin(), body.end()));
    sm.txRouter().handleIpcMessage(std::move(msg));

    LOG_INFO("chat session removal handed to engined (session={})", oid);
    fill(resp, 202, json{{"oid", oid}, {"status", "pending"}}.dump());
}

void ChatController::sessionPatch(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp)
{
    const std::string owner = ownerOf(sm, req);
    if (owner.empty())
        return fill(resp, 401, R"({"error":"unauthorized"})");

    json input = json::parse(req.body, nullptr, false);
    if (input.is_discarded())
        return fill(resp, 400, R"({"error":"invalid JSON body"})");

    const std::string oid = input.value("oid", std::string());
    if (oid.empty())
        return fill(resp, 400, R"({"error":"oid is required"})");

    // A conversation with no turns yet has no row, and that is correct: it is a name on a screen
    // until someone says something. So this updates and does not create — the first turn is what
    // brings it into being.
    MgmtdServiceManager::ChatContext ctx;
    ctx.sessionOid = oid;
    ctx.ownerOid = owner;
    ctx.title = input.value("title", std::string());
    ctx.draft = input.value("draft", std::string());

    const json payload = {{"patch", true},
                          {"session", oid},
                          {"owner", owner},
                          {"title", ctx.title},
                          {"draft", ctx.draft}};
    const std::string body = payload.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Mgmtd);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::ChatTurnStore);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
    msg->setPayload(std::vector<std::uint8_t>(body.begin(), body.end()));
    sm.txRouter().handleIpcMessage(std::move(msg));

    fill(resp, 202, json{{"oid", oid}, {"status", "pending"}}.dump());
}

}

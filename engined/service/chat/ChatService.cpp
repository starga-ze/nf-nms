#include "service/chat/ChatService.h"

#include "service/EnginedServiceManager.h"
#include "service/chat/ChatEvent.h"

#include "db/Database.h"
#include "ipc/IpcMessage.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <string>

namespace pz::engined
{

namespace
{

// How long a conversation is kept after its last turn. Long enough that "the one from last month"
// is still there, short enough that an appliance holding what employees typed is not holding it
// indefinitely — which is the bargain that makes storing it at all defensible.
constexpr int kRetentionDays = 30;

// Only two things delete a conversation: the person, and this. So it does not need to run often,
// and running it on every turn would be a table scan per message.
constexpr auto kPruneInterval = std::chrono::hours(6);

std::string str(const nlohmann::json& j, const char* key)
{
    return j.contains(key) && j[key].is_string() ? j[key].get<std::string>() : std::string();
}

}

void ChatService::handleEvent(EnginedServiceManager& serviceManager, const ChatEvent& event)
{
    (void)serviceManager;
    if (event.type() != ChatEventType::ReceiveTurn)
        return;

    const auto* in = event.message();
    if (!in || in->getPayload().empty())
    {
        LOG_WARN("empty ChatTurnStore — dropping");
        return;
    }

    const auto& pl = in->getPayload();
    const std::string payload(reinterpret_cast<const char*>(pl.data()), pl.size());

    nlohmann::json root;
    try
    {
        root = nlohmann::json::parse(payload);
    }
    catch (const std::exception& e)
    {
        LOG_WARN("failed to parse ChatTurnStore payload ({}) — dropping", e.what());
        return;
    }

    if (root.value("delete", false))
        removeSession(payload);
    else if (root.value("patch", false))
        patchSession(payload);
    else
        storeTurn(payload);

    pruneIfDue();
}

void ChatService::storeTurn(const std::string& payloadJson)
{
    const auto root = nlohmann::json::parse(payloadJson, nullptr, false);
    if (root.is_discarded())
        return;

    const std::string session = str(root, "session");
    const std::string owner = str(root, "owner");
    if (session.empty() || owner.empty())
    {
        LOG_WARN("ChatTurnStore without a session or owner — dropping");
        return;
    }

    auto& db = pz::db::Database::instance();

    // The session first, so the messages have something to reference. Upserted rather than
    // inserted-once: the title and the model are settled on the first turn but the draft and the
    // timestamp move with every one, and a conversation that already exists must not be recreated.
    //
    // `owner` is written only on insert. It is mgmtd's answer to "who is signed in", and an UPDATE
    // that took it from a later message would let a second person's turn re-home someone's
    // conversation onto themselves.
    const bool sessionOk = db.exec(
        "INSERT INTO chat_session (oid, owner, service, title, model, draft, updated_at) "
        "VALUES ($1, $2, $3, $4, $5, $6, now()) "
        "ON CONFLICT (oid) DO UPDATE SET "
        "  title = EXCLUDED.title, model = EXCLUDED.model, draft = EXCLUDED.draft, "
        "  updated_at = now()",
        {session, owner, str(root, "service"), str(root, "title"), str(root, "model"),
         str(root, "draft")});

    if (!sessionOk)
    {
        // Almost always the owner: a turn for an account that has since been removed. Dropped
        // rather than retried — there is nobody for it to belong to.
        LOG_WARN("chat_session write failed (session={}) — the turn is not stored", session);
        return;
    }

    int stored = 0;
    for (const auto& m : root.value("messages", nlohmann::json::array()))
    {
        if (!m.is_object())
            continue;

        const std::string oid = str(m, "oid");
        if (oid.empty())
            continue;

        // A message is written once. mgmtd files a turn when pretzel-ai answers, and a retry that
        // arrived twice must not double the conversation.
        //
        // DO NOTHING with no conflict target on purpose: chat_message has TWO unique constraints,
        // the oid primary key and UNIQUE (session, seq). Naming only the oid left the second one
        // to raise, so a retry that re-used a seq under a fresh oid failed the insert instead of
        // being absorbed - and a failed insert here loses that half-turn silently, which is how a
        // conversation ends up with a question and no answer.
        const bool ok = db.exec(
            "INSERT INTO chat_message "
            "  (oid, session, seq, role, content, model, ok, code, latency_ms, scan) "
            "VALUES ($1, $2, $3::int, $4, $5, NULLIF($6,''), "
            "        CASE WHEN $7 = '' THEN NULL ELSE $7::boolean END, "
            "        NULLIF($8,''), CASE WHEN $9 = '' THEN NULL ELSE $9::int END, "
            "        CASE WHEN $10 = '' THEN NULL ELSE $10::jsonb END) "
            "ON CONFLICT DO NOTHING",
            {oid, session, std::to_string(m.value("seq", 0)), str(m, "role"), str(m, "content"),
             str(m, "model"),
             m.contains("ok") && m["ok"].is_boolean() ? (m["ok"].get<bool>() ? "true" : "false") : "",
             str(m, "code"),
             m.contains("latency_ms") && m["latency_ms"].is_number()
                 ? std::to_string(m["latency_ms"].get<int>()) : "",
             m.contains("scan") && !m["scan"].is_null() ? m["scan"].dump() : ""});
        if (ok)
            ++stored;
        else
            LOG_WARN("chat_message write failed (session={}, oid={})", session, oid);
    }

    // The content is never logged. It is whatever an employee typed, and this log is read by
    // people who have no business reading it — the same rule ChatController follows on the way in.
    LOG_INFO("chat turn stored (session={}, messages={})", session, stored);
}

void ChatService::removeSession(const std::string& payloadJson)
{
    const auto root = nlohmann::json::parse(payloadJson, nullptr, false);
    if (root.is_discarded())
        return;

    const std::string session = str(root, "session");
    const std::string owner = str(root, "owner");
    if (session.empty() || owner.empty())
    {
        LOG_WARN("chat session delete without a session or owner — dropping");
        return;
    }

    // Matched on the owner as well as the id. mgmtd checks it too, and this is the second lock on
    // the same door: knowing a conversation's id must not be enough to delete someone else's.
    // The messages go with it — chat_message references this ON DELETE CASCADE.
    if (pz::db::Database::instance().exec(
            "DELETE FROM chat_session WHERE oid = $1 AND owner = $2", {session, owner}))
        LOG_INFO("chat session removed (session={})", session);
    else
        LOG_WARN("chat session delete failed (session={})", session);
}

// The fields a conversation carries that are not a turn: its name, and what is typed and not yet
// sent. An UPDATE and not an upsert — a conversation with no turns yet has no row, and that is
// correct: it is a name on a screen until someone says something, and the first turn is what brings
// it into being.
void ChatService::patchSession(const std::string& payloadJson)
{
    const auto root = nlohmann::json::parse(payloadJson, nullptr, false);
    if (root.is_discarded())
        return;

    const std::string session = str(root, "session");
    const std::string owner = str(root, "owner");
    if (session.empty() || owner.empty())
        return;

    // Matched on the owner as well as the id, same as the delete: knowing an id must not be enough
    // to rename someone else's conversation.
    //
    // `updated_at` is deliberately NOT touched. Typing into a conversation is not talking in it,
    // and letting a draft push the retention window out would keep a conversation alive on the
    // strength of an unsent sentence.
    pz::db::Database::instance().exec(
        "UPDATE chat_session SET title = $3, draft = $4 WHERE oid = $1 AND owner = $2",
        {session, owner, str(root, "title"), str(root, "draft")});
}

void ChatService::pruneIfDue()
{
    const auto now = std::chrono::steady_clock::now();
    if (m_lastPrune.time_since_epoch().count() != 0 && now - m_lastPrune < kPruneInterval)
        return;

    m_lastPrune = now;   // set first: a failing sweep must not retry on every subsequent turn
    prune();
}

void ChatService::prune()
{
    // On `updated_at`, not `created_at`: a conversation someone came back to last week is not a
    // month old, whatever day it started on. The messages go with it by cascade.
    pz::db::Database::instance().exec(
        "DELETE FROM chat_session WHERE updated_at < now() - ($1 || ' days')::interval",
        {std::to_string(kRetentionDays)});

    LOG_DEBUG("chat sessions pruned (retention={}d)", kRetentionDays);
}

}

#include "db/Database.h"

#include <iostream>
#include <libpq-fe.h>

namespace pz::db
{

namespace
{

constexpr const char* kSchemaDDL = R"SQL(
CREATE TABLE IF NOT EXISTS startup_config (
    oid         INT PRIMARY KEY DEFAULT 1 CHECK (oid = 1),
    config_json JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS running_config (
    oid          BIGSERIAL   PRIMARY KEY,
    version      BIGINT      NOT NULL UNIQUE,
    config_json  JSONB       NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    state        TEXT        NOT NULL DEFAULT 'active'
        CONSTRAINT running_config_state_check CHECK (state IN ('pending','active','superseded'))
);
-- The local accounts' secrets. Which accounts exist is declared in running_config
-- (pretzel.user.list) and this holds only what proves one, keyed by the same oid.
--
--   username  the login handle. Primary key because it is what someone types and what every read
--             here is by. It is NOT an identity: a name can be given up and taken by someone else.
--   oid       the identity. Issued once at creation, never updated, and what durable ownership —
--             a person's assistant conversations — is keyed on.
CREATE TABLE IF NOT EXISTS local_users (
    username      TEXT PRIMARY KEY,
    oid           TEXT NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    -- True only for the account the seeder creates, and only until someone signs in as it and
    -- replaces the factory password. An account made from the console is never in this state:
    -- a forced change is what "this appliance has not been set up" looks like, and it would mean
    -- nothing if a routine account creation raised it too.
    must_change   BOOLEAN NOT NULL DEFAULT false,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ── Config vs state ─────────────────────────────────────────────────────────────
-- running_config holds what the OPERATOR declared: sites, devices, API keys, endpoints,
-- connectors. It is append-versioned, diffed before publish and revertable, so only things a
-- human authored belong in it.
--
-- Everything the SYSTEM produces lives in the tables below instead — issued API keys, expiry,
-- probe status, test outcomes. Writing those into running_config would mint a new configuration
-- version every time a key was re-issued or a probe answered, and would show machine noise in
-- the operator's review diff. engined is the single writer for all of them.

-- Devices projected from running_config, plus live reachability. A pure projection (rebuilt
-- from config on every reload). NGFW and SASE are separate tables (the table IS the type, no
-- device_type discriminator); each row mixes projected config fields with runtime state.
CREATE TABLE IF NOT EXISTS api_credential_state (
    oid            TEXT PRIMARY KEY,
    id_enc         TEXT,
    pw_enc         TEXT,
    key_enc     TEXT,
    issued_at      TIMESTAMPTZ,
    expires_at     TIMESTAMPTZ,
    last_test_at   TIMESTAMPTZ,
    last_test_ok   BOOLEAN,
    last_test_note TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_provider_credential_state (
    id             TEXT PRIMARY KEY,
    key_enc        TEXT,            -- AES-256-GCM, base64(nonce ‖ tag ‖ ciphertext)
    last_test_at   TIMESTAMPTZ,
    last_test_ok   BOOLEAN,
    last_test_note TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The guardrail's API key, sealed the same way and for the same reasons as the providers' above.
--
-- Its own table rather than a reserved id in that one. The two are the same shape and could have
-- shared, but they are not the same kind of thing: a provider row is one of a set an operator adds
-- to and removes from, and the guardrail is a single fact about this appliance — there is one scan
-- service, and a second row here would not mean anything. Sharing would also have made every query
-- that means "the vendors" carry a filter to exclude the one row that is not a vendor, which is the
-- shape of bug that gets written once and found much later.
--
-- Two rows at most, and the check says which: 'airs' is the scan service's subscription, 'portkey'
-- the AI gateway's. Both are configured on the same console page and both are a single fact about
-- this appliance rather than one of a set, which is what separates them from the vendors next door.
-- Enumerated rather than left open so a caller that thought it was writing a keyed store cannot
-- invent a third id nothing downstream reads.
CREATE TABLE IF NOT EXISTS ai_guardrail_credential_state (
    id             TEXT PRIMARY KEY CHECK (id IN ('airs', 'portkey')),
    key_enc        TEXT,            -- AES-256-GCM, base64(nonce ‖ tag ‖ ciphertext)
    last_test_at   TIMESTAMPTZ,
    last_test_ok   BOOLEAN,
    last_test_note TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API collection samples: what each connector's scheduled endpoint poll returned. Pure state
-- (system-produced, never operator-declared), written only by engined from collectord's IPC — the same
-- config-vs-state split that keeps issued keys out of running_config. Raw response + call metadata
-- now; structured metric extraction is a later analytics layer that reads these rows back.
--   connector_oid/endpoint_oid : which connector schedule, and which of its endpoints, this is from
--   ok        : the poll produced a usable response (HTTP 200)
--   body      : the response, capped; oversized replies are cut and `truncated` is set
--   body_aged : the row is past the body-retention window and its payload has been released. Says
--               "there WAS a body, it is gone" — which a bare NULL cannot, since a failed poll
--               legitimately has no body at all. See CollectionService::prune.
CREATE TABLE IF NOT EXISTS api_collection (
    oid           BIGSERIAL   PRIMARY KEY,
    connector_oid TEXT        NOT NULL,
    endpoint_oid  TEXT        NOT NULL,
    collected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ok            BOOLEAN     NOT NULL,
    http_status   INT,
    latency_ms    INT,
    bytes         INT,
    truncated     BOOLEAN     NOT NULL DEFAULT false,
    body          TEXT,
    error         TEXT,
    body_aged     BOOLEAN     NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS api_collection_conn_time ON api_collection (connector_oid, collected_at DESC);
CREATE INDEX IF NOT EXISTS api_collection_endpoint_time ON api_collection (endpoint_oid, collected_at DESC);
-- The Insight ▸ API Collection read path and the body-retention sweep both address ONE stream
-- (connector + endpoint) newest-first; neither single-column index above serves that without a
-- filter-and-sort over the whole connector's history.
CREATE INDEX IF NOT EXISTS api_collection_stream_time
    ON api_collection (connector_oid, endpoint_oid, collected_at DESC);

-- The assistant's conversations.
--
-- They lived in the operator's browser until now (localStorage), which meant they were lost on
-- logout, invisible from a second machine, and capped by a browser quota. None of those are
-- properties anyone chose; they were what "we have not built this yet" looked like.
--
-- State, not configuration: system-produced, never operator-declared, so it lives here rather than
-- in running_config — the same split that keeps issued API keys out of the versioned document.
--
-- Owned by `local_users.oid` and NOT by the username. A name can be given up and taken by someone
-- else, and anything owned by "kim" would then belong to whoever is called kim next. The oid is
-- issued once at account creation and never updated, which is what makes it safe to own things by.
--
-- What deletes a conversation: the person deletes it, or it passes the retention window. Signing
-- out does not, and that is the whole point of it being here.
CREATE TABLE IF NOT EXISTS chat_session (
    oid        TEXT        PRIMARY KEY,   -- minted by the browser, like every other object here
    owner      TEXT        NOT NULL REFERENCES local_users(oid) ON DELETE CASCADE,
    service    TEXT        NOT NULL,      -- 'chat' | 'agent'
    title      TEXT        NOT NULL DEFAULT '',
    model      TEXT        NOT NULL DEFAULT '',
    draft      TEXT        NOT NULL DEFAULT '',  -- what is typed and not yet sent
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The rail lists a person's conversations newest-first and reads no messages to do it.
CREATE INDEX IF NOT EXISTS chat_session_owner ON chat_session (owner, updated_at DESC);

-- One row per half-turn: what was asked, and what came back.
--
-- `scan` is the AIRS verdict, whole. It is most of the reason this table exists — a blocked turn's
-- findings used to disappear with the browser that held them, which made the one turn worth going
-- back to the one that could not be.
CREATE TABLE IF NOT EXISTS chat_message (
    oid        TEXT        PRIMARY KEY,
    session    TEXT        NOT NULL REFERENCES chat_session(oid) ON DELETE CASCADE,
    seq        INTEGER     NOT NULL,
    role       TEXT        NOT NULL,      -- 'user' | 'assistant'
    content    TEXT        NOT NULL,
    model      TEXT,                      -- which model answered THIS turn
    ok         BOOLEAN,                   -- assistant rows only
    code       TEXT,                      -- BLOCKED, UNREACHABLE, …
    latency_ms INTEGER,
    scan       JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session, seq)
);
CREATE INDEX IF NOT EXISTS chat_message_session ON chat_message (session, seq);

-- System logs: a structured, queryable copy of each daemon's spdlog file. engined tails the rotating
-- log files from a checkpoint (system_log_offset) and batch-inserts parsed rows here — the files stay
-- as local durability, this table is the index the web UI reads. All parsing, ANSI stripping and
-- multi-line folding happens once at ingest, so the frontend renders clean rows without parsing logs.
--   level : spdlog severity — 0=trace 1=debug 2=info 3=warn 4=error 5=critical
CREATE TABLE IF NOT EXISTS system_log (
    oid     BIGSERIAL   PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL,
    daemon  TEXT        NOT NULL,
    level   SMALLINT    NOT NULL,
    loc     TEXT,
    message TEXT        NOT NULL
);
-- Reads are always "newest first, filtered": keyset-paginate on oid DESC, optionally narrowed by
-- daemon or severity. oid order matches insert (hence time) order, so it doubles as the paging cursor.
CREATE INDEX IF NOT EXISTS system_log_oid        ON system_log (oid DESC);
CREATE INDEX IF NOT EXISTS system_log_daemon_oid ON system_log (daemon, oid DESC);
CREATE INDEX IF NOT EXISTS system_log_level_oid  ON system_log (level, oid DESC);

-- Tailer checkpoint: how far into each daemon's current log file engined has already ingested.
-- inode detects rotation (spdlog renames the base file, so a new inode appears) — on mismatch the
-- offset resets to 0 instead of skipping the fresh file; a size < offset (truncation) resets too.
CREATE TABLE IF NOT EXISTS system_log_offset (
    daemon     TEXT        PRIMARY KEY,
    inode      BIGINT      NOT NULL,
    offset_b   BIGINT      NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The declaration of a seeded account, which the seeder cannot write itself.
--
-- Not a migration. seedStore() writes running_config from startup-config.json and only then seeds
-- the default admin into local_users — so at the moment the document is written there is no account
-- to declare, and a fresh appliance would come up with an admin nobody can see or edit. This runs
-- afterwards, on every preflight, and is a no-op once the domain exists.
DO $migrate$
BEGIN
    -- Which accounts exist is declared in running_config (pretzel.user.list) and local_users holds
    -- only what proves one. Seeded from the table, so the declaration names whatever the seeder
    -- created, and guarded on the domain's absence so an operator's later edits are never touched.
    --
    -- The seeded account is an admin: it is the only way in on a fresh appliance, and an appliance
    -- whose first account could not manage accounts would have no way to make a second one.
    UPDATE running_config SET config_json =
        jsonb_set(config_json, '{pretzel,user}',
                  jsonb_build_object('list', COALESCE(
                      (SELECT jsonb_agg(jsonb_build_object('oid', u.oid, 'username', u.username,
                                                           'role', 'admin')
                              ORDER BY u.username)
                         FROM local_users u), '[]'::jsonb)), true)
        WHERE NOT (config_json #> '{pretzel}' ? 'user');

    -- A declared account with no role. Roles arrived after the declaration did, and before them
    -- every account had full access — so the honest reading of an absent role is the one that takes
    -- nothing away, and an operator demotes from the console. The alternative, defaulting to the
    -- lesser role, would sign the appliance's only admin out of account management on upgrade.
    UPDATE running_config SET config_json =
        jsonb_set(config_json, '{pretzel,user,list}',
                  (SELECT COALESCE(jsonb_agg(
                              CASE WHEN u ? 'role' THEN u
                                   ELSE u || jsonb_build_object('role', 'admin') END), '[]'::jsonb)
                     FROM jsonb_array_elements(config_json #> '{pretzel,user,list}') AS u), true)
        WHERE jsonb_path_exists(config_json, '$.pretzel.user.list[*] ? (!exists(@.role))');
END $migrate$;
)SQL";

std::vector<const char*> toParamPtrs(const std::vector<std::string>& params)
{
    std::vector<const char*> ptrs;
    ptrs.reserve(params.size());
    for (const auto& p : params)
        ptrs.push_back(p.c_str());
    return ptrs;
}

}

Database& Database::instance()
{
    static Database s_instance;
    return s_instance;
}

Database::~Database()
{
    if (m_conn)
    {
        PQfinish(m_conn);
        m_conn = nullptr;
    }
}

bool Database::connect(const ConnParams& params)
{
    m_params = params;
    m_haveParams = true;

    return ensureLive();
}

bool Database::isConnected()
{
    return m_conn && PQstatus(m_conn) == CONNECTION_OK;
}

bool Database::ensureLive()
{
    if (!m_haveParams)
        return false;

    if (m_conn)
    {
        if (PQstatus(m_conn) == CONNECTION_OK)
            return true;

        PQreset(m_conn);
        if (PQstatus(m_conn) == CONNECTION_OK)
            return true;

        PQfinish(m_conn);
        m_conn = nullptr;
    }

    const char* keywords[] = {"host", "port", "dbname", "user", "password", nullptr};
    const char* values[] = {m_params.host.c_str(), m_params.port.c_str(),     m_params.name.c_str(),
                            m_params.user.c_str(), m_params.password.c_str(), nullptr};

    m_conn = PQconnectdbParams(keywords, values, 0);

    if (PQstatus(m_conn) != CONNECTION_OK)
    {
        std::cerr << "db: connection failed: " << PQerrorMessage(m_conn);
        PQfinish(m_conn);
        m_conn = nullptr;
        return false;
    }

    PQsetNoticeProcessor(
        m_conn, [](void*, const char*) {}, nullptr);

    return true;
}

bool Database::ensureSchema()
{
    if (!ensureLive())
        return false;

    PGresult* res = PQexec(m_conn, kSchemaDDL);
    const bool ok = res && PQresultStatus(res) == PGRES_COMMAND_OK;
    if (!ok)
        std::cerr << "db: ensureSchema failed: " << PQerrorMessage(m_conn);
    PQclear(res);
    return ok;
}

bool Database::exec(const std::string& sql, const std::vector<std::string>& params)
{
    if (!ensureLive())
        return false;

    const auto ptrs = toParamPtrs(params);

    PGresult* res = PQexecParams(m_conn, sql.c_str(), static_cast<int>(params.size()), nullptr,
                                 ptrs.empty() ? nullptr : ptrs.data(), nullptr, nullptr, 0);

    const ExecStatusType st = res ? PQresultStatus(res) : PGRES_FATAL_ERROR;
    const bool ok = (st == PGRES_COMMAND_OK || st == PGRES_TUPLES_OK);
    if (!ok)
        std::cerr << "db: exec failed: " << PQerrorMessage(m_conn);
    PQclear(res);
    return ok;
}

std::optional<std::string> Database::queryScalar(const std::string& sql, const std::vector<std::string>& params)
{
    if (!ensureLive())
        return std::nullopt;

    const auto ptrs = toParamPtrs(params);

    PGresult* res = PQexecParams(m_conn, sql.c_str(), static_cast<int>(params.size()), nullptr,
                                 ptrs.empty() ? nullptr : ptrs.data(), nullptr, nullptr, 0);

    std::optional<std::string> out;
    if (res && PQresultStatus(res) == PGRES_TUPLES_OK && PQntuples(res) > 0 && PQnfields(res) > 0 &&
        !PQgetisnull(res, 0, 0))
    {
        out = std::string(PQgetvalue(res, 0, 0));
    }
    else if (!res || PQresultStatus(res) != PGRES_TUPLES_OK)
    {
        std::cerr << "db: queryScalar failed: " << PQerrorMessage(m_conn);
    }
    PQclear(res);
    return out;
}

std::vector<std::vector<std::string>> Database::queryRows(const std::string& sql,
                                                          const std::vector<std::string>& params)
{
    std::vector<std::vector<std::string>> rows;

    if (!ensureLive())
        return rows;

    const auto ptrs = toParamPtrs(params);

    PGresult* res = PQexecParams(m_conn, sql.c_str(), static_cast<int>(params.size()), nullptr,
                                 ptrs.empty() ? nullptr : ptrs.data(), nullptr, nullptr, 0);

    if (res && PQresultStatus(res) == PGRES_TUPLES_OK)
    {
        const int nRows = PQntuples(res);
        const int nCols = PQnfields(res);
        rows.reserve(nRows);
        for (int r = 0; r < nRows; ++r)
        {
            std::vector<std::string> row;
            row.reserve(nCols);
            for (int c = 0; c < nCols; ++c)
                row.emplace_back(PQgetisnull(res, r, c) ? "" : PQgetvalue(res, r, c));
            rows.push_back(std::move(row));
        }
    }
    else
    {
        std::cerr << "db: queryRows failed: " << PQerrorMessage(m_conn);
    }
    PQclear(res);
    return rows;
}

}

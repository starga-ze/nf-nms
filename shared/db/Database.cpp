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
-- Upgrade path for databases created before running_config.state existed (config-
-- version convergence: 'pending' on commit, 'active' once the fleet has converged).
ALTER TABLE running_config ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active';
DO $rc_state$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'running_config_state_check') THEN
        ALTER TABLE running_config
            ADD CONSTRAINT running_config_state_check CHECK (state IN ('pending','active','superseded'));
    END IF;
END $rc_state$;
-- Identity-column naming: every configuration object has exactly ONE identity, `oid` — a UUID
-- string issued at creation. Rename pre-existing `id` columns on the persistent tables
-- (projections are drop+recreated).
DO $rename_oid$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'startup_config' AND column_name = 'id') THEN
        ALTER TABLE startup_config RENAME COLUMN id TO oid;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'running_config' AND column_name = 'id') THEN
        ALTER TABLE running_config RENAME COLUMN id TO oid;
    END IF;
END $rename_oid$;
-- Single-identity merge: objects used to carry `uuid` plus a separate numeric `oid`. Fold uuid
-- into oid and drop the numeric one across every persisted version and the baseline.
DO $merge_oid$
DECLARE
    tbl  TEXT;
    spec TEXT;
    path TEXT[];
BEGIN
    FOREACH tbl IN ARRAY ARRAY['running_config', 'startup_config'] LOOP
        FOREACH spec IN ARRAY ARRAY['probed.service.probe.probe_targets',
                                    'collectord.service.api.auth_profiles',
                                    'collectord.service.api.connectors',
                                    'engined.service.site.sites'] LOOP
            path := string_to_array(spec, '.');
            EXECUTE format($fmt$
                UPDATE %I SET config_json = jsonb_set(config_json, %L, (
                    SELECT COALESCE(jsonb_agg(
                        CASE WHEN elem ? 'uuid'
                             THEN (elem - 'uuid') || jsonb_build_object('oid', elem->'uuid')
                             ELSE elem END), '[]'::jsonb)
                    FROM jsonb_array_elements(config_json #> %L) AS elem))
                WHERE jsonb_typeof(config_json #> %L) = 'array'
                  AND EXISTS (SELECT 1 FROM jsonb_array_elements(config_json #> %L) AS e
                              WHERE e ? 'uuid')
            $fmt$, tbl, path, path, path, path);
        END LOOP;
    END LOOP;
END $merge_oid$;
-- Local login accounts (operator credentials), stored hashed. A non-versioned store
-- (NOT running_config) so password changes don't pollute the config version history.
-- Keyed by username so it extends to multiple local users / a future CLI daemon.
DROP TABLE IF EXISTS admin_user;
CREATE TABLE IF NOT EXISTS local_users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    must_change   BOOLEAN NOT NULL DEFAULT true,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Legacy tables removed: probe_devices (mixed ICMP status + discovered SNMP/interface/
-- LLDP data) and state_snapshot (heartbeat snapshot that was written but never read).
DROP TABLE IF EXISTS probe_devices;
DROP TABLE IF EXISTS state_snapshot;
-- device_credentials was an abandoned first pass at the encrypted credential store: no DDL, no
-- reader, no writer, and it survived every reset because nothing listed it. It held cipher text
-- nothing could decrypt, so it goes. api_credential_state/api_endpoint_state were declared before they
-- had a writer; see the note further down.
DROP TABLE IF EXISTS device_credentials;
DROP TABLE IF EXISTS api_endpoint_state;
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
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS devices;
CREATE TABLE IF NOT EXISTS ngfw_device (
    oid         TEXT PRIMARY KEY,
    site        TEXT,
    target      TEXT,
    name        TEXT,
    description TEXT,
    fingerprint TEXT,
    status      TEXT,
    last_seen   TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ngfw_device_target_uniq ON ngfw_device (target)
    WHERE target IS NOT NULL AND target <> '';
CREATE TABLE IF NOT EXISTS sase_device (
    oid           TEXT PRIMARY KEY,
    site          TEXT,
    target        TEXT,
    name          TEXT,
    description   TEXT,
    health_url    TEXT,
    health_body   TEXT,
    api_key_enc   TEXT,
    status        TEXT,
    last_seen     TIMESTAMPTZ,
    egress_result JSONB,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sase_device_target_uniq ON sase_device (target)
    WHERE target IS NOT NULL AND target <> '';
DO $split_devices$
DECLARE tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['running_config', 'startup_config'] LOOP
        EXECUTE format($fmt$
            UPDATE %I SET config_json = jsonb_set(
                jsonb_set(
                    config_json #- '{engined,service,site,devices}',
                    '{engined,service,site,ngfw_devices}',
                    COALESCE((SELECT jsonb_agg(e - 'device_type')
                              FROM jsonb_array_elements(config_json #> '{engined,service,site,devices}') e
                              WHERE e->>'device_type' IS DISTINCT FROM 'sase'), '[]'::jsonb)),
                '{engined,service,site,sase_devices}',
                COALESCE((SELECT jsonb_agg((e - 'device_type') - 'api_key')
                          FROM jsonb_array_elements(config_json #> '{engined,service,site,devices}') e
                          WHERE e->>'device_type' = 'sase'), '[]'::jsonb))
            WHERE config_json #> '{engined,service,site}' ? 'devices'
        $fmt$, tbl);
    END LOOP;
END $split_devices$;

-- What pretzel learns about a device API key, as opposed to what the operator declared. The
-- declaration (name, device, endpoint, account) lives in running_config; the issued secret and
-- its verification history live here, because running_config is append-versioned, shown verbatim
-- in the review diff and exported by Save-to-file — a key written there would be permanent,
-- readable by every reviewer, and would mint a configuration version each time it was re-issued.
-- Same reasoning that keeps admin passwords in local_users.
--
-- Written only by engined; the values arrive already sealed over IPC (collectord seals them with
-- /etc/pretzel/credentials.key, the one process that holds a plaintext credential). Keyed by the
-- API Key oid. A single schema serves both device types: for ngfw the durable secret is the issued
-- key; for sase it is the tenant OAuth credential (the bearer token stays ephemeral in memory).
--   id_enc     : account identity  — ngfw username / sase client id     (AES-256-GCM, base64)
--   pw_enc     : account secret    — ngfw password / sase client secret (AES-256-GCM, base64)
--   key_enc : issued key/token  — AES-256-GCM, base64(nonce ‖ tag ‖ ciphertext). A database copy
--                without credentials.key is useless.
--   expires_at : NULL means no expiry — PAN-OS keys are indefinite unless an API key lifetime is
--                configured on the device.
-- Rename from the pre-"credential" table name, preserving rows, before the CREATE below no-ops.
DO $rename_credstate$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'api_key_state')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'api_credential_state') THEN
        ALTER TABLE api_key_state RENAME TO api_credential_state;
    END IF;
END $rename_credstate$;
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
-- Upgrade path for databases created before the credential columns existed.
ALTER TABLE api_credential_state ADD COLUMN IF NOT EXISTS id_enc TEXT;
ALTER TABLE api_credential_state ADD COLUMN IF NOT EXISTS pw_enc TEXT;
DO $rename_keyenc$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'api_credential_state' AND column_name = 'secret_enc')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'api_credential_state' AND column_name = 'key_enc') THEN
        ALTER TABLE api_credential_state RENAME COLUMN secret_enc TO key_enc;
    END IF;
END $rename_keyenc$;

-- Renamed from ai_gateway_credential_state: it never held a gateway's credential in production,
-- and once the assistant became "one row per AI provider" the old name described an arrangement
-- that no longer existed. Guarded so an upgrade renames and a fresh install just creates.
DO $rename_ai_cred$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_name = 'ai_gateway_credential_state')
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_name = 'ai_provider_credential_state') THEN
        ALTER TABLE ai_gateway_credential_state RENAME TO ai_provider_credential_state;
    END IF;
END $rename_ai_cred$;

-- The AI providers' API keys, sealed. Same reasoning that keeps issued device keys out of
-- running_config: a key is the customer's own vendor subscription, it is re-issued and rotated on
-- its own schedule, and running_config is append-versioned, shown verbatim in the review diff and
-- written out by Save-to-file — a key there would be permanent and readable by every reviewer, and
-- rotating it would mint a configuration version.
--
-- What DOES live in running_config is the declaration around it: which vendors are configured and
-- which of their models this appliance may ask for. Those are choices an operator makes and
-- should see diffed; this table holds only the secret and the record of whether it last worked.
--
-- One row per provider — 'openai', 'google', 'anthropic' — because a key is issued by the vendor
-- and works for every model they serve. Keyed rather than a singleton so a fourth vendor does not
-- need a schema change to sit beside the first three.
--
-- Written only by engined, and the value arrives already sealed: mgmtd seals it with
-- /etc/pretzel/credentials.key, exactly as collectord does for device credentials, so the plaintext
-- crosses the socket once on entry and never on use.
CREATE TABLE IF NOT EXISTS ai_provider_credential_state (
    id             TEXT PRIMARY KEY,
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
ALTER TABLE api_collection ADD COLUMN IF NOT EXISTS body_aged BOOLEAN NOT NULL DEFAULT false;
-- Time-series read paths: latest samples for a connector, and one endpoint's history.
CREATE INDEX IF NOT EXISTS api_collection_conn_time ON api_collection (connector_oid, collected_at DESC);
CREATE INDEX IF NOT EXISTS api_collection_endpoint_time ON api_collection (endpoint_oid, collected_at DESC);
-- The Insight ▸ API Collection read path and the body-retention sweep both address ONE stream
-- (connector + endpoint) newest-first; neither single-column index above serves that without a
-- filter-and-sort over the whole connector's history.
CREATE INDEX IF NOT EXISTS api_collection_stream_time
    ON api_collection (connector_oid, endpoint_oid, collected_at DESC);

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

-- One-time config-json normalizations (idempotent; run by engined via Config::preflight).
DO $migrate$
BEGIN
    -- Daemon rename (snmpd -> collectord): move the top-level config section so the renamed
    -- daemon finds its settings across every running_config version and the startup_config
    -- baseline. Idempotent — once moved, the `? 'snmpd'` guard is false.
    UPDATE running_config SET config_json =
        (config_json - 'snmpd') || jsonb_build_object('collectord', config_json->'snmpd')
        WHERE config_json ? 'snmpd';
    UPDATE startup_config SET config_json =
        (config_json - 'snmpd') || jsonb_build_object('collectord', config_json->'snmpd')
        WHERE config_json ? 'snmpd';
    -- Drop the dead ipcd.service.daemon_map: routing uses the compiled IpcDaemon enum,
    -- never this config key. Strip the stale nested key from every persisted version.
    UPDATE running_config SET config_json = config_json #- '{ipcd,service,daemon_map}'
        WHERE config_json #> '{ipcd,service}' ? 'daemon_map';
    UPDATE startup_config SET config_json = config_json #- '{ipcd,service,daemon_map}'
        WHERE config_json #> '{ipcd,service}' ? 'daemon_map';
    -- API key -> credential rename: move collectord.service.api.api_keys to .api_credentials in every
    -- persisted version and the baseline. Idempotent — once moved, the `? 'api_keys'` guard is false.
    UPDATE running_config SET config_json =
        jsonb_set(config_json, '{collectord,service,api,api_credentials}', config_json #> '{collectord,service,api,api_keys}', true)
            #- '{collectord,service,api,api_keys}'
        WHERE config_json #> '{collectord,service,api}' ? 'api_keys';
    UPDATE startup_config SET config_json =
        jsonb_set(config_json, '{collectord,service,api,api_credentials}', config_json #> '{collectord,service,api,api_keys}', true)
            #- '{collectord,service,api,api_keys}'
        WHERE config_json #> '{collectord,service,api}' ? 'api_keys';
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

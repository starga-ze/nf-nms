#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace pz::ipc
{

inline constexpr std::uint8_t IPC_PROTOCOL_VERSION = 2;
inline constexpr std::size_t IPC_MAX_FRAME_SIZE = 1024 * 1024;

enum class IpcDaemon : std::uint8_t
{
    Unknown = 0,
    Ipcd = 1,
    Engined = 2,
    Authd = 3,
    Probed = 4,
    Collectord = 5,
    Topologyd = 6,
    Mgmtd = 7,
    Apid = 8,
    // 9 (Inferd) and 10 (Ragd) retired. Inference was an IPC daemon of ours until it moved out to
    // the standalone pretzel-ai service, which is reached over gRPC and is not on this fabric at
    // all; retrieval was briefly a daemon of its own before that, and folded into inference because
    // embedding a query and answering from it are one concern. Both values are kept spent rather
    // than reused: ids are a wire contract, and handing 9 to a future daemon would make an old
    // peer's frames route to it silently instead of being rejected.

    Broadcast = 255
};

enum class IpcCmd : std::uint16_t
{
    Unknown = 0,

    // ── Lifecycle (transport): handshake, config sync, runtime orchestration, transport error ──
    ClientHello = 1,
    ServerHello = 2,
    SyncRequest = 3,
    SyncResponse = 4,
    RuntimeReady = 5,
    RuntimeStart = 6,
    Error = 102,

    // ── Heartbeat (engined ↔ every daemon liveness) ──
    HeartbeatRequest = 104,
    HeartbeatResponse = 105,
    HeartbeatResult = 106,

    // ── Config distribution (engined authors and fans out) ──
    // Was ConfigReload. One-way broadcast that tells every daemon to apply the newly committed
    // config. engined, ipcd and mgmtd are deliberately not among the destinations: the first two
    // do not hold a service config, and mgmtd learns the commit landed from SettingsCommitResponse
    // below — the reply to the request it made — rather than from the fan-out it is not part of.
    ConfigApply = 107,
    // 108 (ConfigReloadRequest) reserved: never sent. It was the request half of an RPC whose
    // response half is now SettingsCommitResponse, named for the request that actually provokes it.

    // ── Settings & admin (mgmtd → engined; engined is the sole DB writer) ──
    SettingsCommitRequest = 110,
    // Was ConfigReloadResponse, which paired with nothing: mgmtd asks with SettingsCommitRequest
    // and this is what answers it. Sent once the fleet has converged onto the committed version —
    // or failed to, which arrives as Response|Error rather than as a different command.
    SettingsCommitResponse = 109,
    // Was CommitQueueStatus. engined → mgmtd, commit-queue progress for the settings-commit flow.
    SettingsCommitStatus = 111,
    // Was AdminPasswordUpdate, when the only local account was the appliance's admin and the only
    // thing that ever changed about it was its password. Accounts are created and removed from the
    // console now, so this writes the row rather than one column of it: an upsert keyed on the
    // account's oid, or a removal when `remove` is set.
    LocalUserUpdate = 114,

    // ── Assistant (mgmtd → engined; the conversations the console shows) ──
    // One message per completed turn, carrying the session's own fields and both halves of the
    // turn. Not two writes: a turn is one thing, and a pair that could half-land would leave a
    // question on screen with no answer under it. `delete` removes one conversation.
    ChatTurnStore = 141,

    // ── Probe (ICMP reachability; probed, a privileged raw-socket daemon) ──
    ProbeRequest = 115,   // → probed: run a reachability sweep
    ProbeResult = 103,    // probed → engined: alive set, persisted to device status

    // ── Scan (collectord) ──
    ScanRequest = 112,    // → collectord
    ScanResult = 113,     // → engined

    // ── Auth (mgmtd → authd, delegated request/response) ──
    AuthLoginRequest = 116,
    AuthLoginResponse = 117,
    AuthOidcStartRequest = 118,
    AuthOidcStartResponse = 119,
    AuthOidcCallbackRequest = 120,
    AuthOidcCallbackResponse = 121,
    AuthSamlStartRequest = 122,
    AuthSamlStartResponse = 123,
    AuthSamlAcsRequest = 124,
    AuthSamlAcsResponse = 125,

    // ── Api (vendor credential lifecycle + collection + SASE device health key). These names/edges
    //    are reworked in the probed→collectord API migration (per-op split: keygen / endpoint-test /
    //    egress), so treat the group below as pending until that lands. ──
    //
    // engined is the only database writer, so the outcome of a key generation (already-encrypted
    // secret, expiry, test result) is handed over rather than written twice.
    ApiCredentialStateUpdate = 126,
    // Connector tests run in collectord, not mgmtd: collectord is the daemon that will poll these
    // devices on a schedule, and a test that exercised a different code path than the collector
    // would not be testing much. mgmtd forwards the operator's (possibly uncommitted) target and
    // correlates the reply by seqNo — the same shape as the SAML ACS delegation to authd. One cmd
    // per operation so collectord routes straight to the owning controller (no in-payload mode).
    ApiKeygenRequest = 127,        // mgmtd → collectord: issue/validate a credential (ngfw key / sase token)
    ApiConnectorTestResponse = 128,// collectord → mgmtd: result of any of the three tests (by seqNo)
    ApiEndpointTestRequest = 134,  // mgmtd → collectord: call an endpoint with a key (keygen first if none)
    ApiSaseTestRequest = 135,      // mgmtd → collectord: SASE device health (getPrismaAccessIP) + store api-key
    ApiTlsProbeRequest = 136,      // mgmtd → collectord: TLS-only handshake to a device, returns its cert
                                   // fingerprint so an NGFW can be pinned at creation (no credentials)
    ApiSaseKeyStoreRequest = 137,  // mgmtd → collectord: seal a SASE device's health api-key and hand it
                                   // to engined. Storing is its own operation, not a side effect of a
                                   // passing test, so the key survives a save that was never tested.
    ApiCredentialStoreRequest = 138,  // mgmtd → collectord: seal an API Key's account credential
                                      // (username/password) and hand it to engined. Same reason as
                                      // above — the operator's password must not live in one browser.
    // collectord asks engined for the issued keys. engined answers with the SEALED blobs and
    // collectord opens them with credentials.key — the plaintext never crosses the socket. collectord
    // caches the result rather than asking per call, because periodic collection would otherwise hit
    // the database on every poll.
    ApiCredentialStateRequest = 129,
    ApiCredentialStateResponse = 130,
    // collectord → engined: one connector's scheduled endpoint poll result, persisted to api_collection.
    ApiCollectionSample = 131,
    // probed → engined: a validated SASE device health api-key, sealed, to store in sase_device.api_key_enc.
    SaseApiKeyUpdate = 132,
    // collectord → engined: SASE control-plane health outcome (alive/down targets + egress-IP payloads),
    // persisted to sase_device.status/egress_result. The SASE counterpart of ProbeResult, which stays
    // ICMP/NGFW-only now that the SASE probe runs in collectord rather than riding probed's message.
    SaseHealthResult = 133,

    // ── Topology (mgmtd ↔ topologyd) ──
    // mgmtd owns no topology logic: it asks topologyd for one site's composed picture and serves
    // whatever it last received. topologyd reads the collected samples, correlates them and answers.
    // A request/response pair rather than a Write, because the composition is derived and lives in
    // memory — it is cheap to rebuild and never worth a table.
    TopologyRequest = 139,    // mgmtd → topologyd: compose this site (payload {site})
    TopologyResponse = 140,   // topologyd → mgmtd: the composed model

    // ── Inference ──
    // 141–144 (ChatRequest/ChatResponse/RetrieveRequest/RetrieveResponse) retired: chat moved off
    // the IPC fabric onto the pretzel-ai gRPC transport (see mgmtd/grpc/). The numbers are left
    // unused rather than reassigned so an old peer's frame is rejected, not silently misrouted.

    // The AI assistant's vendor API keys — one sealed row per vendor (openai / gemini / claude).
    //
    // 145–146 (GatewayCredentialStoreRequest/Response) retired: they delegated the sealing to the
    // inferd daemon, which no longer exists. The assistant's peer is pretzel-ai, which is not on
    // this fabric, so there is no worker to delegate to — mgmtd already holds the plaintext and
    // seals it itself (AiController), leaving one hop instead of three. The numbers are left
    // unused rather than reassigned so an old peer's frame is rejected, not silently misrouted.
    AiCredentialStateUpdate = 147,    // mgmtd → engined: {id, key_enc} — already sealed,
                                           //   or {id, clear:true} to remove one
};

// Coarse role of a command, orthogonal to its domain. Feeds IpcProtocol::isRoutingAllowed, which
// carries the one cross-cutting routing invariant this motivated — a `Write` only ever legitimately
// targets engined, the sole DB writer.
enum class CmdCategory : std::uint8_t
{
    Lifecycle,   // transport, heartbeat, runtime — infra, not a feature edge
    Config,      // config reload/apply distribution
    Auth,        // mgmtd → authd delegated request/response
    DeviceOp,    // ask a worker to act on something outside the appliance — a managed device
                 // (probe / scan / api test) or an upstream service (a chat turn through the gateway)
    Write,       // mutate engined's store — dst must be Engined
    Read,        // query engined's store
};

enum class IpcFlag : std::uint8_t
{
    None = 0x00,
    Request = 0x01,
    Response = 0x02,
    Error = 0x04,
    Broadcast = 0x08
};

#pragma pack(push, 1)
struct IpcWireHeader
{
    std::uint8_t version;
    std::uint8_t src;
    std::uint8_t dst;
    std::uint8_t flags;
    std::uint16_t cmd;
    std::uint16_t reserved;
    std::uint32_t seqNo;
    std::uint32_t payloadLen;
};
#pragma pack(pop)

static_assert(sizeof(IpcWireHeader) == 16, "IpcWireHeader must be 16 bytes");

class IpcProtocol
{
public:
    static std::uint8_t toFlag(IpcFlag flag) noexcept;
    static std::uint8_t orFlag(IpcFlag lhs, IpcFlag rhs) noexcept;
    static bool hasFlag(std::uint8_t flags, IpcFlag flag) noexcept;

    static IpcWireHeader hostToNet(const IpcWireHeader& h) noexcept;
    static IpcWireHeader netToHost(const IpcWireHeader& h) noexcept;

    static const char* daemonToStr(IpcDaemon daemon) noexcept;
    static const char* cmdToStr(IpcCmd cmd) noexcept;
    static CmdCategory classify(IpcCmd cmd) noexcept;

    // Routing invariant for the IPC fabric, derived from a command's CmdCategory: "route by data
    // ownership, not by hierarchy". Whatever the exact (src, dst) edge, a state mutation may only be
    // addressed to engined — the sole DB writer — so a Write pointed anywhere else is a misroute.
    //
    // Not yet a full (src, dst, cmd) allowlist: enumerating every legitimate edge (the auth
    // delegations in particular) is a later pass, so unconstrained categories return true and this
    // can be wired into Ipcd in warn-only mode without dropping valid traffic.
    static bool isRoutingAllowed(IpcDaemon src, IpcDaemon dst, IpcCmd cmd) noexcept;

    static std::string flagsToStr(std::uint8_t flags);

    static IpcDaemon strToDaemon(const std::string& daemon) noexcept;
};

}

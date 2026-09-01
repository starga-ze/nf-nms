#include "ipc/IpcProtocol.h"

#include <arpa/inet.h>

namespace pz::ipc
{

std::uint8_t IpcProtocol::toFlag(IpcFlag flag) noexcept
{
    return static_cast<std::uint8_t>(flag);
}

std::uint8_t IpcProtocol::orFlag(IpcFlag lhs, IpcFlag rhs) noexcept
{
    return static_cast<std::uint8_t>(lhs) | static_cast<std::uint8_t>(rhs);
}

bool IpcProtocol::hasFlag(std::uint8_t flags, IpcFlag flag) noexcept
{
    return (flags & static_cast<std::uint8_t>(flag)) != 0;
}

IpcWireHeader IpcProtocol::hostToNet(const IpcWireHeader& h) noexcept
{
    IpcWireHeader out = h;
    out.cmd = htons(out.cmd);
    out.reserved = htons(out.reserved);
    out.seqNo = htonl(out.seqNo);
    out.payloadLen = htonl(out.payloadLen);
    return out;
}

IpcWireHeader IpcProtocol::netToHost(const IpcWireHeader& h) noexcept
{
    IpcWireHeader out = h;
    out.cmd = ntohs(out.cmd);
    out.reserved = ntohs(out.reserved);
    out.seqNo = ntohl(out.seqNo);
    out.payloadLen = ntohl(out.payloadLen);
    return out;
}

const char* IpcProtocol::daemonToStr(IpcDaemon daemon) noexcept
{
    switch (daemon)
    {
    case IpcDaemon::Ipcd:
        return "ipcd";
    case IpcDaemon::Engined:
        return "engined";
    case IpcDaemon::Authd:
        return "authd";
    case IpcDaemon::Probed:
        return "probed";
    case IpcDaemon::Collectord:
        return "collectord";
    case IpcDaemon::Topologyd:
        return "topologyd";
    case IpcDaemon::Mgmtd:
        return "mgmtd";
    case IpcDaemon::Apid:
        return "apid";
    case IpcDaemon::Broadcast:
        return "broadcast";
    default:
        return "unknown";
    }
}

const char* IpcProtocol::cmdToStr(IpcCmd cmd) noexcept
{
    switch (cmd)
    {
    case IpcCmd::ClientHello:
        return "ClientHello";
    case IpcCmd::ServerHello:
        return "ServerHello";
    case IpcCmd::SyncRequest:
        return "SyncRequest";
    case IpcCmd::SyncResponse:
        return "SyncResponse";
    case IpcCmd::RuntimeReady:
        return "RuntimeReady";
    case IpcCmd::RuntimeStart:
        return "RuntimeStart";
    case IpcCmd::Error:
        return "Error";
    case IpcCmd::ProbeResult:
        return "ProbeResult";
    case IpcCmd::HeartbeatRequest:
        return "HeartbeatRequest";
    case IpcCmd::HeartbeatResponse:
        return "HeartbeatResponse";
    case IpcCmd::HeartbeatResult:
        return "HeartbeatResult";
    case IpcCmd::ConfigApply:
        return "ConfigApply";
    case IpcCmd::SettingsCommitRequest:
        return "SettingsCommitRequest";
    case IpcCmd::SettingsCommitResponse:
        return "SettingsCommitResponse";
    case IpcCmd::SettingsCommitStatus:
        return "SettingsCommitStatus";
    case IpcCmd::ScanRequest:
        return "ScanRequest";
    case IpcCmd::ScanResult:
        return "ScanResult";
    case IpcCmd::AdminPasswordUpdate:
        return "AdminPasswordUpdate";
    case IpcCmd::ApiCredentialStateUpdate:
        return "ApiCredentialStateUpdate";
    case IpcCmd::ApiKeygenRequest:
        return "ApiKeygenRequest";
    case IpcCmd::ApiEndpointTestRequest:
        return "ApiEndpointTestRequest";
    case IpcCmd::ApiSaseTestRequest:
        return "ApiSaseTestRequest";
    case IpcCmd::ApiTlsProbeRequest:
        return "ApiTlsProbeRequest";
    case IpcCmd::ApiSaseKeyStoreRequest:
        return "ApiSaseKeyStoreRequest";
    case IpcCmd::ApiCredentialStoreRequest:
        return "ApiCredentialStoreRequest";
    case IpcCmd::AiCredentialStateUpdate:
        return "AiCredentialStateUpdate";
    case IpcCmd::ApiConnectorTestResponse:
        return "ApiConnectorTestResponse";
    case IpcCmd::ApiCredentialStateRequest:
        return "ApiCredentialStateRequest";
    case IpcCmd::ApiCredentialStateResponse:
        return "ApiCredentialStateResponse";
    case IpcCmd::ApiCollectionSample:
        return "ApiCollectionSample";
    case IpcCmd::SaseApiKeyUpdate:
        return "SaseApiKeyUpdate";
    case IpcCmd::SaseHealthResult:
        return "SaseHealthResult";
    case IpcCmd::TopologyRequest:
        return "TopologyRequest";
    case IpcCmd::TopologyResponse:
        return "TopologyResponse";
    case IpcCmd::ProbeRequest:
        return "ProbeRequest";
    case IpcCmd::AuthLoginRequest:
        return "AuthLoginRequest";
    case IpcCmd::AuthLoginResponse:
        return "AuthLoginResponse";
    case IpcCmd::AuthOidcStartRequest:
        return "AuthOidcStartRequest";
    case IpcCmd::AuthOidcStartResponse:
        return "AuthOidcStartResponse";
    case IpcCmd::AuthOidcCallbackRequest:
        return "AuthOidcCallbackRequest";
    case IpcCmd::AuthOidcCallbackResponse:
        return "AuthOidcCallbackResponse";
    case IpcCmd::AuthSamlStartRequest:
        return "AuthSamlStartRequest";
    case IpcCmd::AuthSamlStartResponse:
        return "AuthSamlStartResponse";
    case IpcCmd::AuthSamlAcsRequest:
        return "AuthSamlAcsRequest";
    case IpcCmd::AuthSamlAcsResponse:
        return "AuthSamlAcsResponse";
    default:
        return "Unknown";
    }
}

CmdCategory IpcProtocol::classify(IpcCmd cmd) noexcept
{
    switch (cmd)
    {
    // Config distribution. The broadcast alone: SettingsCommitResponse is engined's reply on the
    // commit flow and is classified with the other status replies below.
    case IpcCmd::ConfigApply:
        return CmdCategory::Config;

    // mgmtd → authd delegated auth.
    case IpcCmd::AuthLoginRequest:
    case IpcCmd::AuthLoginResponse:
    case IpcCmd::AuthOidcStartRequest:
    case IpcCmd::AuthOidcStartResponse:
    case IpcCmd::AuthOidcCallbackRequest:
    case IpcCmd::AuthOidcCallbackResponse:
    case IpcCmd::AuthSamlStartRequest:
    case IpcCmd::AuthSamlStartResponse:
    case IpcCmd::AuthSamlAcsRequest:
    case IpcCmd::AuthSamlAcsResponse:
        return CmdCategory::Auth;

    // Ask a worker to act on a device.
    case IpcCmd::ProbeRequest:
    case IpcCmd::ScanRequest:
    case IpcCmd::ApiKeygenRequest:
    case IpcCmd::ApiEndpointTestRequest:
    case IpcCmd::ApiSaseTestRequest:
    case IpcCmd::ApiTlsProbeRequest:
    case IpcCmd::ApiSaseKeyStoreRequest:
    case IpcCmd::ApiCredentialStoreRequest:
    case IpcCmd::ApiConnectorTestResponse:
        return CmdCategory::DeviceOp;

    // Mutate engined's store — dst must be Engined.
    case IpcCmd::SettingsCommitRequest:
    case IpcCmd::AdminPasswordUpdate:
    case IpcCmd::ProbeResult:
    case IpcCmd::ScanResult:
    case IpcCmd::ApiCredentialStateUpdate:
    case IpcCmd::AiCredentialStateUpdate:
    case IpcCmd::ApiCollectionSample:
    case IpcCmd::SaseApiKeyUpdate:
    case IpcCmd::SaseHealthResult:
        return CmdCategory::Write;

    // Query another daemon's store or derived view.
    case IpcCmd::ApiCredentialStateRequest:
    case IpcCmd::ApiCredentialStateResponse:
    case IpcCmd::TopologyRequest:
    case IpcCmd::TopologyResponse:
        return CmdCategory::Read;

    // Handshake, sync, runtime, heartbeat, transport error, and status replies — infra, not a
    // feature edge (SettingsCommitResponse and SettingsCommitStatus are engined's replies on the
    // commit flow, not writes to it).
    case IpcCmd::ClientHello:
    case IpcCmd::ServerHello:
    case IpcCmd::SyncRequest:
    case IpcCmd::SyncResponse:
    case IpcCmd::RuntimeReady:
    case IpcCmd::RuntimeStart:
    case IpcCmd::Error:
    case IpcCmd::HeartbeatRequest:
    case IpcCmd::HeartbeatResponse:
    case IpcCmd::HeartbeatResult:
    case IpcCmd::SettingsCommitResponse:
    case IpcCmd::SettingsCommitStatus:
    case IpcCmd::Unknown:
    default:
        return CmdCategory::Lifecycle;
    }
}

bool IpcProtocol::isRoutingAllowed(IpcDaemon /*src*/, IpcDaemon dst, IpcCmd cmd) noexcept
{
    switch (classify(cmd))
    {
    case CmdCategory::Write:
        // Only engined persists state, so a Write addressed to any other daemon is a misroute. This
        // is the one invariant that is complete and safe to enforce today.
        return dst == IpcDaemon::Engined;

    case CmdCategory::Lifecycle:
    case CmdCategory::Config:
    case CmdCategory::Auth:
    case CmdCategory::DeviceOp:
    case CmdCategory::Read:
    default:
        // Not yet constrained — a per-edge allowlist is a later tightening. Permissive so wiring
        // this in warn-only mode cannot drop valid traffic.
        return true;
    }
}

std::string IpcProtocol::flagsToStr(std::uint8_t flags)
{
    if (flags == static_cast<std::uint8_t>(IpcFlag::None))
        return "None";

    std::string out;

    auto append = [&](const char* s)
    {
        if (!out.empty())
            out += "|";
        out += s;
    };

    if (hasFlag(flags, IpcFlag::Request))
    {
        append("Request");
    }
    if (hasFlag(flags, IpcFlag::Response))
    {
        append("Response");
    }
    if (hasFlag(flags, IpcFlag::Error))
    {
        append("Error");
    }
    if (hasFlag(flags, IpcFlag::Broadcast))
    {
        append("Broadcast");
    }

    return out;
}

pz::ipc::IpcDaemon IpcProtocol::strToDaemon(const std::string& daemon) noexcept
{
    if (daemon == "ipcd")
    {
        return IpcDaemon::Ipcd;
    }

    if (daemon == "engined")
    {
        return IpcDaemon::Engined;
    }

    if (daemon == "authd")
    {
        return IpcDaemon::Authd;
    }

    if (daemon == "probed")
    {
        return IpcDaemon::Probed;
    }

    if (daemon == "collectord")
    {
        return IpcDaemon::Collectord;
    }

    if (daemon == "topologyd")
    {
        return IpcDaemon::Topologyd;
    }

    if (daemon == "mgmtd")
    {
        return IpcDaemon::Mgmtd;
    }

    if (daemon == "apid")
    {
        return IpcDaemon::Apid;
    }

    if (daemon == "broadcast")
    {
        return IpcDaemon::Broadcast;
    }

    return IpcDaemon::Unknown;
}

}

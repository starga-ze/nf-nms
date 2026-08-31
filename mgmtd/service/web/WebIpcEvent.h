#pragma once

#include "event/MgmtdEvent.h"
#include "ipc/IpcMessage.h"

#include <cstdint>
#include <memory>

namespace pz::mgmtd
{

// An answer from another daemon that a web-domain controller is waiting on.
//
// Separate from WebEvent on purpose: WebEvent is HTTP ingress and ends in a response written back to
// a browser socket, which is a different shape of work from "file this answer where the next request
// will find it". Sharing one class would mean a kind field and two disjoint halves.
//
// Why an event at all, when the router could simply call the store: because that is the pattern every
// other daemon follows, and because a router that writes state is a router that quietly acquires
// domain logic. The TopologyResponse branch had already grown a JSON parse and a drop-on-malformed
// rule inside MgmtdRxRouter; the ConfigReloadResponse branch discarded engined's error flag because
// there was no handler in which checking it was the obvious thing to do. Routing these through their
// owning controller puts each one somewhere its failure modes are somebody's job.
enum class WebIpcEventType : std::uint32_t
{
    Unknown = 0,
    TopologyResponse = 1,        // topologyd composed a site      → TopologyController
    SettingsCommitStatus = 2,    // engined's commit queue moved   → SettingsController
    ApiConnectorTestResponse = 3,// collectord ran a device call   → ApiController
    // 4, 5 (ChatResponse, RetrieveResponse) retired: chat moved to the pretzel-ai gRPC transport,
    // whose answers arrive inline via GrpcClientHandler, not as inbound IPC events.
    // 6 (GatewayCredentialStoreResponse) retired: sealing a vendor key no longer takes a round
    // trip. It used to be delegated to a daemon that has since been deleted; mgmtd now seals in
    // AiController and writes straight to engined, so there is no response to file. The number
    // stays spent rather than reused.
};

class WebIpcEvent final : public MgmtdEvent
{
public:
    WebIpcEvent(WebIpcEventType type, std::unique_ptr<pz::ipc::IpcMessage> message);

    void dispatch(MgmtdServiceManager& serviceManager) override;

    WebIpcEventType type() const;
    const pz::ipc::IpcMessage* message() const;

private:
    WebIpcEventType m_type{WebIpcEventType::Unknown};
    std::unique_ptr<pz::ipc::IpcMessage> m_message;
};

}

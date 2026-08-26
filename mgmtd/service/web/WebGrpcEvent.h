#pragma once

#include "event/MgmtdEvent.h"
#include "grpc/GrpcProtocol.h"

#include <cstdint>
#include <string>

namespace pz::mgmtd
{

// An answer from pretzel-ai that a web-domain controller is waiting on — the gRPC counterpart of
// WebIpcEvent, and it exists for the same reason.
//
// The transport could file these itself: GrpcClientHandler already runs its delivery on the loop
// thread, so a callback straight into MgmtdServiceManager would work. It is not done that way
// because that callback is where domain logic accumulates unnoticed. WebIpcEvent's comment records
// how that went on the IPC side — a JSON parse and a drop-on-malformed rule grew inside the router,
// and an error flag was discarded because no handler owned checking it. Routing a gRPC answer
// through its owning controller puts its failure modes somewhere they are somebody's job, and
// keeps the transport a transport.
enum class WebGrpcEventType : std::uint32_t
{
    Unknown = 0,
    ChatResponse = 1,           // a turn came back            → ChatController
    CorpusStatusResponse = 3,   // store snapshot read         → TechDocController
    CorpusRefreshProgress = 4,  // one progress message        → TechDocController
    CorpusDocumentList = 5,     // one book's documents        → TechDocController
    // Every benchtest call answers once and is collected once, so they share a single event type
    // rather than one each: the controller that polls the ticket already knows what it asked for,
    // and a type per call would be six names carrying no information.
    BenchtestResponse = 6,      // any benchtest answer        → BenchtestController
    // A run reports many times and is read by any number of polls, so it overwrites one live slot
    // rather than resolving a ticket — the same shape a corpus refresh has.
    BenchtestRunProgress = 7,   // one run message             → BenchtestController
    ModelListResponse = 8,      // the picker's catalog        → ChatController
};

// Maps the call that was made to the answer it produces. Kept beside the enum so adding a call
// cannot leave its answer unroutable.
WebGrpcEventType webGrpcEventFor(GrpcCmd cmd) noexcept;

class WebGrpcEvent final : public MgmtdEvent
{
public:
    WebGrpcEvent(WebGrpcEventType type, std::uint32_t ticket, std::string json);

    void dispatch(MgmtdServiceManager& serviceManager) override;

    WebGrpcEventType type() const;
    std::uint32_t ticket() const;
    const std::string& json() const;

private:
    WebGrpcEventType m_type{WebGrpcEventType::Unknown};
    std::uint32_t m_ticket{0};
    std::string m_json;
};

}

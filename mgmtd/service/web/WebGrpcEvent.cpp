#include "service/web/WebGrpcEvent.h"

#include "service/MgmtdServiceManager.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <utility>

namespace pz::mgmtd
{

WebGrpcEventType webGrpcEventFor(GrpcCmd cmd) noexcept
{
    switch (cmd)
    {
    case GrpcCmd::Chat:          return WebGrpcEventType::ChatResponse;
    case GrpcCmd::CorpusStatus:  return WebGrpcEventType::CorpusStatusResponse;
    case GrpcCmd::CorpusDocuments: return WebGrpcEventType::CorpusDocumentList;
    case GrpcCmd::CorpusRefresh: return WebGrpcEventType::CorpusRefreshProgress;
    case GrpcCmd::BenchtestDatasets:
    case GrpcCmd::BenchtestUpload:
    case GrpcCmd::BenchtestDelete:
    case GrpcCmd::BenchtestSummary:
    case GrpcCmd::BenchtestRows:
    case GrpcCmd::BenchtestExport:
    case GrpcCmd::BenchtestRunList:
    case GrpcCmd::BenchtestRunInfo:
    case GrpcCmd::BenchtestCases:
    case GrpcCmd::BenchtestCase:
        return WebGrpcEventType::BenchtestResponse;
    case GrpcCmd::BenchtestRun:  return WebGrpcEventType::BenchtestRunProgress;
    case GrpcCmd::BenchtestCancel: break;
    case GrpcCmd::CorpusCancel:  break;
    case GrpcCmd::Unknown:       break;
    }
    return WebGrpcEventType::Unknown;
}

WebGrpcEvent::WebGrpcEvent(WebGrpcEventType type, std::uint32_t ticket, std::string json)
    : MgmtdEvent(MgmtdEventDomain::Web), m_type(type), m_ticket(ticket), m_json(std::move(json))
{
}

WebGrpcEventType WebGrpcEvent::type() const
{
    return m_type;
}

std::uint32_t WebGrpcEvent::ticket() const
{
    return m_ticket;
}

const std::string& WebGrpcEvent::json() const
{
    return m_json;
}

void WebGrpcEvent::dispatch(MgmtdServiceManager& serviceManager)
{
    switch (m_type)
    {
    // A chat turn reports twice on one ticket: the answer as it is being written, then the turn
    // document. A partial must never resolve the ticket — a poll that collected one would end the
    // turn on a fragment, and the real answer would arrive with nobody waiting for it. The
    // transport marks them rather than this handler guessing from shape: the payload contains a
    // model's own words, and any field name is something it could have written.
    case WebGrpcEventType::ChatResponse:
    {
        const nlohmann::json body = nlohmann::json::parse(m_json, nullptr, false);
        if (!body.is_discarded() && body.value("partial", false))
        {
            serviceManager.appendChatPartial(m_ticket, body.value("text", std::string()));
            return;
        }
        serviceManager.setChatResult(m_ticket, std::move(m_json));
        return;
    }

    // Unary answers resolve the ticket the browser is polling. These share the chat ticket store:
    // both are "one JSON document, collected once by whoever asked".
    case WebGrpcEventType::CorpusStatusResponse:
    case WebGrpcEventType::CorpusDocumentList:
    case WebGrpcEventType::BenchtestResponse:
        serviceManager.setChatResult(m_ticket, std::move(m_json));
        return;

    // A refresh reports many times and is read by any number of polls, so it overwrites one live
    // slot rather than resolving a ticket. The service manager is what decides the run is over —
    // the transport reports progress, it does not get to declare state.
    case WebGrpcEventType::CorpusRefreshProgress:
    {
        // Reading `final` is this handler's job, not the transport's. A stream that ends without
        // it — the process died mid-crawl — leaves the run marked running forever, so a message
        // that will not parse is treated as terminal: a refresh nobody can describe is over.
        const nlohmann::json body = nlohmann::json::parse(m_json, nullptr, false);
        const bool finished = body.is_discarded() || body.value("final", false);
        if (body.is_discarded())
        {
            LOG_WARN("unparseable refresh progress from pretzel-ai; ending the run");
        }
        LOG_DEBUG("tech-doc progress event (final={}): {}", finished, m_json.substr(0, 120));
        serviceManager.setCorpusProgress(std::move(m_json), finished);
        return;
    }

    // Same reasoning as above, on its own slot.
    case WebGrpcEventType::BenchtestRunProgress:
    {
        const nlohmann::json body = nlohmann::json::parse(m_json, nullptr, false);
        const bool finished = body.is_discarded() || body.value("final", false);
        if (body.is_discarded())
        {
            LOG_WARN("unparseable benchtest progress from pretzel-ai; ending the run");
        }
        // A per-case message queues; everything else is run-level state and overwrites the slot.
        // Both, for a case message: the slot carries the running totals the header reads.
        if (!body.is_discarded() && body.value("stage", std::string()) == "case")
        {
            serviceManager.queueBenchtestCase(m_json);
        }
        serviceManager.setBenchtestProgress(std::move(m_json), finished);
        return;
    }

    case WebGrpcEventType::Unknown:
        break;
    }

    LOG_WARN("dropping pretzel-ai answer with no handler (type={}, ticket={})",
             static_cast<std::uint32_t>(m_type), m_ticket);
}

}

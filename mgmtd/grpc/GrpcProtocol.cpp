#include "grpc/GrpcProtocol.h"

namespace pz::mgmtd
{

const char* grpcCmdToStr(GrpcCmd cmd) noexcept
{
    switch (cmd)
    {
    case GrpcCmd::Chat:          return "Chat";
    case GrpcCmd::ListModels:    return "ListModels";
    case GrpcCmd::CorpusStatus:  return "CorpusStatus";
    case GrpcCmd::CorpusRefresh: return "CorpusRefresh";
    case GrpcCmd::CorpusCancel:  return "CorpusCancel";
    case GrpcCmd::CorpusDocuments: return "CorpusDocuments";
    case GrpcCmd::BenchtestDatasets: return "BenchtestDatasets";
    case GrpcCmd::BenchtestUpload:   return "BenchtestUpload";
    case GrpcCmd::BenchtestDelete:   return "BenchtestDelete";
    case GrpcCmd::BenchtestSummary:  return "BenchtestSummary";
    case GrpcCmd::BenchtestRows:     return "BenchtestRows";
    case GrpcCmd::BenchtestExport:   return "BenchtestExport";
    case GrpcCmd::BenchtestRun:      return "BenchtestRun";
    case GrpcCmd::BenchtestRunList:  return "BenchtestRunList";
    case GrpcCmd::BenchtestRunInfo:  return "BenchtestRunInfo";
    case GrpcCmd::BenchtestCases:    return "BenchtestCases";
    case GrpcCmd::BenchtestCase:     return "BenchtestCase";
    case GrpcCmd::BenchtestCancel:   return "BenchtestCancel";
    case GrpcCmd::Unknown:       break;
    }
    return "Unknown";
}

bool grpcCmdStreams(GrpcCmd cmd) noexcept
{
    return cmd == GrpcCmd::CorpusRefresh || cmd == GrpcCmd::BenchtestRun;
}

}

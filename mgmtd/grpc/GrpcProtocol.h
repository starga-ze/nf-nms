#pragma once

#include <cstdint>

namespace pz::mgmtd
{

// The pretzel-ai RPC surface, named the way IpcCmd names the IPC one.
//
// mgmtd talks to exactly one gRPC peer, so there is no addressing here and no wire format to
// version — this enum exists for the reason IpcCmd does: so a call is dispatched by naming what it
// is, rather than by the router growing one method per operation. A router with a method per
// operation is a router that has to be edited every time the service gains a call, and that is the
// point at which it starts holding opinions about them.
enum class GrpcCmd : std::uint16_t
{
    Unknown = 0,

    // ── The assistant ──
    Chat = 1,

    // ── The tech-doc knowledge base ──
    CorpusStatus = 3,    // what the store holds now
    CorpusRefresh = 4,   // apply it; streams progress for minutes
    // Not a call — it cancels the streaming one already in flight. Routed as a command anyway so
    // the transport keeps its single entry point: a controller that reached past the router to
    // cancel would be the first thing to know a transport detail.
    CorpusCancel = 5,
    CorpusDocuments = 6,   // the documents under one product/book, for the corpus browser

    // ── Benchtest sets ──
    // Reads and one write, all unary. The upload carries a whole file in `content`; everything
    // else carries a dataset id and a handful of filter strings.
    BenchtestDatasets = 7,   // every stored set, newest first
    BenchtestUpload   = 8,   // store one uploaded .jsonl as a new set
    BenchtestDelete   = 9,   // remove a set and its prompts
    BenchtestSummary  = 10,  // composition of one set, for the header band
    BenchtestRows     = 11,  // one page of a set
    BenchtestExport   = 12,  // a whole set back out as the .jsonl it arrived as

    // ── Benchtest runs ──
    // BenchtestRun is the second streaming call: it runs for minutes and reports per case, so it
    // overwrites a live slot the way a corpus refresh does rather than resolving a ticket.
    BenchtestRun      = 13,  // execute a set against the guardrail; streams
    BenchtestRunList  = 14,  // runs that have already happened
    BenchtestRunInfo  = 15,  // one run with its outcome tally
    BenchtestCases    = 16,  // one page of a run's cases
    BenchtestCase     = 17,  // one case with the whole exchange
    BenchtestCancel   = 18,  // stop the run in flight; not a call, see CorpusCancel
};

const char* grpcCmdToStr(GrpcCmd cmd) noexcept;

// True for calls that report many times before they finish. The distinction is what decides how a
// completion is filed: a unary call resolves a ticket once and is drained by whoever polls it, a
// streaming one overwrites a single live slot that any number of polls can read.
bool grpcCmdStreams(GrpcCmd cmd) noexcept;

}

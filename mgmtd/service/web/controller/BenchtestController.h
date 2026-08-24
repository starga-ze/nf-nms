#pragma once

#include "http/HttpMessage.h"

namespace pz::mgmtd
{

class MgmtdServiceManager;

// AI ▸ Benchtest, and Operation ▸ Benchtest Data — the server half of both.
//
// mgmtd owns none of this data. pretzel-ai holds the sets in pretzel_knowledge and is the only
// writer of them; every call here dispatches over gRPC and serves the answer back verbatim, the
// same relay TechDocController is. A field added on the pretzel-ai side therefore reaches the
// console without a change in this file.
//
// Every call takes the ticket-and-poll path, because that is the only path mgmtd has: a gRPC call
// blocks for as long as pretzel-ai takes and mgmtd runs one event loop, so dispatch returns a
// ticket immediately and the answer is filed under it for /result to collect. The calls here are
// milliseconds rather than minutes — they are database reads — but giving them a second,
// synchronous mechanism would mean the transport had two shapes, and the faster one would be the
// one that blocks the console's only thread.
//
// The upload is the one call that is not a read. It carries the whole .jsonl in the request body
// rather than as multipart: the payload is one file and nothing else, and the filename travels in
// a header where it cannot be confused with the content. Validation is pretzel-ai's — it is the
// process that has to store the thing — so a malformed file comes back as an answer with per-line
// detail, not as an HTTP error with a sentence.
class BenchtestController
{
public:
    // GET  /api/benchtest/datasets?q=      → 202 {ticket}; every stored set, newest first
    void datasets(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // POST /api/benchtest/datasets         → 202 {ticket}; body is the .jsonl,
    //                                        X-Benchtest-Filename carries the name
    void upload(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // DELETE /api/benchtest/datasets?id=   → 202 {ticket}
    void remove(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/summary?id=      → 202 {ticket}; composition of one set
    void summary(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/rows?id=&category=&verdict=&language=&technique=&q=&offset=&limit=
    //                                      → 202 {ticket}; one page of a set
    void rows(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/export?id=       → 202 {ticket}; the whole set as .jsonl
    void exportSet(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // --- Runs -------------------------------------------------------------------------------
    //
    // A run streams: it is minutes long and reports per case, so it does not resolve a ticket. It
    // overwrites a single live slot that any number of polls can read, which is also what lets the
    // modal recover its progress after a page reload. Single-flight is the ServiceManager's call,
    // not the transport's — "is a run going" is state, and state lives there.

    // POST /api/benchtest/run?id=&category=&verdict=&language=&technique=&q=&workers=
    //                                      → 202 {started:true}, or 409 when one is running
    void runStart(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/run/progress     → the latest message, plus running:true|false
    void runProgress(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // POST /api/benchtest/run/cancel       → 202; stops the run on the appliance, not just here
    void runCancel(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/runs?id=&limit=  → 202 {ticket}; runs that already happened
    void runs(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/run?run=         → 202 {ticket}; one run with its outcome tally
    void runInfo(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/cases?run=&cause=&offset=&limit=  → 202 {ticket}
    void cases(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/case?run=&seq=   → 202 {ticket}; one case with the whole exchange
    void caseDetail(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET  /api/benchtest/result?ticket=   → {status:"pending"} until pretzel-ai answers.
    //
    // Shared by all of the above. Export is unwrapped here rather than served as a document: the
    // answer to that one is a file, and handing the browser a JSON envelope to unpack would put
    // the download's content-type and filename in the page's hands instead of the server's.
    void result(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);
};

}

#pragma once

#include "grpc/GrpcMessage.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace pz::mgmtd
{

// The mgmtd-side client for the pretzel-ai inference service — the gRPC replacement for the
// old IPC ChatRequest/ChatResponse path to inferd. A chat turn streams back chunk by chunk;
// on_delta is invoked for each piece of text as it arrives, which is what lets the console
// render the answer as it is produced rather than after it is complete.
//
// Pimpl so this header stays free of the generated protobuf/gRPC headers: only the .cpp (and
// the smoke target that compiles it) needs them.
class GrpcClient
{
public:
    // target is host:port, e.g. "127.0.0.1:50051". The channel is created lazily/insecure —
    // loopback only for now (see the SSL note in script/install.py install_grpc()).
    explicit GrpcClient(const std::string& target);
    ~GrpcClient();

    GrpcClient(const GrpcClient&) = delete;
    GrpcClient& operator=(const GrpcClient&) = delete;

    struct Outcome
    {
        // A human-readable failure reason, or empty on success. Set for a transport failure, or
        // for the turn-level error the server reported on its final chunk.
        std::string error;
        // The complete turn document (reply, AIRS scan, usage, ok/code) the server put on its
        // final chunk. Empty only when the stream never reached that chunk (a transport failure).
        std::string resultJson;
    };

    // Streams one chat turn. on_delta is called once per non-empty chunk, in order.
    //
    // `history` is the conversation before this turn, oldest first and excluding `message`;
    // `sessionId` is the thread it belongs to, which pretzel-ai forwards to Prisma AIRS as the
    // scan's tr_id. Both may be empty — that is the single-turn, one-session-per-scan behaviour
    // this call had before they existed.
    Outcome chat(const std::string& model,
                 const std::string& message,
                 const std::string& systemPrompt,
                 const std::vector<GrpcMessage::Turn>& history,
                 const std::string& sessionId,
                 const std::string& transactionId,
                 const std::function<void(const std::string&)>& on_delta);

    // The models this appliance may ask for, as {models:[{id,label,provider}], default_model}.
    // Served straight through like the corpus calls: mgmtd has no opinion about the catalog, so a
    // field pretzel-ai adds reaches the picker without a change here.
    std::string listModels(std::string& error);

    // --- The tech-doc knowledge base ---------------------------------------------------------
    //
    // These return the server's reply already rendered as JSON rather than as a struct. mgmtd has
    // no opinion about a crawl: it shows the operator what pretzel-ai reported and posts back what
    // the operator decided, so a field added on the pretzel-ai side reaches the console without a
    // change here. It is the same reason ChatController serves result_json verbatim.

    // What the store holds right now, for the card's resting state.
    std::string corpusStatus(std::string& error);

    // Titles and URLs under one product/book. Bodies are not returned: they run to megabytes and
    // nothing in the browser reads them.
    std::string corpusDocuments(const std::string& product, const std::string& docset,
                                std::string& error);

    // Runs the crawl, calling on_progress once per progress message. Blocks for as long as the
    // crawl takes, so callers run it on a worker thread. Returning early from on_progress is not
    // how this is cancelled — dropping the reader is, which the caller does by destroying it.
    void refreshCorpus(const std::string& scope,
                       const std::function<void(const std::string&)>& on_progress,
                       std::string& error);

    // --- Benchtest sets ------------------------------------------------------------------------
    //
    // Same rendering choice as the corpus calls: the server's reply comes back as JSON rather than
    // as a struct, so a field added on the pretzel-ai side reaches the console without a change
    // here. `error` is set for a transport failure; a call that reached the server and was refused
    // by it reports that inside the JSON, because "the file had a bad line on 12" is an answer and
    // not a failure of the call.

    std::string benchtestDatasets(const std::string& search, std::string& error);
    std::string benchtestSummary(std::int64_t datasetId, std::string& error);
    std::string benchtestRows(std::int64_t datasetId, const std::string& category,
                              const std::string& verdict, const std::string& language,
                              const std::string& technique, const std::string& checkpoint,
                              const std::string& search,
                              std::int32_t offset, std::int32_t limit,
                              const std::string& orderBy, bool descending, std::string& error);
    std::string benchtestUpload(const std::string& content, const std::string& filename,
                                const std::string& name, const std::string& note,
                                const std::string& uploadedBy, std::string& error);
    std::string benchtestDelete(std::int64_t datasetId, std::string& error);

    // The whole set as .jsonl. Returns the file's bytes in `content` rather than as JSON: this is
    // the one call whose answer is a download and not something the console renders.
    struct Export
    {
        std::string content;
        std::string filename;
        std::string error;
    };
    Export benchtestExport(std::int64_t datasetId);

    // --- Benchtest runs -------------------------------------------------------------------
    //
    // The run streams: on_progress is called once per message, and the caller cancels by letting
    // the reader go — the server sees the dropped stream and marks the run cancelled, so this
    // stops work on the appliance rather than merely stopping us listening to it.
    void benchtestRun(std::int64_t datasetId, const std::string& category,
                      const std::string& verdict, const std::string& language,
                      const std::string& technique, const std::string& search,
                      std::int32_t workers, const std::string& label, const std::string& note,
                      const std::function<void(const std::string&)>& on_progress,
                      std::string& error);
    void cancelBenchtestRun();

    std::string benchtestRuns(std::int64_t datasetId, std::int32_t limit, std::string& error);
    std::string benchtestRunInfo(std::int64_t runId, const std::string& category,
                                 const std::string& verdict, const std::string& language,
                                 const std::string& technique, const std::string& checkpoint,
                                 const std::string& search,
                                 std::string& error);
    std::string benchtestCases(std::int64_t runId, const std::string& cause,
                               const std::string& category, const std::string& verdict,
                               const std::string& language, const std::string& technique,
                               const std::string& checkpoint,
                               const std::string& search, const std::string& orderBy,
                               bool descending,
                               std::int32_t offset, std::int32_t limit, std::string& error);
    std::string benchtestCase(std::int64_t runId, std::int32_t seq, std::string& error);

    // Cancels the refresh currently in flight, from another thread. A no-op when none is running.
    // The server sees the cancelled stream and stops crawling (its generator checks is_active), so
    // this stops work on the appliance rather than merely stopping us listening to it.
    void cancelRefresh();

    // Channel connectivity, for connection logging. The state is grpc_connectivity_state as a
    // plain int (IDLE=0, CONNECTING=1, READY=2, TRANSIENT_FAILURE=3, SHUTDOWN=4) so the header
    // stays free of gRPC types. tryToConnect nudges an idle channel to start connecting.
    int connectivityState(bool tryToConnect);
    // Block until the state leaves lastState or timeoutMs elapses; true if it changed. This is how
    // a monitor observes connect / drop / reconnect without polling in a tight loop.
    bool waitForStateChange(int lastState, int timeoutMs);

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

}

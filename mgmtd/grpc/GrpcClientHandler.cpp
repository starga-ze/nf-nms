#include "grpc/GrpcClientHandler.h"

#include "grpc/GrpcClient.h"

#include "util/Logger.h"

#include <nlohmann/json.hpp>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>

namespace pz::mgmtd
{

namespace
{

// grpc_connectivity_state as a name, for the connection log.
const char* stateName(int s)
{
    switch (s)
    {
    case 0: return "IDLE";
    case 1: return "CONNECTING";
    case 2: return "READY";
    case 3: return "TRANSIENT_FAILURE";
    case 4: return "SHUTDOWN";
    default: return "UNKNOWN";
    }
}

std::string jsonEscape(const std::string& raw)
{
    std::string escaped;
    escaped.reserve(raw.size());
    for (char c : raw)
    {
        if (c == '"' || c == '\\')
            escaped += '\\';
        if (c == '\n' || c == '\r' || c == '\t')
            escaped += ' ';
        else
            escaped += c;
    }
    return escaped;
}

// A call whose stream never reached the server's answer (the process is down, the connection
// dropped) still has to resolve whatever the browser is waiting on — so synthesize the document
// shape that call's controller already knows how to read.
std::string unreachableDoc(GrpcCmd cmd, const std::string& reason)
{
    const std::string escaped = jsonEscape(reason);
    if (cmd == GrpcCmd::Chat)
        return R"({"ok":false,"code":"UNREACHABLE","error":")" + escaped + R"("})";
    if (cmd == GrpcCmd::CorpusRefresh)
        return R"({"stage":"failed","final":true,"error":")" + escaped + R"("})";
    return R"({"error":")" + escaped + R"("})";
}

// How much answer text is worth waking the main loop for. The browser polls every 400ms, so a
// finer batch is invisible to it and costs a queue entry, a JSON document and a lock apiece.
constexpr std::size_t kDeltaBatchChars = 24;

}

// Three concurrency stories live in here, and they are separate on purpose:
//
//   the worker pool   N threads draining `tasks`, one unary call each. Bounded, because a call
//                     that blocks must not stop the others.
//   the stream        its own thread. A tech-doc refresh runs for the better part of an hour and
//                     letting it occupy a worker would starve the turns the console is waiting on.
//   the channel watch one thread doing nothing but logging connectivity transitions, so a
//                     pretzel-ai restart is visible from this side without a call being made.
//
// They meet in exactly two places — `tasks` on the way in and `done` on the way out — and each of
// those is a small guarded queue below rather than a mutex and a container side by side in this
// struct. That is what makes it possible to say what any one lock protects.
struct GrpcClientHandler::Impl
{
    // target is copied for the log line before it is moved into the client.
    explicit Impl(std::string t) : target(t), client(std::move(t)) {}

    std::string target;
    GrpcClient client;

    // ── In: the main loop hands work to the pool ────────────────────────────────────────────
    // `stopping` lives here because it is what the workers wait on beside the queue being
    // non-empty; a shutdown flag kept elsewhere would be a second thing to reason about at the
    // same wait.
    struct TaskQueue
    {
        std::mutex mutex;
        std::condition_variable cv;
        std::deque<GrpcMessage> items;
        std::atomic<bool> stopping{false};

        void push(GrpcMessage m)
        {
            {
                std::lock_guard<std::mutex> lock(mutex);
                items.push_back(std::move(m));
            }
            cv.notify_one();
        }

        // False once there is nothing left to do and the handler is going away.
        bool pop(GrpcMessage& out)
        {
            std::unique_lock<std::mutex> lock(mutex);
            cv.wait(lock, [this] { return stopping.load() || !items.empty(); });
            if (stopping.load() && items.empty())
                return false;
            out = std::move(items.front());
            items.pop_front();
            return true;
        }
    } tasks;

    // ── Out: the pool hands answers back to the main loop ───────────────────────────────────
    struct ResultQueue
    {
        std::mutex mutex;
        std::deque<std::tuple<GrpcCmd, std::uint32_t, std::string>> items;

        void push(GrpcCmd cmd, std::uint32_t ticket, std::string json)
        {
            std::lock_guard<std::mutex> lock(mutex);
            items.emplace_back(cmd, ticket, std::move(json));
        }

        bool empty()
        {
            std::lock_guard<std::mutex> lock(mutex);
            return items.empty();
        }

        // Swapped out under the lock so the caller can deliver without holding it: delivery posts
        // events on the main loop, and holding this across it would serialise the workers against
        // the loop for no reason.
        std::deque<std::tuple<GrpcCmd, std::uint32_t, std::string>> take()
        {
            std::deque<std::tuple<GrpcCmd, std::uint32_t, std::string>> out;
            std::lock_guard<std::mutex> lock(mutex);
            out.swap(items);
            return out;
        }
    } done;

    // Where a drained answer goes. Injected rather than called directly so this transport knows
    // nothing about the ServiceManager — and, more to the point, so every write to that manager
    // happens inside an event handler on the main loop rather than on a worker thread. It is the
    // seam that keeps the manager single-threaded.
    ResultSink sink;

    std::vector<std::thread> workers;
    std::thread monitor;
    std::thread streamThread;
    std::atomic<bool> streaming{false};

    void report(GrpcCmd cmd, std::uint32_t ticket, std::string json)
    {
        done.push(cmd, ticket, std::move(json));
    }

    // One turn through the chat engine.
    //
    // Deltas are reported as they arrive so the poll can show the answer being written. They are
    // NOT forwarded one per chunk: pretzel-ai re-streams word by word, and a queue entry (plus a
    // JSON document, plus a lock) per word would cost more than the answer. Batched to roughly a
    // poll interval's worth instead — the browser reads every 400ms, so anything finer is
    // invisible to it and pure overhead.
    //
    // Note what this is and is not. The gateway call itself is deliberately non-streaming: the
    // response-side guardrail has to see the whole answer to rule on it. So the text arriving here
    // has already been scanned and cleared, and this streams a decided answer rather than raw
    // tokens. A turn the guardrail blocks produces no deltas at all, which is the correct
    // behaviour — a blocked answer must never appear on screen even briefly.
    std::string runChat(const GrpcMessage& task, std::string& error)
    {
        std::string pending;
        auto flush = [&](bool force)
        {
            if (pending.empty() || (!force && pending.size() < kDeltaBatchChars))
                return;
            report(GrpcCmd::Chat, task.ticket,
                   nlohmann::json{{"partial", true}, {"text", pending}}.dump());
            pending.clear();
        };

        auto outcome = client.chat(task.model, task.message, task.systemPrompt, task.history,
                                   task.sessionId, task.transactionId,
                                   [&](const std::string& delta) { pending += delta; flush(false); });
        flush(true);
        error = std::move(outcome.error);
        return std::move(outcome.resultJson);
    }

    // The only answer here that is a file rather than a document. It still travels the ticket path
    // as JSON — the controller unwraps it and serves the bytes — because a second delivery
    // mechanism for one call would be a transport with two shapes.
    std::string runBenchtestExport(const GrpcMessage& task, std::string& error)
    {
        auto out = client.benchtestExport(task.datasetId);
        error = out.error;
        return nlohmann::json{{"filename", out.filename},
                              {"content", out.content},
                              {"error", out.error}}.dump();
    }

    // Which call each command is, and nothing else. Every line is one command and one client
    // method, so the whole contract with pretzel-ai reads top to bottom — the two that need more
    // than a line are named above rather than expanded inline, which is what used to bury the
    // thirteen that do not.
    std::string invoke(const GrpcMessage& task, std::string& error)
    {
        switch (task.cmd)
        {
        case GrpcCmd::Chat:
            return runChat(task, error);
        case GrpcCmd::BenchtestExport:
            return runBenchtestExport(task, error);

        case GrpcCmd::ListModels:
            return client.listModels(error);
        case GrpcCmd::ApplyConfig:
            return client.applyConfig(task.configJson, error);
        case GrpcCmd::CorpusStatus:
            return client.corpusStatus(error);
        case GrpcCmd::CorpusDocuments:
            return client.corpusDocuments(task.message, task.docset, error);

        case GrpcCmd::BenchtestDatasets:
            return client.benchtestDatasets(task.search, error);
        case GrpcCmd::BenchtestSummary:
            return client.benchtestSummary(task.datasetId, error);
        case GrpcCmd::BenchtestRows:
            return client.benchtestRows(task.datasetId, task.category, task.verdict, task.language,
                                        task.technique, task.checkpoint, task.search, task.offset,
                                        task.limit, task.orderBy, task.descending, error);
        case GrpcCmd::BenchtestUpload:
            return client.benchtestUpload(task.content, task.filename, task.name, task.note,
                                          task.uploadedBy, error);
        case GrpcCmd::BenchtestDelete:
            return client.benchtestDelete(task.datasetId, error);
        case GrpcCmd::BenchtestRunList:
            return client.benchtestRuns(task.datasetId, task.limit, error);
        case GrpcCmd::BenchtestRunInfo:
            return client.benchtestRunInfo(task.runId, task.category, task.verdict, task.language,
                                           task.technique, task.checkpoint, task.search, error);
        case GrpcCmd::BenchtestCases:
            return client.benchtestCases(task.runId, task.cause, task.category, task.verdict,
                                         task.language, task.technique, task.checkpoint,
                                         task.search, task.orderBy, task.descending, task.offset,
                                         task.limit, error);
        case GrpcCmd::BenchtestCase:
            return client.benchtestCase(task.runId, task.seq, error);

        default:
            error = "unroutable command";
            return {};
        }
    }

    void runUnary(const GrpcMessage& task)
    {
        std::string error;
        std::string json = invoke(task, error);

        // Reaching pretzel-ai at all (even to be told the call failed) is routine; not reaching it
        // is the connection-level event worth a warning.
        if (json.empty())
        {
            LOG_WARN("pretzel-ai {} unreachable (ticket={}): {}", grpcCmdToStr(task.cmd),
                     task.ticket, error.empty() ? "no result" : error);
            json = unreachableDoc(task.cmd,
                                  error.empty() ? "pretzel-ai returned no result" : error);
        }
        else if (!error.empty())
        {
            // Answered, and the answer was "no". Distinct from unreachable above and it has to be
            // said out loud: for every other command the refusal reaches a browser holding a screen
            // open on it, but ApplyConfig answers to nobody — so a refused push used to leave this
            // side logging "answered, 37 bytes" while the service went on running the previous
            // configuration. The appliance looked converged and was not.
            LOG_WARN("pretzel-ai {} refused (ticket={}): {}", grpcCmdToStr(task.cmd), task.ticket,
                     error);
        }
        else
        {
            LOG_TRACE("pretzel-ai {} answered (ticket={}, {} bytes)", grpcCmdToStr(task.cmd),
                      task.ticket, json.size());
        }

        report(task.cmd, task.ticket, std::move(json));
    }

    // The stream thread's entry point. Same reasoning as run() above: an exception that leaves a
    // std::thread's function is std::terminate. The card in the browser is holding a window open
    // on this stream and has to be told it ended, which the guard below does by hand — nothing
    // downstream will do it once the generator has stopped yielding.
    void runStreamGuarded(GrpcMessage task)
    {
        const GrpcCmd cmd = task.cmd;
        const std::uint32_t ticket = task.ticket;
        try
        {
            runStream(std::move(task));
        }
        catch (const std::exception& ex)
        {
            LOG_ERROR("pretzel-ai stream threw (ticket={}): {}", ticket, ex.what());
            report(cmd, ticket, unreachableDoc(cmd, ex.what()));
        }
        catch (...)
        {
            LOG_ERROR("pretzel-ai stream threw a non-standard exception (ticket={})", ticket);
            report(cmd, ticket, unreachableDoc(cmd, "an unknown error"));
        }
    }

    void runStream(GrpcMessage task)
    {
        // Cleared however this function leaves, not on the way past the last line. It is the flag
        // that says a stream is in flight, and an exception on the normal path used to leave it
        // set for the life of the process — after which every tech-doc refresh and every benchtest
        // run was refused as "one is already running", with nothing running.
        struct ClearStreaming
        {
            std::atomic<bool>& flag;
            ~ClearStreaming() { flag.store(false); }
        } clearStreaming{streaming};

        std::string error;
        bool sawFinal = false;
        const char* what = task.cmd == GrpcCmd::BenchtestRun ? "benchtest run" : "tech-doc refresh";

        // The serializer puts a space after the colon ("final": true), so a pattern without one
        // never matches and every completed stream reported itself as one that died.
        auto onProgress = [this, &task, &sawFinal, what](const std::string& json)
        {
            if (json.find("\"final\"") != std::string::npos
                && json.find("true", json.find("\"final\"")) != std::string::npos)
                sawFinal = true;
            LOG_DEBUG("{} progress: {}", what, json.substr(0, 160));
            report(task.cmd, task.ticket, json);
        };

        if (task.cmd == GrpcCmd::BenchtestRun)
            client.benchtestRun(task.datasetId, task.category, task.verdict, task.language,
                                task.technique, task.search, task.workers, task.name,
                                task.note, onProgress, error);
        else
            client.refreshCorpus(task.message, onProgress, error);

        // Only synthesize a terminal message when the server never sent one; otherwise the
        // server's own final message is the more accurate account of what happened.
        if (!sawFinal)
        {
            // A cancelled stream also ends without a final message, but it is not a failure — the
            // operator asked for it, and the pages already written stay written. Reported as its
            // own stage so the card can say so instead of showing an error nobody caused.
            const bool cancelled = error.find("CANCELLED") != std::string::npos
                                   || error.find("Cancelled") != std::string::npos;
            if (cancelled)
            {
                LOG_INFO("{} cancelled", what);
                report(task.cmd, task.ticket,
                       R"({"stage":"cancelled","final":true})");
            }
            else
            {
                LOG_WARN("{} ended without a final message: {}", what,
                         error.empty() ? "stream closed" : error);
                report(task.cmd, task.ticket,
                       unreachableDoc(task.cmd,
                                      error.empty() ? "the stream closed" : error));
            }
        }
        else
        {
            LOG_INFO("{} finished", what);
        }
    }

    void run()
    {
        GrpcMessage task;
        while (tasks.pop(task))
        {
            // An exception that leaves a std::thread's function is std::terminate, so a malformed
            // answer from pretzel-ai would take the whole management daemon with it — and this
            // path builds JSON, which throws. Caught per task rather than around the loop: one
            // unusable answer costs its own ticket and nothing else, and the worker stays in the
            // pool. The caller is told the same thing it is told about an unreachable service,
            // because from where it sits the two are the same: no usable answer arrived.
            try
            {
                runUnary(task);
            }
            catch (const std::exception& ex)
            {
                LOG_ERROR("pretzel-ai {} threw (ticket={}): {}", grpcCmdToStr(task.cmd),
                          task.ticket, ex.what());
                report(task.cmd, task.ticket, unreachableDoc(task.cmd, ex.what()));
            }
            catch (...)
            {
                LOG_ERROR("pretzel-ai {} threw a non-standard exception (ticket={})",
                          grpcCmdToStr(task.cmd), task.ticket);
                report(task.cmd, task.ticket, unreachableDoc(task.cmd, "an unknown error"));
            }
        }
    }

    // Watches the gRPC channel and logs every connectivity transition — connect, drop, reconnect.
    // This is what makes a pretzel-ai restart visible from the mgmtd side: READY -> TRANSIENT_
    // FAILURE when it goes down, and back to READY when it returns, with no calls needed in between.
    void monitorLoop()
    {
        int last = client.connectivityState(/*tryToConnect=*/true);
        LOG_INFO("pretzel-ai gRPC channel ({}): {}", target, stateName(last));
        while (!tasks.stopping.load())
        {
            // Block up to 1s for a change, then re-check — the timeout also lets us notice stopping.
            client.waitForStateChange(last, 1000);
            if (tasks.stopping.load())
                break;
            const int now = client.connectivityState(/*tryToConnect=*/false);
            if (now != last)
            {
                LOG_INFO("pretzel-ai gRPC channel: {} -> {}", stateName(last), stateName(now));
                last = now;
            }
        }
    }
};

GrpcClientHandler::GrpcClientHandler(std::string target, std::size_t workers)
    : m_impl(std::make_unique<Impl>(std::move(target)))
{
    if (workers == 0)
        workers = 1;
    m_impl->workers.reserve(workers);
    for (std::size_t i = 0; i < workers; ++i)
        m_impl->workers.emplace_back([this] { m_impl->run(); });

    m_impl->monitor = std::thread(
        [this]
        {
            // Nothing here answers a caller, so a throw has nothing to report to — but it would
            // still be std::terminate, and losing the daemon because a channel-state log line
            // failed to format would be an absurd way to go. The watch stops; calls do not need it.
            try
            {
                m_impl->monitorLoop();
            }
            catch (const std::exception& ex)
            {
                LOG_ERROR("the pretzel-ai channel watch stopped: {}", ex.what());
            }
            catch (...)
            {
                LOG_ERROR("the pretzel-ai channel watch stopped on a non-standard exception");
            }
        });
}

GrpcClientHandler::~GrpcClientHandler()
{
    // The flag first, then the wake: a worker parked in pop() is waiting on the condition variable
    // and would sleep through a notify that arrived before the flag it re-checks.
    m_impl->tasks.stopping.store(true);
    m_impl->tasks.cv.notify_all();

    for (auto& t : m_impl->workers)
        if (t.joinable())
            t.join();
    if (m_impl->monitor.joinable())
        m_impl->monitor.join();
    // Last, and not cancelled: a stream is a crawl someone started, and the pages it has written
    // are written. It notices the flag on its next progress callback.
    if (m_impl->streamThread.joinable())
        m_impl->streamThread.join();
}

void GrpcClientHandler::setResultSink(ResultSink sink)
{
    m_impl->sink = std::move(sink);
}

void GrpcClientHandler::egress(GrpcMessage message)
{
    // Cancel does not queue. Every other command waits its turn behind the worker pool, but a
    // cancel that waited would be a cancel that arrives after the thing it was cancelling — and
    // the operator pressed it because they want the crawl to stop now. It reaches the in-flight
    // call's context directly (GrpcClient::cancel*), which is why it needs no thread of its own.
    if (message.cmd == GrpcCmd::CorpusCancel)
    {
        LOG_INFO("cancelling the in-flight tech-doc refresh");
        m_impl->client.cancelRefresh();
        return;
    }
    if (message.cmd == GrpcCmd::BenchtestCancel)
    {
        LOG_INFO("cancelling the in-flight benchtest run");
        m_impl->client.cancelBenchtestRun();
        return;
    }

    // A stream gets its own thread rather than a worker: one runs for the better part of an hour,
    // and a pool of N would be a pool of N-1 for that long.
    if (grpcCmdStreams(message.cmd))
    {
        // Whether a second refresh is allowed was already decided by the ServiceManager; this
        // guard is only here so a bug there cannot leave two threads crawling at once.
        bool expected = false;
        if (!m_impl->streaming.compare_exchange_strong(expected, true))
        {
            LOG_WARN("refusing a second {} while one is in flight", grpcCmdToStr(message.cmd));
            m_impl->report(message.cmd, message.ticket,
                           unreachableDoc(message.cmd, "a refresh is already running"));
            return;
        }
        // The previous stream's thread has finished its work but may not have been joined yet.
        // Reached only after the CAS above succeeded, so it is never a join on a live stream.
        if (m_impl->streamThread.joinable())
            m_impl->streamThread.join();
        m_impl->streamThread =
            std::thread([this, message = std::move(message)]() mutable
                        { m_impl->runStreamGuarded(std::move(message)); });
        return;
    }

    // Everything else is one unary call, and waits its turn.
    m_impl->tasks.push(std::move(message));
}

void GrpcClientHandler::poll()
{
    // Idle fast path: a cheap peek, no work when no worker has produced an answer since the last
    // tick. Only when the queue is non-empty do we take the delivery path.
    if (m_impl->done.empty())
        return;
    drain();
}

void GrpcClientHandler::drain()
{
    auto ready = m_impl->done.take();
    if (ready.empty() || !m_impl->sink)
        return;
    for (auto& [cmd, ticket, json] : ready)
        m_impl->sink(cmd, ticket, std::move(json));
}


}

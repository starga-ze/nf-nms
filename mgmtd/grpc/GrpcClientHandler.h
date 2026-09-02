#pragma once

#include "grpc/GrpcMessage.h"
#include "grpc/GrpcProtocol.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace pz::mgmtd
{

// The egress handler for the pretzel-ai gRPC transport — the gRPC analogue of IpcClientHandler.
// It exists so a call keeps the same shape it had over IPC: the HTTP thread dispatches and returns
// a ticket immediately, and the answer is delivered later, on the main loop thread, exactly where
// an IPC response would have arrived.
//
// A call blocks for as long as pretzel-ai takes — seconds for a turn, minutes for a corpus
// refresh — so calls run on worker threads; mgmtd otherwise runs a single event loop and blocking
// it would freeze the whole console. Answers do NOT cross back on those threads: they are parked
// on a completion queue and handed to the sink during drain(), which the core calls on the loop
// thread. Every write to the ServiceManager therefore happens on the one thread it was designed
// for, mutex-free.
//
// The handler holds no state about what a call meant. It reports (cmd, ticket, json) and stops
// there; whether that answer resolves a ticket, overwrites a live slot, or ends a run is decided
// by the event it becomes. Refresh in particular is single-flight, and that decision is the
// ServiceManager's — a transport that owned it would be a transport holding domain truth.
//
// This header is deliberately free of any gRPC/protobuf type, so the router and controllers that
// use it never pull the generated headers into their translation units.
class GrpcClientHandler
{
public:
    // Delivered on the drain (main loop) thread. `json` is the server's reply already rendered as
    // JSON; a streaming call delivers many times under the same cmd.
    using ResultSink = std::function<void(GrpcCmd cmd, std::uint32_t ticket, std::string json)>;

    // target is host:port, e.g. "127.0.0.1:50051". workers bounds concurrent in-flight unary calls;
    // a streaming call gets a thread of its own so it cannot occupy one for minutes.
    explicit GrpcClientHandler(std::string target, std::size_t workers = 4);
    ~GrpcClientHandler();

    GrpcClientHandler(const GrpcClientHandler&) = delete;
    GrpcClientHandler& operator=(const GrpcClientHandler&) = delete;

    // Where answers are filed. Wired once at startup; invoked only from drain().
    void setResultSink(ResultSink sink);

    // Called on the MAIN LOOP when the channel comes back after having been down.
    //
    // The watch runs on its own thread and cannot make this call itself: what it would want to do
    // — re-read the running config and push it — touches the config cache and the tx router, and
    // both of those belong to the loop. So the watch raises a flag and poll() below delivers it
    // here, on the thread that may act on it.
    using ReconnectSink = std::function<void()>;
    void setReconnectSink(ReconnectSink sink);

    // Dispatch one call. Returns immediately; answers arrive later via poll().
    void egress(GrpcMessage message);

    // Pump this transport, alongside IpcClient::poll() and HttpServer::poll() in
    // MgmtdProcess::tick(). Peeks the completion queue and, when a worker has produced an answer,
    // drains it to the sink on the calling (main loop) thread. Cheap and non-blocking when idle.
    void poll();

private:
    // Deliver every pending answer to the sink. Split from poll() so the common idle path is a
    // cheap peek and the delivery only runs when there is something to deliver.
    void drain();

    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

}

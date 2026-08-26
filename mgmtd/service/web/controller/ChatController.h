#pragma once

#include "http/HttpMessage.h"

namespace pz::mgmtd
{

class MgmtdServiceManager;

// AI ▸ Assistant, the server half of it.
//
// mgmtd owns no inference logic — it validates the turn, hands it to the pretzel-ai service over
// gRPC (via MgmtdTxRouter::handleGrpcMessage), and serves whatever came back. A turn takes seconds
// and responses here are built on the single loop, so the browser never waits on the socket: POST
// answers 202 with a ticket, pretzel-ai's answer is filed under that ticket when it lands
// (GrpcClientHandler::drain), and the page polls for it — the same shape as the connector tests in
// ApiController. It is also the shape streaming will need: a poll that returns a growing answer is
// an additive change, where a held-open POST would have to be rebuilt into one.
class ChatController
{
public:
    // POST /api/chat  {model, message} → 202 {ticket, status:"pending"}
    void send(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET /api/chat/result?ticket=<n> → {status:"pending"} until pretzel-ai answers, then the turn.
    void result(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);

    // GET /api/chat/models → 202 {ticket, status:"pending"}; the answer is polled on
    // /api/chat/result like a turn is.
    //
    // The catalog lives in pretzel-ai's own config and is asked for rather than mirrored here: the
    // gateway account decides which models are reachable, so it is a fact about the daemon, not a
    // declaration the operator commits. Held in running_config it would be diffed and rolled back
    // like a policy, and rolling the configuration back does not put a model back in the account.
    void models(MgmtdServiceManager& sm, const pz::http::HttpRequest& req, pz::http::HttpResponse& resp);
};

}

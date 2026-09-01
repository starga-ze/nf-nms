#pragma once

#include <chrono>
#include <string>

namespace pz::engined
{

class EnginedServiceManager;
class ChatEvent;

// The assistant's conversations, persisted.
//
// They lived in the operator's browser until now, which meant they were lost on sign-out, invisible
// from a second machine, and capped by a browser quota. None of that was chosen.
//
// engined writes them because engined writes everything: mgmtd holds the session that says who is
// asking and the gRPC channel that produced the answer, and hands the finished turn over by IPC.
// Reads do not come through here — mgmtd selects them directly, the way it reads settings and
// credential state.
class ChatService
{
public:
    void handleEvent(EnginedServiceManager& serviceManager, const ChatEvent& event);

private:
    // One completed turn: the session's own fields, and both halves of the exchange. Written
    // together because a turn is one thing — a pair that could half-land would leave a question on
    // screen with no answer under it.
    void storeTurn(const std::string& payloadJson);
    void removeSession(const std::string& payloadJson);
    void patchSession(const std::string& payloadJson);

    // Conversations past the window. Swept on a write rather than on a timer: engined has no clock
    // of its own here, and a person who is not talking to the assistant has nothing to prune.
    void pruneIfDue();
    void prune();

    std::chrono::steady_clock::time_point m_lastPrune{};
};

}

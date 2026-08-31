#pragma once

#include "service/bootstrap/BootstrapAction.h"
#include "service/bootstrap/BootstrapEvent.h"

#include <chrono>
#include <memory>

namespace pz::mgmtd
{

class MgmtdServiceManager;
class MgmtdEventFactory;
class MgmtdActionFactory;

class BootstrapService
{
public:
    enum class State
    {
        Init,
        WaitServerHello,
        Ready,
        Running,
        Failed
    };

    BootstrapService(MgmtdEventFactory* eventFactory, MgmtdActionFactory* actionFactory);

    ~BootstrapService() = default;

    void start();

    std::unique_ptr<MgmtdEvent> schedule(std::chrono::steady_clock::time_point now);

    bool isReady() const;

    void handleEvent(MgmtdServiceManager& serviceManager, const BootstrapEvent& event);

    void handleAction(MgmtdServiceManager& serviceManager, const BootstrapAction& action);

private:
    void onServerHello(MgmtdServiceManager& serviceManager, const pz::ipc::IpcMessage& msg);

    void onRuntimeStart(MgmtdServiceManager& serviceManager, const pz::ipc::IpcMessage& msg);

    // Success and failure both arrive as ConfigReloadResponse; this is where they are told apart.
    void onConfigReloadResponse(MgmtdServiceManager& serviceManager, const pz::ipc::IpcMessage& msg);

    bool checkTimeout(std::chrono::steady_clock::time_point now, const char* stateName);

    std::unique_ptr<pz::ipc::IpcMessage> buildClientHelloMessage() const;
    std::unique_ptr<pz::ipc::IpcMessage> buildRuntimeReadyMessage() const;

private:
    MgmtdEventFactory* m_eventFactory{nullptr};
    MgmtdActionFactory* m_actionFactory{nullptr};

    State m_state{State::Init};

    std::chrono::steady_clock::time_point m_startedAt{};
    std::chrono::steady_clock::time_point m_lastClientHelloSentAt{};
};

}

#pragma once

#include "service/bootstrap/BootstrapAction.h"
#include "service/bootstrap/BootstrapEvent.h"

#include "ipc/IpcProtocol.h"

#include <chrono>
#include <memory>
#include <unordered_map>

namespace pz::engined
{

class EnginedServiceManager;
class EnginedEventFactory;
class EnginedActionFactory;

class BootstrapService
{
public:
    enum class State
    {
        Init,
        WaitHandshake,
        Reconcile
    };

    BootstrapService(EnginedEventFactory* eventFactory, EnginedActionFactory* actionFactory);

    ~BootstrapService() = default;

    void start();
    void scheduleServiceReload();

    std::unique_ptr<EnginedEvent> schedule(std::chrono::steady_clock::time_point now);

    bool isReady() const;

    void handleEvent(EnginedServiceManager& serviceManager, const BootstrapEvent& event);

    void handleAction(EnginedServiceManager& serviceManager, const BootstrapAction& action);

private:
    void onServerHello(EnginedServiceManager& serviceManager, const pz::ipc::IpcMessage& msg);

    void onSyncResponse(EnginedServiceManager& serviceManager, const pz::ipc::IpcMessage& msg);

    void warnIfBootSlow(std::chrono::steady_clock::time_point now, const char* stateName);

    void initProcessMap();
    bool updateProcessMap(const pz::ipc::IpcMessage& msg);
    bool isProcessReady(pz::ipc::IpcDaemon daemon) const;
    bool isAllProcessReady() const;
    void dumpProcessMap() const;

    std::unique_ptr<pz::ipc::IpcMessage> buildClientHelloMessage() const;
    std::unique_ptr<pz::ipc::IpcMessage> buildSyncRequestMessage() const;
    std::unique_ptr<pz::ipc::IpcMessage> buildRuntimeStartMessage() const;
    std::unique_ptr<pz::ipc::IpcMessage> buildSettingsCommitResponse(bool ok) const;

private:
    EnginedEventFactory* m_eventFactory{nullptr};
    EnginedActionFactory* m_actionFactory{nullptr};

    State m_state{State::Init};

    std::chrono::steady_clock::time_point m_startedAt{};
    std::chrono::steady_clock::time_point m_lastClientHelloSentAt{};
    std::chrono::steady_clock::time_point m_lastSyncRequestSentAt{};
    std::chrono::steady_clock::time_point m_lastBootWarnAt{};

    struct ProcessState
    {
        bool connected = false;
        uint64_t appliedVersion = 0;
        uint32_t generation = 0;
        uint32_t blessedGeneration = 0;
    };

    uint64_t m_targetVersion{0};

    std::unordered_map<pz::ipc::IpcDaemon, ProcessState> m_processMap;

    bool m_isReload{false};
    bool m_bootstrapped{false};

    std::chrono::steady_clock::time_point m_reloadStartedAt{};
};

}

#include "service/commit/CommitService.h"

#include "service/EnginedServiceManager.h"
#include "service/commit/CommitAction.h"
#include "service/commit/CommitEvent.h"

#include "action/EnginedActionFactory.h"
#include "config/Config.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "util/Logger.h"

#include <nlohmann/json.hpp>

namespace pz::engined
{

using json = nlohmann::json;

const char* CommitService::statusStr(TaskStatus s)
{
    switch (s)
    {
    case TaskStatus::Pending:
        return "pending";
    case TaskStatus::Running:
        return "running";
    case TaskStatus::Done:
        return "done";
    case TaskStatus::Failed:
        return "failed";
    }
    return "unknown";
}

void CommitService::sendQueueStatus(EnginedServiceManager& serviceManager) const
{
    json arr = json::array();
    for (const auto& t : m_queue)
    {
        arr.push_back({{"id", t.id}, {"status", statusStr(t.status)}});
    }

    const std::string payload = arr.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Engined);
    msg->setDst(pz::ipc::IpcDaemon::Mgmtd);
    msg->setCmd(pz::ipc::IpcCmd::SettingsCommitStatus);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Response));
    msg->setPayload(std::vector<uint8_t>(payload.begin(), payload.end()));

    serviceManager.txRouter().handleIpcMessage(std::move(msg));
    LOG_DEBUG("queue snapshot sent (tasks={})", m_queue.size());
}

void CommitService::startNext(EnginedServiceManager& serviceManager)
{
    for (auto& t : m_queue)
    {
        if (t.status != TaskStatus::Pending)
            continue;

        t.status = TaskStatus::Running;
        sendQueueStatus(serviceManager);

        auto action = serviceManager.actionFactory()->create(EnginedActionDomain::Commit,
                static_cast<std::uint32_t>(CommitActionType::ApplyCommit));
        serviceManager.postAction(std::move(action));
        return;
    }
}

void CommitService::handleEvent(EnginedServiceManager& serviceManager, const CommitEvent& event)
{
    switch (event.type())
    {
    case CommitEventType::ReceiveSettingsCommit:
    {
        const pz::ipc::IpcMessage* msg = event.message();
        if (!msg || msg->getPayload().empty())
        {
            LOG_ERROR("SettingsCommitRequest payload is empty");
            return;
        }

        Task task;
        task.id = m_nextId++;
        task.payload = msg->getPayload();
        task.status = TaskStatus::Pending;
        m_queue.push_back(std::move(task));

        LOG_INFO("task enqueued (id={}, queue_size={})", m_queue.back().id, m_queue.size());
        sendQueueStatus(serviceManager);

        const bool anyRunning =
            std::any_of(m_queue.begin(), m_queue.end(), [](const Task& t) { return t.status == TaskStatus::Running; });

        if (!anyRunning)
            startNext(serviceManager);

        break;
    }

    case CommitEventType::ReloadComplete:
    {
        for (auto& t : m_queue)
        {
            if (t.status == TaskStatus::Running)
            {
                t.status = TaskStatus::Done;
                LOG_DEBUG("task done (id={})", t.id);
                break;
            }
        }

        while (m_queue.size() > 5 || (!m_queue.empty() && (m_queue.front().status == TaskStatus::Done ||
                                                           m_queue.front().status == TaskStatus::Failed)))
        {
            m_queue.pop_front();
        }

        sendQueueStatus(serviceManager);
        startNext(serviceManager);
        break;
    }

    case CommitEventType::ReloadFailed:
    {
        for (auto& t : m_queue)
        {
            if (t.status == TaskStatus::Running)
            {
                t.status = TaskStatus::Failed;
                LOG_ERROR("task failed, reload did not converge (id={})", t.id);
                break;
            }
        }

        while (m_queue.size() > 5 || (!m_queue.empty() && (m_queue.front().status == TaskStatus::Done ||
                                                           m_queue.front().status == TaskStatus::Failed)))
        {
            m_queue.pop_front();
        }

        sendQueueStatus(serviceManager);
        startNext(serviceManager);
        break;
    }

    default:
        LOG_WARN("unhandled event (type={})", static_cast<std::uint32_t>(event.type()));
        break;
    }
}

void CommitService::handleAction(EnginedServiceManager& serviceManager, const CommitAction& action)
{
    switch (action.type())
    {
    case CommitActionType::ApplyCommit:
    {
        Task* running = nullptr;
        for (auto& t : m_queue)
        {
            if (t.status == TaskStatus::Running)
            {
                running = &t;
                break;
            }
        }

        if (!running)
        {
            LOG_ERROR("ApplyCommit fired but no Running task found");
            return;
        }

        json changes;
        try
        {
            changes = json::parse(running->payload.begin(), running->payload.end());
        }
        catch (const std::exception& e)
        {
            LOG_ERROR("failed to parse commit payload (error={})", e.what());
            running->status = TaskStatus::Failed;
            sendQueueStatus(serviceManager);
            startNext(serviceManager);
            return;
        }

        if (!changes.is_array())
        {
            LOG_ERROR("payload root must be a JSON array");
            running->status = TaskStatus::Failed;
            sendQueueStatus(serviceManager);
            startNext(serviceManager);
            return;
        }

        int applied = 0;
        int failed = 0;

        json root = pz::config::Config::runningConfigRoot();

        for (const auto& change : changes)
        {
            const std::string scopeName = change.value("scope", "");
            const std::string domain = change.value("domain", "");

            if (scopeName.empty() || domain.empty() || !change.contains("values"))
            {
                LOG_WARN("skipping malformed change entry");
                failed++;
                continue;
            }

            const json& values = change["values"];
            if (!values.is_object())
            {
                LOG_WARN("'values' not object (scope={}, domain={})", scopeName, domain);
                failed++;
                continue;
            }

            // Two levels now, not three. The system/service split under each daemon was there to
            // say "infrastructure" versus "what an operator picked"; the scope says that instead —
            // `global` is the infrastructure, and mgmtd refuses to route a change addressing it.
            root[scopeName][domain].merge_patch(values);
            LOG_DEBUG("staged (scope={}, domain={}, keys={})", scopeName, domain, values.size());
            applied++;
        }

        if (applied == 0)
        {
            LOG_ERROR("no changes staged, task failed (id={})", running->id);
            running->status = TaskStatus::Failed;
            sendQueueStatus(serviceManager);
            startNext(serviceManager);
            return;
        }

        if (!pz::config::Config::commitConfig(root))
        {
            LOG_ERROR("commitConfig failed, task failed (id={})", running->id);
            running->status = TaskStatus::Failed;
            sendQueueStatus(serviceManager);
            startNext(serviceManager);
            return;
        }

        LOG_INFO("committed new running_config version, scheduling reload "
                 "(id={}, staged={}, skipped={})",
                 running->id, applied, failed);

        // Intentionally skips following daemon (i.e., engined, ipcd, mgmtd)
        static constexpr pz::ipc::IpcDaemon kServiceDaemons[] = {
            pz::ipc::IpcDaemon::Authd,
            pz::ipc::IpcDaemon::Probed,
            pz::ipc::IpcDaemon::Collectord,
            pz::ipc::IpcDaemon::Topologyd,
            pz::ipc::IpcDaemon::Apid
        };

        for (const auto dst : kServiceDaemons)
        {
            auto cfgMsg = std::make_unique<pz::ipc::IpcMessage>();
            cfgMsg->setSrc(pz::ipc::IpcDaemon::Engined);
            cfgMsg->setDst(dst);
            cfgMsg->setCmd(pz::ipc::IpcCmd::ConfigApply);
            cfgMsg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Request));
            serviceManager.txRouter().handleIpcMessage(std::move(cfgMsg));
            LOG_DEBUG("ConfigReload sent (dst={})", pz::ipc::IpcProtocol::daemonToStr(dst));
        }

        pz::config::Config::invalidateConfigCache();
        serviceManager.bootstrapService().scheduleServiceReload();
        break;
    }

    default:
        LOG_WARN("unhandled action (type={})", static_cast<std::uint32_t>(action.type()));
        break;
    }
}

}

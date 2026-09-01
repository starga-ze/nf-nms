#include "service/MgmtdServiceManager.h"

#include "config/Config.h"
#include "util/Logger.h"

#include <chrono>

namespace pz::mgmtd
{

MgmtdServiceManager::MgmtdServiceManager(MgmtdEventFactory* eventFactory, MgmtdActionFactory* actionFactory,
                                         MgmtdTxRouter* txRouter)
    : m_eventFactory(eventFactory), m_actionFactory(actionFactory), m_txRouter(txRouter),
      m_bootstrapService(std::make_unique<BootstrapService>(m_eventFactory, m_actionFactory)),
      m_heartbeatService(std::make_unique<HeartbeatService>())
{
}

void MgmtdServiceManager::start()
{
    m_metricService.start();
    m_bootstrapService->start();
}

void MgmtdServiceManager::schedule()
{
    const auto now = std::chrono::steady_clock::now();

    if (!m_bootstrapService->isReady())
    {
        postEvent(m_bootstrapService->schedule(now));
        return;
    }

    m_metricService.tick(now);
}

void MgmtdServiceManager::postEvent(std::unique_ptr<MgmtdEvent> event)
{
    if (!event)
    {
        return;
    }

    m_eventQueue.push(std::move(event));
}

void MgmtdServiceManager::postAction(std::unique_ptr<MgmtdAction> action)
{
    if (!action)
    {
        return;
    }

    m_actionQueue.push(std::move(action));
}

void MgmtdServiceManager::execute()
{
    while (!m_eventQueue.empty() or !m_actionQueue.empty())
    {
        if (!m_eventQueue.empty())
        {
            std::unique_ptr<MgmtdEvent> event = std::move(m_eventQueue.front());
            m_eventQueue.pop();
            event->dispatch(*this);
        }
        else if (!m_actionQueue.empty())
        {
            std::unique_ptr<MgmtdAction> action = std::move(m_actionQueue.front());
            m_actionQueue.pop();
            action->dispatch(*this);
        }
    }
}

AuthService& MgmtdServiceManager::authService()
{
    return m_authService;
}

MetricService& MgmtdServiceManager::metricService()
{
    return m_metricService;
}

BootstrapService& MgmtdServiceManager::bootstrapService()
{
    return *m_bootstrapService;
}

HeartbeatService& MgmtdServiceManager::heartbeatService()
{
    return *m_heartbeatService;
}

WebService& MgmtdServiceManager::webService()
{
    return m_webService;
}

MgmtdTxRouter& MgmtdServiceManager::txRouter()
{
    return *m_txRouter;
}

void MgmtdServiceManager::startReload()
{
    m_reloadStartedAt = std::chrono::steady_clock::now();
    m_reloadStatus.store(static_cast<int>(ReloadStatus::Reloading), std::memory_order_release);
    LOG_INFO("reload started");
}

void MgmtdServiceManager::completeReload()
{
    pz::config::Config::invalidateConfigCache();
    m_reloadStatus.store(static_cast<int>(ReloadStatus::Complete), std::memory_order_release);
    LOG_INFO("reload complete (elapsed_ms={})", reloadElapsedMs());
}

void MgmtdServiceManager::failReload()
{
    // The cache is invalidated on a failure too: engined committed the new running_config before it
    // asked the fleet to converge, so what mgmtd holds is stale either way. What failed is the
    // convergence, not the write.
    pz::config::Config::invalidateConfigCache();
    m_reloadStatus.store(static_cast<int>(ReloadStatus::Failed), std::memory_order_release);
    LOG_ERROR("reload failed (elapsed_ms={})", reloadElapsedMs());
}

MgmtdServiceManager::ReloadStatus MgmtdServiceManager::reloadStatus() const
{
    return static_cast<ReloadStatus>(m_reloadStatus.load(std::memory_order_acquire));
}

std::int64_t MgmtdServiceManager::reloadElapsedMs() const
{
    if (reloadStatus() == ReloadStatus::Idle)
        return 0;
    const auto elapsed = std::chrono::steady_clock::now() - m_reloadStartedAt;
    return std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();
}

void MgmtdServiceManager::setCommitQueue(std::string snapshotJson)
{
    LOG_DEBUG("CommitQueue Update ({})", snapshotJson);
    m_commitQueueSnapshot = std::move(snapshotJson);
}

std::string MgmtdServiceManager::commitQueueSnapshot() const
{
    return m_commitQueueSnapshot;
}

void MgmtdServiceManager::setTopology(const std::string& siteOid, std::string modelJson)
{
    m_topology[siteOid] = std::move(modelJson);
    m_topologyAt[siteOid] = std::chrono::steady_clock::now();
    m_topologyAsked.erase(siteOid);
}

bool MgmtdServiceManager::topologyFresh(const std::string& siteOid, std::chrono::seconds within) const
{
    const auto it = m_topologyAt.find(siteOid);
    return it != m_topologyAt.end() && (std::chrono::steady_clock::now() - it->second) < within;
}

// An outstanding request expires: topologyd may have died mid-compose, and a site stuck "in flight"
// forever would never be asked again.
bool MgmtdServiceManager::topologyRequested(const std::string& siteOid) const
{
    const auto it = m_topologyAsked.find(siteOid);
    return it != m_topologyAsked.end() &&
           (std::chrono::steady_clock::now() - it->second) < std::chrono::seconds(10);
}

void MgmtdServiceManager::markTopologyRequested(const std::string& siteOid)
{
    m_topologyAsked[siteOid] = std::chrono::steady_clock::now();
}

const std::string* MgmtdServiceManager::topology(const std::string& siteOid) const
{
    const auto it = m_topology.find(siteOid);
    return it == m_topology.end() ? nullptr : &it->second;
}

void MgmtdServiceManager::setApiTestResult(std::uint32_t ticket, std::string resultJson)
{
    if (m_apiTestResults.size() > 256)
    {
        m_apiTestResults.clear();
    }
    m_apiTestResults[ticket] = std::move(resultJson);
}

std::optional<std::string> MgmtdServiceManager::takeApiTestResult(std::uint32_t ticket)
{
    auto it = m_apiTestResults.find(ticket);
    if (it == m_apiTestResults.end())
    {
        return std::nullopt;
    }
    std::string out = std::move(it->second);
    m_apiTestResults.erase(it);
    return out;
}

void MgmtdServiceManager::setChatContext(std::uint32_t ticket, ChatContext ctx)
{
    // Bounded the same way the results are, and for the same reason: a browser that navigated away
    // never comes back for its ticket, and a question nobody will ever see the answer to is worth
    // nothing. Cleared wholesale rather than aged — the map is small and the alternative is a
    // timestamp per entry to serve a case that costs one lost turn.
    if (m_chatContexts.size() > 256)
        m_chatContexts.clear();
    m_chatContexts[ticket] = std::move(ctx);
}

std::optional<MgmtdServiceManager::ChatContext> MgmtdServiceManager::takeChatContext(std::uint32_t ticket)
{
    const auto it = m_chatContexts.find(ticket);
    if (it == m_chatContexts.end())
        return std::nullopt;
    ChatContext out = std::move(it->second);
    m_chatContexts.erase(it);
    return out;
}

void MgmtdServiceManager::setChatResult(std::uint32_t ticket, std::string resultJson)
{
    // A browser that navigated away never drains its ticket, so the map is bounded the same way
    // the test results are: an answer nobody came back for is worth nothing.
    if (m_chatResults.size() > 256)
    {
        m_chatResults.clear();
    }
    m_chatResults[ticket] = std::move(resultJson);
}

std::optional<std::string> MgmtdServiceManager::takeChatResult(std::uint32_t ticket)
{
    auto it = m_chatResults.find(ticket);
    if (it == m_chatResults.end())
    {
        return std::nullopt;
    }
    std::string out = std::move(it->second);
    m_chatResults.erase(it);
    // The turn is over; whatever was accumulating for it is now dead weight.
    m_chatPartials.erase(ticket);
    return out;
}

void MgmtdServiceManager::appendChatPartial(std::uint32_t ticket, const std::string& delta)
{
    // Bounded like the result map, and for the same reason — a browser that closed mid-answer
    // leaves a partial nobody will ever poll for.
    if (m_chatPartials.size() > 256)
    {
        m_chatPartials.clear();
    }
    m_chatPartials[ticket] += delta;
}

std::string MgmtdServiceManager::chatPartial(std::uint32_t ticket) const
{
    const auto it = m_chatPartials.find(ticket);
    return it == m_chatPartials.end() ? std::string() : it->second;
}

void MgmtdServiceManager::setRetrievalResult(std::uint32_t ticket, std::string resultJson)
{
    // Bounded like the others: a page that navigated away mid-turn leaves its passages
    // behind, and a retrieval nobody came back for is worth nothing.
    if (m_retrievalResults.size() > 256)
    {
        m_retrievalResults.clear();
    }
    m_retrievalResults[ticket] = std::move(resultJson);
}

std::optional<std::string> MgmtdServiceManager::takeRetrievalResult(std::uint32_t ticket)
{
    auto it = m_retrievalResults.find(ticket);
    if (it == m_retrievalResults.end())
    {
        return std::nullopt;
    }
    std::string out = std::move(it->second);
    m_retrievalResults.erase(it);
    return out;
}

void MgmtdServiceManager::setSsoResult(std::uint32_t ticket, std::string resultJson)
{
    if (m_ssoResults.size() > 256)
    {
        m_ssoResults.clear();
    }
    m_ssoResults[ticket] = std::move(resultJson);
}

std::optional<std::string> MgmtdServiceManager::takeSsoResult(std::uint32_t ticket)
{
    auto it = m_ssoResults.find(ticket);
    if (it == m_ssoResults.end())
    {
        return std::nullopt;
    }
    std::string out = std::move(it->second);
    m_ssoResults.erase(it);
    return out;
}

void MgmtdServiceManager::setStaticCache(std::shared_ptr<pz::http::StaticFileCache> cache)
{
    m_staticCache = std::move(cache);
}

const std::shared_ptr<pz::http::StaticFileCache>& MgmtdServiceManager::staticCache() const
{
    return m_staticCache;
}

std::uint32_t MgmtdServiceManager::nextSsoTicket()
{
    return m_ssoTicket++;
}

std::uint32_t MgmtdServiceManager::nextApiTestTicket()
{
    return m_apiTestTicket++;
}

bool MgmtdServiceManager::beginCorpusRefresh()
{
    if (m_corpusRefreshing)
    {
        return false;
    }
    m_corpusRefreshing = true;
    // Cleared rather than kept: the previous run's final message would otherwise be served to the
    // first poll of this one, which reads as a refresh that finished before it started.
    m_corpusProgress.clear();
    return true;
}

void MgmtdServiceManager::setCorpusProgress(std::string json, bool finished)
{
    m_corpusProgress = std::move(json);
    if (finished)
    {
        m_corpusRefreshing = false;
    }
}

bool MgmtdServiceManager::beginBenchtestRun()
{
    if (m_benchtestRunning)
    {
        return false;
    }
    m_benchtestRunning = true;
    // Cleared for the same reason the corpus slot is: the previous run's final message would
    // otherwise be served to the first poll of this one, which reads as a run that finished
    // before it started.
    m_benchtestProgress.clear();
    m_benchtestCases.clear();
    return true;
}

void MgmtdServiceManager::setBenchtestProgress(std::string json, bool finished)
{
    m_benchtestProgress = std::move(json);
    if (finished)
    {
        m_benchtestRunning = false;
    }
}

void MgmtdServiceManager::queueBenchtestCase(std::string json)
{
    constexpr std::size_t kMaxQueued = 2000;
    if (m_benchtestCases.size() >= kMaxQueued)
    {
        // Drop the oldest rather than the newest: a console that fell behind wants to catch up to
        // where the run is now, not to read a transcript from ten minutes ago.
        m_benchtestCases.erase(m_benchtestCases.begin());
    }
    m_benchtestCases.push_back(std::move(json));
}

std::vector<std::string> MgmtdServiceManager::takeBenchtestCases()
{
    std::vector<std::string> out;
    out.swap(m_benchtestCases);
    return out;
}

const std::string& MgmtdServiceManager::benchtestProgress() const
{
    return m_benchtestProgress;
}

bool MgmtdServiceManager::benchtestRunning() const
{
    return m_benchtestRunning;
}

const std::string& MgmtdServiceManager::corpusProgress() const
{
    return m_corpusProgress;
}

bool MgmtdServiceManager::corpusRefreshing() const
{
    return m_corpusRefreshing;
}

std::uint32_t MgmtdServiceManager::nextChatTicket()
{
    return m_chatTicket++;
}

}

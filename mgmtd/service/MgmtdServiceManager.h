#pragma once

#include "service/ServiceManager.h"

#include "action/MgmtdAction.h"
#include "event/MgmtdEvent.h"

#include "service/auth/AuthService.h"
#include "service/bootstrap/BootstrapService.h"
#include "service/heartbeat/HeartbeatService.h"
#include "service/metrics/MetricService.h"
#include "service/web/WebService.h"

#include "http/StaticFileCache.h"

#include "router/MgmtdTxRouter.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <queue>
#include <string>
#include <unordered_map>
#include <vector>

namespace pz::mgmtd
{

class MgmtdEventFactory;
class MgmtdActionFactory;

class MgmtdServiceManager : public pz::service::ServiceManager<MgmtdEvent, MgmtdAction>
{
public:
    MgmtdServiceManager(MgmtdEventFactory* eventFactory, MgmtdActionFactory* actionFactory, MgmtdTxRouter* txRouter);
    ~MgmtdServiceManager() override = default;

    void start() override;
    void schedule() override;
    void postEvent(std::unique_ptr<MgmtdEvent> event) override;
    void postAction(std::unique_ptr<MgmtdAction> action) override;
    void execute() override;

    AuthService& authService();
    MetricService& metricService();
    BootstrapService& bootstrapService();
    HeartbeatService& heartbeatService();
    WebService& webService();

    MgmtdTxRouter& txRouter();

    // A commit's reload has three outcomes, not two. `Failed` exists because engined answers a
    // reload that did not converge with the same command it answers a successful one, and folding
    // that into Complete told the browser a failed publish had succeeded.
    enum class ReloadStatus
    {
        Idle,
        Reloading,
        Complete,
        Failed
    };
    void startReload();
    void completeReload();
    void failReload();
    ReloadStatus reloadStatus() const;
    std::int64_t reloadElapsedMs() const;

    void setCommitQueue(std::string snapshotJson);
    std::string commitQueueSnapshot() const;

    void setSsoResult(std::uint32_t ticket, std::string resultJson);
    std::optional<std::string> takeSsoResult(std::uint32_t ticket);

    // API connector tests reach out to a customer device, which may be slow or unreachable, so
    // collectord performs them and answers over IPC. Both ends of this store are on the main loop —
    // MgmtdRxRouter fills it, the polling web handler drains it — so no lock is needed.
    void setApiTestResult(std::uint32_t ticket, std::string resultJson);
    std::optional<std::string> takeApiTestResult(std::uint32_t ticket);

    // The same arrangement for one assistant turn: inferd calls the AI gateway, which takes
    // seconds, and answers on the ticket the browser is polling. Filed by the WebIpcEvent handler,
    // drained by the poll route — both on the main loop, so no lock.
    void setChatResult(std::uint32_t ticket, std::string resultJson);
    std::optional<std::string> takeChatResult(std::uint32_t ticket);

    // The answer as it is being written, for the poll to show before the turn resolves.
    //
    // Read rather than taken: a poll every 400ms would otherwise consume the text it just showed,
    // and the next one would start again from empty. The slot is dropped by takeChatResult —
    // the final document carries the whole reply, and a partial surviving past it is only a
    // second, staler copy of the same words.
    void appendChatPartial(std::uint32_t ticket, const std::string& delta);
    std::string chatPartial(std::uint32_t ticket) const;

    // A grounded turn answers twice on one ticket: the passages as soon as they are found,
    // the answer when the model returns. Kept in its own slot so the second does not
    // overwrite the first — the page shows what was retrieved while the model is still
    // working, which is the whole point of splitting them.
    void setRetrievalResult(std::uint32_t ticket, std::string resultJson);
    std::optional<std::string> takeRetrievalResult(std::uint32_t ticket);

    // The tech-doc refresh: one live slot, not a ticket.
    //
    // A refresh reports progress for minutes and is read by every poll for the duration, so there
    // is nothing to "take" — the browser wants the state now, repeatedly, and a page reloaded
    // mid-crawl has to be able to find it again. Single-flight is decided here rather than in the
    // transport because "is a refresh running" is state, and state on the loop thread lives in the
    // service manager; a handler that owned the answer would be a handler holding domain truth.
    bool beginCorpusRefresh();                      // false: one is already running
    void setCorpusProgress(std::string json, bool finished);
    const std::string& corpusProgress() const;
    bool corpusRefreshing() const;

    // A benchtest run, in the same shape and for the same reasons. Kept as its own slot rather
    // than sharing the corpus one: the two are unrelated operations and a console watching a run
    // must not be handed a crawl's progress because a crawl happened to start.
    bool beginBenchtestRun();                       // false: one is already running
    void setBenchtestProgress(std::string json, bool finished);
    const std::string& benchtestProgress() const;
    bool benchtestRunning() const;

    // Cases finish faster than the console polls, so a slot holding only the latest message loses
    // most of them — a 1,500-prompt run rendered about one line in ten. They queue here instead
    // and a poll takes the whole batch, which is why the list can show every case rather than a
    // sample of them. Bounded: a reader who left the tab for ten minutes wants the tail, not a
    // replay, and an unbounded queue is a memory leak with a nice name.
    void queueBenchtestCase(std::string json);
    std::vector<std::string> takeBenchtestCases();

    // The composed site topology, as topologyd last answered. mgmtd owns no topology logic — it asks
    // and it serves. Kept rather than awaited because an HTTP response here is built synchronously:
    // holding one open for a cross-daemon round trip would block the loop every other daemon's
    // messages arrive on. The page polls on a timer, so "serve the last answer, ask for the next"
    // costs one cycle of freshness and nothing else, and the answer states its own age.
    // Filled by MgmtdRxRouter when topologyd answers; read by the web handler. `requested` marks a
    // composition already in flight so a burst of polls does not fan out into a burst of requests —
    // one outstanding request per site is all that can ever be useful.
    void setTopology(const std::string& siteOid, std::string modelJson);
    const std::string* topology(const std::string& siteOid) const;
    bool topologyFresh(const std::string& siteOid, std::chrono::seconds within) const;
    bool topologyRequested(const std::string& siteOid) const;
    void markTopologyRequested(const std::string& siteOid);

    // Static file cache, set once at startup by MgmtdCore. The web handlers read it from here so
    // they can stay stateless (plain functions in the route table).
    void setStaticCache(std::shared_ptr<pz::http::StaticFileCache> cache);
    const std::shared_ptr<pz::http::StaticFileCache>& staticCache() const;

    // Monotonic ticket ids the web handlers hand to the browser to poll an async result on. Kept
    // here beside the result stores they key into, not on the (now stateless) WebService.
    std::uint32_t nextSsoTicket();
    std::uint32_t nextApiTestTicket();
    std::uint32_t nextChatTicket();

private:
    MgmtdEventFactory* m_eventFactory{nullptr};
    MgmtdActionFactory* m_actionFactory{nullptr};
    MgmtdTxRouter* m_txRouter{nullptr};

    AuthService m_authService;
    MetricService m_metricService;
    std::unique_ptr<BootstrapService> m_bootstrapService;
    std::unique_ptr<HeartbeatService> m_heartbeatService;
    WebService m_webService;

    std::queue<std::unique_ptr<MgmtdEvent>> m_eventQueue;
    std::queue<std::unique_ptr<MgmtdAction>> m_actionQueue;

    std::atomic<int> m_reloadStatus{static_cast<int>(ReloadStatus::Idle)};
    std::chrono::steady_clock::time_point m_reloadStartedAt{};

    std::string m_commitQueueSnapshot{"[]"};

    std::unordered_map<std::uint32_t, std::string> m_ssoResults;

    std::unordered_map<std::uint32_t, std::string> m_apiTestResults;

    std::unordered_map<std::uint32_t, std::string> m_chatResults;
    std::unordered_map<std::uint32_t, std::string> m_chatPartials;
    std::string m_corpusProgress;
    std::string m_benchtestProgress;
    bool m_benchtestRunning{false};
    std::vector<std::string> m_benchtestCases;
    bool m_corpusRefreshing{false};
    std::unordered_map<std::uint32_t, std::string> m_retrievalResults;

    // site oid ('' = every site) -> last composed model. One entry per site the operator has looked
    // at; an estate has tens of sites, not thousands, so this never needs eviction.
    std::unordered_map<std::string, std::string> m_topology;
    // When each site's model arrived, and whether a request for it is outstanding.
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> m_topologyAt;
    std::unordered_map<std::string, std::chrono::steady_clock::time_point> m_topologyAsked;

    std::shared_ptr<pz::http::StaticFileCache> m_staticCache;
    std::uint32_t m_ssoTicket{1};
    std::uint32_t m_apiTestTicket{1};
    std::uint32_t m_chatTicket{1};
};

}

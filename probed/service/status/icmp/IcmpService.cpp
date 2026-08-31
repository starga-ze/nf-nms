#include "service/status/icmp/IcmpService.h"

#include "action/ProbedActionFactory.h"
#include "config/Config.h"
#include "event/ProbedEventFactory.h"
#include "ipc/IpcMessage.h"
#include "ipc/IpcProtocol.h"
#include "router/ProbedTxRouter.h"
#include "service/ProbedServiceManager.h"
#include "util/Logger.h"
#include <nlohmann/json.hpp>

#include <arpa/inet.h>
#include <unistd.h>

#include <algorithm>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace pz::probed
{

namespace
{

const nlohmann::json& probeConfig()
{
    return pz::config::Config::section(pz::config::scope::kPretzel, "probe");
}

std::size_t probeBatchSize()
{
    return probeConfig().value("batch_size", 32);
}

std::chrono::milliseconds probeBatchInterval()
{
    return std::chrono::milliseconds(probeConfig().value("batch_interval_ms", 20));
}

std::chrono::milliseconds replyIdleTimeout()
{
    return std::chrono::seconds(probeConfig().value("reply_idle_timeout_sec", 5));
}

std::chrono::milliseconds replyMaxWaitTimeout()
{
    return std::chrono::seconds(probeConfig().value("reply_max_wait_timeout_sec", 15));
}

std::vector<std::string> probeExcludedIps()
{
    const std::string raw = probeConfig().value("excluded_ips", std::string(""));
    std::vector<std::string> result;
    std::stringstream ss(raw);
    std::string token;
    while (std::getline(ss, token, ','))
    {
        const auto b = token.find_first_not_of(" \t");
        const auto e = token.find_last_not_of(" \t");
        if (b != std::string::npos)
            result.push_back(token.substr(b, e - b + 1));
    }
    return result;
}

// Explicit per-object targets (Inventory). Only `direct` (IP-based) objects are ICMP-probed —
// `tenant` objects have no IP and are health-checked elsewhere. Disabled objects are skipped.
std::vector<std::string> probeExplicitTargets()
{
    std::vector<std::string> result;
    // Only NGFW devices have an address to ping (SASE is reached through its tenant API), so read
    // just the ngfw_devices array. Devices are declared once, next to the sites they belong to.
    const auto& cfg = pz::config::Config::section(pz::config::scope::kPretzel, "site");
    for (const auto& t : cfg.value("ngfw_devices", nlohmann::json::array()))
    {
        if (!t.is_object())
            continue;
        const std::string target = t.value("target", std::string());
        if (!target.empty())
            result.push_back(target);
    }
    return result;
}

}

IcmpService::IcmpService(ProbedEventFactory* eventFactory, ProbedActionFactory* actionFactory)
    : m_eventFactory(eventFactory), m_actionFactory(actionFactory)
{
}

void IcmpService::start()
{
    m_state = State::Idle;

    m_localIps.clear();
    for (const auto& ip : probeExcludedIps())
        m_localIps.insert(ip);

    LOG_INFO("probe service started");
}

std::unique_ptr<ProbedEvent> IcmpService::schedule(std::chrono::steady_clock::time_point now)
{
    if (!m_eventFactory)
    {
        LOG_ERROR("EventFactory is not initialized");
        return nullptr;
    }

    switch (m_state)
    {
    case State::Init:
    case State::Idle:
        return nullptr;

    case State::Sending:
    {
        if (!allProbeSent() && now - m_lastBatchSentAt >= probeBatchInterval())
        {
            return m_eventFactory->create(ProbedEventDomain::Icmp,
                                          static_cast<std::uint32_t>(IcmpEventType::SendProbeBatch));
        }

        if (allProbeSent())
        {
            m_waitingStartedAt = now;
            m_lastReplyAt = now;
            m_state = State::WaitingReplies;

            LOG_TRACE("all probes sent, waiting replies (idle_timeout_ms={}, max_timeout_ms={})",
                      std::chrono::duration_cast<std::chrono::milliseconds>(replyIdleTimeout()).count(),
                      std::chrono::duration_cast<std::chrono::milliseconds>(replyMaxWaitTimeout()).count());
        }

        return nullptr;
    }

    case State::WaitingReplies:
    {
        if (replyWaitExpired(now))
        {
            return m_eventFactory->create(ProbedEventDomain::Icmp,
                                          static_cast<std::uint32_t>(IcmpEventType::ProbeCompleted));
        }

        return nullptr;
    }
    }

    return nullptr;
}

void IcmpService::handleEvent(ProbedServiceManager& serviceManager, const IcmpEvent& event)
{
    if (!m_actionFactory)
    {
        LOG_ERROR("ActionFactory is not initialized");
        return;
    }

    switch (event.type())
    {
    case IcmpEventType::StartProbe:
    {
        auto action =
            m_actionFactory->create(ProbedActionDomain::Icmp, static_cast<std::uint32_t>(IcmpActionType::StartProbe));

        serviceManager.postAction(std::move(action));
        break;
    }

    case IcmpEventType::SendProbeBatch:
    {
        auto action = m_actionFactory->create(ProbedActionDomain::Icmp,
                                              static_cast<std::uint32_t>(IcmpActionType::SendProbeBatch));

        serviceManager.postAction(std::move(action));
        break;
    }

    case IcmpEventType::EchoReply:
    {
        onEchoReply(event);
        break;
    }

    case IcmpEventType::ProbeCompleted:
    {
        completeProbeSession();

        auto action = m_actionFactory->create(ProbedActionDomain::Icmp,
                                              static_cast<std::uint32_t>(IcmpActionType::SendProbeResult));

        serviceManager.postAction(std::move(action));
        break;
    }

    default:
    {
        LOG_DEBUG("unhandled event (type={})", static_cast<std::uint32_t>(event.type()));
        break;
    }
    }
}

void IcmpService::handleAction(ProbedServiceManager& serviceManager, const IcmpAction& action)
{
    switch (action.type())
    {
    case IcmpActionType::StartProbe:
    {
        if (m_state == State::Sending || m_state == State::WaitingReplies)
        {
            LOG_DEBUG("skip StartProbe while active (state={})", static_cast<int>(m_state));
            return;
        }

        beginProbeSession();

        if (m_targets.empty())
        {
            auto result = m_actionFactory->create(ProbedActionDomain::Icmp,
                                                  static_cast<std::uint32_t>(IcmpActionType::SendProbeResult));
            serviceManager.postAction(std::move(result));
        }
        break;
    }

    case IcmpActionType::SendProbeBatch:
    {
        if (m_state != State::Sending)
        {
            LOG_DEBUG("skip SendProbeBatch (state={})", static_cast<int>(m_state));
            return;
        }

        sendProbeBatch(serviceManager);
        break;
    }

    case IcmpActionType::SendProbeResult:
    {
        sendProbeResult(serviceManager);
        break;
    }

    default:
    {
        LOG_DEBUG("unhandled action (type={})", static_cast<std::uint32_t>(action.type()));
        break;
    }
    }
}

void IcmpService::beginProbeSession()
{
    m_identifier = static_cast<std::uint16_t>(::getpid() & 0xffff);

    const auto explicitIps = probeExplicitTargets();

    m_targets.clear();
    m_targetIndexByIp.clear();
    m_nextSendIndex = 0;

    if (explicitIps.empty())
    {
        m_lastAliveCount = 0;
        m_state = State::Idle;
        LOG_INFO("no devices configured — skipping probe sweep (reporting 0 alive)");
        return;
    }

    // Explicit per-object targets only (scan_cidr sweep removed). Skip excluded/local IPs.
    std::unordered_map<std::string, bool> seen;
    for (const auto& ip : explicitIps)
    {
        if (m_localIps.find(ip) != m_localIps.end())
            continue;
        if (seen.emplace(ip, true).second)
        {
            ProbeTarget t;
            t.ip = ip;
            m_targets.push_back(std::move(t));
        }
    }

    for (std::size_t i = 0; i < m_targets.size(); ++i)
    {
        m_targets[i].sequence = static_cast<std::uint16_t>(i + 1);
        m_targets[i].alive = false;
        m_targetIndexByIp.emplace(m_targets[i].ip, i);
    }

    m_nextSendIndex = 0;

    const auto now = std::chrono::steady_clock::now();
    m_probeStartedAt = now;
    m_lastBatchSentAt = now - probeBatchInterval();
    m_waitingStartedAt = {};
    m_lastReplyAt = {};
    m_state = State::Sending;

    LOG_DEBUG("starting probe cycle (targets={})", m_targets.size());
}

void IcmpService::sendProbeBatch(ProbedServiceManager& serviceManager)
{
    const auto now = std::chrono::steady_clock::now();

    std::size_t sentCount = 0;

    while (m_nextSendIndex < m_targets.size() && sentCount < probeBatchSize())
    {
        auto& target = m_targets[m_nextSendIndex];

        LOG_TRACE("send echo request (dst={}, seq={})", target.ip, target.sequence);

        auto packet = buildEchoRequestPacket(target.sequence);
        serviceManager.txRouter().handleIcmpPacket(std::move(packet), target.ip);

        ++m_nextSendIndex;
        ++sentCount;
    }

    m_lastBatchSentAt = now;

    LOG_DEBUG("sent batch (count={}, progress={}/{})", sentCount, m_nextSendIndex, m_targets.size());
}

void IcmpService::onEchoReply(const IcmpEvent& event)
{
    const auto& srcIp = event.srcIp();

    auto it = m_targetIndexByIp.find(srcIp);
    if (it == m_targetIndexByIp.end())
    {
        LOG_TRACE("ignore echo reply from unknown (ip={})", srcIp);
        return;
    }

    if (!canAcceptReply())
    {
        LOG_DEBUG("late echo reply ignored (src={}, state={})", srcIp, static_cast<int>(m_state));
        return;
    }

    const auto* packet = event.packet();
    if (!packet)
    {
        LOG_WARN("ignore echo reply with null packet (src={})", srcIp);
        return;
    }

    auto& target = m_targets[it->second];

    if (packet->identifier() != m_identifier)
    {
        LOG_TRACE("ignore echo reply id mismatch (src={}, recv={}, expected={})", srcIp, packet->identifier(),
                  m_identifier);
        return;
    }

    if (packet->sequence() != target.sequence)
    {
        LOG_TRACE("ignore echo reply seq mismatch (src={}, recv={}, expected={})", srcIp, packet->sequence(),
                  target.sequence);
        return;
    }

    m_lastReplyAt = std::chrono::steady_clock::now();

    if (target.alive)
        return;

    target.alive = true;

    LOG_TRACE("reachable (ip={})", srcIp);
}

void IcmpService::completeProbeSession()
{
    if (m_state != State::WaitingReplies)
    {
        LOG_DEBUG("skip complete (state={})", static_cast<int>(m_state));
        return;
    }

    std::vector<std::string> aliveIps;

    for (const auto& target : m_targets)
    {
        if (target.alive)
            aliveIps.push_back(target.ip);
    }

    std::sort(aliveIps.begin(), aliveIps.end(),
              [](const std::string& lhs, const std::string& rhs) { return ipv4ToHostU32(lhs) < ipv4ToHostU32(rhs); });

    const auto now = std::chrono::steady_clock::now();

    m_lastAliveCount = static_cast<std::uint32_t>(aliveIps.size());

    LOG_TRACE("probe cycle complete (total={}, alive={}, dead={}, elapsed_ms={})", m_targets.size(), aliveIps.size(),
             m_targets.size() - aliveIps.size(),
             std::chrono::duration_cast<std::chrono::milliseconds>(now - m_probeStartedAt).count());

    for (const auto& ip : aliveIps)
        LOG_TRACE("reachable (ip={})", ip);

    m_lastProbeCompletedAt = now;
    m_state = State::Idle;
}

bool IcmpService::allProbeSent() const
{
    return m_nextSendIndex >= m_targets.size();
}

bool IcmpService::replyWaitExpired(std::chrono::steady_clock::time_point now) const
{
    using namespace std::chrono;

    const auto idleElapsed = duration_cast<milliseconds>(now - m_lastReplyAt);
    const auto maxElapsed = duration_cast<milliseconds>(now - m_waitingStartedAt);

    const bool idleExpired = idleElapsed >= replyIdleTimeout();
    const bool maxExpired = maxElapsed >= replyMaxWaitTimeout();

    if (idleExpired || maxExpired)
    {
        std::string reason = idleExpired ? "ReplyIdleTimeout" : "ReplyMaxWaitTimeout";

        if (idleExpired && maxExpired)
        {
            reason = "ReplyIdleTimeout|ReplyMaxWaitTimeout";
        }

        LOG_DEBUG("probe wait expired (reason={}, idle_elapsed_ms={}/{}, max_elapsed_ms={}/{})", reason,
                  idleElapsed.count(), duration_cast<milliseconds>(replyIdleTimeout()).count(), maxElapsed.count(),
                  duration_cast<milliseconds>(replyMaxWaitTimeout()).count());
    }

    return idleExpired || maxExpired;
}

bool IcmpService::canAcceptReply() const
{
    return m_state == State::Sending || m_state == State::WaitingReplies;
}

std::unique_ptr<IcmpPacket> IcmpService::buildEchoRequestPacket(std::uint16_t sequence) const
{
    const std::string payload = "pz-probed-probe";

    IcmpHeader header = IcmpHeader::buildEchoRequest(m_identifier, sequence);

    auto packet = std::make_unique<IcmpPacket>(std::move(header));
    packet->setPayload(payload.data(), payload.size());

    return packet;
}

void IcmpService::sendProbeResult(ProbedServiceManager& serviceManager)
{
    nlohmann::json payload;
    payload["alive"] = m_lastAliveCount;
    nlohmann::json ips = nlohmann::json::array();
    for (const auto& t : m_targets)
    {
        if (t.alive)
            ips.push_back(t.ip);
    }
    payload["ips"] = std::move(ips);

    const std::string payloadStr = payload.dump();

    auto msg = std::make_unique<pz::ipc::IpcMessage>();
    msg->setSrc(pz::ipc::IpcDaemon::Probed);
    msg->setDst(pz::ipc::IpcDaemon::Engined);
    msg->setCmd(pz::ipc::IpcCmd::ProbeResult);
    msg->setFlags(pz::ipc::IpcProtocol::toFlag(pz::ipc::IpcFlag::Response));
    msg->setPayload(reinterpret_cast<const std::uint8_t*>(payloadStr.data()), payloadStr.size());

    LOG_DEBUG("sending ProbeResult to engined (alive={})", m_lastAliveCount);

    serviceManager.txRouter().handleIpcMessage(std::move(msg));
}

std::uint32_t IcmpService::ipv4ToHostU32(const std::string& ip)
{
    in_addr addr{};
    if (::inet_pton(AF_INET, ip.c_str(), &addr) != 1)
        throw std::invalid_argument("invalid ipv4: " + ip);

    return ntohl(addr.s_addr);
}

}

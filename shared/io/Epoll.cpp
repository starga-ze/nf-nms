#include "Epoll.h"

#include "util/Logger.h"

#include <errno.h>
#include <sys/eventfd.h>
#include <unistd.h>

namespace nf::io
{

Epoll::Epoll() = default;

Epoll::~Epoll()
{
    close();
}

bool Epoll::init()
{
    if (!createEpoll())
        return false;

    if (!createEventFd())
        return false;

    add(m_eventFd, EPOLLIN);
    return true;
}

bool Epoll::createEpoll()
{
    m_epFd = ::epoll_create1(0);
    if (m_epFd < 0)
    {
        LOG_ERROR("epoll_create1 failed errno={}", errno);
        return false;
    }
    return true;
}

bool Epoll::createEventFd()
{
    m_eventFd = ::eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
    if (m_eventFd < 0)
    {
        LOG_ERROR("eventfd failed errno={}", errno);
        return false;
    }
    return true;
}

void Epoll::close()
{
    if (m_eventFd >= 0)
    {
        ::close(m_eventFd);
        m_eventFd = -1;
    }

    if (m_epFd >= 0)
    {
        ::close(m_epFd);
        m_epFd = -1;
    }
}

bool Epoll::add(int fd, uint32_t events)
{
    epoll_event ev{};
    ev.events = events;
    ev.data.fd = fd;
    return ::epoll_ctl(m_epFd, EPOLL_CTL_ADD, fd, &ev) == 0;
}

bool Epoll::mod(int fd, uint32_t events)
{
    epoll_event ev{};
    ev.events = events;
    ev.data.fd = fd;
    return ::epoll_ctl(m_epFd, EPOLL_CTL_MOD, fd, &ev) == 0;
}

bool Epoll::del(int fd)
{
    return ::epoll_ctl(m_epFd, EPOLL_CTL_DEL, fd, nullptr) == 0;
}

int Epoll::wait(std::vector<epoll_event>& events, int timeoutMs)
{
    return ::epoll_wait(m_epFd, events.data(), static_cast<int>(events.size()), timeoutMs);
}

void Epoll::wakeup()
{
    uint64_t v = 1;
    ::write(m_eventFd, &v, sizeof(v));
}

void Epoll::drainWakeup()
{
    uint64_t v;
    while (::read(m_eventFd, &v, sizeof(v)) > 0)
    {
    }
}

} // namespace nf::io

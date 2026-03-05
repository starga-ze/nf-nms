#pragma once

#include <cstdint>
#include <sys/epoll.h>
#include <vector>

namespace nf::io
{

class Epoll
{
public:
    Epoll();
    ~Epoll();

    bool init();
    void close();

    bool add(int fd, uint32_t events);
    bool mod(int fd, uint32_t events);
    bool del(int fd);

    int wait(std::vector<epoll_event>& events, int timeoutMs);

    int getWakeupFd() const
    {
        return m_eventFd;
    }
    void wakeup();
    void drainWakeup();

private:
    bool createEpoll();
    bool createEventFd();

    int m_epFd{-1};
    int m_eventFd{-1};
};

} // namespace nf::io

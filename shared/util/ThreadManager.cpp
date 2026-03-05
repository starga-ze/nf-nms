#include "ThreadManager.h"
#include "util/Logger.h"

#include <cstring>
#include <sys/prctl.h>
#include <unistd.h>

namespace nf::util
{
ThreadManager::~ThreadManager()
{
    stopAll();
}

bool ThreadManager::setName(const std::string &name)
{
    char thread_name[16];
    std::strncpy(thread_name, name.c_str(), sizeof(thread_name) - 1);
    thread_name[sizeof(thread_name) - 1] = '\0';

    return prctl(PR_SET_NAME, thread_name, 0, 0, 0) == 0;
}

void ThreadManager::threadWrapper(const std::string &name, std::function<void()> func)
{
    setName(name);
    func();
}

void ThreadManager::addThread(const std::string &name, std::function<void()> runFunc, 
                              std::function<void()> stopFunc)
{
    ThreadInfo info;
    info.name = name;
    info.stopFunc = stopFunc;

    info.thread = std::thread(&ThreadManager::threadWrapper, this, name, runFunc);

    std::lock_guard<std::mutex> lock(m_lock);
    m_threads.emplace_back(std::move(info));
}

void ThreadManager::start(size_t n, const std::string &baseName, std::function<void()> runFunc,
                          std::function<void()> stopFunc)
{
    for (size_t i = 0; i < n; ++i)
    {
        addThread(baseName + "_" + std::to_string(i), runFunc, stopFunc);
    }
}

void ThreadManager::stopAll()
{
    std::vector<ThreadInfo> snapshot;

    {
        std::lock_guard<std::mutex> lock(m_lock);
        snapshot = std::move(m_threads);
        m_threads.clear();
    }

    for (auto &t : snapshot)
    {
        if (t.stopFunc)
            t.stopFunc();
    }

    auto self = std::this_thread::get_id();

    for (auto &t : snapshot)
    {
        if (t.thread.joinable())
        {
            if (t.thread.get_id() == self)
                continue;

            t.thread.join();
        }
    }
}
} // namespace nf::util

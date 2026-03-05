#pragma once

#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace nf::util
{

class ThreadManager
{
public:
    ~ThreadManager();

    void addThread(const std::string& name, std::function<void()> runFunc, std::function<void()> stopFunc = {});

    void start(size_t n, const std::string& baseName, std::function<void()> runFunc,
               std::function<void()> stopFunc = {});

    void stopAll();

    static bool setName(const std::string& name);

private:
    struct ThreadInfo
    {
        std::string name;
        std::thread thread;
        std::function<void()> stopFunc;
    };

    void threadWrapper(const std::string& name, std::function<void()> func);

    std::vector<ThreadInfo> m_threads;
    std::mutex m_lock;
};

} // namespace nf::util

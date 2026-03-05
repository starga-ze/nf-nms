#pragma once

#include <memory>
#include <spdlog/spdlog.h>
#include <string>

namespace nf::util
{

class Logger
{
public:
    static void Init(const std::string& logger_name, const std::string& log_filepath, size_t max_filesize,
                     size_t max_files);

    static void Shutdown();

    inline static std::shared_ptr<spdlog::logger>& GetLogger()
    {
        return s_logger;
    }

private:
    static std::shared_ptr<spdlog::logger> s_logger;

    static void setThreadName();
};

} // namespace nf::util

#ifdef _WIN32
#define __FILENAME__ (strrchr(__FILE__, '\\') ? strrchr(__FILE__, '\\') + 1 : __FILE__)
#else
#define __FILENAME__ (strrchr(__FILE__, '/') ? strrchr(__FILE__, '/') + 1 : __FILE__)
#endif

#define LOG_INTERNAL(level, format, ...)                                                             \
    nf::util::Logger::GetLogger()->log(spdlog::source_loc{__FILENAME__, __LINE__, SPDLOG_FUNCTION},  \
            level, format, ##__VA_ARGS__)

#define LOG_DEBUG(...) LOG_INTERNAL(spdlog::level::debug, __VA_ARGS__)
#define LOG_TRACE(...) LOG_INTERNAL(spdlog::level::trace, __VA_ARGS__)
#define LOG_INFO(...) LOG_INTERNAL(spdlog::level::info, __VA_ARGS__)
#define LOG_WARN(...) LOG_INTERNAL(spdlog::level::warn, __VA_ARGS__)
#define LOG_ERROR(...) LOG_INTERNAL(spdlog::level::err, __VA_ARGS__)
#define LOG_FATAL(...) LOG_INTERNAL(spdlog::level::critical, __VA_ARGS__)

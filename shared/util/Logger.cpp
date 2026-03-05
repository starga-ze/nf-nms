#include "util/Logger.h"
#include "util/ThreadManager.h"

#include <filesystem>
#include <spdlog/async.h>
#include <spdlog/cfg/env.h>
#include <spdlog/pattern_formatter.h>
#include <spdlog/sinks/rotating_file_sink.h>
#include <spdlog/sinks/stdout_color_sinks.h>
#include <vector>

namespace nf::util
{

class short_level_flag : public spdlog::custom_flag_formatter
{

public:
    void format(const spdlog::details::log_msg& msg, const std::tm&, spdlog::memory_buf_t& dest) override
    {
        const char* color_code = "\033[0m";
        switch (msg.level)
        {
        case spdlog::level::debug:
            color_code = "\033[36m";
            break;
        case spdlog::level::trace:
            color_code = "\033[34m";
            break; // Blue
        case spdlog::level::info:
            color_code = "\033[90m";
            break; // Dark gray
        case spdlog::level::warn:
            color_code = "\033[33m";
            break; // Yellow
        case spdlog::level::err:
            color_code = "\033[91m";
            break; // Red
        case spdlog::level::critical:
            color_code = "\033[31m";
            break; // Bright Red
        default:
            color_code = "\033[0m";
            break;
        }

        std::string lvl;

        switch (msg.level)
        {
        case spdlog::level::debug:
            lvl = "DEBUG";
            break;
        case spdlog::level::trace:
            lvl = "TRACE";
            break;
        case spdlog::level::info:
            lvl = "INFO";
            break;
        case spdlog::level::warn:
            lvl = "WARN";
            break;
        case spdlog::level::err:
            lvl = "ERROR";
            break;
        case spdlog::level::critical:
            lvl = "CRIT";
            break;
        default:
            lvl = "unkn";
            break;
        }

        std::string out = std::string(color_code) + lvl + "\033[0m";
        dest.append(out.data(), out.data() + out.size());
    }

    std::unique_ptr<custom_flag_formatter> clone() const override
    {
        return spdlog::details::make_unique<short_level_flag>();
    }
};

std::shared_ptr<spdlog::logger> Logger::s_logger;

void Logger::Init(const std::string& logger_name, const std::string& log_filepath, size_t max_filesize,
                  size_t max_files)
{
    try
    {
        std::filesystem::path log_path(log_filepath);
        if (log_path.has_parent_path())
        {
            std::filesystem::create_directories(log_path.parent_path());
        }
    }
    catch (const std::exception& e)
    {
        printf("Failed to create log directory: %s\n", e.what());
    }

    spdlog::init_thread_pool(8192, 1, &Logger::setThreadName, [] {});

    auto console_sink = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
    auto file_sink = std::make_shared<spdlog::sinks::rotating_file_sink_mt>(log_filepath, max_filesize, max_files);

    std::vector<spdlog::sink_ptr> sinks{console_sink, file_sink};

    s_logger = std::make_shared<spdlog::async_logger>(logger_name, sinks.begin(), sinks.end(), spdlog::thread_pool(),
                                                      spdlog::async_overflow_policy::block);

    spdlog::set_default_logger(s_logger);
    spdlog::set_level(spdlog::level::trace);

    auto console_fmt = std::make_unique<spdlog::pattern_formatter>();
    console_fmt->add_flag<short_level_flag>('!');
    console_fmt->set_pattern("[%H:%M:%S.%e]%^[%!]%$[%s:%#] %v");
    console_sink->set_formatter(std::move(console_fmt));

    auto file_fmt = std::make_unique<spdlog::pattern_formatter>();
    file_fmt->add_flag<short_level_flag>('!');
    file_fmt->set_pattern("[%Y-%m-%d %H:%M:%S.%e][%!][%s:%#] %v");
    file_sink->set_formatter(std::move(file_fmt));

    s_logger->flush_on(spdlog::level::trace);

    spdlog::cfg::load_env_levels();
}

void Logger::Shutdown()
{
    if (s_logger)
    {
        s_logger->flush();
    }
    spdlog::shutdown();
}

void Logger::setThreadName()
{
    ThreadManager::setName("spdlog");
}

} // namespace nf::util

file(GLOB_RECURSE SHARED_SRC_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

add_library(nf-shared ${SHARED_SRC_FILES})

target_compile_definitions(nf-shared PUBLIC
    PROJECT_ROOT="${CMAKE_SOURCE_DIR}")

target_include_directories(nf-shared PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(nf-shared PUBLIC
    spdlog::spdlog
)

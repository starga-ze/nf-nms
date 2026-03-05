file(GLOB_RECURSE ICMPD_SRC_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

add_executable(nf-icmpd ${ICMPD_SRC_FILES})

target_include_directories(nf-icmpd PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_definitions(nf-icmpd PRIVATE
    PROJECT_ROOT="${CMAKE_SOURCE_DIR}"
)

target_link_libraries(nf-icmpd PRIVATE
    nf-shared
)

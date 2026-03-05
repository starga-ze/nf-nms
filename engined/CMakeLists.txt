file(GLOB_RECURSE ENGINED_SRC_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

add_executable(nf-engined ${ENGINED_SRC_FILES})

target_include_directories(nf-engined PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_definitions(nf-engined PRIVATE
    PROJECT_ROOT="${CMAKE_SOURCE_DIR}"
)

target_link_libraries(nf-engined PRIVATE
    nf-shared
)

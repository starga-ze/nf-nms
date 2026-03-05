file(GLOB_RECURSE MGMTD_SRC_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

add_executable(nf-mgmtd ${MGMTD_SRC_FILES})

target_include_directories(nf-mgmtd PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_definitions(nf-mgmtd PRIVATE
    PROJECT_ROOT="${CMAKE_SOURCE_DIR}"
)

target_link_libraries(nf-mgmtd PRIVATE
    nf-shared
)

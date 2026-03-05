file(GLOB_RECURSE AUTHD_SRC_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

add_executable(nf-authd ${AUTHD_SRC_FILES})

target_include_directories(nf-authd PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_definitions(nf-authd PRIVATE
    PROJECT_ROOT="${CMAKE_SOURCE_DIR}"
)

target_link_libraries(nf-authd PRIVATE
    nf-shared
)

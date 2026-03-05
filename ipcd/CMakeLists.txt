file(GLOB_RECURSE IPCD_SRC_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

add_executable(nf-ipcd ${IPCD_SRC_FILES})

target_include_directories(nf-ipcd PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_definitions(nf-ipcd PRIVATE
    PROJECT_ROOT="${CMAKE_SOURCE_DIR}"
)

target_link_libraries(nf-ipcd PRIVATE
    nf-shared
)

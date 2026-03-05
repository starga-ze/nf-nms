file(GLOB_RECURSE TOPOLOGYD_SRC_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

add_executable(nf-topologyd ${TOPOLOGYD_SRC_FILES})

target_include_directories(nf-topologyd PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_definitions(nf-topologyd PRIVATE
    PROJECT_ROOT="${CMAKE_SOURCE_DIR}"
)

target_link_libraries(nf-topologyd PRIVATE
    nf-shared
)

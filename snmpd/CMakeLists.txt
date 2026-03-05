file(GLOB_RECURSE SNMPD_SRC_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/*.cpp"
)

add_executable(nf-snmpd ${SNMPD_SRC_FILES})

target_include_directories(nf-snmpd PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

target_compile_definitions(nf-snmpd PRIVATE
    PROJECT_ROOT="${CMAKE_SOURCE_DIR}"
)

target_link_libraries(nf-snmpd PRIVATE
    nf-shared
)

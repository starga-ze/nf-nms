cmake_minimum_required(VERSION 3.16)
project(nf-nms LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

set(THIRD_PARTY_INSTALL_DIR "${CMAKE_SOURCE_DIR}/3rd_party/install")

set(OPENSSL_ROOT_DIR "${THIRD_PARTY_INSTALL_DIR}/openssl")
set(OPENSSL_USE_STATIC_LIBS TRUE)
set(OPENSSL_CRYPTO_LIBRARY "${OPENSSL_ROOT_DIR}/lib64/libcrypto.a")
set(OPENSSL_SSL_LIBRARY "${OPENSSL_ROOT_DIR}/lib64/libssl.a")
set(OPENSSL_INCLUDE_DIR "${OPENSSL_ROOT_DIR}/include")

list(APPEND CMAKE_PREFIX_PATH ${THIRD_PARTY_INSTALL_DIR}/spdlog)
list(APPEND CMAKE_PREFIX_PATH ${THIRD_PARTY_INSTALL_DIR}/openssl)
list(APPEND CMAKE_PREFIX_PATH ${THIRD_PARTY_INSTALL_DIR}/boost)
list(APPEND CMAKE_PREFIX_PATH ${THIRD_PARTY_INSTALL_DIR}/nlohmann_json)

find_package(Threads REQUIRED)
find_package(spdlog REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Boost REQUIRED)
find_package(nlohmann_json REQUIRED)

add_compile_options(
    -Wall
    -Wextra
    -fdiagnostics-color=always
)

add_subdirectory(shared)

add_subdirectory(ipcd)
add_subdirectory(engined)
add_subdirectory(icmpd)
add_subdirectory(snmpd)
add_subdirectory(topologyd)
add_subdirectory(authd)
add_subdirectory(mgmtd)

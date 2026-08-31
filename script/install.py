"""
script/install.py

Downloads and builds system packages (APT) and 3rd-party C++ dependencies required to run the project.
Installed libraries are isolated under the `3rd_party/install/` directory.
"""

import os
import sys
import glob
import json
import subprocess
import shutil

from script.utils import (
    ROOT_DIR, INSTALL_ROOT, NUM_CORES, MAKE_JOBS, run_cmd, download_and_extract, build_cmake_project,
    OPENSSL_VERSION, OPENSSL_DIR, OPENSSL_INSTALL, OPENSSL_TAR, OPENSSL_SRC_PATH,
    SPDLOG_VERSION, SPDLOG_DIR, SPDLOG_INSTALL, SPDLOG_TAR, SPDLOG_SRC_PATH,
    BOOST_VERSION, BOOST_VERSION_UNDERSCORE, BOOST_DIR, BOOST_INSTALL, BOOST_TAR, BOOST_SRC_PATH,
    JSON_VERSION, JSON_DIR, JSON_INSTALL, JSON_TAR, JSON_SRC_PATH,
    GTEST_VERSION, GTEST_DIR, GTEST_INSTALL, GTEST_TAR, GTEST_SRC_PATH,
    GRPC_VERSION, GRPC_DIR, GRPC_INSTALL, GRPC_SRC_PATH,
    PG_SERVICE, PG_DB_NAME, PG_RAG_DB_NAME, PG_DB_USER, PG_DB_PASSWORD,
    PGADMIN_VERSION, PGADMIN_VENV,
)

def install_openssl():
    """Compiles and installs the OpenSSL library from source."""
    # Skip installation if the static library (libssl.a) already exists (idempotency)
    if os.path.exists(os.path.join(OPENSSL_INSTALL, "lib64", "libssl.a")):
        print("[*] OpenSSL already built and installed, skipping...")
        return

    os.makedirs(OPENSSL_INSTALL, exist_ok=True)
    url = f"https://www.openssl.org/source/openssl-{OPENSSL_VERSION}.tar.gz"
    download_and_extract(url, OPENSSL_TAR, OPENSSL_DIR, "Extracting OpenSSL source")

    # Uses OpenSSL's custom Configure script
    run_cmd(["./Configure", "linux-x86_64", "no-shared", f"--prefix={OPENSSL_INSTALL}"], cwd=OPENSSL_SRC_PATH, msg="Configuring OpenSSL")
    run_cmd(["make", MAKE_JOBS], cwd=OPENSSL_SRC_PATH, msg=f"Compiling OpenSSL with {NUM_CORES} jobs")
    run_cmd(["make", "install"], cwd=OPENSSL_SRC_PATH, msg="Installing OpenSSL")
    print("[*] OpenSSL installation complete.")

def install_spdlog():
    """Builds and installs spdlog, a high-performance C++ logging library, using CMake."""
    if os.path.exists(os.path.join(SPDLOG_INSTALL, "lib", "cmake", "spdlog", "spdlogConfig.cmake")):
        print("[*] spdlog already installed, skipping...")
        return

    url = f"https://github.com/gabime/spdlog/archive/refs/tags/v{SPDLOG_VERSION}.tar.gz"
    download_and_extract(url, SPDLOG_TAR, SPDLOG_DIR, "Extracting spdlog source")

    build_cmake_project(
        src_path=SPDLOG_SRC_PATH,
        install_prefix=SPDLOG_INSTALL,
        extra_args=["-DSPDLOG_BUILD_SHARED=OFF", "-DSPDLOG_BUILD_EXAMPLES=OFF", "-DSPDLOG_BUILD_TESTS=OFF"]
    )
    print("[*] spdlog installation complete.")

def install_boost():
    """Installs the C++ Boost library using the b2 engine (primarily utilizing asio and thread features)."""
    if os.path.exists(os.path.join(BOOST_INSTALL, "include", "boost", "asio.hpp")):
        print("[*] Boost already built and installed, skipping...")
        return

    url = f"https://archives.boost.io/release/{BOOST_VERSION}/source/boost_{BOOST_VERSION_UNDERSCORE}.tar.gz"
    download_and_extract(url, BOOST_TAR, BOOST_DIR, "Extracting Boost source")

    # Boost custom bootstrap and build process
    run_cmd(["./bootstrap.sh", f"--prefix={BOOST_INSTALL}"], cwd=BOOST_SRC_PATH, msg="Bootstrapping Boost")
    run_cmd(
        ["./b2", f"-j{NUM_CORES}", "variant=release", "link=static", "threading=multi", "runtime-link=static", "--with-system", "--with-thread", "install"], 
        cwd=BOOST_SRC_PATH, 
        msg="Building Boost"
    )
    print("[*] Boost installation complete.")

def install_json():
    """Installs the nlohmann_json header-only library."""
    if os.path.exists(os.path.join(JSON_INSTALL, "share", "cmake", "nlohmann_json", "nlohmann_jsonConfig.cmake")):
        print("[*] nlohmann_json already installed, skipping...")
        return

    url = f"https://github.com/nlohmann/json/archive/refs/tags/v{JSON_VERSION}.tar.gz"
    download_and_extract(url, JSON_TAR, JSON_DIR, "Extracting nlohmann_json")

    build_cmake_project(
        src_path=JSON_SRC_PATH,
        install_prefix=JSON_INSTALL,
        extra_args=["-DJSON_BuildTests=OFF"]
    )
    print("[*] nlohmann_json installation complete.")

def install_googletest():
    """
    Installs GoogleTest, used by tests/ and by nothing else.

    gmock is skipped: the current suite asserts on pure functions and needs no mock objects.
    Turn BUILD_GMOCK back on when a test needs to stand in for Database or the IPC client.
    """
    if os.path.exists(os.path.join(GTEST_INSTALL, "lib", "cmake", "GTest", "GTestConfig.cmake")):
        print("[*] googletest already installed, skipping...")
        return

    url = f"https://github.com/google/googletest/archive/refs/tags/v{GTEST_VERSION}.tar.gz"
    download_and_extract(url, GTEST_TAR, GTEST_DIR, "Extracting googletest")

    build_cmake_project(
        src_path=GTEST_SRC_PATH,
        install_prefix=GTEST_INSTALL,
        extra_args=["-DBUILD_GMOCK=OFF", "-DINSTALL_GTEST=ON"],
    )
    print("[*] googletest installation complete.")


def install_grpc():
    """Builds gRPC + protobuf (and their bundled deps) from source into 3rd_party/install/grpc.

    This is the mgmtd <-> pretzel-ai transport, and a build-time dependency: mgmtd links
    libgrpc++ and the generated stubs, and its build needs protoc + grpc_cpp_plugin from here.

    Cloned WITH submodules rather than fetched as a tarball because GitHub's auto-generated
    source archives do not include gRPC's third_party/ submodules (abseil, protobuf, re2,
    c-ares, BoringSSL, zlib), all of which its CMake build compiles in-tree.

    SSL comes from our vendored OpenSSL (gRPC_SSL_PROVIDER=package), NOT gRPC's bundled BoringSSL.
    BoringSSL exports the same symbol names as OpenSSL, so its libcrypto.a and ours multiply-define
    every EVP_*/RSA_* at static link and mgmtd fails to link. One OpenSSL for the whole process is
    the fix — and cleaner than the bundled route. zlib/protobuf/abseil/re2/c-ares stay bundled;
    their symbols collide with nothing mgmtd links.

    Heavy: the clone is large and the from-source build of the whole stack takes many minutes.
    Kept in install_build_deps() (unprivileged, no apt/root) — the clone and CMake build only
    touch the repo-owned 3rd_party/ tree.
    """
    plugin = os.path.join(GRPC_INSTALL, "bin", "grpc_cpp_plugin")
    config = os.path.join(GRPC_INSTALL, "lib", "cmake", "grpc", "gRPCConfig.cmake")
    if os.path.exists(plugin) and os.path.exists(config):
        print("[*] gRPC already built and installed, skipping...")
        return

    if not os.path.isdir(os.path.join(GRPC_SRC_PATH, ".git")):
        os.makedirs(GRPC_DIR, exist_ok=True)
        run_cmd(
            ["git", "clone", "--depth", "1", "--branch", f"v{GRPC_VERSION}",
             "--recurse-submodules", "--shallow-submodules",
             "https://github.com/grpc/grpc", GRPC_SRC_PATH],
            msg=f"Cloning gRPC v{GRPC_VERSION} with submodules (large; several minutes)",
        )

    build_cmake_project(
        src_path=GRPC_SRC_PATH,
        install_prefix=GRPC_INSTALL,
        extra_args=[
            "-DCMAKE_BUILD_TYPE=Release",
            "-DgRPC_INSTALL=ON",
            "-DgRPC_BUILD_TESTS=OFF",
            "-DABSL_PROPAGATE_CXX_STD=ON",
            # SSL comes from OUR vendored OpenSSL, not gRPC's bundled BoringSSL. BoringSSL exports
            # the same OpenSSL symbol names (EVP_*, RSA_*), so its libcrypto.a and ours multiply-
            # define every one of them at static link time and mgmtd fails to link. Pointing gRPC
            # at the one OpenSSL the process already uses keeps a single crypto stack — cleaner
            # than the earlier bundled attempt, and it also removes the runtime interposition risk.
            "-DgRPC_SSL_PROVIDER=package",
            # ROOT_DIR alone is not enough here: the box has a system static libcrypto.a in
            # /usr/lib that FindOpenSSL picks first, which would reintroduce the very duplicate it
            # is meant to avoid. Name the exact libraries — the same ones the top-level CMakeLists
            # pins for every daemon — so gRPC links the one OpenSSL the rest of mgmtd links.
            f"-DOPENSSL_ROOT_DIR={OPENSSL_INSTALL}",
            f"-DOPENSSL_INCLUDE_DIR={OPENSSL_INSTALL}/include",
            f"-DOPENSSL_CRYPTO_LIBRARY={OPENSSL_INSTALL}/lib64/libcrypto.a",
            f"-DOPENSSL_SSL_LIBRARY={OPENSSL_INSTALL}/lib64/libssl.a",
            "-DOPENSSL_USE_STATIC_LIBS=TRUE",
            # The rest stay bundled: their symbols do not collide with anything mgmtd links.
            "-DgRPC_ZLIB_PROVIDER=module",
            "-DgRPC_PROTOBUF_PROVIDER=module",
            "-DgRPC_ABSL_PROVIDER=module",
            "-DgRPC_RE2_PROVIDER=module",
            "-DgRPC_CARES_PROVIDER=module",
        ],
    )
    print("[*] gRPC installation complete.")


def is_postgresql_installed():
    """Checks whether the PostgreSQL client/server is already installed."""
    return shutil.which("psql") is not None


def _pg_row_exists(check_sql):
    """Runs a SELECT as the postgres superuser; True if it returns a '1' row."""
    out = subprocess.run(
        ["sudo", "-u", "postgres", "psql", "-tAc", check_sql],
        capture_output=True, text=True,
    )
    return out.returncode == 0 and out.stdout.strip() == "1"


def provision_postgresql():
    """
    Idempotently creates the dedicated 'pretzel' login role and database.
    Run as the 'postgres' superuser via peer auth; pz-mgmtd later connects to
    this role over localhost TCP using the password in running-config.json.
    """
    # 1. Login role. PG_DB_PASSWORD is the single source of truth (start.py injects the
    # same value into startup-config + the exporter env file), so we must re-sync the
    # role's password on every run — otherwise a pre-existing role keeps its original
    # password while the deployed config moves to a new one, and mgmtd / exporter /
    # pgAdmin all fail auth. Create when missing, ALTER to re-sync when it already exists.
    if _pg_row_exists(f"SELECT 1 FROM pg_roles WHERE rolname='{PG_DB_USER}'"):
        run_cmd(
            ["sudo", "-u", "postgres", "psql", "-c",
             f"ALTER ROLE {PG_DB_USER} LOGIN PASSWORD '{PG_DB_PASSWORD}'"],
            msg=f"Re-syncing PostgreSQL role '{PG_DB_USER}' password",
        )
    else:
        run_cmd(
            ["sudo", "-u", "postgres", "psql", "-c",
             f"CREATE ROLE {PG_DB_USER} LOGIN PASSWORD '{PG_DB_PASSWORD}'"],
            msg=f"Creating PostgreSQL role '{PG_DB_USER}'",
        )

    # 2. Database owned by that role
    if _pg_row_exists(f"SELECT 1 FROM pg_database WHERE datname='{PG_DB_NAME}'"):
        print(f"[*] PostgreSQL database '{PG_DB_NAME}' already exists, skipping...")
    else:
        run_cmd(
            ["sudo", "-u", "postgres", "createdb", "-O", PG_DB_USER, PG_DB_NAME],
            msg=f"Creating PostgreSQL database '{PG_DB_NAME}' (owner={PG_DB_USER})",
        )


def is_libpq_dev_installed():
    """Checks whether the libpq client dev headers (libpq-fe.h) are present."""
    return any(os.path.exists(p) for p in (
        "/usr/include/libpq-fe.h",
        "/usr/include/postgresql/libpq-fe.h",
    ))


def install_libpq_dev():
    """
    Installs ONLY the PostgreSQL client dev library (libpq-dev) — the headers/lib the
    C++ layer (shared/db) links against via CMake's find_package(PostgreSQL). Split
    out from install_postgresql() so a pure build can compile without pulling in the
    full PostgreSQL server + provisioning.
    """
    if is_libpq_dev_installed():
        print("[*] libpq-dev already present, skipping...")
        return

    print("[*] Installing libpq-dev (PostgreSQL client headers)...")
    run_cmd(["sudo", "apt", "update"])
    run_cmd(["sudo", "apt", "install", "-y", "libpq-dev"])


def is_libsnmp_dev_installed():
    """Checks whether the Net-SNMP dev headers (net-snmp-config.h) are present."""
    return os.path.exists("/usr/include/net-snmp/net-snmp-config.h")


def install_libsnmp_dev():
    """
    Installs ONLY the Net-SNMP dev library (libsnmp-dev) — the headers/lib that
    pz-collectord compiles against (#include <net-snmp/...>) and links against (-lnetsnmp,
    see collectord/CMakeLists.txt). Same build-time-only pattern as install_libpq_dev():
    a distro dev package rather than a from-source 3rd_party build.
    """
    if is_libsnmp_dev_installed():
        print("[*] libsnmp-dev already present, skipping...")
        return

    print("[*] Installing libsnmp-dev (Net-SNMP headers)...")
    run_cmd(["sudo", "apt", "update"])
    run_cmd(["sudo", "apt", "install", "-y", "libsnmp-dev"])


def is_xmlsec_dev_installed():
    """Checks whether the xmlsec1 dev package (its pkg-config file) is present."""
    return bool(glob.glob("/usr/lib/*/pkgconfig/xmlsec1-openssl.pc") or
                glob.glob("/usr/lib/pkgconfig/xmlsec1-openssl.pc"))


def install_xmlsec_dev():
    """
    Installs the SAML XML-DSig build dependencies for pz-authd: libxmlsec1-dev (XML signature
    verification), zlib1g-dev (HTTP-Redirect AuthnRequest DEFLATE) and pkg-config, which
    authd/CMakeLists.txt needs to locate xmlsec via pkg_check_modules().

    Same build-time-only pattern as install_libpq_dev(): distro dev packages rather than a
    from-source 3rd_party build. pkg-config is NOT part of build-essential, so it has to be
    named explicitly or a bare machine fails at authd's find_package(PkgConfig REQUIRED).
    """
    if is_xmlsec_dev_installed() and shutil.which("pkg-config") is not None:
        print("[*] xmlsec/zlib dev packages already present, skipping...")
        return

    print("[*] Installing libxmlsec1-dev, zlib1g-dev, pkg-config (SAML build deps)...")
    run_cmd(["sudo", "apt", "update"])
    run_cmd(["sudo", "apt", "install", "-y", "libxmlsec1-dev", "zlib1g-dev", "pkg-config"])


def install_postgresql():
    """
    Installs PostgreSQL server + client dev library (libpq-dev for the C++ layer)
    via APT and provisions the pretzel role/database. The server runs under the
    distro-managed postgresql.service (not wrapped as a pz-* unit).
    """
    if is_postgresql_installed():
        print("[*] PostgreSQL already installed, skipping apt install...")
    else:
        print("[*] Installing PostgreSQL...")
        run_cmd(["sudo", "apt", "update"])
        run_cmd(["sudo", "apt", "install", "-y",
                 "postgresql", "postgresql-contrib", "libpq-dev"])
        if not is_postgresql_installed():
            print("[ERROR] PostgreSQL installation failed.")
            sys.exit(1)

    # The cluster must be up to provision the role/database.
    run_cmd(["sudo", "systemctl", "enable", "--now", PG_SERVICE],
            msg="Enabling and starting postgresql.service")

    provision_postgresql()
    print("[*] PostgreSQL installation complete.")


def _pg_server_major():
    """The major version of the RUNNING server, which is what names the pgvector package.

    Asked of the server rather than read from `psql --version`: the client in PATH is not
    necessarily the one the cluster runs. On this project's own development box `psql` reports
    14.23 from Ubuntu while the server is 14.24 from PGDG — same major by luck, but the client
    is not the thing the extension has to match.
    """
    out = subprocess.run(
        ["sudo", "-u", "postgres", "psql", "-tAc", "SHOW server_version_num"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        return None
    try:
        return int(out.stdout.strip()) // 10000
    except ValueError:
        return None


def _apt_candidate_exists(package):
    """True if apt can resolve an installable version of `package` from the configured repos."""
    out = subprocess.run(["apt-cache", "policy", package], capture_output=True, text=True)
    if out.returncode != 0:
        return False
    for line in out.stdout.splitlines():
        if line.strip().startswith("Candidate:"):
            return line.split(":", 1)[1].strip() not in ("(none)", "")
    return False


def add_pgdg_repo():
    """Adds the PostgreSQL project's own APT repository (apt.postgresql.org).

    Needed because Ubuntu 22.04 ships no pgvector at any version — `apt-cache policy` on a
    stock jammy box returns no candidate for postgresql-*-pgvector — and pgvector is not
    optional here: without it `CREATE EXTENSION vector` fails, the `vector` column type does
    not exist, and even restoring a prebuilt corpus dump dies in its schema step.

    Deliberately added AFTER install_postgresql(). PGDG's `postgresql` metapackage tracks the
    newest major release, so adding this first and then installing would put a much newer
    server on the box than the distro one every other part of this script assumes.
    """
    run_cmd(["sudo", "apt", "install", "-y", "curl", "ca-certificates"])
    run_cmd(["sudo", "install", "-d", "/usr/share/postgresql-common/pgdg"])
    run_cmd(["sudo", "curl", "-fsSL", "-o",
             "/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc",
             "https://www.postgresql.org/media/keys/ACCC4CF8.asc"],
            msg="Fetching the PGDG signing key")

    codename = subprocess.run(["lsb_release", "-cs"], capture_output=True, text=True)
    suite = codename.stdout.strip() or "jammy"
    line = (f"deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] "
            f"https://apt.postgresql.org/pub/repos/apt {suite}-pgdg main\n")

    # Written through `sudo tee` rather than open(): this script is normally re-executed
    # under sudo, but every other privileged step here goes through an explicit sudo, and a
    # bare open() on /etc would be the one place that silently assumed otherwise.
    written = subprocess.run(["sudo", "tee", "/etc/apt/sources.list.d/pgdg.list"],
                             input=line, text=True, stdout=subprocess.DEVNULL)
    if written.returncode != 0:
        print("[WARN] could not write /etc/apt/sources.list.d/pgdg.list")
        return

    print(f"[*] Added PGDG repository ({suite}-pgdg)")
    run_cmd(["sudo", "apt", "update"])


def install_pgvector():
    """Installs the pgvector extension for the running server's major version.

    Not part of the corpus. The corpus — the rows in rag_chunk — is built elsewhere and
    restored as data; this is the platform underneath it, in the same category as libpq-dev,
    and it has to be on the appliance whether or not anyone has loaded a corpus yet.
    """
    major = _pg_server_major()
    if major is None:
        print("[WARN] could not determine the PostgreSQL server version; skipping pgvector.")
        return False

    package = f"postgresql-{major}-pgvector"

    installed = subprocess.run(["dpkg", "-s", package],
                               capture_output=True).returncode == 0
    if installed:
        print(f"[*] {package} already installed, skipping...")
        return True

    # Checked before reaching for PGDG: a future Ubuntu release may carry pgvector itself, and
    # adding a third-party repo that the distro has made unnecessary is a cost with no benefit.
    if not _apt_candidate_exists(package):
        print(f"[*] {package} not available from the configured repositories.")
        add_pgdg_repo()

    if not _apt_candidate_exists(package):
        print(f"[WARN] {package} is still unavailable after adding PGDG.")
        return False

    run_cmd(["sudo", "apt", "install", "-y", package],
            msg=f"Installing {package}")
    return True


def provision_rag_database():
    """Creates the empty corpus database and enables the vector extension in it.

    Empty on purpose. What goes IN it — the crawl, the chunking, the embedding run — is a batch
    job that lives in the corpus repository and takes minutes; it is not something an appliance
    does to itself at install time, and on an airgapped box it could not. This creates the
    container so that a corpus can be restored into it, and so that "no corpus loaded" is
    distinguishable from "the install is broken".

    CREATE EXTENSION runs as the postgres superuser because pgvector is not a trusted
    extension: the pretzel role cannot enable it itself.
    """
    # A fixed default: the daemon that used to own the retrieval config this was read from
    # is gone, and retrieval is not yet ported to pretzel-ai, so this provisions an empty
    # substrate for a future consumer.
    db = PG_RAG_DB_NAME

    if _pg_row_exists(f"SELECT 1 FROM pg_database WHERE datname='{db}'"):
        print(f"[*] PostgreSQL database '{db}' already exists, skipping...")
    else:
        run_cmd(["sudo", "-u", "postgres", "createdb", "-O", PG_DB_USER, db],
                msg=f"Creating corpus database '{db}' (owner={PG_DB_USER})")

    ext = subprocess.run(
        ["sudo", "-u", "postgres", "psql", "-d", db, "-v", "ON_ERROR_STOP=1", "-q",
         "-c", "CREATE EXTENSION IF NOT EXISTS vector"],
        capture_output=True, text=True,
    )
    if ext.returncode != 0:
        print(f"[WARN] could not enable the vector extension in '{db}': "
              f"{ext.stderr.strip()}")
        return False

    print(f"[*] Corpus database '{db}' ready (vector extension enabled, no corpus loaded)")
    return True


def install_rag_store():
    """pgvector + the empty corpus database.

    Failure is a warning, never fatal — the same policy install_test_deps() follows. Nine
    daemons and the whole web console do not touch this: without a corpus, the assistant
    reports retrieval as unavailable and answers every turn ungrounded, which is a running
    appliance with one feature degraded rather than a failed install.
    """
    try:
        if not install_pgvector():
            print("[WARN] pgvector unavailable — the AI Assistant will answer ungrounded. "
                  "The rest of the appliance is unaffected.")
            return
        provision_rag_database()
    except (Exception, SystemExit) as e:
        detail = f"exit status {e}" if isinstance(e, SystemExit) else str(e)
        print(f"[WARN] corpus store setup failed ({detail}) — the AI Assistant will answer "
              f"ungrounded. Re-run './pretzel install' to retry.")


def is_pgadmin_installed():
    """Checks whether pgAdmin is already installed in its dedicated virtualenv."""
    return os.path.isfile(os.path.join(PGADMIN_VENV, "bin", "gunicorn")) and \
        bool(glob.glob(os.path.join(PGADMIN_VENV, "lib", "python*", "site-packages", "pgadmin4")))


def install_pgadmin():
    """
    Installs pgAdmin 4 (web/server mode) into a dedicated Python virtualenv via pip.
    It is run headless under pz-pgadmin.service (gunicorn) — see script/start.py.
    The apt pgadmin4-web package is deliberately avoided: it pulls in Apache and an
    interactive setup-web.sh, which do not fit this project's unattended
    pz-*.service deployment model.
    """
    if is_pgadmin_installed():
        print("[*] pgAdmin already installed, skipping...")
        return

    print("[*] Installing pgAdmin...")

    # venv + headers needed to build pgAdmin's deps (psycopg, etc.) if no wheel.
    # libpq-dev is also pulled in by install_postgresql(); harmless to ensure here.
    run_cmd(["sudo", "apt", "install", "-y", "python3-venv", "python3-dev", "libpq-dev"])

    os.makedirs(os.path.dirname(PGADMIN_VENV), exist_ok=True)
    run_cmd(["python3", "-m", "venv", PGADMIN_VENV], msg="Creating pgAdmin virtualenv")

    pip = os.path.join(PGADMIN_VENV, "bin", "pip")
    run_cmd([pip, "install", "--upgrade", "pip", "wheel"], msg="Upgrading pip in pgAdmin venv")
    run_cmd([pip, "install", f"pgadmin4=={PGADMIN_VERSION}", "gunicorn"],
            msg=f"Installing pgAdmin4 {PGADMIN_VERSION} + gunicorn")

    if not is_pgadmin_installed():
        print("[ERROR] pgAdmin installation failed.")
        sys.exit(1)

    print("[*] pgAdmin installation complete.")


def get_gpp_version():
    """Extracts the major version of the currently installed g++ compiler."""
    try:
        out = subprocess.check_output(["g++", "--version"], stderr=subprocess.STDOUT)
        return int(out.decode().split("\n")[0].split()[-1].split(".")[0])
    except Exception:
        return 0

def install_system_packages():
    """
    Installs the basic build toolchain and required packages for the OS (Ubuntu/Debian) via APT.
    Groups required packages into a single apt command to optimize speed.
    """
    packages_to_install = []
    
    # 1. Build tools check (make, gcc, cmake, etc.)
    required_tools = ["make", "gcc", "g++", "cmake"]
    if any(shutil.which(tool) is None for tool in required_tools):
        packages_to_install.extend(["build-essential", "cmake"])

    # 2. GCC 9 version check (required for C++17 support)
    if get_gpp_version() < 9:
        packages_to_install.extend(["software-properties-common", "g++-9"])

    # 3. unixODBC check (for DB integration)
    if not os.path.exists("/usr/include/sql.h"):
        packages_to_install.extend(["unixodbc", "unixodbc-dev"])

    # Early exit if no packages need to be installed
    if not packages_to_install:
        print("[*] System dependencies (build tools, GCC >= 9, unixODBC) are already satisfied.")
        return

    print(f"[*] Installing system packages: {', '.join(packages_to_install)}")
    run_cmd(["sudo", "apt", "update"])
    
    # Add PPA repository for GCC-9 if required
    if "g++-9" in packages_to_install:
        run_cmd(["sudo", "add-apt-repository", "-y", "ppa:ubuntu-toolchain-r/test"])
        run_cmd(["sudo", "apt", "update"])

    # Batch install packages
    run_cmd(["sudo", "apt", "install", "-y"] + packages_to_install)

    # Set default gcc version to 9 using update-alternatives
    if "g++-9" in packages_to_install:
        run_cmd(["sudo", "update-alternatives", "--install", "/usr/bin/g++", "g++", "/usr/bin/g++-9", "20"])

def install_build_deps():
    """
    Build-time ONLY dependencies: the compiler toolchain, the C++ source libraries,
    and libpq-dev headers — everything needed to COMPILE the project (CMake +
    shared/db link against these). Does NOT install the runtime services, and does not
    install test-only libraries (see install_test_deps) — nothing here may require root,
    because script/build.py calls this unprivileged and a plain build must stay
    fast and side-effect-free.
    """
    install_system_packages()
    install_libpq_dev()
    install_libsnmp_dev()
    install_xmlsec_dev()
    install_openssl()
    install_spdlog()
    install_boost()
    install_json()
    install_grpc()


def install_test_deps():
    """
    Dependencies for tests/ only. Deliberately NOT part of install_build_deps(): no daemon
    links GoogleTest, and `./pretzel build` runs unprivileged, so fetching into the
    root-owned 3rd_party/ would fail there and block an ordinary build.

    Failure is a warning, never fatal — CMake finds GoogleTest with find_package(..., QUIET)
    and skips tests/ when it is absent, so the product still builds and installs.

    SystemExit is caught alongside Exception on purpose: run_cmd() and download_and_extract()
    report failure by calling sys.exit(), which raises SystemExit — and that derives from
    BaseException, not Exception, so catching Exception alone would let a failed download or
    build abort the whole install. KeyboardInterrupt is deliberately NOT caught, so Ctrl+C
    during a slow download still stops everything.
    """
    try:
        install_googletest()
    except (Exception, SystemExit) as e:
        # A SystemExit stringifies to its exit code, which alone reads like nonsense; the real
        # error was already printed by whichever helper bailed out.
        detail = f"exit status {e}" if isinstance(e, SystemExit) else str(e)
        print(f"[WARN] googletest not installed ({detail}) — tests/ will be skipped.")
        print("       The product build is unaffected; run './pretzel install' again to retry.")


def install_runtime_deps():
    """
    Runtime services the project needs to RUN but not to build: the PostgreSQL server (with
    role/database provisioning), the pgvector extension and empty corpus database, and the pgAdmin
    web UI.

    These pull in apt packages, download binaries and start systemd units, so they are kept out
    of the build path and only run on a full `./pretzel install`.
    """
    install_postgresql()
    install_rag_store()
    install_pgadmin()


def run():
    """Full install (./pretzel install): build deps + test deps + all runtime services."""
    os.makedirs(INSTALL_ROOT, exist_ok=True)
    install_build_deps()
    install_test_deps()
    install_runtime_deps()
    print("[*] All dependencies installed successfully.")


def run_build_deps():
    """Build-only deps (invoked by script/build.py before CMake/Make)."""
    os.makedirs(INSTALL_ROOT, exist_ok=True)
    install_build_deps()
    print("[*] Build dependencies ready.")


if __name__ == "__main__":
    run()

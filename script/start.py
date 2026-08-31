"""
script/start.py

A complete deployment pipeline script that deploys built binaries, configuration files, 
and certificates to the actual operational paths (/opt/pretzel, /etc/pretzel) and runs the services via systemd.
"""

import glob
import json
import os
import sys
import shutil
import subprocess
import time
from script.utils import (
    ROOT_DIR, BUILD_DIR, CERT_DIR, SECRET_DIR, run_cmd, install_file,
    PG_SERVICE, PG_DB_HOST, PG_DB_PORT, PG_DB_NAME, PG_DB_USER, PG_DB_PASSWORD,
    PGADMIN_VENV, PGADMIN_SETUP_EMAIL, PGADMIN_SETUP_PASSWORD,
)

# List of child systemd services targeted for start/restart
DAEMONS = [
    "pz-db-ready.service",
    "pz-ipcd.service", "pz-engined.service", "pz-authd.service", "pz-mgmtd.service",
    "pz-probed.service", "pz-collectord.service", "pz-topologyd.service", "pz-apid.service",
    "pz-pgadmin.service",
]

# Defines source and destination paths for deployment
BUILD_BIN_DIR = os.path.join(BUILD_DIR, "bin")
# Two source directories, split by destination rather than by file type:
#   service/ → /etc/systemd/system   unit files, nothing else
#   bin/     → /opt/pretzel/bin      runtime scripts that ship beside the compiled daemons
# Keeping a shell script in service/ made deploy_files' "install every .service" loop skip it, and
# left a file in a directory whose whole contents were otherwise systemd's.
SERVICE_DIR = os.path.join(os.path.dirname(__file__), "service")
SCRIPT_BIN_DIR = os.path.join(os.path.dirname(__file__), "bin")
SYSTEMD_DIR = "/etc/systemd/system"
INSTALL_BIN_DIR = "/opt/pretzel/bin"
ETC_ROOT_DIR = "/etc/pretzel"
CERT_INSTALL_DIR = os.path.join(ETC_ROOT_DIR, "cert")
CORE_DIR = "/var/crash/pretzel"
SYSCTL_CORE_FILE = "/etc/sysctl.d/60-pretzel-core.conf"
CREDENTIALS_KEY_NAME = "credentials.key"
CREDENTIALS_KEY_PATH = os.path.join(ETC_ROOT_DIR, CREDENTIALS_KEY_NAME)

TARGET = "pretzel.target"

# pgAdmin: canonical config lives under config/pgadmin/ (consistent with
# pgadmin). It is deployed both into the venv package dir (where pgAdmin
# reads it) and into /etc/pretzel/pgadmin/ (for parity). PGADMIN_WRAPPER_PATH is the
# generated launcher that pz-pgadmin.service execs.
PGADMIN_CONFIG_SRC = os.path.join(ROOT_DIR, "config", "pgadmin", "config_local.py")
PGADMIN_CONFIG_INSTALL_DIR = os.path.join(ETC_ROOT_DIR, "pgadmin")
PGADMIN_WRAPPER_PATH = os.path.join(INSTALL_BIN_DIR, "pz-pgadmin")

# pz daemons read the baseline startup-config from /etc/pretzel/startup-config.json
# (deployed by deploy_startup_config) for DB connection params + factory seed, then
# adopt the live config from the DB. Runtime state lives under /var/lib/pretzel/<daemon>/.
STATE_ROOT_DIR = "/var/lib/pretzel"

# Static web frontend assets served by mgmtd, installed read-only alongside the
# binaries (see pz::mgmtd::HttpServer — overridable via PRETZEL_SHARE_DIR).
SHARE_INSTALL_DIR = "/opt/pretzel/share"
MGMTD_WWW_INSTALL_DIR = os.path.join(SHARE_INSTALL_DIR, "mgmtd", "www")

def ensure_credentials_key() -> None:
    """
    Generates the credential-store master key in secret/ if missing, the same way
    ensure_certificates() handles the TLS key: gitignored, created per install, deployed to
    /etc/pretzel by this script.

    It encrypts device API keys before they reach the database, so a database copy on its own
    (a dump, a backup, a replica) is useless without the file. Committing it to the repository
    would defeat that entirely, which is why it is generated rather than shipped.

    Losing it is recoverable: the stored keys stop decrypting and each API Key is re-issued by
    running its Key Gen Test again.
    """
    os.makedirs(SECRET_DIR, exist_ok=True)
    key = os.path.join(SECRET_DIR, CREDENTIALS_KEY_NAME)
    if os.path.isfile(key) and os.path.getsize(key) == 32:
        return

    try:
        with open(key, "wb") as f:
            f.write(os.urandom(32))          # AES-256
        os.chmod(key, 0o600)
    except OSError as e:
        sys.exit(f"[FATAL] failed to create credential-store key {key}: {e}")
    print(f"[*] Generated credential-store key -> secret/{CREDENTIALS_KEY_NAME}")


def deploy_startup_config() -> None:
    """
    Installs the baseline startup-config to the active path
    /etc/pretzel/startup-config.json. Daemons read this file at bootstrap for the DB
    connection params and as the factory-fresh seed / offline fallback; mgmtd syncs
    it into the DB.

    config/startup-config.json is committed (it carries NO secrets): the DB password
    is injected here from the single source of truth (PZ_PG_PASSWORD via PG_DB_PASSWORD)
    so mgmtd's connection password can never drift from the role install.py created; the
    admin credential lives hashed in the admin_user table; SNMP v3 credentials are entered
    via the mgmtd web UI at runtime. So nothing secret is ever persisted in this file.
    """
    src = os.path.join(ROOT_DIR, "config", "startup-config.json")
    if not os.path.isfile(src):
        sys.exit(f"[FATAL] startup-config not found: {src}")

    try:
        with open(src) as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f"[FATAL] failed to read startup-config {src}: {e}")

    # Drop the template's "//"-prefixed comment keys (present only in the seeded
    # example) so the deployed config stays clean.
    if isinstance(cfg, dict):
        for k in [k for k in cfg if isinstance(k, str) and k.startswith("//")]:
            cfg.pop(k)

    # Inject the canonical DB password — single source of truth.
    try:
        cfg["pretzel"]["database"]["password"] = PG_DB_PASSWORD
    except (KeyError, TypeError):
        print("[WARN] startup-config has no pretzel.database block; "
              "leaving DB password as-is.")

    os.makedirs(ETC_ROOT_DIR, exist_ok=True)
    dst = os.path.join(ETC_ROOT_DIR, "startup-config.json")
    tmp = dst + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(cfg, f, indent=2)   # carries the injected DB password -> 0600
        os.chmod(tmp, 0o600)
        os.replace(tmp, dst)              # atomic swap
    except OSError as e:
        sys.exit(f"[FATAL] failed to install startup-config: {e}")
    print(f"[*] Installed startup-config: {dst}")




def ensure_certificates() -> None:
    """
    Generates a self-signed TLS pair in cert/ if missing. The private key
    (cert/server.key) is gitignored, so a fresh checkout has none — create one so
    mgmtd's HTTPS endpoint can start. Real deployments should drop in a CA-issued
    cert/key here instead.
    """
    os.makedirs(CERT_DIR, exist_ok=True)
    crt = os.path.join(CERT_DIR, "server.crt")
    key = os.path.join(CERT_DIR, "server.key")
    if os.path.isfile(crt) and os.path.isfile(key):
        return
    # openssl is chatty (key-gen progress dots, banners) — capture its output and
    # surface it only on failure, so a successful run is a single clean log line.
    r = subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", crt, "-days", "825",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], check=False, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"[FATAL] openssl cert generation failed:\n{(r.stdout + r.stderr).rstrip()}")
    os.chmod(key, 0o600)
    print("[*] Generated self-signed TLS certificate -> cert/server.{crt,key}")


def pre_flight_checks():
    """
    Validates that all required files (built binaries, external dependencies, etc.) 
    are ready before service deployment.
    """
    # 1. Validate built binaries
    if not os.path.isdir(BUILD_BIN_DIR) or not os.listdir(BUILD_BIN_DIR):
        sys.exit("[ERROR] build/bin not found or empty. Run build first.")
        
    # 5. Validate PostgreSQL is installed (server + client). Provisioned by install.
    if shutil.which("psql") is None:
        sys.exit("[ERROR] PostgreSQL not found. Install first: ./pretzel install")

    # 6. Validate pgAdmin virtualenv (gunicorn launcher present). Provisioned by install.
    if not os.path.isfile(os.path.join(PGADMIN_VENV, "bin", "gunicorn")):
        sys.exit("[ERROR] pgAdmin venv not found. Install first: ./pretzel install")


def ensure_postgresql():
    """
    Ensures the PostgreSQL cluster (distro-managed postgresql.service) is enabled
    and accepting connections BEFORE the pz daemons that depend on it are started.
    postgresql.service is intentionally NOT PartOf pretzel.target, so it survives
    `./pretzel stop` and every deploy cycle (the DB must persist across restarts).
    """
    print("[*] Ensuring PostgreSQL is up...")
    # Only enable when not already enabled — `systemctl enable` re-prints a noisy
    # "Synchronizing state ..." block every time on this SysV-compat unit. Starting
    # an already-running service is a quiet no-op.
    already_enabled = subprocess.run(
        ["systemctl", "is-enabled", "--quiet", PG_SERVICE], check=False).returncode == 0
    if already_enabled:
        subprocess.run(["systemctl", "start", PG_SERVICE], check=False)
    else:
        run_cmd(["systemctl", "enable", "--now", PG_SERVICE], msg=f"Enabling {PG_SERVICE}")

    # Wait until the cluster accepts TCP connections (pz-mgmtd connects via localhost).
    for _ in range(30):
        ready = subprocess.run(
            ["pg_isready", "-q", "-h", PG_DB_HOST, "-p", str(PG_DB_PORT)],
            check=False,
        )
        if ready.returncode == 0:
            print("[*] PostgreSQL is ready.")
            return
        time.sleep(0.5)

    print("[WARN] PostgreSQL not ready in time; pz-mgmtd will retry its DB connection.")


def _pgadmin_web_dir():
    """Resolves the installed pgadmin4 package directory inside the venv (the dir
    holding config.py / pgAdmin4.py). Returns None if pgAdmin is not installed."""
    matches = glob.glob(
        os.path.join(PGADMIN_VENV, "lib", "python*", "site-packages", "pgadmin4"))
    return matches[0] if matches else None


def _read_pgadmin_settings():
    """Loads the canonical pgAdmin config (config/pgadmin/config_local.py) and
    returns the values start.py needs: the listen address/port (for the gunicorn
    bind) and the writable data dir / log file (to pre-create)."""
    ns = {}
    with open(PGADMIN_CONFIG_SRC) as f:
        exec(compile(f.read(), PGADMIN_CONFIG_SRC, "exec"), ns)
    return {
        "address": ns.get("PZ_PGADMIN_LISTEN_ADDRESS", "0.0.0.0"),
        "port": int(ns.get("PZ_PGADMIN_LISTEN_PORT", 5050)),
        "data_dir": ns.get("DATA_DIR", "/var/lib/pretzel/pgadmin"),
        "log_file": ns.get("LOG_FILE", "/var/log/pretzel/pgadmin.log"),
        "tls_enabled": bool(ns.get("PZ_PGADMIN_TLS_ENABLED", False)),
        "tls_cert": ns.get("PZ_PGADMIN_TLS_CERT", ""),
        "tls_key": ns.get("PZ_PGADMIN_TLS_KEY", ""),
    }


def deploy_pgadmin():
    """
    Deploys pgAdmin's canonical config and generates the launcher pz-pgadmin.service
    execs:
      1. install config/pgadmin/config_local.py into pgAdmin's package dir (where it
         is read at startup) and into /etc/pretzel/pgadmin/ (parity with the others)
      2. bootstrap the SQLite config DB and the admin account
      3. generate /opt/pretzel/bin/pz-pgadmin (a gunicorn wrapper; the listen
         address/port come from the same config file — single source of truth — and
         the resolved venv/web-dir paths are baked in since systemd's ExecStart needs
         a literal executable)
    Idempotent: re-running overwrites config/wrapper and syncs the admin password.
    """
    # Explicit opt-out: PZ_SKIP_PGADMIN=1 skips the whole pgAdmin deploy (config +
    # the slow setup-db migration + wrapper). Only safe once pgAdmin has been
    # deployed at least once before — the launcher/config from the prior run remain.
    if os.environ.get("PZ_SKIP_PGADMIN"):
        print("[*] PZ_SKIP_PGADMIN set; skipping pgAdmin deploy.")
        return

    web_dir = _pgadmin_web_dir()
    if not web_dir:
        print("[WARN] pgAdmin venv not found; skipping pgAdmin deploy. Run install first.")
        return
    if not os.path.isfile(PGADMIN_CONFIG_SRC):
        print(f"[WARN] {PGADMIN_CONFIG_SRC} missing; skipping pgAdmin deploy.")
        return

    cfg = _read_pgadmin_settings()
    os.makedirs(cfg["data_dir"], exist_ok=True)
    os.makedirs(os.path.dirname(cfg["log_file"]), exist_ok=True)

    # 1. Deploy the canonical config: into the package dir (pgAdmin reads
    #    config_local from there) and into /etc/pretzel/pgadmin for parity.
    install_file(PGADMIN_CONFIG_SRC, os.path.join(web_dir, "config_local.py"), quiet=True)
    os.makedirs(PGADMIN_CONFIG_INSTALL_DIR, exist_ok=True)
    install_file(PGADMIN_CONFIG_SRC, os.path.join(PGADMIN_CONFIG_INSTALL_DIR, "config_local.py"), quiet=True)
    print("[*] Deployed pgAdmin config_local.py")

    # 2. Bootstrap the SQLite config DB + admin account. pgAdmin's setup.py is noisy
    #    on every call (a Python FutureWarning, a banner, a "User already exists"
    #    line and a user-details table), so run it quietly: silence warnings via
    #    PYTHONWARNINGS and capture output, surfacing it only when a command fails.
    py = os.path.join(PGADMIN_VENV, "bin", "python")
    setup_py = os.path.join(web_dir, "setup.py")
    # PGADMIN_SETUP_EMAIL/PASSWORD make `setup-db` non-interactive: without them it
    # prompts on stdin for the initial admin account and — since we capture output and
    # give no stdin — blocks forever. We also pass stdin=DEVNULL below as a belt-and-
    # suspenders guard so any unexpected prompt gets EOF and fails fast instead of hanging.
    env = dict(os.environ, PYTHONWARNINGS="ignore",
               PGADMIN_SETUP_EMAIL=PGADMIN_SETUP_EMAIL,
               PGADMIN_SETUP_PASSWORD=PGADMIN_SETUP_PASSWORD)

    def _setup(args, why, warn=True):
        r = subprocess.run([py, setup_py, *args], cwd=web_dir, env=env,
                           stdin=subprocess.DEVNULL,
                           check=False, capture_output=True, text=True)
        if r.returncode != 0 and warn:
            print(f"[WARN] pgAdmin {why} failed:\n{(r.stdout + r.stderr).rstrip()}")
        return r.returncode

    # setup-db (schema init/migration) is the slow step and only needs to run on a
    # fresh DB or after a pgAdmin version bump. Once the SQLite config DB exists the
    # account is already provisioned, so skip the whole bootstrap by default to keep
    # re-deploys fast. Force it with PZ_PGADMIN_FORCE_SETUP=1 (e.g. after upgrading
    # PGADMIN_VERSION, to run pending migrations / resync the admin password).
    sqlite_db = os.path.join(cfg["data_dir"], "pgadmin4.db")
    if os.path.isfile(sqlite_db) and not os.environ.get("PZ_PGADMIN_FORCE_SETUP"):
        print(f"[*] pgAdmin already initialized ({sqlite_db}); skipping setup-db. "
              f"Set PZ_PGADMIN_FORCE_SETUP=1 to re-run migrations / resync admin.")
    else:
        # setup-db initialises/migrates the schema. add-user creates the account on a
        # fresh DB; "User already exists" (non-zero) is expected on re-deploys, so its
        # result is ignored — update-user below is authoritative and enforces the
        # password/active/admin state so credentials stay in sync.
        _setup(["setup-db"], "setup-db")
        _setup(["add-user", PGADMIN_SETUP_EMAIL, PGADMIN_SETUP_PASSWORD, "--admin"],
               "add-user", warn=False)
        if _setup(["update-user", PGADMIN_SETUP_EMAIL,
                   "--password", PGADMIN_SETUP_PASSWORD, "--active", "--admin"],
                  "update-user") == 0:
            print(f"[*] pgAdmin admin account ready: {PGADMIN_SETUP_EMAIL}")

    # 3. Generate the gunicorn launcher (bind from the canonical config; paths quoted).
    #    When TLS is enabled, gunicorn terminates HTTPS itself with mgmtd's cert/key.
    gunicorn = os.path.join(PGADMIN_VENV, "bin", "gunicorn")
    tls_lines = ""
    scheme = "http"
    if cfg["tls_enabled"] and cfg["tls_cert"] and cfg["tls_key"]:
        tls_lines = (f'  --certfile "{cfg["tls_cert"]}" \\\n'
                     f'  --keyfile "{cfg["tls_key"]}" \\\n')
        scheme = "https"
    wrapper = (
        "#!/bin/sh\n"
        "# Generated by script/start.py (deploy_pgadmin). Do not edit by hand.\n"
        "# Listen address/port (and TLS) come from config/pgadmin/config_local.py.\n"
        f'exec "{gunicorn}" \\\n'
        f'  --bind {cfg["address"]}:{cfg["port"]} \\\n'
        f'{tls_lines}'
        "  --workers=1 --threads=25 \\\n"
        f'  --chdir "{web_dir}" \\\n'
        "  pgAdmin4:app\n"
    )
    os.makedirs(INSTALL_BIN_DIR, exist_ok=True)
    if os.path.exists(PGADMIN_WRAPPER_PATH):
        os.remove(PGADMIN_WRAPPER_PATH)
    with open(PGADMIN_WRAPPER_PATH, "w") as f:
        f.write(wrapper)
    os.chmod(PGADMIN_WRAPPER_PATH, 0o755)
    print(f"[*] Generated pgAdmin launcher: {PGADMIN_WRAPPER_PATH} "
          f"({scheme}://{cfg['address']}:{cfg['port']})")


def stop_services():
    """
    [Core Logic] Completely stops existing service processes before deployment.
    Services MUST be brought down before copying files to prevent OS-level locks 
    (Text file busy, Errno 26) when overwriting running binaries.
    """
    print("[*] Stopping existing services...")
    subprocess.run(["systemctl", "stop", TARGET], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    # Delay to ensure processes fully terminate and file locks are released
    time.sleep(2)


def deploy_coredump():
    """
    Core dumps for the pretzel daemons.

    A crash on a customer appliance is debugged from a core file or it is guessed at — there is no
    attaching gdb to somebody else's box. Three things have to be true for that to work, and none
    of them is a default:

      1. RLIMIT_CORE's SOFT limit must be raised. systemd leaves it at 0 on Ubuntu, so the units
         carry LimitCORE=infinity (a hard limit alone writes nothing). That travels with the unit
         files and needs nothing here.
      2. kernel.core_pattern must point somewhere useful. Out of the box it pipes to apport, which
         files a .crash report for a packaged program and is no help for a locally built daemon.
      3. Somewhere to put them, readable by whoever debugs without being readable by everyone. A
         core is a dump of process memory: decrypted device API keys, bearer tokens and session ids
         are in it verbatim, so the directory is root:adm 0750 — the same arrangement the distro
         uses for privileged logs, and `adm` is a group operators are already in.
    """
    print("[*] Configuring core dumps...")

    # The handler lives beside the binaries it serves; core_pattern runs it as root with the core
    # on stdin. It also owns the naming and retention — see the script for why both are needed.
    install_file(os.path.join(SCRIPT_BIN_DIR, "pz-core-handler"),
                 os.path.join(INSTALL_BIN_DIR, "pz-core-handler"), 0o755, quiet=True)

    os.makedirs(CORE_DIR, exist_ok=True)
    try:
        shutil.chown(CORE_DIR, user="root", group="adm")
        os.chmod(CORE_DIR, 0o750)
    except (LookupError, PermissionError) as e:
        # A system without an `adm` group still gets cores; they are simply root-only.
        print(f"[!] Could not set {CORE_DIR} to root:adm ({e}) — leaving it root-owned")

    # A sysctl drop-in rather than a live `sysctl -w`, so the setting survives a reboot. Applied
    # immediately too: the daemons are about to start and the first crash may be one of them.
    with open(SYSCTL_CORE_FILE, "w") as f:
        f.write(
            "# Cores for the pretzel daemons go through pz-core-handler, which names them by\n"
            "# daemon and time and forwards anything that is not ours back to the distribution\n"
            "# handler. Installed by script/start.py (./pretzel start).\n"
            f"kernel.core_pattern=|{INSTALL_BIN_DIR}/pz-core-handler %p %e %s %E\n"
            "kernel.core_uses_pid=0\n"
        )
    run_cmd(["sysctl", "-q", "-p", SYSCTL_CORE_FILE], msg=None)
    print(f"[*] Core dumps -> {CORE_DIR} (root:adm 0750, newest 20 kept)")


def deploy_files():
    """
    Copies all files required for the operational environment (binaries, configs, service units, etc.) 
    to their destination folders.
    """
    print("[*] Deploying files...")

    # Create required destination directories
    os.makedirs(INSTALL_BIN_DIR, exist_ok=True)

    # Files are copied quietly and reported as one summary line per group (the
    # per-file detail is noise; counts are enough to confirm a successful deploy).

    # 1. Deploy self-compiled Pretzel binaries (Execution permission 755)
    pz_bins = os.listdir(BUILD_BIN_DIR)
    for f in pz_bins:
        install_file(os.path.join(BUILD_BIN_DIR, f), os.path.join(INSTALL_BIN_DIR, f), 0o755, quiet=True)
    print(f"[*] Deployed {len(pz_bins)} pretzel binaries -> {INSTALL_BIN_DIR}")

    # 5. Deploy Systemd daemon service files
    units = [f for f in os.listdir(SERVICE_DIR) if f.endswith((".service", ".target"))]
    for f in units:
        install_file(os.path.join(SERVICE_DIR, f), os.path.join(SYSTEMD_DIR, f), quiet=True)
    print(f"[*] Deployed {len(units)} systemd units -> {SYSTEMD_DIR}")

    # 6. Deploy certificate files (Private key files (.key) are strictly set to 600 permission)
    if os.path.isdir(CERT_DIR):
        os.makedirs(CERT_INSTALL_DIR, exist_ok=True)
        certs = os.listdir(CERT_DIR)
        for f in certs:
            mode = 0o600 if f.endswith(".key") or "key" in f.lower() else 0o644
            install_file(os.path.join(CERT_DIR, f), os.path.join(CERT_INSTALL_DIR, f), mode, quiet=True)
        print(f"[*] Deployed TLS cert/key -> {CERT_INSTALL_DIR}")

    # 6b. Deploy the credential-store master key (0600: it decrypts stored device credentials).
    src_key = os.path.join(SECRET_DIR, CREDENTIALS_KEY_NAME)
    if os.path.isfile(src_key):
        install_file(src_key, CREDENTIALS_KEY_PATH, 0o600, quiet=True)
        print(f"[*] Deployed credential-store key -> {CREDENTIALS_KEY_PATH}")

    # 7. Install the baseline startup-config to /etc/pretzel/startup-config.json.
    #    mgmtd syncs it into the DB at boot; all daemons read it for DB conn params.
    deploy_startup_config()

    # 7b. Deploy the IEEE OUI lookup table (engined resolves host MAC -> vendor).
    #     Generated by script/fetch_oui.py; skipped with a warning if absent.
    oui_src = os.path.join(ROOT_DIR, "shared", "data", "oui.tsv")
    if os.path.isfile(oui_src):
        install_file(oui_src, os.path.join(ETC_ROOT_DIR, "oui.tsv"), 0o644, quiet=True)
        print(f"[*] Deployed OUI table -> {os.path.join(ETC_ROOT_DIR, 'oui.tsv')}")
    else:
        print(f"[WARN] OUI table not found ({oui_src}); host vendor lookup disabled. "
              f"Run: python3 script/fetch_oui.py")

    # 8. Create the runtime-state root. Each daemon creates its own
    # <daemon>/ subdirectory on first write (see Config::saveStateSnapshot).
    os.makedirs(STATE_ROOT_DIR, exist_ok=True)

    # 9. Deploy the mgmtd web frontend (static, read-only — always overwritten).
    if os.path.isdir(MGMTD_WWW_INSTALL_DIR):
        shutil.rmtree(MGMTD_WWW_INSTALL_DIR)
    shutil.copytree(os.path.join(ROOT_DIR, "mgmtd", "www"), MGMTD_WWW_INSTALL_DIR)

    # 10. Configure pgAdmin (server mode) and generate its systemd launcher.
    deploy_pgadmin()


def start_services():
    """
    Reloads the Systemd daemon and restarts the services after file deployment is complete.
    """
    print("[*] Starting services...")
    # Reload daemon so systemd recognizes newly copied service files
    run_cmd(["systemctl", "daemon-reload"], msg="Reloading systemd")
    
    # Register for automatic start on OS boot (Enable)
    run_cmd(["systemctl", "enable", TARGET], msg=f"Enabling {TARGET}")
    for svc in DAEMONS:
        run_cmd(["systemctl", "enable", svc], msg=f"Enabling {svc}")
        
    # Restart the service target and check status
    run_cmd(["systemctl", "restart", TARGET], msg=f"Restarting {TARGET}")
    subprocess.run(["systemctl", "status", TARGET, "-n", "0", "--no-pager"], check=False)


def run():
    """Main orchestration logic for the deployment pipeline."""
    pre_flight_checks()

    # Both keys are gitignored, so a fresh checkout has neither — create them before
    # deploy_files copies cert/ and secret/ into /etc/pretzel.
    ensure_certificates()
    ensure_credentials_key()

    # [CRITICAL ORDER] stop -> overwrite files (+startup-config) -> DB up -> start
    # daemons. mgmtd seeds the DB from the startup-config at boot, so PostgreSQL must
    # be accepting connections before the daemons start.
    stop_services()
    deploy_files()
    deploy_coredump()
    ensure_postgresql()
    start_services()

if __name__ == "__main__":
    run()

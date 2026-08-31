"""
script/reset.py

Factory-resets the pretzel application database.

The pretzel daemons own every table in the `pretzel` database and rebuild them
on the next boot: engined's Config::preflight() runs ensureSchema() (CREATE TABLE
IF NOT EXISTS for the full schema) and then seedStore(), which re-seeds the
startup_config baseline, running_config v1, and the default admin login from
config/startup-config.json. So a clean reset is simply: stop the fleet, DROP the
pretzel-owned tables, then start again — the app reseeds itself.

What this does NOT touch:
  * postgresql.service — left running by design (same policy as `./pretzel stop`;
    the cluster/role/database persist, only the pretzel tables are dropped).
  * the on-disk startup-config.json / certs / installed binaries.

Usage:
    ./pretzel reset            # prompts for confirmation
    ./pretzel reset --yes      # skip the prompt (scripted / CI)
    ./pretzel reset --start    # reset, then start the fleet (triggers reseed)
"""

import os
import subprocess
import sys

from script.utils import (
    run_cmd,
    PG_SERVICE,
    PG_DB_HOST,
    PG_DB_PORT,
    PG_DB_NAME,
    PG_DB_USER,
    PG_DB_PASSWORD,
)

TARGET = "pretzel.target"

# The pretzel-owned tables, dropped with CASCADE so any dependent objects go too.
# Everything the daemons create must be listed here, or a "clean" reset silently keeps rows.
# The trailing block is retired tables — harmless if absent, but listed so an upgraded install
# is left as clean as a fresh one.
PZ_TABLES = [
    # live
    "running_config",
    "startup_config",
    "local_users",
    "ngfw_device",        # device projection (ICMP-reached firewalls)
    "sase_device",        # device projection (API-reached tenants) + sealed api-key + egress cache
    "api_credential_state",
    "ai_provider_credential_state",  # the AI providers' sealed API keys
    "api_collection",     # connector endpoint-poll samples
    "system_log",         # tailed daemon logs
    "system_log_offset",  # per-daemon tailer checkpoint
    # retired
    "devices",            # pre-split mixed device projection
    "inventory",          # pre-rename device projection
    "probe_devices",      # mixed ICMP status + discovered SNMP data
    "snmp_devices",       # pre-rename (snmpd -> collectord)
    "state_snapshot",     # heartbeat snapshot, written but never read
    "admin_user",         # pre-rename local_users
    "device_credentials", # abandoned credential store, never wired
    "api_endpoint_state", # declared before it had a writer
]


def _confirm() -> bool:
    """Destructive-op guard. Skipped when --yes/-y/--force is passed."""
    if any(a in ("--yes", "-y", "--force") for a in sys.argv[2:]):
        return True
    print(f"[!] This DROPS all pretzel tables in database '{PG_DB_NAME}' "
          f"({PG_DB_HOST}:{PG_DB_PORT}).")
    print("    Config history, device inventory, and local users will be erased.")
    print("    postgresql itself stays up; the app reseeds a factory baseline on next start.")
    try:
        return input("    Type 'reset' to confirm: ").strip() == "reset"
    except (EOFError, KeyboardInterrupt):
        print()
        return False


def _ensure_pg_ready() -> bool:
    """postgresql must be up to drop the tables. Start it if needed, then probe."""
    subprocess.run(["systemctl", "start", PG_SERVICE], check=False)
    ready = subprocess.run(
        ["pg_isready", "-q", "-h", PG_DB_HOST, "-p", str(PG_DB_PORT)], check=False
    )
    return ready.returncode == 0


def _psql(sql: str) -> int:
    """Runs SQL as the pretzel role over localhost TCP. PGPASSWORD mirrors how the
    daemons authenticate (PZ_PG_PASSWORD; localhost-only dev default in utils.py)."""
    env = dict(os.environ, PGPASSWORD=PG_DB_PASSWORD)
    return subprocess.run(
        ["psql", "-h", PG_DB_HOST, "-p", str(PG_DB_PORT),
         "-U", PG_DB_USER, "-d", PG_DB_NAME,
         "-v", "ON_ERROR_STOP=1", "-q", "-c", sql],
        env=env, check=False,
    ).returncode


def run():
    if not _confirm():
        print("[*] Aborted — nothing changed.")
        return

    # 1. Stop the fleet so no daemon holds a DB connection or reseeds mid-reset.
    #    postgresql.service is NOT PartOf pretzel.target, so it stays up (by design).
    if subprocess.run(["systemctl", "is-active", "--quiet", TARGET],
                      check=False).returncode == 0:
        run_cmd(["systemctl", "stop", TARGET], msg=f"Stopping {TARGET}")
    else:
        print(f"[*] {TARGET} not running")

    # 2. Ensure the cluster is reachable before we touch it.
    if not _ensure_pg_ready():
        print(f"[Error] {PG_SERVICE} not accepting connections at "
              f"{PG_DB_HOST}:{PG_DB_PORT}; cannot reset.")
        sys.exit(1)

    # 3. Drop the pretzel-owned tables in one statement (CASCADE resolves any deps).
    drop_sql = "DROP TABLE IF EXISTS " + ", ".join(PZ_TABLES) + " CASCADE;"
    print(f"[*] Dropping tables: {', '.join(PZ_TABLES)}")
    if _psql(drop_sql) != 0:
        print("[Error] table drop failed (see psql output above).")
        sys.exit(1)
    print("[*] Database reset complete.")

    # 4. Optionally start the fleet, which triggers engined preflight -> ensureSchema
    #    + seedStore (factory baseline). Otherwise the next `./pretzel start` does it.
    if "--start" in sys.argv[2:]:
        run_cmd(["systemctl", "start", TARGET], msg=f"Starting {TARGET}")
        subprocess.run(["systemctl", "status", TARGET, "-n", "0", "--no-pager"], check=False)
    else:
        print("[*] Run './pretzel start' to reseed the factory baseline.")


if __name__ == "__main__":
    run()

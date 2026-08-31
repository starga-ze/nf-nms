#!/usr/bin/env python3
"""pretzel-package — install the compiled daemons on a production host.

    sudo ./pretzel-package install

This file runs standalone from inside the package — a production host has no repository.

The C++ binaries link gRPC, protobuf, boost and spdlog statically, so the only dynamic
dependencies left are the ones the distribution provides (libpq, libssl, libstdc++ and friends).
That is why copying the binaries is enough, provided the distribution and its major version
match. The installer confirms this with ldd rather than assuming it.

What it deliberately does not install:
    /etc/pretzel/credentials.key   encrypts device API keys before they reach the database. It
                                   must differ per host; shipping it would make it a shared secret.
    /etc/pretzel/cert/             TLS certificates, tied to the hostname.
    /etc/pretzel/db.env            database connection details.
    PostgreSQL                     installed and initialised separately.
These must exist beforehand. If any is missing the installer says exactly which and stops.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.abspath(os.path.dirname(__file__))

INSTALL_BIN_DIR = "/opt/pretzel/bin"
SHARE_INSTALL_DIR = "/opt/pretzel/share"
MGMTD_WWW_INSTALL_DIR = os.path.join(SHARE_INSTALL_DIR, "mgmtd", "www")
SYSTEMD_DIR = "/etc/systemd/system"
ETC_ROOT_DIR = "/etc/pretzel"

# Things this installer cannot create. If any is missing the services would start but not do
# their job — better to stop and say so than to run half-working.
PREREQ = (
    (os.path.join(ETC_ROOT_DIR, "credentials.key"), "device API key encryption key"),
    (os.path.join(ETC_ROOT_DIR, "cert"), "TLS certificate directory"),
    (os.path.join(ETC_ROOT_DIR, "db.env"), "database connection details"),
)


def say(msg):
    print(f"[*] {msg}")


def die(msg, hint=""):
    print(f"\n[Error] {msg}", file=sys.stderr)
    if hint:
        for line in hint.splitlines():
            print(f"        {line}", file=sys.stderr)
    sys.exit(1)


def run_cmd(cmd, msg=None, check=True):
    if msg:
        say(msg)
    r = subprocess.run(cmd)
    if check and r.returncode != 0:
        die(f"Command failed: {' '.join(cmd)}")
    return r.returncode


def manifest():
    with open(os.path.join(HERE, "MANIFEST.json")) as f:
        return json.load(f)


def _os_id():
    out = {}
    try:
        with open("/etc/os-release") as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    out[k] = v.strip('"')
    except OSError:
        return "?"
    return f"{out.get('ID','?')} {out.get('VERSION_ID','?')}"


# ── Preflight ────────────────────────────────────────────────────────────────────────────────

def preflight(mf):
    if os.geteuid() != 0:
        die("Root privileges are required.", "sudo ./pretzel-package install")

    here = _os_id()
    built = mf.get("os", "")
    if built and here != built:
        die(f"OS mismatch: the package was built on '{built}', this host is '{here}'.",
            "The dependencies that are not statically linked (libpq, libssl and so on) are tied\n"
            "to the distribution version. Rebuild the package on a matching host.")
    say(f"OS: {here}")

    arch = mf.get("arch", "")
    if arch and arch != os.uname().machine:
        die(f"Architecture mismatch: package {arch}, host {os.uname().machine}.")


def check_linkage():
    """Confirm with ldd. "same OS so it should work" and "it does work" are different claims."""
    bindir = os.path.join(HERE, "bin")
    missing = {}
    for name in sorted(os.listdir(bindir)):
        p = os.path.join(bindir, name)
        if not os.access(p, os.X_OK):
            continue
        out = subprocess.run(["ldd", p], capture_output=True, text=True).stdout
        gone = [ln.split("=>")[0].strip() for ln in out.splitlines() if "not found" in ln]
        if gone:
            missing[name] = gone
    if missing:
        libs = sorted({l for v in missing.values() for l in v})
        die("Shared libraries are missing, so the binaries cannot run:\n        " +
            "\n        ".join(f"{k}: {', '.join(v)}" for k, v in missing.items()),
            "Usually libpq5 alone covers it:\n"
            "  sudo apt-get install -y libpq5\n"
            f"Needed: {', '.join(libs)}")
    say(f"Dynamic linkage: all {len(os.listdir(bindir))} binaries resolve")


def check_prereq():
    missing = [(p, d) for p, d in PREREQ if not os.path.exists(p)]
    pg = subprocess.run(["systemctl", "is-active", "--quiet", "postgresql"],
                        check=False).returncode == 0
    if not missing and pg:
        say("Prerequisites: /etc/pretzel assets present, PostgreSQL running")
        return True

    print()
    say("Prerequisites are not in place. Files will be installed but no service will be started:")
    for p, d in missing:
        print(f"      missing: {p}  ({d})")
    if not pg:
        print("      PostgreSQL is not running  (sudo systemctl start postgresql)")
    print()
    return False


def verify_files(mf):
    bad = []
    for rel, want in mf.get("files", {}).items():
        p = os.path.join(HERE, rel)
        if not os.path.isfile(p):
            bad.append(f"{rel} (missing)")
            continue
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != want:
            bad.append(f"{rel} (checksum mismatch)")
    if bad:
        die("Package integrity check failed:\n        " + "\n        ".join(bad[:10]),
            "The transfer may have been truncated. Copy the tarball across again.")
    say(f"Integrity: {len(mf.get('files', {}))} files verified")


# ── Install ──────────────────────────────────────────────────────────────────────────────────

def units_in_package():
    d = os.path.join(HERE, "service")
    return sorted(f for f in os.listdir(d)) if os.path.isdir(d) else []


def stop_services(units):
    """Bring them down before copying. Overwriting a running binary either fails with ETXTBSY or,
    worse, leaves a half-written file for the next restart to pick up."""
    names = [u for u in units if u.endswith(".service")]
    if names:
        subprocess.run(["systemctl", "stop"] + names, check=False)
        say(f"Stopped {len(names)} services")


def install_binaries():
    os.makedirs(INSTALL_BIN_DIR, exist_ok=True)
    src = os.path.join(HERE, "bin")
    n = 0
    for name in sorted(os.listdir(src)):
        shutil.copy2(os.path.join(src, name), os.path.join(INSTALL_BIN_DIR, name))
        os.chmod(os.path.join(INSTALL_BIN_DIR, name), 0o755)
        n += 1
    say(f"{n} binaries -> {INSTALL_BIN_DIR}")


def install_www():
    src = os.path.join(HERE, "share", "mgmtd", "www")
    if not os.path.isdir(src):
        return
    # Replace wholesale. A stale js file left behind mixes with the new one through the browser
    # cache and produces bugs that will not reproduce.
    if os.path.isdir(MGMTD_WWW_INSTALL_DIR):
        shutil.rmtree(MGMTD_WWW_INSTALL_DIR)
    shutil.copytree(src, MGMTD_WWW_INSTALL_DIR)
    n = sum(len(f) for _, _, f in os.walk(MGMTD_WWW_INSTALL_DIR))
    say(f"{n} web console files -> {MGMTD_WWW_INSTALL_DIR}")


def install_units(units):
    src = os.path.join(HERE, "service")
    for name in units:
        shutil.copy2(os.path.join(src, name), os.path.join(SYSTEMD_DIR, name))
        os.chmod(os.path.join(SYSTEMD_DIR, name), 0o644)
    say(f"{len(units)} systemd units -> {SYSTEMD_DIR}")


def start_services(units):
    run_cmd(["systemctl", "daemon-reload"], msg="systemctl daemon-reload")
    target = "pretzel.target" if "pretzel.target" in units else None
    services = [u for u in units if u.endswith(".service")]
    if target:
        run_cmd(["systemctl", "enable", target], msg=f"Enabling {target}", check=False)
    for s in services:
        subprocess.run(["systemctl", "enable", s], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    say(f"Enabled {len(services)} services")
    run_cmd(["systemctl", "restart"] + services, msg="Starting services", check=False)

    time.sleep(2)
    failed = [s for s in services
              if subprocess.run(["systemctl", "is-active", "--quiet", s],
                                check=False).returncode != 0]
    ok = len(services) - len(failed)
    say(f"Startup: {ok}/{len(services)} running")
    if failed:
        print()
        say(f"Did not start: {', '.join(failed)}")
        for s in failed[:3]:
            print(f"      journalctl -u {s} -n 30 --no-pager")
    return not failed


def install(args):
    mf = manifest()
    say(f"pretzel package {mf.get('version','?')} (built {mf.get('built_at','?')})")
    preflight(mf)
    verify_files(mf)
    check_linkage()

    ready = check_prereq()
    units = units_in_package()

    stop_services(units)
    install_binaries()
    install_www()
    install_units(units)

    if not ready and not args.force:
        run_cmd(["systemctl", "daemon-reload"], msg="systemctl daemon-reload")
        print()
        say("Files are installed. Satisfy the prerequisites above, then bring the services up:")
        print("      sudo systemctl restart pretzel.target")
        print("      (or re-run this installer once they are in place)")
        return

    all_up = start_services(units)
    print()
    if all_up:
        say("Install complete. The web console is at https://<this host>.")
    else:
        say("Install finished but some services did not start. See the journalctl commands above.")


def main():
    ap = argparse.ArgumentParser(prog="pretzel-package")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("install", help="install on this host")
    p.add_argument("--force", action="store_true",
                   help="start the services even if prerequisites are missing")
    args = ap.parse_args()
    if args.cmd != "install":
        ap.print_help()
        sys.exit(1)
    install(args)


if __name__ == "__main__":
    main()

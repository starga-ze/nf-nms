import os
import sys
import shutil
import subprocess
import time

from script.utils import (
    BUILD_DIR,
    CERT_DIR,
    run_cmd,
)

DAEMONS = [
    "nf-ipcd.service",
    "nf-engined.service",
    "nf-authd.service",
    "nf-mgmtd.service",
    "nf-icmpd.service",
    "nf-snmpd.service",
    "nf-topologyd.service",
]

BUILD_BIN_DIR = os.path.join(BUILD_DIR, "bin")

SERVICE_DIR = os.path.join(os.path.dirname(__file__), "service")

SYSTEMD_DIR = "/etc/systemd/system"
INSTALL_BIN_DIR = "/opt/nf-nms/bin"

CERT_INSTALL_DIR = "/etc/nf-nms/cert"

TARGET = "nf-nms.target"


def check_binaries():
    if not os.path.isdir(BUILD_BIN_DIR):
        print("[ERROR] build/bin not found. run build first.")
        sys.exit(1)

    bins = [f for f in os.listdir(BUILD_BIN_DIR)
            if os.path.isfile(os.path.join(BUILD_BIN_DIR, f))]

    if not bins:
        print("[ERROR] no binaries found in build/bin")
        sys.exit(1)


def install_binaries():
    os.makedirs(INSTALL_BIN_DIR, exist_ok=True)

    for f in os.listdir(BUILD_BIN_DIR):

        src = os.path.join(BUILD_BIN_DIR, f)

        if not os.path.isfile(src):
            continue

        dst = os.path.join(INSTALL_BIN_DIR, f)

        shutil.copy(src, dst)
        os.chmod(dst, 0o755)


def install_services():

    for f in os.listdir(SERVICE_DIR):

        if not (f.endswith(".service") or f.endswith(".target")):
            continue

        src = os.path.join(SERVICE_DIR, f)
        dst = os.path.join(SYSTEMD_DIR, f)

        shutil.copy(src, dst)


def install_certs():

    if not os.path.isdir(CERT_DIR):
        return

    os.makedirs(CERT_INSTALL_DIR, exist_ok=True)

    for f in os.listdir(CERT_DIR):

        src = os.path.join(CERT_DIR, f)

        if not os.path.isfile(src):
            continue

        dst = os.path.join(CERT_INSTALL_DIR, f)

        shutil.copy(src, dst)

        if f.endswith(".key") or "key" in f.lower():
            os.chmod(dst, 0o600)
        else:
            os.chmod(dst, 0o644)


def reload_systemd():
    run_cmd(["systemctl", "daemon-reload"])


def enable_target():
    run_cmd(["systemctl", "enable", TARGET])


def enable_services():
    for svc in DAEMONS:
        run_cmd(["systemctl", "enable", svc])


def wait_service_stop(service):
    while True:
        result = subprocess.run(
            ["systemctl", "is-active", service],
            capture_output=True,
            text=True
        )

        state = result.stdout.strip()

        if state in ("inactive", "failed", "unknown"):
            break

        time.sleep(0.2)


def wait_process_exit(name):
    while True:
        result = subprocess.run(
            ["pgrep", "-f", name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

        if result.returncode != 0:
            break

        time.sleep(0.2)


def stop_target():
    subprocess.run(
        ["systemctl", "stop", TARGET],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    for svc in DAEMONS:
        wait_service_stop(svc)

    for svc in DAEMONS:
        proc = svc.replace(".service", "")
        wait_process_exit(proc)

    time.sleep(0.5)

def start_target():
    run_cmd(["systemctl", "restart", TARGET])


def show_status():
    subprocess.run(["systemctl", "status", TARGET, "-n", "0", "--no-pager"])


def run():
    check_binaries()

    stop_target()

    install_binaries()
    install_services()
    install_certs()

    reload_systemd()

    enable_target()
    enable_services()

    start_target()

    show_status()


if __name__ == "__main__":
    run()

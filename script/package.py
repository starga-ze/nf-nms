"""./pretzel package — build the installer tarball for a production host.

    ./pretzel package              # tmp/pretzel-package-<stamp>.tar.gz
    ./pretzel package --out /tmp

How this differs from script/tar.py: that one archives the whole build tree as a developer
snapshot. This one carries only what is needed to run, together with an installer — a production
host is assumed to have no repository, no cmake and no 3rd_party/.

    bin/                compiled daemons (test-* excluded)
    share/mgmtd/www/    web console static files
    service/            systemd units
    pretzel-package     the installer (script/installer.py)

The binaries link gRPC, protobuf, boost and spdlog statically, so 3rd_party/ does not have to
travel with them. The only dynamic dependencies left are the ones the distribution provides
(libpq, libssl and so on), so the binaries run as they are once the OS matches — MANIFEST records
the OS and the installer confirms the linkage with ldd on arrival.
"""

import datetime
import hashlib
import json
import os
import shutil
import sys
import tarfile

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
BUILD_BIN_DIR = os.path.join(ROOT_DIR, "build", "bin")
SCRIPT_DIR = os.path.join(ROOT_DIR, "script")
SERVICE_SRC = os.path.join(SCRIPT_DIR, "service")
SCRIPT_BIN_DIR = os.path.join(SCRIPT_DIR, "bin")
WWW_SRC = os.path.join(ROOT_DIR, "mgmtd", "www")

NAME = "pretzel-package"


# test-* are development executables with no reason to reach production. pz-pgadmin is excluded
# too: start.py generates it per host with paths baked in, so shipping one would freeze the
# wrong paths.
def _wanted_binary(name):
    return name.startswith("pz-") and not name.startswith("test-")


EXCLUDE_NAMES = {"__pycache__", ".pytest_cache"}
EXCLUDE_SUFFIX = (".pyc", ".pyo", ".swp", ".bak", ".map")


def _skip(name):
    return name in EXCLUDE_NAMES or name.endswith(EXCLUDE_SUFFIX)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


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


def _check_built():
    if not os.path.isdir(BUILD_BIN_DIR):
        sys.exit(f"[Error] No build output at {BUILD_BIN_DIR}\n"
                 f"        Run ./pretzel build first.")
    got = [f for f in os.listdir(BUILD_BIN_DIR) if _wanted_binary(f)]
    if not got:
        sys.exit(f"[Error] No pz-* binaries in {BUILD_BIN_DIR}\n"
                 f"        Run ./pretzel build first.")
    return sorted(got)


def _stale_warning(names):
    """Packaging binaries older than the source is a common accident. Warn, but do not block."""
    newest_src = 0
    for sub in ("mgmtd", "shared", "engined", "apid"):
        d = os.path.join(ROOT_DIR, sub)
        if not os.path.isdir(d):
            continue
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x not in EXCLUDE_NAMES]
            for f in files:
                if f.endswith((".cpp", ".h", ".proto")):
                    newest_src = max(newest_src, os.path.getmtime(os.path.join(root, f)))
    # Compare against the newest binary. Comparing against the oldest would warn every time one
    # module was rebuilt on its own, because the untouched binaries are older — and a warning
    # that fires every time is one that gets ignored on the day it is real.
    newest_bin = max(os.path.getmtime(os.path.join(BUILD_BIN_DIR, n)) for n in names)
    if newest_src > newest_bin:
        d = datetime.datetime.fromtimestamp(newest_src).strftime("%m-%d %H:%M")
        print(f"[!] Warning: source is newer than the binaries (latest edit {d}).")
        print("    Check whether ./pretzel build should be run first.")


def run():
    names = _check_built()
    _stale_warning(names)

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    out_dir = os.path.join(ROOT_DIR, "tmp")
    for i, a in enumerate(sys.argv):
        if a == "--out" and i + 1 < len(sys.argv):
            out_dir = os.path.abspath(sys.argv[i + 1])
    os.makedirs(out_dir, exist_ok=True)

    stage_root = os.path.join(out_dir, f".stage-{NAME}")
    stage = os.path.join(stage_root, NAME)
    if os.path.isdir(stage_root):
        shutil.rmtree(stage_root)
    os.makedirs(stage)

    print(f"[*] Building {NAME} — {_os_id()} / {os.uname().machine}")

    # 1. binaries
    bindir = os.path.join(stage, "bin")
    os.makedirs(bindir)
    for n in names:
        shutil.copy2(os.path.join(BUILD_BIN_DIR, n), os.path.join(bindir, n))
    # The core-dump handler is a repository script, not a build output.
    ch = os.path.join(SCRIPT_BIN_DIR, "pz-core-handler")
    if os.path.isfile(ch):
        shutil.copy2(ch, os.path.join(bindir, "pz-core-handler"))
        names = names + ["pz-core-handler"]
    print(f"  added: bin/  ({len(names)} binaries)")

    # 2. web console
    if os.path.isdir(WWW_SRC):
        dst = os.path.join(stage, "share", "mgmtd", "www")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(WWW_SRC, dst,
                        ignore=lambda d, ns: [n for n in ns if _skip(n)])
        cnt = sum(len(f) for _, _, f in os.walk(dst))
        print(f"  added: share/mgmtd/www/  ({cnt} files)")

    # 3. systemd units
    if os.path.isdir(SERVICE_SRC):
        dst = os.path.join(stage, "service")
        shutil.copytree(SERVICE_SRC, dst,
                        ignore=lambda d, ns: [n for n in ns if _skip(n)])
        print(f"  added: service/  ({len(os.listdir(dst))} units)")

    # 4. installer
    installer = os.path.join(stage, NAME)
    shutil.copy2(os.path.join(SCRIPT_DIR, "installer.py"), installer)
    os.chmod(installer, 0o755)

    # 5. checksums
    files = {}
    for root, dirs, fnames in os.walk(stage):
        dirs[:] = [d for d in dirs if not _skip(d)]
        for n in fnames:
            p = os.path.join(root, n)
            rel = os.path.relpath(p, stage)
            if rel == "MANIFEST.json":
                continue
            files[rel] = _sha256(p)

    mf = {
        "name": NAME,
        "version": ts,
        "built_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "os": _os_id(),
        "arch": os.uname().machine,
        "binaries": names,
        "files": files,
    }
    with open(os.path.join(stage, "MANIFEST.json"), "w") as f:
        json.dump(mf, f, ensure_ascii=False, indent=2)

    tar_path = os.path.join(out_dir, f"{NAME}-{ts}.tar.gz")
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(stage, arcname=NAME)
    shutil.rmtree(stage_root)

    size = os.path.getsize(tar_path) / 1048576
    print()
    print(f"[*] Built: {tar_path}  ({size:.1f} MB, {len(files)} files)")
    print()
    print("    On the production host:")
    print(f"      scp {os.path.basename(tar_path)} prod:~/")
    print(f"      tar xzf {os.path.basename(tar_path)}")
    print(f"      cd {NAME} && sudo ./{NAME} install")


if __name__ == "__main__":
    run()

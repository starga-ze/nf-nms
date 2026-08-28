"""./pretzel package — prod 호스트로 옮길 설치 tar 를 만든다.

    ./pretzel package              # tmp/pretzel-package-<날짜>.tar.gz
    ./pretzel package --out /tmp

script/tar.py 와 무엇이 다른가: tar.py 는 빌드 트리를 통째로 묶는 개발자용 스냅샷이다. 이쪽은
prod 에서 '실행에 필요한 것'만 담고 설치 스크립트를 함께 넣는다 — prod 에는 저장소도, cmake 도,
3rd_party/ 도 없다고 가정한다.

    bin/                컴파일된 데몬 (test-* 제외)
    share/mgmtd/www/    웹 콘솔 정적 파일
    service/            systemd 유닛
    pretzel-package     설치 스크립트 (script/installer.py)

바이너리는 gRPC·protobuf·boost·spdlog 를 정적 링크하므로 3rd_party/ 를 함께 옮길 필요가 없다.
남는 동적 의존성은 배포판이 주는 것뿐이라 OS 만 맞으면 그대로 돈다 — MANIFEST 에 OS 를 적어
두고 설치 시점에 대조하며, 설치기가 ldd 로 한 번 더 실제 확인한다.
"""

import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
BUILD_BIN_DIR = os.path.join(ROOT_DIR, "build", "bin")
SCRIPT_DIR = os.path.join(ROOT_DIR, "script")
SERVICE_SRC = os.path.join(SCRIPT_DIR, "service")
SCRIPT_BIN_DIR = os.path.join(SCRIPT_DIR, "bin")
WWW_SRC = os.path.join(ROOT_DIR, "mgmtd", "www")

NAME = "pretzel-package"

# test-* 는 개발용 실행파일이라 prod 에 갈 이유가 없다. pz-pgadmin 은 start.py 가 호스트마다
# 경로를 박아 생성하는 래퍼라 패키지에 담으면 틀린 경로가 굳는다 — 제외한다.
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
        sys.exit(f"[Error] 빌드 산출물이 없다: {BUILD_BIN_DIR}\n"
                 f"        먼저 ./pretzel build 를 돌릴 것.")
    got = [f for f in os.listdir(BUILD_BIN_DIR) if _wanted_binary(f)]
    if not got:
        sys.exit(f"[Error] {BUILD_BIN_DIR} 에 pz-* 바이너리가 없다.\n"
                 f"        먼저 ./pretzel build 를 돌릴 것.")
    return sorted(got)


def _stale_warning(names):
    """소스보다 오래된 바이너리를 담는 것은 흔한 사고다. 막지는 않되 알린다."""
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
    # 가장 새 바이너리와 견준다. 가장 오래된 것과 견주면, 한 모듈만 고쳐 빌드했을 때
    # 손대지 않은 다른 바이너리가 오래됐다는 이유로 매번 경고가 뜬다 — 그런 경고는 곧
    # 무시하게 되고, 진짜로 빌드를 빠뜨린 날에도 똑같이 무시된다.
    newest_bin = max(os.path.getmtime(os.path.join(BUILD_BIN_DIR, n)) for n in names)
    if newest_src > newest_bin:
        d = datetime.datetime.fromtimestamp(newest_src).strftime("%m-%d %H:%M")
        print(f"[!] 경고: 바이너리보다 새 소스가 있다 (가장 최근 수정 {d}).")
        print("    ./pretzel build 를 먼저 돌리는 것이 맞는지 확인할 것.")


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

    print(f"[*] {NAME} 을(를) 만든다 — {_os_id()} / {os.uname().machine}")

    # 1. 바이너리
    bindir = os.path.join(stage, "bin")
    os.makedirs(bindir)
    for n in names:
        shutil.copy2(os.path.join(BUILD_BIN_DIR, n), os.path.join(bindir, n))
    # core 덤프 핸들러는 빌드 산출물이 아니라 저장소가 들고 있는 스크립트다.
    ch = os.path.join(SCRIPT_BIN_DIR, "pz-core-handler")
    if os.path.isfile(ch):
        shutil.copy2(ch, os.path.join(bindir, "pz-core-handler"))
        names = names + ["pz-core-handler"]
    print(f"  담음: bin/  ({len(names)}개)")

    # 2. 웹 콘솔
    if os.path.isdir(WWW_SRC):
        dst = os.path.join(stage, "share", "mgmtd", "www")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copytree(WWW_SRC, dst,
                        ignore=lambda d, ns: [n for n in ns if _skip(n)])
        cnt = sum(len(f) for _, _, f in os.walk(dst))
        print(f"  담음: share/mgmtd/www/  ({cnt}개 파일)")

    # 3. systemd 유닛
    if os.path.isdir(SERVICE_SRC):
        dst = os.path.join(stage, "service")
        shutil.copytree(SERVICE_SRC, dst,
                        ignore=lambda d, ns: [n for n in ns if _skip(n)])
        print(f"  담음: service/  ({len(os.listdir(dst))}개 유닛)")

    # 4. 설치 스크립트
    installer = os.path.join(stage, NAME)
    shutil.copy2(os.path.join(SCRIPT_DIR, "installer.py"), installer)
    os.chmod(installer, 0o755)

    # 5. 무결성 목록
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
    print(f"[*] 완성: {tar_path}  ({size:.1f} MB, {len(files)}개 파일)")
    print()
    print("    prod 에서:")
    print(f"      scp {os.path.basename(tar_path)} prod:~/")
    print(f"      tar xzf {os.path.basename(tar_path)}")
    print(f"      cd {NAME} && sudo ./{NAME} install")


if __name__ == "__main__":
    run()

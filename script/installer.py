#!/usr/bin/env python3
"""pretzel-package — 컴파일된 데몬을 prod 호스트에 설치한다.

    sudo ./pretzel-package install

패키지 안에서 단독으로 돈다 — prod 에는 저장소가 없다.

C++ 산출물은 gRPC·protobuf·boost·spdlog 를 정적 링크하고 있어서, 남는 동적 의존성은 배포판이
주는 것뿐이다(libpq·libssl·libstdc++ 등). 그래서 '바이너리만 옮기면 되는' 것이 맞고, 다만
같은 배포판·같은 메이저 버전이어야 한다. 설치 전에 ldd 로 실제 확인한다.

설치하지 않는 것 — 일부러다:
    /etc/pretzel/credentials.key   장치 API 키를 DB 에 넣기 전 암호화하는 키. 호스트마다
                                   달라야 하고, 패키지에 담기면 그 순간 공용 비밀이 된다.
    /etc/pretzel/cert/             TLS 인증서. 호스트 이름에 묶인다.
    /etc/pretzel/db.env            DB 접속 정보.
    PostgreSQL                     별도 설치·초기화 대상.
이것들은 설치 전에 있어야 하고, 없으면 무엇이 없는지 정확히 알려주고 멈춘다.
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

# 설치기가 만들 수 없는 것들. 여기 없는 항목이 하나라도 있으면 서비스는 뜨더라도 제 일을
# 하지 못한다 — 조용히 반쯤 도는 것보다 멈추고 알려주는 편이 낫다.
PREREQ = (
    (os.path.join(ETC_ROOT_DIR, "credentials.key"), "장치 API 키 암호화 키"),
    (os.path.join(ETC_ROOT_DIR, "cert"), "TLS 인증서 디렉터리"),
    (os.path.join(ETC_ROOT_DIR, "db.env"), "DB 접속 정보"),
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
        die(f"명령 실패: {' '.join(cmd)}")
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


# ── 사전 점검 ────────────────────────────────────────────────────────────────────────────────

def preflight(mf):
    if os.geteuid() != 0:
        die("root 권한이 필요하다.", "sudo ./pretzel-package install")

    here = _os_id()
    built = mf.get("os", "")
    if built and here != built:
        die(f"OS 불일치: 패키지는 '{built}', 이 호스트는 '{here}'.",
            "정적 링크가 아닌 나머지 의존성(libpq·libssl 등)이 배포판 버전에 묶여 있다.\n"
            "같은 OS 에서 다시 패키징할 것.")
    say(f"OS 확인: {here}")

    arch = mf.get("arch", "")
    if arch and arch != os.uname().machine:
        die(f"아키텍처 불일치: 패키지 {arch}, 호스트 {os.uname().machine}.")


def check_linkage():
    """ldd 로 실제 확인한다. '같은 OS 니까 되겠지' 와 '해보니 된다' 는 다르다."""
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
        die("공유 라이브러리가 없어 실행할 수 없다:\n        " +
            "\n        ".join(f"{k}: {', '.join(v)}" for k, v in missing.items()),
            "대부분 libpq5 하나로 해결된다:\n"
            "  sudo apt-get install -y libpq5\n"
            f"필요한 것: {', '.join(libs)}")
    say(f"동적 링크 확인: {len(os.listdir(bindir))}개 바이너리 모두 해결됨")


def check_prereq():
    missing = [(p, d) for p, d in PREREQ if not os.path.exists(p)]
    pg = subprocess.run(["systemctl", "is-active", "--quiet", "postgresql"],
                        check=False).returncode == 0
    if not missing and pg:
        say("사전 요건 확인: /etc/pretzel 자산, PostgreSQL 정상")
        return True

    print()
    say("사전 요건이 갖춰지지 않았다. 바이너리는 설치하되 서비스는 띄우지 않는다:")
    for p, d in missing:
        print(f"      없음: {p}  ({d})")
    if not pg:
        print("      PostgreSQL 이 돌고 있지 않다  (sudo systemctl start postgresql)")
    print()
    return False


def verify_files(mf):
    bad = []
    for rel, want in mf.get("files", {}).items():
        p = os.path.join(HERE, rel)
        if not os.path.isfile(p):
            bad.append(f"{rel} (없음)")
            continue
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != want:
            bad.append(f"{rel} (해시 불일치)")
    if bad:
        die("패키지 무결성 검사 실패:\n        " + "\n        ".join(bad[:10]),
            "전송이 잘렸을 수 있다. tar 를 다시 옮길 것.")
    say(f"무결성 확인: {len(mf.get('files', {}))}개 파일")


# ── 설치 ─────────────────────────────────────────────────────────────────────────────────────

def units_in_package():
    d = os.path.join(HERE, "service")
    return sorted(f for f in os.listdir(d)) if os.path.isdir(d) else []


def stop_services(units):
    """복사 전에 내린다. 실행 중인 바이너리를 덮어쓰면 ETXTBSY 가 나거나, 더 나쁘게는
    반쯤 쓰인 파일을 다음 재시작이 집는다."""
    names = [u for u in units if u.endswith(".service")]
    if names:
        subprocess.run(["systemctl", "stop"] + names, check=False)
        say(f"서비스 정지: {len(names)}개")


def install_binaries():
    os.makedirs(INSTALL_BIN_DIR, exist_ok=True)
    src = os.path.join(HERE, "bin")
    n = 0
    for name in sorted(os.listdir(src)):
        shutil.copy2(os.path.join(src, name), os.path.join(INSTALL_BIN_DIR, name))
        os.chmod(os.path.join(INSTALL_BIN_DIR, name), 0o755)
        n += 1
    say(f"바이너리 {n}개 → {INSTALL_BIN_DIR}")


def install_www():
    src = os.path.join(HERE, "share", "mgmtd", "www")
    if not os.path.isdir(src):
        return
    # 통째로 갈아끼운다. 예전 판의 js 가 남아 캐시에서 섞이면 증상이 재현되지 않는 버그가 된다.
    if os.path.isdir(MGMTD_WWW_INSTALL_DIR):
        shutil.rmtree(MGMTD_WWW_INSTALL_DIR)
    shutil.copytree(src, MGMTD_WWW_INSTALL_DIR)
    n = sum(len(f) for _, _, f in os.walk(MGMTD_WWW_INSTALL_DIR))
    say(f"웹 콘솔 {n}개 파일 → {MGMTD_WWW_INSTALL_DIR}")


def install_units(units):
    src = os.path.join(HERE, "service")
    for name in units:
        shutil.copy2(os.path.join(src, name), os.path.join(SYSTEMD_DIR, name))
        os.chmod(os.path.join(SYSTEMD_DIR, name), 0o644)
    say(f"systemd 유닛 {len(units)}개 → {SYSTEMD_DIR}")


def start_services(units):
    run_cmd(["systemctl", "daemon-reload"], msg="systemctl daemon-reload")
    target = "pretzel.target" if "pretzel.target" in units else None
    services = [u for u in units if u.endswith(".service")]
    if target:
        run_cmd(["systemctl", "enable", target], msg=f"{target} 활성화", check=False)
    for s in services:
        subprocess.run(["systemctl", "enable", s], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    say(f"{len(services)}개 서비스 활성화")
    run_cmd(["systemctl", "restart"] + services, msg="서비스 시작", check=False)

    time.sleep(2)
    failed = [s for s in services
              if subprocess.run(["systemctl", "is-active", "--quiet", s],
                                check=False).returncode != 0]
    ok = len(services) - len(failed)
    say(f"기동 결과: {ok}/{len(services)} 정상")
    if failed:
        print()
        say(f"뜨지 않은 서비스: {', '.join(failed)}")
        for s in failed[:3]:
            print(f"      journalctl -u {s} -n 30 --no-pager")
    return not failed


def install(args):
    mf = manifest()
    say(f"pretzel 패키지 {mf.get('version','?')} (빌드 {mf.get('built_at','?')})")
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
        say("파일 설치는 끝났다. 위 사전 요건을 갖춘 뒤 서비스를 올릴 것:")
        print("      sudo systemctl restart pretzel.target")
        print("      (또는 요건을 갖춘 상태에서 이 설치를 다시 실행)")
        return

    all_up = start_services(units)
    print()
    if all_up:
        say("설치 완료. 웹 콘솔은 https://<이 호스트> 로 접속한다.")
    else:
        say("설치는 끝났으나 일부 서비스가 뜨지 않았다. 위 journalctl 명령으로 원인을 볼 것.")


def main():
    ap = argparse.ArgumentParser(prog="pretzel-package")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("install", help="이 호스트에 설치한다")
    p.add_argument("--force", action="store_true",
                   help="사전 요건이 없어도 서비스를 올린다")
    args = ap.parse_args()
    if args.cmd != "install":
        ap.print_help()
        sys.exit(1)
    install(args)


if __name__ == "__main__":
    main()

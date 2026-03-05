import subprocess
from script.utils import run_cmd

TARGET = "nf-nms.target"


def run():
    status = subprocess.run(
        ["systemctl", "is-active", "--quiet", TARGET],
        check=False
    )

    if status.returncode != 0:
        print("nf-nms.target not running")
        return

    run_cmd(["systemctl", "stop", TARGET])

    subprocess.run(["systemctl", "status", TARGET, "-n", "0", "--no-pager"])


if __name__ == "__main__":
    run()

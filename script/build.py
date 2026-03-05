import os
import importlib

from script.utils import ROOT_DIR, BUILD_DIR, MAKE_JOBS, NUM_CORES, run_cmd


def build_project():
    try:
        install_module = importlib.import_module("script.install")

        if hasattr(install_module, "run"):
            print("[*] Ensuring all 3rd party dependencies are installed...")
            install_module.run()
        else:
            print("[!] Warning: script.install module does not have a run() function.")

    except Exception as e:
        print(f"[Error] Failed to load/run dependency installation: {e}")
        return

    os.makedirs(BUILD_DIR, exist_ok=True)

    run_cmd(["cmake", ROOT_DIR], cwd=BUILD_DIR, msg="Configuring main project with CMake")
    run_cmd(["make", MAKE_JOBS], cwd=BUILD_DIR, msg=f"Compiling main project with {NUM_CORES} jobs")

    print("[*] Project build complete")


def run():
    build_project()

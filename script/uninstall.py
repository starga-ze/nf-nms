import os
import shutil
import sys

from script.utils import ROOT_DIR, BUILD_DIR, THIRD_PARTY_DIR

def clean_project():
    if os.path.exists(BUILD_DIR):
        print(f"[*] Removed build directory...: {BUILD_DIR}")
        shutil.rmtree(BUILD_DIR)

    if os.path.exists(THIRD_PARTY_DIR):
        print(f"[*] Removed all 3rd party dependencies...: {THIRD_PARTY_DIR}")
        shutil.rmtree(THIRD_PARTY_DIR)

    else:
        print("[*] 3rd party folder already clean.")

def run():
    print("[*] Starting uninstallation...")
    clean_project()
    print("[*] All project and dependency files uninstalled successfully.")

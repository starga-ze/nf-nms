import os
import shutil
from script.utils import BUILD_DIR


def clean_build_dir():
    if os.path.exists(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
        print("[*] Build folder cleaned (3rd party installs preserved)")
    else:
        print("[*] Build folder already clean.")


def run():
    clean_build_dir()

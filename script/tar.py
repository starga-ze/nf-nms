#!/usr/bin/env python3

import tarfile
import os

TARGET_ITEMS = [
    'serverd',
    'mgmtd',
]

TAR_FILENAME = "nf-engine.tar.gz"


def run():
    root_dir = os.getcwd()
    output_dir = os.path.join(root_dir, "tmp")
    output_path = os.path.join(output_dir, TAR_FILENAME)

    os.makedirs(output_dir, exist_ok=True)

    print(f"[*] Archiving targets: {TARGET_ITEMS}")
    print(f"[*] Output TAR.GZ file: {output_path}")

    with tarfile.open(output_path, "w:gz") as tar:
        for target in TARGET_ITEMS:
            full_target_path = os.path.join(root_dir, target)

            if not os.path.exists(full_target_path):
                print(f"  > Skipping target: {target} (Not found)")
                continue

            print(f"  > Archiving directory: {target}")
            tar.add(
                name=full_target_path,
                arcname=target,
                recursive=True,
            )

    print(f"\n[*] Successfully generated {TAR_FILENAME} in {output_path}.")


if __name__ == "__main__":
    run()

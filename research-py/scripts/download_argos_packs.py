"""One-shot downloader for Argos offline language packs (zh<->en).

Usage:
    python -m scripts.download_argos_packs            # default data dir
    ARGOS_DATA_DIR=/path python -m scripts.download_argos_packs

Downloads the official zh->en and en->zh packages from the Argos index and
installs them into the local package dir (default
~/.local/share/argos-translate/packages on Linux; ARGOS_DATA_DIR overrides —
set it to research-py/data/argos and mount that volume in docker-compose).

Run inside the research-py container: docker compose exec research-py python -m scripts.download_argos_packs
"""

import os

import argostranslate.package

WANTED = {("zh", "en"), ("en", "zh")}


def main() -> None:
    data_dir = os.environ.get("ARGOS_DATA_DIR")
    if data_dir:
        os.makedirs(data_dir, exist_ok=True)
        # Argos discovers packages under <data>/packages
        import argostranslate.settings

        argostranslate.settings.package_dir = os.path.join(data_dir, "packages")
        os.makedirs(argostranslate.settings.package_dir, exist_ok=True)

    argostranslate.package.update_package_index()
    available = argostranslate.package.get_available_packages()
    installed = {(p.from_code, p.to_code) for p in argostranslate.package.get_installed_packages()}
    for pkg in available:
        pair = (pkg.from_code, pkg.to_code)
        if pair in WANTED and pair not in installed:
            path = pkg.download()
            argostranslate.package.install_from_path(path)
            print(f"installed {pair[0]}->{pair[1]}")
    final = {(p.from_code, p.to_code) for p in argostranslate.package.get_installed_packages()}
    missing = WANTED - final
    if missing:
        raise SystemExit(f"missing pairs after install: {sorted(missing)}")
    print("all wanted pairs installed:", sorted(final))


if __name__ == "__main__":
    main()

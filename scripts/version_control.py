#!/usr/bin/env python3
"""Validate Cheers release versions and release tags.

Each independently shipped product keeps its own version source. This tool
checks every mirrored value before CI spends time building release artifacts.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE_VERSION_RE = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")


class VersionError(ValueError):
    """Raised when release version metadata is missing or inconsistent."""


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def _json_version(path: str, package_root: bool = False) -> str:
    data = json.loads(_read(path))
    if package_root:
        return data["packages"][""]["version"]
    return data["version"]


def _toml_package_version(path: str, package_name: str | None = None) -> str:
    text = _read(path)
    if package_name is None:
        package = re.search(r"(?ms)^\[package\]\s*(.*?)(?=^\[|\Z)", text)
    else:
        package = re.search(
            rf'(?ms)^\[\[package\]\]\s*name\s*=\s*"{re.escape(package_name)}"\s*'
            r'(.*?)(?=^\[\[package\]\]|\Z)',
            text,
        )
    if not package:
        raise VersionError(f"cannot find package {package_name or '[package]'} in {path}")
    version = re.search(r'^version\s*=\s*"([^"]+)"', package.group(1), re.MULTILINE)
    if not version:
        raise VersionError(f"cannot find package version in {path}")
    return version.group(1)


def version_values() -> dict[str, dict[str, str]]:
    ios_versions = re.findall(r"MARKETING_VERSION\s*=\s*([^;\s]+);", _read(
        "apps/ios/Cheers.xcodeproj/project.pbxproj"
    ))
    if not ios_versions:
        raise VersionError("cannot find iOS MARKETING_VERSION values")

    return {
        "platform": {"VERSION": _read("VERSION").strip()},
        "desktop": {
            "apps/macos/package.json": _json_version("apps/macos/package.json"),
            "apps/macos/package-lock.json": _json_version("apps/macos/package-lock.json"),
            "apps/macos/package-lock.json packages root": _json_version(
                "apps/macos/package-lock.json", package_root=True
            ),
            "apps/macos/src-tauri/tauri.conf.json": _json_version(
                "apps/macos/src-tauri/tauri.conf.json"
            ),
            "apps/macos/src-tauri/Cargo.toml": _toml_package_version(
                "apps/macos/src-tauri/Cargo.toml"
            ),
            "apps/macos/src-tauri/Cargo.lock cheers-desktop": _toml_package_version(
                "apps/macos/src-tauri/Cargo.lock", "cheers-desktop"
            ),
        },
        "ios": {
            f"apps/ios/Cheers.xcodeproj/project.pbxproj MARKETING_VERSION #{index}": value
            for index, value in enumerate(ios_versions, start=1)
        },
        "connector": {
            "packages/cheers-acp-connector-rs/Cargo.toml": _toml_package_version(
                "packages/cheers-acp-connector-rs/Cargo.toml"
            ),
            "packages/cheers-acp-connector-rs/bridge-protocol/Cargo.toml": _toml_package_version(
                "packages/cheers-acp-connector-rs/bridge-protocol/Cargo.toml"
            ),
            "packages/cheers-acp-connector-rs/Cargo.lock cce-acp-connector": _toml_package_version(
                "packages/cheers-acp-connector-rs/Cargo.lock", "cce-acp-connector"
            ),
            "packages/cheers-acp-connector-rs/Cargo.lock cheers-bridge-protocol": _toml_package_version(
                "packages/cheers-acp-connector-rs/Cargo.lock", "cheers-bridge-protocol"
            ),
        },
    }


def checked_versions() -> dict[str, str]:
    checked: dict[str, str] = {}
    errors: list[str] = []
    for component, sources in version_values().items():
        unique = set(sources.values())
        if len(unique) != 1:
            rendered = ", ".join(f"{source}={value}" for source, value in sources.items())
            errors.append(f"{component} versions disagree: {rendered}")
            continue
        version = next(iter(unique))
        if not CORE_VERSION_RE.fullmatch(version):
            errors.append(f"{component} version is not major.minor.patch: {version}")
            continue
        checked[component] = version
    if errors:
        raise VersionError("\n".join(errors))
    return checked


def verify_tag(tag: str, versions: dict[str, str]) -> str:
    prefixes = {
        "desktop-v": "desktop",
        "connector-v": "connector",
        "ios-v": "ios",
        "v": "platform",
    }
    for prefix, component in prefixes.items():
        if not tag.startswith(prefix):
            continue
        expected = versions[component]
        suffix = tag[len(prefix):]
        if component == "ios":
            valid = suffix == expected or re.fullmatch(
                rf"{re.escape(expected)}-build\.[1-9]\d*", suffix
            ) is not None
        else:
            valid = suffix == expected
        if not valid:
            raise VersionError(
                f"{tag} does not match {component} source version {expected}"
            )
        return component
    raise VersionError(
        f"unsupported release tag {tag}; expected v*, desktop-v*, ios-v*, or connector-v*"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check", help="validate every version source")
    show = subparsers.add_parser("show", help="print one component version")
    show.add_argument("component", choices=("platform", "desktop", "ios", "connector"))
    tag = subparsers.add_parser("verify-tag", help="validate a release tag against source")
    tag.add_argument("tag")
    args = parser.parse_args(argv)

    try:
        versions = checked_versions()
        if args.command == "check":
            for component, version in versions.items():
                print(f"{component}: {version}")
        elif args.command == "show":
            print(versions[args.component])
        else:
            component = verify_tag(args.tag, versions)
            print(f"{args.tag}: valid {component} release tag")
    except (KeyError, OSError, VersionError, json.JSONDecodeError) as error:
        print(f"version-control error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Guard apps/ios/Cheers.xcodeproj/project.pbxproj against merge damage.

The project file uses hand-assigned sequential object ids (…01xx file refs,
…02xx build files) rather than Xcode's random 24-hex. Two branches adding iOS
sources in parallel each grab "the next" id off the same base, and a merge keeps
both — leaving one id owned by two different files.

Xcode resolves that silently: one file wins, the other is dropped from Compile
Sources and never compiles. The failure surfaces far away as `cannot find 'X' in
scope` for a file that is plainly present in the project, and the only warning is
an easily-missed "Skipping duplicate build file". That cost a broken develop
build on 2026-07-20 (ChatModelStore vs WorkbenchSheet).

Checks, all of which a full xcodebuild would also catch — but this runs in a
second and names the actual problem:

  1. no object id is defined twice
  2. every Swift file on disk under Sources/ is in the Sources build phase
  3. every file referenced by the project exists on disk

Exit 0 = clean, 1 = problems (printed to stderr).
"""

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PROJ = REPO / "apps/ios/Cheers.xcodeproj/project.pbxproj"
SOURCES = REPO / "apps/ios/Sources"

# `<ID> /* Name */ = {isa = PBXSomething; ...` — an object *definition*. Bare
# references (group children, build-phase entries) omit the `= {isa =`, so this
# deliberately does not match them.
DEFINITION = re.compile(r"^\t*([0-9A-F]{24}) /\* (.+?) \*/ = \{isa = (\w+)")
# `path = Foo.swift;` inside a PBXFileReference.
FILE_REF = re.compile(r"^\t*([0-9A-F]{24}) /\* (.+?) \*/ = \{isa = PBXFileReference;.*?path = ([^;]+);")
# A build-phase entry: `<ID> /* Name in Sources */,`
IN_SOURCES = re.compile(r"^\t*([0-9A-F]{24}) /\* (.+?) in Sources \*/,")


def main() -> int:
    if not PROJ.exists():
        print(f"error: {PROJ} not found", file=sys.stderr)
        return 1

    text = PROJ.read_text()
    problems: list[str] = []

    # 1. Duplicate object ids — the bug this script exists for.
    seen: dict[str, list[str]] = {}
    for line in text.splitlines():
        m = DEFINITION.match(line)
        if m:
            seen.setdefault(m.group(1), []).append(f"{m.group(2)} ({m.group(3)})")
    for obj_id, owners in seen.items():
        if len(owners) > 1:
            problems.append(
                f"duplicate object id {obj_id} claimed by: {', '.join(owners)}\n"
                f"    → Xcode keeps one and silently drops the rest. "
                f"Give the newer file an unused id."
            )

    # 2. Swift sources on disk that the project never compiles.
    compiled = {m.group(2) for line in text.splitlines() if (m := IN_SOURCES.match(line))}
    for path in sorted(SOURCES.rglob("*.swift")):
        if path.name not in compiled:
            problems.append(
                f"{path.relative_to(REPO)} is not in the Sources build phase\n"
                f"    → it will not compile; add it to the Xcode project."
            )

    # 3. Project references pointing at files that no longer exist. Only
    #    leaf-name matching is possible here (paths are group-relative), so
    #    resolve by searching Sources/ — good enough to catch a stale rename.
    on_disk = {p.name for p in SOURCES.rglob("*") if p.is_file()}
    for line in text.splitlines():
        m = FILE_REF.match(line)
        if not m:
            continue
        name = m.group(3).strip('"')
        # Assets/Info.plist and friends live outside Sources/; skip anything the
        # project stores at a non-Sources path rather than guessing.
        if not name.endswith(".swift"):
            continue
        if name not in on_disk:
            problems.append(
                f"project references {name}, which is not on disk under Sources/\n"
                f"    → stale reference; remove it or restore the file."
            )

    if problems:
        print(f"project.pbxproj: {len(problems)} problem(s)\n", file=sys.stderr)
        for p in problems:
            print(f"  ✗ {p}", file=sys.stderr)
        return 1

    print(f"project.pbxproj OK — {len(seen)} objects, {len(compiled)} sources compiled")
    return 0


if __name__ == "__main__":
    sys.exit(main())

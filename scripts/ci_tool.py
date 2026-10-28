#!/usr/bin/env python3
"""Plan affected Cheers CI/CD lanes and report workflow efficiency.

The dependency map lives in .github/ci-paths.json so CI, CD, and local checks
cannot silently drift apart. Requires Python 3.11+; uses only its standard library.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import statistics
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = REPO_ROOT / ".github" / "ci-paths.json"
ZERO_SHA = "0" * 40
# Build entry points, not a second dependency map: local dependencies and embedded
# files below these manifests are discovered from their source declarations.
BUILD_MANIFESTS = {
    "gateway": ("server/Cargo.toml",),
    "frontend": ("frontend/package.json",),
    "plugin": (
        "packages/cheers-acp-connector-rs/Cargo.toml",
        "packages/cheers-mcp-server/Cargo.toml",
    ),
    "desktop": ("apps/macos/src-tauri/Cargo.toml",),
}
RUST_LITERAL_INCLUDE = re.compile(r'include_(?:str|bytes)!\(\s*"([^"\n]+)"\s*\)')


class CiToolError(RuntimeError):
    """A user-facing planner or audit error."""


@dataclass(frozen=True)
class LaneResult:
    """Selection decision and matching files for one workflow lane."""

    selected: bool
    matches: tuple[str, ...]


def load_config(path: Path = DEFAULT_CONFIG) -> dict:
    """Load and minimally validate the versioned CI dependency map."""

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CiToolError(f"cannot load {path}: {exc}") from exc
    if data.get("version") != 1 or not isinstance(data.get("workflows"), dict):
        raise CiToolError(f"unsupported CI path configuration in {path}")
    return data


def normalize_files(files: Iterable[str]) -> tuple[str, ...]:
    """Normalize repository paths, remove duplicates, and return stable ordering."""

    normalized = {
        item.strip().replace("\\", "/").removeprefix("./")
        for item in files
        if item.strip()
    }
    return tuple(sorted(normalized))


def matches_any(path: str, patterns: Sequence[str]) -> bool:
    """Return whether a repository path matches any configured glob."""

    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def plan_for_files(
    config: dict,
    workflow: str,
    files: Iterable[str],
    *,
    force_all: bool = False,
) -> dict[str, LaneResult]:
    """Select workflow lanes affected by a set of changed files."""

    try:
        workflow_config = config["workflows"][workflow]
        lanes = workflow_config["lanes"]
    except KeyError as exc:
        raise CiToolError(f"unknown workflow: {workflow}") from exc

    changed = normalize_files(files)
    global_patterns = workflow_config.get("global_patterns", [])
    global_matches = tuple(path for path in changed if matches_any(path, global_patterns))
    select_all = force_all or bool(global_matches)

    result: dict[str, LaneResult] = {}
    for lane, patterns in lanes.items():
        lane_matches = tuple(path for path in changed if matches_any(path, patterns))
        matches = tuple(dict.fromkeys((*global_matches, *lane_matches)))
        result[lane] = LaneResult(select_all or bool(lane_matches), matches)
    return result


def git_changed_files(base: str, head: str, *, merge_base: bool) -> tuple[str, ...]:
    """Read changed paths from Git using either two-dot or merge-base semantics."""

    if not base or base == ZERO_SHA:
        raise CiToolError("the base revision is empty; use --force-all for an initial push")
    revision_range = f"{base}...{head}" if merge_base else f"{base}..{head}"
    command = [
        "git",
        "diff",
        "--name-only",
        "--diff-filter=ACDMRTUXB",
        revision_range,
        "--",
    ]
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or "git diff failed"
        raise CiToolError(f"cannot compare {revision_range}: {detail}")
    return normalize_files(result.stdout.splitlines())


def write_github_output(path: Path, plan: dict[str, LaneResult], changed_count: int) -> None:
    """Append lane decisions in GitHub Actions output-file format."""

    selected = ",".join(name for name, result in plan.items() if result.selected)
    with path.open("a", encoding="utf-8") as output:
        for lane, result in plan.items():
            output.write(f"{lane}={'true' if result.selected else 'false'}\n")
        output.write(f"changed_count={changed_count}\n")
        output.write(f"selected={selected}\n")


def render_plan(
    workflow: str,
    changed: Sequence[str],
    plan: dict[str, LaneResult],
    *,
    forced: bool,
) -> str:
    """Render a human-readable lane plan for local or CI logs."""

    lines = [
        f"CI/CD plan for {workflow}: {len(changed)} changed file(s)"
        + (" (forced full run)" if forced else "")
    ]
    for lane, result in plan.items():
        state = "RUN" if result.selected else "skip"
        reason = ", ".join(result.matches[:4])
        if len(result.matches) > 4:
            reason += f", +{len(result.matches) - 4} more"
        if forced and not reason:
            reason = "manual, tag, or initial full run"
        lines.append(f"  {lane:<10} {state:<4}" + (f"  {reason}" if reason else ""))
    return "\n".join(lines)


def write_summary(
    path: Path,
    workflow: str,
    changed: Sequence[str],
    plan: dict[str, LaneResult],
    forced: bool,
) -> None:
    """Append a Markdown execution plan to a GitHub Actions job summary."""

    with path.open("a", encoding="utf-8") as summary:
        summary.write(f"## {workflow.upper()} execution plan\n\n")
        summary.write(f"Changed files: **{len(changed)}**")
        if forced:
            summary.write(" · full run forced")
        summary.write("\n\n| Lane | Decision | Matching files |\n|---|---|---|\n")
        for lane, result in plan.items():
            matches = "<br>".join(f"`{item}`" for item in result.matches[:6]) or "—"
            summary.write(
                f"| {lane} | {'run' if result.selected else 'skip'} | {matches} |\n"
            )


def local_build_inputs(repo_root: Path, manifests: Sequence[str]) -> tuple[set[str], set[str]]:
    """Read transitive local manifests and literal Rust includes, without building.

    Cargo target-specific dependency tables are included. Literal includes outside
    a crate are inputs too (including test fixtures); non-literal includes such as
    CARGO_MANIFEST_DIR/assets remain covered by the crate's own directory rule.
    """

    repo_root = repo_root.resolve()
    package_dirs: set[str] = set()
    embedded_files: set[str] = set()
    pending = [repo_root / manifest for manifest in manifests]
    seen: set[Path] = set()

    def relative(path: Path) -> str:
        try:
            return path.relative_to(repo_root).as_posix()
        except ValueError as exc:
            raise CiToolError(f"local build input is outside the repository: {path}") from exc

    while pending:
        manifest = pending.pop().resolve()
        if manifest in seen:
            continue
        seen.add(manifest)
        directory = manifest.parent
        package_dirs.add(relative(directory))
        if manifest.name == "Cargo.toml":
            data = tomllib.loads(manifest.read_text(encoding="utf-8"))
            tables = [data, *data.get("target", {}).values()]
            for table in tables:
                for section in ("dependencies", "dev-dependencies", "build-dependencies"):
                    for dependency in table.get(section, {}).values():
                        if isinstance(dependency, dict) and "path" in dependency:
                            pending.append(directory / dependency["path"] / "Cargo.toml")
            sources = [directory / "build.rs"]
            for source_dir in (directory / "src", directory / "tests"):
                if source_dir.is_dir():
                    sources.extend(source_dir.rglob("*.rs"))
            for source in sources:
                if not source.is_file():
                    continue
                for name in RUST_LITERAL_INCLUDE.findall(source.read_text(encoding="utf-8")):
                    included = (source.parent / name).resolve()
                    if not included.is_relative_to(directory):
                        if not included.is_file():
                            raise CiToolError(f"missing embedded build input: {relative(included)}")
                        embedded_files.add(relative(included))
        else:
            data = json.loads(manifest.read_text(encoding="utf-8"))
            for section in ("dependencies", "devDependencies", "optionalDependencies"):
                for dependency in data.get(section, {}).values():
                    if isinstance(dependency, str) and dependency.startswith(("file:", "link:")):
                        pending.append(directory / dependency.split(":", 1)[1] / "package.json")
    return package_dirs, embedded_files


def audit_build_dependencies(
    config: dict,
    repo_root: Path = REPO_ROOT,
    build_manifests: dict[str, tuple[str, ...]] = BUILD_MANIFESTS,
) -> list[str]:
    """Check lane coverage against actual local build inputs, including transitive ones."""

    errors: list[str] = []
    inputs = {
        lane: local_build_inputs(repo_root, manifests)
        for lane, manifests in build_manifests.items()
    }
    for workflow, workflow_config in config.get("workflows", {}).items():
        for lane, lane_patterns in workflow_config.get("lanes", {}).items():
            if lane not in inputs:
                continue
            patterns = [*workflow_config.get("global_patterns", []), *lane_patterns]
            package_dirs, embedded_files = inputs[lane]
            for directory in sorted(package_dirs):
                # A manifest-only rule is insufficient: a source edit must select
                # the consumer as well. Match probes instead of requiring one
                # exact glob spelling, so broader valid rules are accepted.
                if not all(matches_any(f"{directory}/{probe}", patterns) for probe in (
                    "Cargo.toml" if (repo_root / directory / "Cargo.toml").is_file() else "package.json",
                    "src/__ci_build_input__",
                )):
                    errors.append(f"{workflow}.{lane}: missing local build dependency {directory}/**")
            for path in sorted(embedded_files):
                if not matches_any(path, patterns):
                    errors.append(f"{workflow}.{lane}: missing embedded build input {path}")
    return errors


def audit(config: dict) -> list[str]:
    """Validate dependency-map shape and its integration with workflow files."""

    errors: list[str] = []
    workflows = config.get("workflows", {})
    expected = {"ci": {"gateway", "frontend", "plugin", "desktop", "ios"}, "cd": {"gateway", "frontend"}}

    for workflow, expected_lanes in expected.items():
        workflow_config = workflows.get(workflow, {})
        lanes = workflow_config.get("lanes", {})
        if set(lanes) != expected_lanes:
            errors.append(
                f"{workflow}: expected lanes {sorted(expected_lanes)}, got {sorted(lanes)}"
            )
        for lane, patterns in lanes.items():
            if not patterns or not all(isinstance(pattern, str) for pattern in patterns):
                errors.append(f"{workflow}.{lane}: patterns must be a non-empty string list")

        workflow_path = REPO_ROOT / ".github" / "workflows" / f"{workflow}.yml"
        try:
            workflow_text = workflow_path.read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(f"cannot read {workflow_path}: {exc}")
            continue
        if "scripts/ci_tool.py" not in workflow_text or "plan" not in workflow_text:
            errors.append(f"{workflow}: workflow does not invoke scripts/ci_tool.py plan")
        if "dorny/paths-filter" in workflow_text:
            errors.append(f"{workflow}: legacy paths-filter remains; dependency rules would drift")
        for lane in expected_lanes:
            token = f"steps.plan.outputs.{lane}"
            if token not in workflow_text:
                errors.append(f"{workflow}: missing planner output {lane}")

    required_patterns = (
        ("ci", "frontend", "website/**"),
        ("cd", "frontend", "website/**"),
        ("cd", "frontend", "design-system/**"),
    )
    for workflow, lane, pattern in required_patterns:
        patterns = workflows.get(workflow, {}).get("lanes", {}).get(lane, [])
        if pattern not in patterns:
            errors.append(f"{workflow}.{lane}: missing build dependency {pattern}")

    errors.extend(audit_build_dependencies(config))
    return errors


def parse_timestamp(value: str) -> datetime:
    """Parse an ISO-8601 timestamp, accepting GitHub's trailing `Z` form."""

    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def analyze_runs(runs: Sequence[dict]) -> dict:
    """Compute duration and duplicate-trigger metrics from Actions run records."""

    durations: list[float] = []
    events_by_sha: dict[str, set[str]] = {}
    branches_by_sha: dict[str, set[str]] = {}
    for run in runs:
        if run.get("status") == "completed" and run.get("createdAt") and run.get("updatedAt"):
            durations.append(
                (parse_timestamp(run["updatedAt"]) - parse_timestamp(run["createdAt"])).total_seconds()
            )
        sha = run.get("headSha")
        event = run.get("event")
        if sha and event:
            events_by_sha.setdefault(sha, set()).add(event)
            if run.get("headBranch"):
                branches_by_sha.setdefault(sha, set()).add(run["headBranch"])
    duplicates = sorted(
        sha for sha, events in events_by_sha.items() if {"push", "pull_request"} <= events
    )
    avoidable_duplicates = [
        sha
        for sha in duplicates
        if not branches_by_sha.get(sha, set()) <= {"main", "develop"}
    ]
    return {
        "count": len(runs),
        "median_seconds": statistics.median(durations) if durations else 0,
        "max_seconds": max(durations, default=0),
        "duplicate_push_pr_shas": duplicates,
        "avoidable_duplicate_shas": avoidable_duplicates,
    }


def command_plan(args: argparse.Namespace) -> int:
    """Execute the `plan` subcommand and emit requested machine-readable outputs."""

    config = load_config(args.config)
    force_all = args.force_all
    if args.files_from:
        if args.files_from == "-":
            changed = normalize_files(sys.stdin)
        else:
            changed = normalize_files(args.files_from.read_text(encoding="utf-8").splitlines())
    elif force_all or not args.base or args.base == ZERO_SHA:
        force_all = True
        changed = ()
    else:
        changed = git_changed_files(args.base, args.head, merge_base=args.merge_base)

    plan = plan_for_files(config, args.workflow, changed, force_all=force_all)
    if args.format == "json":
        print(
            json.dumps(
                {
                    "workflow": args.workflow,
                    "changed_files": list(changed),
                    "forced": force_all,
                    "lanes": {
                        name: {"selected": result.selected, "matches": list(result.matches)}
                        for name, result in plan.items()
                    },
                },
                indent=2,
                sort_keys=True,
            )
        )
    else:
        print(render_plan(args.workflow, changed, plan, forced=force_all))

    if args.github_output:
        write_github_output(args.github_output, plan, len(changed))
    if args.summary:
        write_summary(args.summary, args.workflow, changed, plan, force_all)
    return 0


def command_audit(args: argparse.Namespace) -> int:
    """Execute the `audit` subcommand and report all dependency-map errors."""

    errors = audit(load_config(args.config))
    if errors:
        print("CI/CD audit failed:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("CI/CD dependency map and workflow integration are consistent.")
    return 0


def command_metrics(args: argparse.Namespace) -> int:
    """Execute the `metrics` subcommand from a file or recent GitHub runs."""

    if args.input:
        runs = json.loads(args.input.read_text(encoding="utf-8"))
    else:
        command = [
            "gh",
            "run",
            "list",
            "--repo",
            args.repo,
            "--workflow",
            args.workflow,
            "--limit",
            str(args.limit),
            "--json",
            "event,status,createdAt,updatedAt,headBranch,headSha,url",
        ]
        result = subprocess.run(command, check=False, capture_output=True, text=True)
        if result.returncode != 0:
            raise CiToolError(result.stderr.strip() or "gh run list failed")
        runs = json.loads(result.stdout)
    metrics = analyze_runs(runs)
    print(f"Runs analyzed: {metrics['count']}")
    print(f"Median duration: {metrics['median_seconds'] / 60:.1f} min")
    print(f"Maximum duration: {metrics['max_seconds'] / 60:.1f} min")
    print(
        "Avoidable feature push + PR duplicates: "
        f"{len(metrics['avoidable_duplicate_shas'])}"
    )
    for sha in metrics["avoidable_duplicate_shas"]:
        print(f"  {sha[:12]}")
    promotion_duplicates = len(metrics["duplicate_push_pr_shas"]) - len(
        metrics["avoidable_duplicate_shas"]
    )
    print(f"Protected-branch promotion pairs: {promotion_duplicates}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    """Construct the command-line parser and its three subcommands."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.set_defaults(handler=None)
    subparsers = parser.add_subparsers(dest="command")

    plan_parser = subparsers.add_parser("plan", help="select affected workflow lanes")
    plan_parser.add_argument("--workflow", choices=("ci", "cd"), required=True)
    plan_parser.add_argument("--base", default=os.environ.get("CI_BASE_SHA", ""))
    plan_parser.add_argument("--head", default=os.environ.get("CI_HEAD_SHA", "HEAD"))
    plan_parser.add_argument("--merge-base", action="store_true")
    plan_parser.add_argument("--force-all", action="store_true")
    plan_parser.add_argument("--files-from", type=lambda value: value if value == "-" else Path(value))
    plan_parser.add_argument("--format", choices=("text", "json"), default="text")
    plan_parser.add_argument("--github-output", type=Path)
    plan_parser.add_argument("--summary", type=Path)
    plan_parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    plan_parser.set_defaults(handler=command_plan)

    audit_parser = subparsers.add_parser("audit", help="validate the dependency map")
    audit_parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    audit_parser.set_defaults(handler=command_audit)

    metrics_parser = subparsers.add_parser("metrics", help="summarize recent Actions runs")
    metrics_parser.add_argument("--repo", default="ElePerson/Cheers")
    metrics_parser.add_argument("--workflow", default="CI")
    metrics_parser.add_argument("--limit", type=int, default=50)
    metrics_parser.add_argument("--input", type=Path)
    metrics_parser.set_defaults(handler=command_metrics)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the selected command and convert expected failures into exit code 2."""

    parser = build_parser()
    args = parser.parse_args(argv)
    if args.handler is None:
        parser.print_help()
        return 2
    try:
        return args.handler(args)
    except (CiToolError, OSError, json.JSONDecodeError) as exc:
        print(f"ci_tool: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

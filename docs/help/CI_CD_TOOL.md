# CI/CD Planning and Optimization Tool

`scripts/ci_tool.py` is the single source of truth for deciding which Cheers
CI checks and production images are affected by a change. Its dependency map is
stored in `.github/ci-paths.json` and is shared by the CI and CD workflows.

## Why it exists

- Prevent CI and CD path filters from drifting apart.
- Explain why a job runs or is skipped.
- Keep image dependencies accurate; for example, `website/**` is copied into
  the production frontend image and must rebuild that image.
- Make impact planning reproducible locally.
- Measure duplicate GitHub Actions runs and overall workflow duration.

## Local usage

Plan CI work for a branch:

```bash
python3 scripts/ci_tool.py plan \
  --workflow ci \
  --base origin/develop \
  --head HEAD \
  --merge-base
```

Plan from an explicit file list:

```bash
git diff --name-only origin/develop...HEAD \
  | python3 scripts/ci_tool.py plan --workflow ci --files-from -
```

Validate configuration and workflow integration:

```bash
python3 scripts/ci_tool.py audit
python3 scripts/version_control.py check
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
```

Measure recent Actions behavior through the GitHub CLI:

```bash
python3 scripts/ci_tool.py metrics --repo ElePerson/Cheers --limit 50
```

## Workflow behavior

- Pull requests to `develop` or `main` run affected lanes.
- Pushes to `develop` and `main` run affected CI lanes.
- Feature-branch pushes do not trigger CI. Use a draft pull request for
  continuous validation or `workflow_dispatch` for an explicit full run before
  opening one; this avoids a push run and pull-request run for the same commit.
- Manual CI runs select every applicable lane.
- Production CD is tag-only: `v<major.minor.patch>` builds and deploys the
  gateway and frontend together with the same immutable version. A merge to
  `main` does not deploy production.
- Changes to the planner, dependency map, or a workflow select all of that
  workflow's lanes so planner changes validate themselves.

The `Detect Changes` job name and existing required job names are preserved to
avoid breaking GitHub branch-protection rules.

Release names and source versions are governed separately from path planning.
See [Release Versioning](RELEASE_VERSIONING.md) for the four release trains,
their tag formats, and the pre-release checks.

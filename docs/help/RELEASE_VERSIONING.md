# Release Versioning

Cheers ships four independent release trains. They do not need to share a
version number. A stable release tag must match the version stored in source;
platform and connector release candidates append an RC suffix to that same version.

| Release train | Source version | Tag |
| --- | --- | --- |
| Gateway + web | `VERSION` | `v<version>` (production), `v<version>-rc.N` (candidate) |
| macOS desktop | `apps/macos/package.json` (mirrored by npm, Tauri, and Cargo metadata) | `desktop-v<version>` |
| iOS | `MARKETING_VERSION` in the Xcode project | `ios-v<version>` or `ios-v<version>-build.<number>` |
| ACP connector | `packages/cheers-acp-connector-rs/Cargo.toml` (mirrored by the bridge protocol and lockfile) | `connector-v<version>`, `connector-v<version>-rc.N` |

All source versions use `major.minor.patch`, including while preparing an RC.
The RC number is a positive integer without a leading zero, such as `-rc.1` or
`-rc.12`. Desktop and iOS do not accept RC tags. The optional iOS `-build.N`
tag suffix distinguishes repeated TestFlight releases without changing the App
Store marketing version.

## Before opening a release PR

Update every mirror for the product being released, regenerate the relevant
lockfile with its package manager, then run:

```bash
python3 scripts/version_control.py check
python3 scripts/version_control.py verify-tag desktop-v0.1.32
```

Replace the sample tag with the tag you intend to publish. CI runs the same
consistency check for every pull request. Release workflows repeat it before
toolchain setup or artifact builds, so an incorrect tag fails quickly and
cannot publish mislabeled artifacts.

Merging to `main` does not deploy the production application. The complete
gateway and frontend stack is deployed only from a matching stable `v<version>` tag,
using immutable image tags for both services. The public website remains a
separate path-filtered deployment because it has its own hosting target.

## Platform and connector release candidates

For example, platform source `0.1.52` permits `v0.1.52-rc.1`, and connector
source `0.1.55` permits `connector-v0.1.55-rc.1`. Validate the actual tags before
publishing them:

```bash
python3 scripts/version_control.py check
python3 scripts/version_control.py verify-tag v0.1.52-rc.1
python3 scripts/version_control.py verify-tag connector-v0.1.55-rc.1
```

An RC publishes candidate artifacts and a GitHub prerelease. It does not deploy
production, move the desktop update feed, or sync the gateway's connector release
pin. Gateway and web candidates use their full RC image tags; test those exact
images in a separate environment. A stable tag is a production release signal,
so creating a prerelease afterward does not turn that tag into an RC.

Connector RC binaries keep the core runtime version from Cargo, such as `0.1.55`.
Install an RC manually from its exact GitHub release asset. The gateway installer,
version floor and connector self-updater remain on the stable release contract;
they do not select RC tags. For example, from this checkout an Apple-silicon Mac
can download its candidate binary with:

```bash
gh release download connector-v0.1.55-rc.1 --pattern cce-acp-connector-darwin-arm64
```

Use the [manual connector installation steps](AgentBridge接入指南.md#acp--opencode-acp-provider)
with that downloaded binary, an isolated test configuration/state directory, and
`[update] auto = false`. Keep the RC daemon separate from production connectors.
When the matching stable release is available, explicitly
reinstall its stable binary and restart: the RC and stable binary report the same
core version, so version comparison cannot promote that RC installation for you.

Record each tested artifact's full RC tag and resolved commit SHA, plus the image
digest or downloaded asset's SHA-256. After publishing the tags, obtain their
commit identities with:

```bash
git rev-parse 'v0.1.52-rc.1^{commit}'
git rev-parse 'connector-v0.1.55-rc.1^{commit}'
```

Test the published artifacts from those tags and SHAs. If source changes, publish
the next RC number and test it again; do not move an existing RC tag or treat a
mutable branch or `latest` download as the tested candidate.

## Stable release publishing

For iOS, the TestFlight workflow reads `MARKETING_VERSION` from the checked-in
Xcode project. Its build number is derived from both the GitHub Actions run and
rerun attempt, so retrying a failed upload does not reuse an App Store build
number.

For stable connector releases, keep the required order:

1. Update `Cargo.toml` and `Cargo.lock` together.
2. Run formatting, tests, and checks for the Rust connector.
3. Push the matching `connector-v<version>` tag.
4. Let the workflow build binaries, sign the manifest, and only then sync the
   gateway release pin.

Connector publishing is intentionally tag-only. A manual run had no release
tag to attach assets to and could bypass the version contract.

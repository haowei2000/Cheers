# Release Versioning

Cheers ships four independent release trains. They do not need to share a
version number, but every release tag must match the version stored in source.

| Release train | Source version | Tag |
| --- | --- | --- |
| Gateway + web | `VERSION` | `v<version>` (build and production deploy) |
| macOS desktop | `apps/macos/package.json` (mirrored by npm, Tauri, and Cargo metadata) | `desktop-v<version>` |
| iOS | `MARKETING_VERSION` in the Xcode project | `ios-v<version>` or `ios-v<version>-build.<number>` |
| ACP connector | `packages/cheers-acp-connector-rs/Cargo.toml` (mirrored by the bridge protocol and lockfile) | `connector-v<version>` |

All source versions use `major.minor.patch`. The optional iOS `-build.N` tag
suffix distinguishes repeated TestFlight releases without changing the App
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
gateway and frontend stack is deployed only from a matching `v<version>` tag,
using immutable image tags for both services. The public website remains a
separate path-filtered deployment because it has its own hosting target.

For iOS, the TestFlight workflow reads `MARKETING_VERSION` from the checked-in
Xcode project. Its build number is derived from both the GitHub Actions run and
rerun attempt, so retrying a failed upload does not reuse an App Store build
number.

For connector releases, keep the required order:

1. Update `Cargo.toml` and `Cargo.lock` together.
2. Run formatting, tests, and checks for the Rust connector.
3. Push the matching `connector-v<version>` tag.
4. Let the workflow build binaries, sign the manifest, and only then sync the
   gateway release pin.

Connector publishing is intentionally tag-only. A manual run had no release
tag to attach assets to and could bypass the version contract.

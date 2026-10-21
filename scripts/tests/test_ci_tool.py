import copy
import hashlib
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "ci_tool.py"
SPEC = importlib.util.spec_from_file_location("ci_tool", MODULE_PATH)
assert SPEC and SPEC.loader
ci_tool = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ci_tool
SPEC.loader.exec_module(ci_tool)


class PlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = ci_tool.load_config()

    def selected(self, workflow, files, force_all=False):
        plan = ci_tool.plan_for_files(
            self.config, workflow, files, force_all=force_all
        )
        return {name for name, result in plan.items() if result.selected}

    def test_gateway_change_selects_gateway_only(self):
        self.assertEqual(self.selected("ci", ["server/src/main.rs"]), {"gateway"})

    def test_sqlx_offline_inputs_select_gateway(self):
        for path in ["server/.sqlx/query-example.json", "server/.cargo/config.toml",
                     ".cargo/config.toml", "scripts/sqlx-offline.sh"]:
            with self.subTest(path=path):
                self.assertEqual(self.selected("ci", [path]), {"gateway"})
        self.assertEqual(self.selected("cd", [".cargo/config.toml"]), {"gateway"})

    def test_bridge_protocol_selects_gateway_and_plugin(self):
        self.assertEqual(
            self.selected(
                "ci",
                ["packages/cheers-acp-connector-rs/bridge-protocol/src/lib.rs"],
            ),
            {"gateway", "plugin"},
        )

    def test_shared_rust_libraries_select_every_consumer(self):
        for package in ("cheers-interactive-core", "cheers-mcp-server"):
            path = f"packages/{package}/src/lib.rs"
            with self.subTest(package=package):
                self.assertEqual(self.selected("ci", [path]), {"gateway", "plugin"})
                self.assertEqual(self.selected("cd", [path]), {"gateway"})

    def test_canvas_runtime_selects_frontend_builds(self):
        path = "packages/cheers-canvas-runtime/src/index.ts"
        for workflow in ("ci", "cd"):
            with self.subTest(workflow=workflow):
                self.assertEqual(self.selected(workflow, [path]), {"frontend"})

    def test_embedded_rust_inputs_select_consumers(self):
        cases = {
            "design-system/a2ui-catalog.json": {"gateway", "frontend", "plugin", "ios"},
            "frontend/src/features/chat/workbench/lens/a2ui/example.a2ui.json": {
                "gateway", "frontend", "plugin"
            },
            "fixtures/locator/corpus.json": {"gateway", "plugin"},
        }
        for path, selected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(self.selected("ci", [path]), selected)
                self.assertIn("gateway", self.selected("cd", [path]))
        self.assertEqual(
            self.selected("cd", ["design-system/a2ui-catalog.json"]),
            {"gateway", "frontend"},
        )

    def test_website_change_rebuilds_frontend_in_ci_and_cd(self):
        files = ["website/privacy.html"]
        self.assertEqual(self.selected("ci", files), {"frontend"})
        self.assertEqual(self.selected("cd", files), {"frontend"})

    def test_extension_source_runs_catalog_frontend_and_gateway_contracts(self):
        self.assertEqual(
            self.selected("ci", ["extensions/official/research-planner/manifest.json"]),
            {"frontend"},
        )
        self.assertEqual(
            self.selected("ci", ["fixtures/workbench/research-planner.cheers-extension"]),
            {"gateway", "frontend"},
        )
        self.assertEqual(
            self.selected("cd", ["extensions/catalog.json"]),
            {"frontend"},
        )

    def test_ios_and_project_checker_share_a_lane(self):
        self.assertEqual(
            self.selected("ci", ["scripts/check-pbxproj.py"]), {"ios"}
        )

    def test_docs_only_change_skips_all_lanes(self):
        self.assertEqual(self.selected("ci", ["docs/help/README.md"]), set())

    def test_global_configuration_change_selects_every_lane(self):
        selected = self.selected("ci", [".github/ci-paths.json"])
        self.assertEqual(selected, {"gateway", "frontend", "plugin", "desktop", "ios"})

    def test_force_all_selects_every_cd_lane(self):
        self.assertEqual(
            self.selected("cd", [], force_all=True), {"gateway", "frontend"}
        )

    def test_github_outputs_always_include_true_and_false_values(self):
        plan = ci_tool.plan_for_files(self.config, "ci", ["server/src/main.rs"])
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            ci_tool.write_github_output(output, plan, 1)
            values = dict(
                line.split("=", 1)
                for line in output.read_text(encoding="utf-8").splitlines()
            )
        self.assertEqual(values["gateway"], "true")
        self.assertEqual(values["frontend"], "false")
        self.assertEqual(values["changed_count"], "1")


class MetricsTests(unittest.TestCase):
    def test_detects_duplicate_push_and_pull_request_runs(self):
        runs = [
            {
                "status": "completed",
                "createdAt": "2026-08-07T09:00:00Z",
                "updatedAt": "2026-08-07T09:07:00Z",
                "headBranch": "feat/example",
                "headSha": "abc",
                "event": "push",
            },
            {
                "status": "completed",
                "createdAt": "2026-08-07T09:00:05Z",
                "updatedAt": "2026-08-07T09:08:05Z",
                "headBranch": "feat/example",
                "headSha": "abc",
                "event": "pull_request",
            },
        ]
        result = ci_tool.analyze_runs(runs)
        self.assertEqual(result["duplicate_push_pr_shas"], ["abc"])
        self.assertEqual(result["avoidable_duplicate_shas"], ["abc"])
        self.assertEqual(result["median_seconds"], 450)

    def test_develop_promotion_pair_is_not_classified_as_avoidable(self):
        runs = [
            {"headSha": "abc", "headBranch": "develop", "event": "push"},
            {"headSha": "abc", "headBranch": "develop", "event": "pull_request"},
        ]
        result = ci_tool.analyze_runs(runs)
        self.assertEqual(result["duplicate_push_pr_shas"], ["abc"])
        self.assertEqual(result["avoidable_duplicate_shas"], [])


class AuditTests(unittest.TestCase):
    def test_repository_workflows_match_the_dependency_map(self):
        self.assertEqual(ci_tool.audit(ci_tool.load_config()), [])

    def test_audit_catches_missing_local_manifest_dependencies(self):
        cases = (
            ("ci", "gateway", "packages/cheers-mcp-server/**"),
            ("cd", "gateway", "packages/cheers-interactive-core/**"),
            ("ci", "plugin", "packages/cheers-interactive-core/**"),
            ("ci", "frontend", "packages/cheers-canvas-runtime/**"),
            ("cd", "frontend", "packages/cheers-canvas-runtime/**"),
        )
        for workflow, lane, pattern in cases:
            with self.subTest(workflow=workflow, lane=lane, pattern=pattern):
                config = copy.deepcopy(ci_tool.load_config())
                config["workflows"][workflow]["lanes"][lane].remove(pattern)
                self.assertIn(
                    f"{workflow}.{lane}: missing local build dependency {pattern}",
                    ci_tool.audit(config),
                )

    def test_audit_catches_missing_compiler_include_inputs(self):
        for path in (
            "design-system/a2ui-catalog.json",
            "frontend/src/features/chat/workbench/lens/a2ui/example.a2ui.json",
        ):
            with self.subTest(path=path):
                config = copy.deepcopy(ci_tool.load_config())
                config["workflows"]["cd"]["lanes"]["gateway"].remove(path)
                self.assertIn(
                    f"cd.gateway: missing embedded build input {path}",
                    ci_tool.audit(config),
                )

    def test_audit_preserves_frontend_asset_dependencies(self):
        for pattern in ("website/**", "design-system/**"):
            with self.subTest(pattern=pattern):
                config = copy.deepcopy(ci_tool.load_config())
                config["workflows"]["cd"]["lanes"]["frontend"].remove(pattern)
                self.assertIn(
                    f"cd.frontend: missing build dependency {pattern}",
                    ci_tool.audit(config),
                )

    def test_discovers_transitive_and_target_specific_dependencies_from_manifests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {
                "app/Cargo.toml": '[target.\'cfg(unix)\'.dependencies]\nfirst = { path = "../first" }\n',
                "first/Cargo.toml": '[dependencies]\nsecond = { path = "../second" }\n',
                "second/Cargo.toml": '[package]\nname = "second"\n',
                "second/src/lib.rs": 'const DATA: &str = include_str!("../../catalog.json");\n',
                "catalog.json": "{}",
                "web/package.json": '{"dependencies":{"runtime":"file:../runtime"}}',
                "runtime/package.json": '{"dependencies":{"shared":"link:../shared"}}',
                "shared/package.json": "{}",
            }
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            self.assertEqual(
                ci_tool.local_build_inputs(root, ("app/Cargo.toml",)),
                ({"app", "first", "second"}, {"catalog.json"}),
            )
            self.assertEqual(
                ci_tool.local_build_inputs(root, ("web/package.json",)),
                ({"web", "runtime", "shared"}, set()),
            )
            config = {"workflows": {"ci": {"lanes": {"gateway": ["app/**", "first/**", "second/Cargo.toml"]}}}}
            errors = ci_tool.audit_build_dependencies(config, root, {"gateway": ("app/Cargo.toml",)})
            self.assertIn("ci.gateway: missing local build dependency second/**", errors)
            self.assertIn("ci.gateway: missing embedded build input catalog.json", errors)


@unittest.skipUnless(shutil.which("helm"), "Helm is required to validate rendered deployments")
class HelmDeploymentContractTests(unittest.TestCase):
    chart = MODULE_PATH.parents[1] / "deploy" / "helm" / "cheers"

    def render(self, overlay=None, *settings):
        command = ["helm", "template", "ci-contract", str(self.chart)]
        if overlay:
            command.extend(["-f", str(self.chart / overlay)])
        for setting in ("secrets.create=false", "secrets.existingSecret=ci-test", *settings):
            command.extend(["--set", setting])
        return subprocess.run(command, text=True, capture_output=True, check=False)

    def test_default_dev_and_prod_keep_one_gateway_without_rollout_overlap(self):
        for overlay in (None, "values-dev.yaml", "values-prod.yaml"):
            with self.subTest(overlay=overlay):
                result = self.render(overlay)
                self.assertEqual(result.returncode, 0, result.stderr)
                gateway = next(
                    document for document in result.stdout.split("\n---\n")
                    if "# Source: cheers/templates/gateway.yaml\n" in document
                    and "\nkind: Deployment\n" in document
                )
                self.assertIn("\n  replicas: 1\n", gateway)
                self.assertIn("\n  strategy:\n    type: Recreate\n", gateway)
                self.assertNotIn("rollingUpdate:", gateway)
                self.assertNotIn("# Source: cheers/templates/redis.yaml", result.stdout)

    def test_multiple_gateways_are_rejected_even_with_redis_enabled(self):
        for redis in ("false", "true"):
            with self.subTest(redis=redis):
                result = self.render("values-prod.yaml", "gateway.replicaCount=2", f"redis.enabled={redis}")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("replicaCount", result.stderr)


class DeploymentTriggerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = MODULE_PATH.parents[1] / ".github" / "workflows" / "cd.yml"
        cls.workflow = path.read_text(encoding="utf-8")

    def test_production_cd_is_release_tag_only(self):
        trigger = self.workflow.split("on:\n", 1)[1].split("\nconcurrency:", 1)[0]
        self.assertIn('tags: ["v*.*.*"]', trigger)
        self.assertNotIn("branches:", trigger)

    def test_production_uses_immutable_release_images(self):
        self.assertIn(
            "${{ env.IMAGE_GATEWAY }}:${{ needs.changes.outputs.release_version }}",
            self.workflow,
        )
        self.assertIn(
            "${{ env.IMAGE_FRONTEND }}:${{ needs.changes.outputs.release_version }}",
            self.workflow,
        )
        self.assertNotIn("${{ env.IMAGE_GATEWAY }}:main", self.workflow)
        self.assertNotIn("${{ env.IMAGE_FRONTEND }}:main", self.workflow)

    def test_rc_cannot_deploy_or_replace_stable_image_aliases(self):
        for job in ("deploy-contract", "deploy"):
            section = self.workflow.split(f"\n  {job}:\n", 1)[1].split("\n    steps:", 1)[0]
            with self.subTest(job=job):
                self.assertIn("needs.changes.outputs.prerelease == 'false' &&", section)
        self.assertEqual(self.workflow.count(
            "flavor: latest=${{ needs.changes.outputs.prerelease == 'false' }}"
        ), 2)
        self.assertEqual(self.workflow.count(
            "type=semver,pattern={{major}}.{{minor}},enable=${{ needs.changes.outputs.prerelease == 'false' }}"
        ), 2)

    def test_rc_is_published_only_after_both_images_succeed(self):
        section = self.workflow.split("\n  publish-rc:\n", 1)[1].split("\n  deploy:\n", 1)[0]
        self.assertIn("needs.changes.outputs.prerelease == 'true' &&", section)
        for component in ("gateway", "frontend"):
            self.assertIn(f"needs.build-{component}.result == 'success'", section)
        self.assertIn("prerelease: true", section)
        self.assertIn("make_latest: false", section)
        self.assertIn("files: rc-images.json", section)

    def test_connector_rc_does_not_change_production_pin_or_latest_release(self):
        workflow = (MODULE_PATH.parents[1] / ".github/workflows/release-connector.yml").read_text()
        pin = workflow.split("\n  sync-pin:\n", 1)[1].split("\n    steps:", 1)[0]
        self.assertIn("!contains(github.ref_name, '-rc.') &&", pin)
        self.assertEqual(workflow.count("prerelease: ${{ contains(github.ref_name, '-rc.') }}"), 2)
        self.assertEqual(workflow.count("make_latest: false"), 2)


class DockerActionRuntimeTests(unittest.TestCase):
    def test_docker_actions_use_node24_generations(self):
        workflow_dir = MODULE_PATH.parents[1] / ".github" / "workflows"
        workflows = "\n".join(
            path.read_text(encoding="utf-8") for path in workflow_dir.glob("*.yml")
        )
        expected = (
            "docker/build-push-action@v7",
            "docker/login-action@v4",
            "docker/metadata-action@v6",
            "docker/setup-buildx-action@v4",
        )
        legacy = (
            "docker/build-push-action@v6",
            "docker/login-action@v3",
            "docker/metadata-action@v5",
            "docker/setup-buildx-action@v3",
        )
        for action in expected:
            with self.subTest(action=action):
                self.assertIn(action, workflows)
        for action in legacy:
            with self.subTest(action=action):
                self.assertNotIn(action, workflows)


class DeployContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = MODULE_PATH.parents[1] / "deploy" / "production" / "deploy.sh"
        cls.expected_sha = hashlib.sha256(cls.script.read_bytes()).hexdigest()

    def run_preflight(self, expected_sha):
        return subprocess.run(
            ["bash", str(self.script)],
            input=f"CHEERS_DEPLOY_PREFLIGHT_V1\n{expected_sha}\n",
            text=True,
            capture_output=True,
            check=False,
        )

    def test_deploy_contract_accepts_the_exact_script(self):
        result = self.run_preflight(self.expected_sha)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"sha256={self.expected_sha}", result.stdout)

    def test_deploy_contract_rejects_script_drift(self):
        result = self.run_preflight("0" * 64)
        self.assertEqual(result.returncode, 78)
        self.assertIn("deploy contract mismatch", result.stderr)

    def test_deploy_contract_rejects_an_invalid_digest(self):
        result = self.run_preflight("not-a-sha")
        self.assertEqual(result.returncode, 78)
        self.assertIn("invalid SHA-256", result.stderr)


if __name__ == "__main__":
    unittest.main()

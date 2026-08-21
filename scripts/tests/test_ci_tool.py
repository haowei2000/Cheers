import importlib.util
import hashlib
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

    def test_bridge_protocol_selects_gateway_and_plugin(self):
        self.assertEqual(
            self.selected(
                "ci",
                ["packages/cheers-acp-connector-rs/bridge-protocol/src/lib.rs"],
            ),
            {"gateway", "plugin"},
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

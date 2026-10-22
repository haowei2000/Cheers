import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "version_control.py"
SPEC = importlib.util.spec_from_file_location("version_control", MODULE_PATH)
assert SPEC and SPEC.loader
version_control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(version_control)


class VersionControlTests(unittest.TestCase):
    def setUp(self):
        self.versions = {
            "platform": "0.1.41",
            "desktop": "0.1.31",
            "ios": "1.0.0",
            "connector": "0.1.40",
        }

    def test_repository_version_metadata_is_consistent(self):
        self.assertEqual(
            set(version_control.checked_versions()),
            {"platform", "desktop", "ios", "connector"},
        )

    def test_accepts_each_release_train(self):
        cases = {
            "v0.1.41": "platform",
            "desktop-v0.1.31": "desktop",
            "ios-v1.0.0": "ios",
            "ios-v1.0.0-build.6": "ios",
            "connector-v0.1.40": "connector",
        }
        for tag, expected in cases.items():
            with self.subTest(tag=tag):
                self.assertEqual(version_control.verify_tag(tag, self.versions), expected)

    def test_rejects_tag_that_does_not_match_source(self):
        with self.assertRaisesRegex(version_control.VersionError, "source version 0.1.31"):
            version_control.verify_tag("desktop-v0.1.32", self.versions)

    def test_accepts_platform_and_connector_release_candidates(self):
        cases = {
            "v0.1.41-rc.1": "platform",
            "v0.1.41-rc.12": "platform",
            "connector-v0.1.40-rc.1": "connector",
            "connector-v0.1.40-rc.123": "connector",
        }
        for tag, expected in cases.items():
            with self.subTest(tag=tag):
                self.assertEqual(version_control.verify_tag(tag, self.versions), expected)

    def test_rejects_malformed_release_candidate_suffixes(self):
        suffixes = (
            "-rc", "-rc1", "-rc.", "-rc.0", "-rc.01", "-rc.-1", "-rc.+1",
            "-rc.1.1", "-rc.1+build.2", "-RC.1", "-beta.1", "-rc.١",
        )
        for core_tag in ("v0.1.41", "connector-v0.1.40"):
            for suffix in suffixes:
                tag = core_tag + suffix
                with self.subTest(tag=tag), self.assertRaises(version_control.VersionError):
                    version_control.verify_tag(tag, self.versions)

    def test_rejects_release_candidate_with_a_different_source_version(self):
        for tag in ("v0.1.42-rc.1", "connector-v0.1.41-rc.1"):
            with self.subTest(tag=tag), self.assertRaisesRegex(
                version_control.VersionError, "source version"
            ):
                version_control.verify_tag(tag, self.versions)

    def test_rejects_release_candidates_for_other_release_trains(self):
        for tag in ("desktop-v0.1.31-rc.1", "ios-v1.0.0-rc.1", "ios-v1.0.0-build.1-rc.1"):
            with self.subTest(tag=tag), self.assertRaises(version_control.VersionError):
                version_control.verify_tag(tag, self.versions)

    def test_source_versions_remain_core_versions_for_release_candidates(self):
        for component in self.versions:
            with self.subTest(component=component), patch.object(
                version_control,
                "version_values",
                return_value={component: {"source": self.versions[component] + "-rc.1"}},
            ), self.assertRaisesRegex(version_control.VersionError, "not major.minor.patch"):
                version_control.checked_versions()

    def test_rejects_invalid_ios_build_suffix(self):
        for tag in ("ios-v1.0.0-build.0", "ios-v1.0.0-preview.1"):
            with self.subTest(tag=tag), self.assertRaises(version_control.VersionError):
                version_control.verify_tag(tag, self.versions)

    def test_rejects_unsupported_tag(self):
        with self.assertRaisesRegex(version_control.VersionError, "unsupported release tag"):
            version_control.verify_tag("release-0.1.41", self.versions)


if __name__ == "__main__":
    unittest.main()

"""
Tests for deploy.yml — verifies the release workflow contains all required
docs-build steps and references per T-083 acceptance criteria.
"""
import subprocess
import sys
import unittest
import yaml

WORKFLOW_PATH = ".github/workflows/deploy.yml"


def load_workflow():
    with open(WORKFLOW_PATH, "r") as f:
        return yaml.safe_load(f)


class TestDeployWorkflowYamlValid(unittest.TestCase):
    """AC baseline: the workflow file must be valid YAML."""

    def test_workflow_file_parses_as_valid_yaml(self):
        # If load_workflow raises, the test fails with a meaningful error.
        workflow = load_workflow()
        self.assertIsInstance(workflow, dict)


class TestMdbookInstallStep(unittest.TestCase):
    """AC-4: mdbook and mdbook-mermaid must be installed before the docs build."""

    def setUp(self):
        self.workflow = load_workflow()
        self.steps = self.workflow["jobs"]["release"]["steps"]

    def test_workflow_references_mdbook(self):
        """grep -q 'mdbook' deploy.yml — static check from task verification."""
        result = subprocess.run(
            ["grep", "-q", "mdbook", WORKFLOW_PATH], capture_output=True
        )
        self.assertEqual(result.returncode, 0, "workflow must reference mdbook")

    def test_workflow_references_mdbook_mermaid(self):
        """mdbook-mermaid must also be installed."""
        result = subprocess.run(
            ["grep", "-q", "mdbook-mermaid", WORKFLOW_PATH], capture_output=True
        )
        self.assertEqual(result.returncode, 0, "workflow must reference mdbook-mermaid")

    def test_mdbook_install_step_exists_before_docs_build(self):
        """AC-4: an install step must appear before the docs build step."""
        step_names = [s.get("name", "") for s in self.steps]
        install_indices = [
            i for i, name in enumerate(step_names) if "install" in name.lower() and "mdbook" in name.lower()
        ]
        docs_build_indices = [
            i for i, name in enumerate(step_names) if "docs" in name.lower() and "build" in name.lower()
        ]
        self.assertTrue(install_indices, "expected an mdbook install step")
        self.assertTrue(docs_build_indices, "expected a docs build step")
        self.assertLess(
            install_indices[0],
            docs_build_indices[0],
            "mdbook install step must come before docs build step",
        )


class TestDocsBuildStep(unittest.TestCase):
    """AC-2, AC-3: docs build step must use BOB_BIN and work in the-intern/docs."""

    def setUp(self):
        self.workflow = load_workflow()
        self.steps = self.workflow["jobs"]["release"]["steps"]

    def test_workflow_references_the_intern_docs(self):
        """grep -q 'the-intern/docs' deploy.yml — static check from task verification."""
        result = subprocess.run(
            ["grep", "-q", "the-intern/docs", WORKFLOW_PATH], capture_output=True
        )
        self.assertEqual(result.returncode, 0, "workflow must reference the-intern/docs")

    def test_workflow_references_bob_bin(self):
        """grep -q 'BOB_BIN' deploy.yml — static check from task verification."""
        result = subprocess.run(
            ["grep", "-q", "BOB_BIN", WORKFLOW_PATH], capture_output=True
        )
        self.assertEqual(result.returncode, 0, "workflow must reference BOB_BIN")

    def _find_docs_build_step(self):
        for step in self.steps:
            name = step.get("name", "")
            if "docs" in name.lower() and "build" in name.lower():
                return step
        return None

    def test_docs_build_step_sets_bob_bin_env(self):
        """AC-3: BOB_BIN must be set in the docs build step's environment."""
        step = self._find_docs_build_step()
        self.assertIsNotNone(step, "docs build step not found")
        env = step.get("env", {})
        self.assertIn("BOB_BIN", env, "docs build step must set BOB_BIN env var")

    def test_docs_build_step_bob_bin_points_to_release_binary(self):
        """AC-3: BOB_BIN must point to the release binary produced earlier."""
        step = self._find_docs_build_step()
        self.assertIsNotNone(step, "docs build step not found")
        bob_bin_value = step.get("env", {}).get("BOB_BIN", "")
        self.assertIn(
            "release/bob",
            bob_bin_value,
            "BOB_BIN must reference the release profile bob binary",
        )

    def test_docs_build_step_works_in_docs_directory(self):
        """AC-3: docs build must run inside the-intern/docs.

        The working-directory may be set to the literal path 'the-intern/docs'
        or via a workflow env variable that resolves to that path (e.g.
        '${{ env.DOCS_DIR }}' where DOCS_DIR = 'the-intern/docs').  Both are
        valid; the grep-based static checks already confirm the literal path
        appears somewhere in the file.
        """
        step = self._find_docs_build_step()
        self.assertIsNotNone(step, "docs build step not found")
        working_dir = step.get("working-directory", "")
        # Accept either the literal path or an env-var expression referencing
        # a variable defined earlier in the workflow.
        is_literal_path = "the-intern/docs" in working_dir
        is_env_var_ref = "env." in working_dir and "DOCS" in working_dir.upper()
        self.assertTrue(
            is_literal_path or is_env_var_ref,
            "docs build step must have working-directory pointing to the-intern/docs "
            "(literal path or env var reference)",
        )

    def test_docs_build_step_runs_mdbook_build(self):
        """Docs build step must invoke mdbook build."""
        step = self._find_docs_build_step()
        self.assertIsNotNone(step, "docs build step not found")
        run_cmd = step.get("run", "")
        self.assertIn("mdbook build", run_cmd, "docs build step must run 'mdbook build'")


class TestArchiveStep(unittest.TestCase):
    """AC-1: archive step must create a file with the tag in its name."""

    def setUp(self):
        self.workflow = load_workflow()
        self.steps = self.workflow["jobs"]["release"]["steps"]

    def _find_archive_step(self):
        for step in self.steps:
            name = step.get("name", "")
            if "archive docs" in name.lower():
                return step
        for step in self.steps:
            run = step.get("run", "")
            if "tar" in run and "docs" in run:
                return step
        return None

    def test_archive_step_exists(self):
        """AC-1: an archive step must exist."""
        step = self._find_archive_step()
        self.assertIsNotNone(step, "expected a docs archive creation step")

    def test_archive_filename_includes_tag(self):
        """AC-1: archive filename must include the release tag."""
        step = self._find_archive_step()
        self.assertIsNotNone(step, "expected a docs archive creation step")
        run_cmd = step.get("run", "")
        # The tag is accessed via github.ref_name in GitHub Actions
        self.assertIn(
            "github.ref_name",
            run_cmd,
            "archive filename must incorporate the release tag via github.ref_name",
        )

    def test_archive_covers_docs_book_directory(self):
        """AC-1: archive must package the-intern/docs/book/."""
        step = self._find_archive_step()
        self.assertIsNotNone(step, "expected a docs archive creation step")
        run_cmd = step.get("run", "")
        self.assertTrue(
            "book" in run_cmd or "the-intern/docs" in run_cmd,
            "archive step must reference the docs book output directory",
        )


class TestReleaseStep(unittest.TestCase):
    """AC-1: release step must include bob binary, docs, and extension archives."""

    def setUp(self):
        self.workflow = load_workflow()
        self.steps = self.workflow["jobs"]["release"]["steps"]

    def _find_release_step(self):
        for step in self.steps:
            uses = step.get("uses", "")
            if "softprops/action-gh-release" in uses:
                return step
        return None

    def test_release_step_exists(self):
        step = self._find_release_step()
        self.assertIsNotNone(step, "softprops/action-gh-release step must exist")

    def test_release_files_includes_bob_binary(self):
        """AC-1: release must still attach the bob binary."""
        step = self._find_release_step()
        self.assertIsNotNone(step, "softprops/action-gh-release step must exist")
        files_value = step.get("with", {}).get("files", "")
        self.assertIn(
            "bob",
            files_value,
            "release files must include the bob binary",
        )

    def test_release_files_includes_docs_archive(self):
        """AC-1: release must attach the docs archive."""
        step = self._find_release_step()
        self.assertIsNotNone(step, "softprops/action-gh-release step must exist")
        files_value = step.get("with", {}).get("files", "")
        self.assertIn(
            "the-intern-docs",
            files_value,
            "release files must include the docs archive (the-intern-docs-*.tar.gz)",
        )

    def test_release_files_includes_bob_extension_archive(self):
        """Release must attach the bob extension archive."""
        step = self._find_release_step()
        self.assertIsNotNone(step, "softprops/action-gh-release step must exist")
        files_value = step.get("with", {}).get("files", "")
        self.assertIn(
            "the-intern-bob-extension",
            files_value,
            "release files must include the bob extension archive",
        )

    def test_release_files_includes_bob_companion_archive(self):
        """Release must keep the bob-companion archive unchanged."""
        step = self._find_release_step()
        self.assertIsNotNone(step, "softprops/action-gh-release step must exist")
        files_value = step.get("with", {}).get("files", "")
        self.assertIn(
            "the-intern-bob-companion-claude",
            files_value,
            "release files must include the bob-companion archive",
        )

    def test_release_files_includes_linux_install_bundle_zip(self):
        """Release must attach the Linux install-bundle zip."""
        step = self._find_release_step()
        self.assertIsNotNone(step, "softprops/action-gh-release step must exist")
        files_value = step.get("with", {}).get("files", "")
        self.assertIn(
            "the-intern-bob-install-${{ github.ref_name }}-linux-x86_64.zip",
            files_value,
            "release files must include the Linux install-bundle zip",
        )

    def test_release_files_includes_macos_install_bundle_zip(self):
        """Release must attach the macOS install-bundle zip."""
        step = self._find_release_step()
        self.assertIsNotNone(step, "softprops/action-gh-release step must exist")
        files_value = step.get("with", {}).get("files", "")
        self.assertIn(
            "the-intern-bob-install-${{ github.ref_name }}-macos-arm64.zip",
            files_value,
            "release files must include the macOS install-bundle zip",
        )

    def test_release_files_list_keeps_four_existing_assets_and_adds_two_zips(self):
        """Release must publish exactly six assets in the existing release step."""
        step = self._find_release_step()
        self.assertIsNotNone(step, "softprops/action-gh-release step must exist")
        files_value = step.get("with", {}).get("files", "")
        files = [line.strip() for line in files_value.splitlines() if line.strip()]
        self.assertEqual(
            len(files),
            6,
            "release files list must keep the four existing assets and add two install-bundle zips",
        )


class TestMacosBuildJob(unittest.TestCase):
    """AC-1, AC-2, AC-4: macOS build job must create and upload a zipped install bundle."""

    def setUp(self):
        self.workflow = load_workflow()
        self.job = self.workflow["jobs"].get("build-macos")

    def test_build_macos_job_exists(self):
        self.assertIsNotNone(self.job, "expected a separate build-macos job")

    def test_build_macos_job_runs_on_macos_14(self):
        self.assertIsNotNone(self.job, "expected a separate build-macos job")
        self.assertEqual(
            self.job.get("runs-on"),
            "macos-14",
            "build-macos job must run on macos-14",
        )

    def test_build_macos_job_builds_release_bob_binary(self):
        self.assertIsNotNone(self.job, "expected a separate build-macos job")
        run_blocks = [
            step.get("run", "") for step in self.job.get("steps", []) if step.get("run")
        ]
        self.assertTrue(
            any("cargo build --release -p bob" in run for run in run_blocks),
            "build-macos job must build bob in release mode",
        )

    def test_build_macos_job_packages_expected_files_into_zip(self):
        self.assertIsNotNone(self.job, "expected a separate build-macos job")
        run_blocks = [
            step.get("run", "") for step in self.job.get("steps", []) if step.get("run")
        ]
        package_run = next(
            (
                run for run in run_blocks
                if "the-intern-bob-install-${{ github.ref_name }}-macos-arm64.zip" in run
            ),
            "",
        )
        self.assertIn("target/release/bob", package_run)
        self.assertIn("bob.ts", package_run)
        self.assertIn("install.sh", package_run)
        self.assertIn("README.txt", package_run)
        self.assertIn("zip", package_run, "macOS install bundle must be zipped before upload")

    def test_build_macos_job_uploads_zip_artifact_with_repo_pinned_action_major(self):
        self.assertIsNotNone(self.job, "expected a separate build-macos job")
        upload_steps = [
            step for step in self.job.get("steps", []) if "upload-artifact" in step.get("uses", "")
        ]
        self.assertEqual(len(upload_steps), 1, "expected one upload-artifact step in build-macos")
        upload_step = upload_steps[0]
        self.assertIn(
            "@v6",
            upload_step.get("uses", ""),
            "upload-artifact must use the same pinned major version as build.yml",
        )
        self.assertIn(
            ".zip",
            upload_step.get("with", {}).get("path", ""),
            "upload-artifact must upload the pre-zipped macOS bundle",
        )


class TestReleaseJobInstallBundles(unittest.TestCase):
    """AC-2, AC-4, AC-5: Linux release job must package Linux bundle and gate on macOS."""

    def setUp(self):
        self.workflow = load_workflow()
        self.job = self.workflow["jobs"]["release"]
        self.steps = self.job["steps"]

    def test_release_job_needs_build_macos(self):
        self.assertEqual(
            self.job.get("needs"),
            "build-macos",
            "release job must depend on build-macos so a macOS failure blocks the release",
        )

    def test_release_job_downloads_macos_artifact_with_repo_pinned_action_major(self):
        download_steps = [
            step for step in self.steps if "download-artifact" in step.get("uses", "")
        ]
        self.assertEqual(len(download_steps), 1, "expected one download-artifact step in release job")
        download_step = download_steps[0]
        self.assertIn(
            "@v6",
            download_step.get("uses", ""),
            "download-artifact must use the same pinned major version as build.yml",
        )

    def test_release_job_packages_linux_install_bundle_zip(self):
        package_steps = [
            step for step in self.steps
            if "the-intern-bob-install-${{ github.ref_name }}-linux-x86_64.zip" in step.get("run", "")
        ]
        self.assertEqual(len(package_steps), 1, "expected one Linux install-bundle packaging step")
        run_cmd = package_steps[0].get("run", "")
        self.assertIn("target/release/bob", run_cmd)
        self.assertIn("bob.ts", run_cmd)
        self.assertIn("install.sh", run_cmd)
        self.assertIn("README.txt", run_cmd)

    def test_release_job_keeps_existing_archive_steps_exactly_once(self):
        archive_step_names = [step.get("name", "") for step in self.steps]
        self.assertEqual(archive_step_names.count("Archive docs"), 1)
        self.assertEqual(archive_step_names.count("Archive bob extension"), 1)
        self.assertEqual(archive_step_names.count("Archive bob-companion plugin"), 1)

    def test_release_job_builds_docs_exactly_once(self):
        docs_build_steps = [
            step for step in self.steps
            if "docs" in step.get("name", "").lower() and "build" in step.get("name", "").lower()
        ]
        self.assertEqual(len(docs_build_steps), 1, "release job must build docs exactly once")


class TestBobExtensionArchiveStep(unittest.TestCase):
    """The release workflow must package the source-only bob extension."""

    def setUp(self):
        self.workflow = load_workflow()
        self.steps = self.workflow["jobs"]["release"]["steps"]

    def _find_bob_extension_archive_step(self):
        for step in self.steps:
            name = step.get("name", "").lower()
            run = step.get("run", "")
            if "bob extension" in name and "tar" in run:
                return step
        return None

    def test_bob_extension_archive_step_exists(self):
        step = self._find_bob_extension_archive_step()
        self.assertIsNotNone(step, "expected a bob extension archive creation step")

    def test_bob_extension_archive_filename_includes_tag(self):
        step = self._find_bob_extension_archive_step()
        self.assertIsNotNone(step, "expected a bob extension archive creation step")
        run_cmd = step.get("run", "")
        self.assertIn(
            "github.ref_name",
            run_cmd,
            "bob extension archive filename must incorporate the release tag",
        )

    def test_bob_extension_archive_includes_extension_source(self):
        step = self._find_bob_extension_archive_step()
        self.assertIsNotNone(step, "expected a bob extension archive creation step")
        run_cmd = step.get("run", "")
        self.assertIn("bob.ts", run_cmd, "bob extension archive must include bob.ts")


class TestJobFailsOnDocsFailure(unittest.TestCase):
    """AC-2: no continue-on-error directives on the docs-related steps."""

    def setUp(self):
        self.workflow = load_workflow()
        self.steps = self.workflow["jobs"]["release"]["steps"]

    def _docs_related_steps(self):
        docs_steps = []
        for step in self.steps:
            name = step.get("name", "").lower()
            run = step.get("run", "")
            if any(kw in name for kw in ("mdbook", "docs", "archive", "tar")) or "mdbook" in run:
                docs_steps.append(step)
        return docs_steps

    def test_docs_steps_do_not_use_continue_on_error(self):
        """AC-2: docs-related steps must not set continue-on-error: true."""
        docs_steps = self._docs_related_steps()
        self.assertTrue(docs_steps, "expected at least one docs-related step")
        for step in docs_steps:
            self.assertNotEqual(
                step.get("continue-on-error", False),
                True,
                f"step '{step.get('name', '?')}' must not set continue-on-error: true",
            )


if __name__ == "__main__":
    unittest.main()

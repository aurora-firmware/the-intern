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
            if "archive" in name.lower() or "tar" in name.lower() or "package" in name.lower():
                return step
        # Also look in run commands
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
    """AC-1: release step must include both bob binary and docs archive."""

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

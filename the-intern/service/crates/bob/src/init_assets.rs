#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbeddedAsset {
    relative_path: &'static str,
    bytes: &'static [u8],
}

impl EmbeddedAsset {
    pub const fn new(relative_path: &'static str, bytes: &'static [u8]) -> Self {
        Self {
            relative_path,
            bytes,
        }
    }

    pub fn relative_path(&self) -> &'static str {
        self.relative_path
    }

    pub fn bytes(&self) -> &'static [u8] {
        self.bytes
    }
}

// Generated at build time from the canonical tracked the-intern/bob-skills/.pi/skills tree.
include!(concat!(env!("OUT_DIR"), "/embedded_pi_skill_assets.rs"));

pub fn embedded_pi_skill_package_source_dir() -> &'static str {
    EMBEDDED_PI_SKILL_PACKAGE_SOURCE_DIR
}

pub fn embedded_pi_skill_assets() -> &'static [EmbeddedAsset] {
    EMBEDDED_PI_SKILL_ASSETS
}

pub fn embedded_pi_skill_asset(relative_path: &str) -> Option<&'static EmbeddedAsset> {
    embedded_pi_skill_assets()
        .iter()
        .find(|asset| asset.relative_path() == relative_path)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    use super::{
        embedded_pi_skill_asset, embedded_pi_skill_assets, embedded_pi_skill_package_source_dir,
    };

    const DOCS_REFERENCES_PREFIX: &str = "the-intern-docs/references/";

    fn manual_source_dir() -> std::path::PathBuf {
        Path::new(embedded_pi_skill_package_source_dir()).join("../../../docs/src")
    }

    fn embedded_docs_pages() -> Vec<&'static str> {
        embedded_pi_skill_assets()
            .iter()
            .map(|asset| asset.relative_path())
            .filter(|path| path.starts_with(DOCS_REFERENCES_PREFIX))
            .collect()
    }

    fn docs_skill_text() -> &'static str {
        let skill = embedded_pi_skill_asset("the-intern-docs/SKILL.md")
            .expect("the-intern-docs/SKILL.md must be embedded");
        std::str::from_utf8(skill.bytes()).expect("docs SKILL.md must be UTF-8")
    }

    /// Every `references/...` path named in backticks in the docs SKILL.md.
    fn pages_named_by_docs_skill() -> BTreeSet<String> {
        docs_skill_text()
            .split('`')
            .filter(|segment| segment.starts_with("references/") && segment.ends_with(".md"))
            .map(|segment| format!("the-intern-docs/{segment}"))
            .collect()
    }

    #[test]
    fn embeds_assets_from_the_canonical_pi_package_path() {
        let source_dir = embedded_pi_skill_package_source_dir();

        assert!(
            source_dir.ends_with("/the-intern/bob-skills/.pi/skills"),
            "expected canonical package path suffix, got {source_dir}"
        );
    }

    #[test]
    fn exposes_a_stable_relative_path_list_and_matching_bytes() {
        let expected_paths = vec![
            "email-triage/SKILL.md",
            "email-triage/references/categories/README.md",
            "email-triage/references/categories/automated-notification.md",
            "email-triage/references/categories/direct-request.md",
            "email-triage/references/categories/meeting-scheduling.md",
            "email-triage/references/categories/newsletter-bulk.md",
            "email-triage/references/categories/self-escalation.md",
            "email-triage/references/categories/suspected-spam.md",
            "email-triage/references/escalation.md",
            "email-triage/references/worklog.md",
            "himalaya/SKILL.md",
            "himalaya/references/command-reference.md",
            "tasks/SKILL.md",
            "the-intern-docs/SKILL.md",
            "the-intern-docs/references/architecture-overview/index.md",
            "the-intern-docs/references/end-user-guide/index.md",
            "the-intern-docs/references/extension-author-guide/index.md",
            "the-intern-docs/references/operator-guide/index.md",
            "the-intern-docs/references/quickstart/index.md",
            "worklog/SKILL.md",
            "worklog/references/entry-format.md",
            "worklog/references/reconciliation.md",
        ];
        let actual_paths = embedded_pi_skill_assets()
            .iter()
            .map(|asset| asset.relative_path())
            .collect::<Vec<_>>();

        assert_eq!(actual_paths, expected_paths);

        for relative_path in expected_paths {
            let asset = embedded_pi_skill_asset(relative_path)
                .unwrap_or_else(|| panic!("missing embedded asset {relative_path}"));
            let source_path = Path::new(embedded_pi_skill_package_source_dir()).join(relative_path);
            if relative_path.starts_with(DOCS_REFERENCES_PREFIX) {
                // Manual pages are copied from the manual, not from the pi package tree.
                continue;
            }
            let source_bytes = std::fs::read(&source_path)
                .unwrap_or_else(|err| panic!("read {source_path:?}: {err}"));

            assert_eq!(
                asset.bytes(),
                source_bytes.as_slice(),
                "embedded bytes differed for {relative_path}"
            );
        }
    }

    #[test]
    fn embedded_docs_pages_are_byte_identical_to_the_manual_sources() {
        let pages = embedded_docs_pages();
        assert!(!pages.is_empty(), "no manual pages embedded");

        for page in pages {
            let manual_relative = page
                .strip_prefix(DOCS_REFERENCES_PREFIX)
                .expect("filtered by prefix");
            let source_path = manual_source_dir().join(manual_relative);
            let source_bytes = std::fs::read(&source_path)
                .unwrap_or_else(|err| panic!("read {source_path:?}: {err}"));
            let asset = embedded_pi_skill_asset(page).expect("listed from embedded assets");

            assert_eq!(
                asset.bytes(),
                source_bytes.as_slice(),
                "embedded page {page} drifted from {source_path:?}"
            );
        }
    }

    #[test]
    fn embedded_docs_pages_match_the_pages_named_in_the_docs_skill_index() {
        let named = pages_named_by_docs_skill();
        let embedded = embedded_docs_pages()
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();

        assert_eq!(
            named.len(),
            5,
            "docs SKILL.md should name five pages: {named:?}"
        );
        assert_eq!(embedded, named);
    }

    #[test]
    fn never_embeds_the_summary_the_cli_reference_or_a_copied_skill_md() {
        for page in embedded_docs_pages() {
            assert!(!page.ends_with("SUMMARY.md"), "embedded {page}");
            assert!(!page.contains("cli-reference"), "embedded {page}");
            assert!(!page.ends_with("/SKILL.md"), "embedded {page}");
        }
    }

    #[test]
    fn contains_the_five_shipped_skill_roots() {
        let roots = embedded_pi_skill_assets()
            .iter()
            .map(|asset| {
                asset
                    .relative_path()
                    .split('/')
                    .next()
                    .expect("every embedded asset must have a skill root")
            })
            .collect::<BTreeSet<_>>();

        assert_eq!(
            roots,
            BTreeSet::from([
                "email-triage",
                "himalaya",
                "tasks",
                "the-intern-docs",
                "worklog"
            ])
        );
    }
}

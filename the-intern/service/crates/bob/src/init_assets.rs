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

// Generated at build time from the canonical tracked the-intern/email-skills/.pi/skills tree.
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

    #[test]
    fn embeds_assets_from_the_canonical_pi_package_path() {
        let source_dir = embedded_pi_skill_package_source_dir();

        assert!(
            source_dir.ends_with("/the-intern/email-skills/.pi/skills"),
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
    fn contains_the_three_shipped_skill_roots() {
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
            BTreeSet::from(["email-triage", "himalaya", "worklog"])
        );
    }
}

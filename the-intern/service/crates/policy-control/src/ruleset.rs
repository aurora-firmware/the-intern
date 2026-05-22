use std::sync::Arc;

use serde::Deserialize;

use bob_core::types::UserId;

/// A structurally-invalid policy configuration was supplied.
#[derive(Debug, thiserror::Error)]
pub enum RulesetError {
    /// An `ArgMatcher` contains an empty field path or pattern.
    #[error("arg_matcher field_path and pattern must not be empty")]
    EmptyArgMatcher,
}

/// An argument matcher: a field path and a glob pattern (both plain strings).
///
/// Matching behaviour is implemented in T-050.
#[derive(Debug, Clone, Deserialize)]
pub struct ArgMatcher {
    /// Dot-separated path to the argument field (e.g. `"user.name"`).
    pub field_path: String,
    /// Glob pattern to match against the field value.
    pub pattern: String,
}

/// One rule governing a specific tool call.
#[derive(Debug, Clone, Deserialize)]
pub struct ActionRule {
    /// Name of the tool this rule applies to.
    pub tool: String,
    /// Optional set of argument matchers. If absent, the rule applies to all
    /// invocations of the named tool regardless of arguments.
    #[serde(default)]
    pub arg_matchers: Vec<ArgMatcher>,
}

/// The shape of the `[policy]` TOML section.
///
/// Deserialised once at start-up and then converted to a [`RulesetSnapshot`]
/// via [`RulesetSnapshot::from_config`].
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PolicyConfig {
    /// Users whose requests are admitted to the system.
    #[serde(default)]
    pub admitted_users: Vec<String>,
    /// Rules that describe which tool actions are allowed.
    #[serde(default)]
    pub action_rules: Vec<ActionRule>,
}

/// Validated, immutable in-memory ruleset.
///
/// Cheaply cloneable: inner collections are wrapped in [`Arc`] so that a clone
/// shares the heap allocation rather than copying it.
#[derive(Debug, Clone)]
pub struct RulesetSnapshot {
    /// Admitted user identifiers.
    pub(crate) admitted_users: Arc<Vec<UserId>>,
    /// Validated action rules.
    pub(crate) action_rules: Arc<Vec<ActionRule>>,
}

impl RulesetSnapshot {
    /// Build a validated snapshot from a raw [`PolicyConfig`].
    ///
    /// An empty config is valid and produces a deny-all snapshot.
    ///
    /// # Errors
    ///
    /// Returns [`RulesetError::EmptyArgMatcher`] if any `ArgMatcher` contains
    /// an empty `field_path` or `pattern`.
    pub fn from_config(cfg: PolicyConfig) -> Result<Self, RulesetError> {
        // Parse and validate admitted users.
        let admitted_users: Vec<UserId> = cfg
            .admitted_users
            .iter()
            .filter_map(|s| s.parse().ok())
            .collect();

        // Validate arg matchers are non-empty.
        for rule in &cfg.action_rules {
            for matcher in &rule.arg_matchers {
                if matcher.field_path.is_empty() || matcher.pattern.is_empty() {
                    return Err(RulesetError::EmptyArgMatcher);
                }
            }
        }

        Ok(Self {
            admitted_users: Arc::new(admitted_users),
            action_rules: Arc::new(cfg.action_rules),
        })
    }

    /// Returns the set of admitted user identifiers.
    #[must_use]
    pub fn admitted_users(&self) -> &[UserId] {
        &self.admitted_users
    }

    /// Returns the action rules for this snapshot.
    #[must_use]
    pub fn action_rules(&self) -> &[ActionRule] {
        &self.action_rules
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bob_core::types::UserId;

    // ── AC-1 ────────────────────────────────────────────────────────────────

    #[test]
    fn policy_config_deserializes_admitted_users_and_action_rules_from_toml() {
        let user_id = UserId::new();
        let toml_str = format!(
            r#"
            admitted_users = ["{user_id}"]

            [[action_rules]]
            tool = "bash"
            arg_matchers = [{{ field_path = "cmd", pattern = "ls*" }}]
            "#
        );

        let cfg: PolicyConfig = toml::from_str(&toml_str).expect("valid toml must parse");

        assert_eq!(cfg.admitted_users.len(), 1);
        assert_eq!(cfg.admitted_users[0], user_id.to_string());
        assert_eq!(cfg.action_rules.len(), 1);
        assert_eq!(cfg.action_rules[0].tool, "bash");
        assert_eq!(cfg.action_rules[0].arg_matchers.len(), 1);
        assert_eq!(cfg.action_rules[0].arg_matchers[0].field_path, "cmd");
        assert_eq!(cfg.action_rules[0].arg_matchers[0].pattern, "ls*");
    }

    #[test]
    fn policy_config_admits_empty_fields_with_defaults() {
        let toml_str = "";
        let cfg: PolicyConfig = toml::from_str(toml_str).expect("empty toml is valid");

        assert!(cfg.admitted_users.is_empty());
        assert!(cfg.action_rules.is_empty());
    }

    #[test]
    fn action_rule_without_arg_matchers_defaults_to_empty_vec() {
        let toml_str = r#"
            [[action_rules]]
            tool = "read_file"
        "#;
        let cfg: PolicyConfig = toml::from_str(toml_str).expect("valid toml must parse");

        assert_eq!(cfg.action_rules.len(), 1);
        assert!(cfg.action_rules[0].arg_matchers.is_empty());
    }

    // ── AC-2 ────────────────────────────────────────────────────────────────

    #[test]
    fn ruleset_snapshot_is_cheaply_cloneable_via_arc_sharing() {
        let cfg = PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![],
        };
        let snapshot = RulesetSnapshot::from_config(cfg).expect("empty config is valid");
        let clone = snapshot.clone();

        // Both clones point to the same inner Arc allocations.
        assert!(Arc::ptr_eq(&snapshot.admitted_users, &clone.admitted_users));
        assert!(Arc::ptr_eq(&snapshot.action_rules, &clone.action_rules));
    }

    // ── AC-3 ────────────────────────────────────────────────────────────────

    #[test]
    fn from_config_with_valid_config_returns_ok_snapshot_reflecting_config() {
        let user_id = UserId::new();
        let cfg = PolicyConfig {
            admitted_users: vec![user_id.to_string()],
            action_rules: vec![ActionRule {
                tool: "bash".to_string(),
                arg_matchers: vec![ArgMatcher {
                    field_path: "cmd".to_string(),
                    pattern: "ls*".to_string(),
                }],
            }],
        };

        let snapshot = RulesetSnapshot::from_config(cfg).expect("valid config must succeed");

        assert_eq!(snapshot.admitted_users().len(), 1);
        assert_eq!(snapshot.admitted_users()[0], user_id);
        assert_eq!(snapshot.action_rules().len(), 1);
        assert_eq!(snapshot.action_rules()[0].tool, "bash");
    }

    // ── AC-4 ────────────────────────────────────────────────────────────────

    #[test]
    fn from_config_with_empty_config_returns_deny_all_snapshot() {
        let cfg = PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![],
        };

        let snapshot = RulesetSnapshot::from_config(cfg).expect("empty config is valid");

        assert!(
            snapshot.admitted_users().is_empty(),
            "empty config must admit no users"
        );
        assert!(
            snapshot.action_rules().is_empty(),
            "empty config must allow no tools"
        );
    }

    // ── AC-5 ────────────────────────────────────────────────────────────────

    #[test]
    fn from_config_returns_error_when_arg_matcher_has_empty_field_path() {
        let cfg = PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![ActionRule {
                tool: "bash".to_string(),
                arg_matchers: vec![ArgMatcher {
                    field_path: String::new(), // invalid — empty
                    pattern: "ls*".to_string(),
                }],
            }],
        };

        let result = RulesetSnapshot::from_config(cfg);
        assert!(
            result.is_err(),
            "empty field_path must return Err, not panic"
        );
    }

    #[test]
    fn from_config_returns_error_when_arg_matcher_has_empty_pattern() {
        let cfg = PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![ActionRule {
                tool: "bash".to_string(),
                arg_matchers: vec![ArgMatcher {
                    field_path: "cmd".to_string(),
                    pattern: String::new(), // invalid — empty
                }],
            }],
        };

        let result = RulesetSnapshot::from_config(cfg);
        assert!(result.is_err(), "empty pattern must return Err, not panic");
    }
}

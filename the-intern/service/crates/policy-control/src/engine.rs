use bob_core::types::{PolicyVerdict, UserId};
use serde_json::Value;

use crate::ruleset::{ActionRule, RulesetSnapshot};

/// Pure, synchronous policy evaluation logic.
///
/// Carries no state — the ruleset snapshot is passed in at each call site.
pub struct PolicyEngine;

impl PolicyEngine {
    /// Evaluate whether `user` is admitted by the snapshot.
    ///
    /// Returns an allow verdict when `user` is in the snapshot's admission
    /// list; otherwise returns a deny verdict with a non-empty reason.
    #[must_use]
    pub fn evaluate_admission(snapshot: &RulesetSnapshot, user: UserId) -> PolicyVerdict {
        let admitted = snapshot.admitted_users().contains(&user);
        if admitted {
            PolicyVerdict {
                allow: true,
                reason: None,
            }
        } else {
            PolicyVerdict {
                allow: false,
                reason: Some(format!("user {user} is not in the admission list")),
            }
        }
    }

    /// Evaluate whether a tool call is allowed under the snapshot's action rules.
    ///
    /// Allow-only, default-deny: the call is permitted iff at least one
    /// `ActionRule` names `tool` and every `ArgMatcher` on that rule matches
    /// `arguments`. A rule with no matchers allows the tool for any arguments.
    #[must_use]
    pub fn evaluate_action(
        snapshot: &RulesetSnapshot,
        tool: &str,
        arguments: &Value,
    ) -> PolicyVerdict {
        let allowed = snapshot
            .action_rules()
            .iter()
            .any(|rule| rule_matches(rule, tool, arguments));

        if allowed {
            PolicyVerdict {
                allow: true,
                reason: None,
            }
        } else {
            PolicyVerdict {
                allow: false,
                reason: Some(format!(
                    "no action rule permits tool '{tool}' with the supplied arguments"
                )),
            }
        }
    }
}

/// Returns `true` when `rule` names `tool` and every arg matcher matches.
fn rule_matches(rule: &ActionRule, tool: &str, arguments: &Value) -> bool {
    if rule.tool != tool {
        return false;
    }
    rule.arg_matchers.iter().all(|m| m.matches(arguments))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ruleset::{ArgMatcher, PolicyConfig};

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn snapshot_with_users(user_ids: Vec<UserId>) -> RulesetSnapshot {
        let cfg = PolicyConfig {
            admitted_users: user_ids.iter().map(|u| u.to_string()).collect(),
            action_rules: vec![],
        };
        RulesetSnapshot::from_config(cfg).expect("valid config")
    }

    fn snapshot_with_action_rules(rules: Vec<ActionRule>) -> RulesetSnapshot {
        let cfg = PolicyConfig {
            admitted_users: vec![],
            action_rules: rules,
        };
        RulesetSnapshot::from_config(cfg).expect("valid config")
    }

    // ── AC-1: known user is admitted ─────────────────────────────────────────

    #[test]
    fn evaluate_admission_returns_allow_when_user_is_in_admission_list() {
        let user = UserId::new();
        let snapshot = snapshot_with_users(vec![user]);

        let verdict = PolicyEngine::evaluate_admission(&snapshot, user);

        assert!(verdict.allow);
    }

    // ── AC-2: unknown user is denied with non-empty reason ───────────────────

    #[test]
    fn evaluate_admission_returns_deny_when_user_is_absent_from_admission_list() {
        let admitted = UserId::new();
        let unknown = UserId::new();
        let snapshot = snapshot_with_users(vec![admitted]);

        let verdict = PolicyEngine::evaluate_admission(&snapshot, unknown);

        assert!(!verdict.allow);
        assert!(
            verdict.reason.as_deref().is_some_and(|r| !r.is_empty()),
            "deny verdict must carry a non-empty reason"
        );
    }

    #[test]
    fn evaluate_admission_returns_deny_when_admission_list_is_empty() {
        let snapshot = snapshot_with_users(vec![]);
        let user = UserId::new();

        let verdict = PolicyEngine::evaluate_admission(&snapshot, user);

        assert!(!verdict.allow);
        assert!(
            verdict.reason.as_deref().is_some_and(|r| !r.is_empty()),
            "deny verdict must carry a non-empty reason"
        );
    }

    // ── AC-3: tool present, all matchers pass → allow ────────────────────────

    #[test]
    fn evaluate_action_returns_allow_when_rule_names_tool_and_no_matchers_present() {
        let snapshot = snapshot_with_action_rules(vec![ActionRule {
            tool: "read_file".to_string(),
            arg_matchers: vec![],
        }]);

        let verdict =
            PolicyEngine::evaluate_action(&snapshot, "read_file", &json!({ "path": "/tmp" }));

        assert!(verdict.allow);
    }

    #[test]
    fn evaluate_action_returns_allow_when_rule_names_tool_and_all_matchers_match() {
        let snapshot = snapshot_with_action_rules(vec![ActionRule {
            tool: "bash".to_string(),
            arg_matchers: vec![
                ArgMatcher {
                    field_path: "command".to_string(),
                    pattern: "ls*".to_string(),
                },
                ArgMatcher {
                    field_path: "cwd".to_string(),
                    pattern: "/tmp*".to_string(),
                },
            ],
        }]);

        let verdict = PolicyEngine::evaluate_action(
            &snapshot,
            "bash",
            &json!({ "command": "ls -la", "cwd": "/tmp/work" }),
        );

        assert!(verdict.allow);
    }

    // ── AC-4: tool absent or matcher fails → deny with non-empty reason ───────

    #[test]
    fn evaluate_action_returns_deny_when_no_rule_names_the_tool() {
        let snapshot = snapshot_with_action_rules(vec![ActionRule {
            tool: "read_file".to_string(),
            arg_matchers: vec![],
        }]);

        let verdict = PolicyEngine::evaluate_action(&snapshot, "bash", &json!({}));

        assert!(!verdict.allow);
        assert!(
            verdict.reason.as_deref().is_some_and(|r| !r.is_empty()),
            "deny verdict must carry a non-empty reason"
        );
    }

    #[test]
    fn evaluate_action_returns_deny_when_action_rules_are_empty() {
        let snapshot = snapshot_with_action_rules(vec![]);

        let verdict = PolicyEngine::evaluate_action(&snapshot, "bash", &json!({}));

        assert!(!verdict.allow);
        assert!(
            verdict.reason.as_deref().is_some_and(|r| !r.is_empty()),
            "deny verdict must carry a non-empty reason"
        );
    }

    #[test]
    fn evaluate_action_returns_deny_when_one_matcher_fails_even_if_tool_name_matches() {
        let snapshot = snapshot_with_action_rules(vec![ActionRule {
            tool: "bash".to_string(),
            arg_matchers: vec![
                ArgMatcher {
                    field_path: "command".to_string(),
                    pattern: "ls*".to_string(),
                },
                ArgMatcher {
                    field_path: "cwd".to_string(),
                    pattern: "/tmp*".to_string(),
                },
            ],
        }]);

        // "command" matches but "cwd" does not.
        let verdict = PolicyEngine::evaluate_action(
            &snapshot,
            "bash",
            &json!({ "command": "ls -la", "cwd": "/etc" }),
        );

        assert!(!verdict.allow);
        assert!(
            verdict.reason.as_deref().is_some_and(|r| !r.is_empty()),
            "deny verdict must carry a non-empty reason"
        );
    }

    #[test]
    fn evaluate_action_returns_allow_when_second_rule_matches_even_if_first_does_not() {
        // Tests that any-rule semantics work: a second matching rule suffices.
        let snapshot = snapshot_with_action_rules(vec![
            ActionRule {
                tool: "bash".to_string(),
                arg_matchers: vec![ArgMatcher {
                    field_path: "command".to_string(),
                    pattern: "rm*".to_string(), // won't match
                }],
            },
            ActionRule {
                tool: "bash".to_string(),
                arg_matchers: vec![ArgMatcher {
                    field_path: "command".to_string(),
                    pattern: "ls*".to_string(), // will match
                }],
            },
        ]);

        let verdict =
            PolicyEngine::evaluate_action(&snapshot, "bash", &json!({ "command": "ls -la" }));

        assert!(verdict.allow);
    }
}

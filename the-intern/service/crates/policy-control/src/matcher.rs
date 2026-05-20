use serde_json::Value;
use wildmatch::WildMatch;

use crate::ruleset::ArgMatcher;

impl ArgMatcher {
    /// Returns `true` when the value at `self.field_path` in `arguments` is a
    /// JSON string that matches `self.pattern` (glob: `*` = any run, `?` = one
    /// character, all other characters literal).
    ///
    /// Returns `false` when:
    /// - The field path is absent.
    /// - A non-object node is encountered while traversing the path.
    /// - The final value is not a JSON string.
    #[must_use]
    pub fn matches(&self, arguments: &Value) -> bool {
        let string_value = resolve_field_path(arguments, &self.field_path);
        match string_value {
            Some(s) => WildMatch::new(&self.pattern).matches(s),
            None => false,
        }
    }
}

/// Resolve a dot-separated field path through a JSON object tree.
///
/// Returns `Some(&str)` only when the final node is a JSON string.
/// Returns `None` for any absent key, non-object intermediate node, or
/// non-string final value.
fn resolve_field_path<'a>(root: &'a Value, field_path: &str) -> Option<&'a str> {
    let mut current = root;
    for key in field_path.split('.') {
        match current {
            Value::Object(map) => {
                current = map.get(key)?;
            }
            _ => return None,
        }
    }
    current.as_str()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    // ── AC-1: exact and literal match ────────────────────────────────────────

    #[test]
    fn matches_returns_true_when_string_value_equals_literal_pattern() {
        let matcher = ArgMatcher {
            field_path: "command".to_string(),
            pattern: "ls".to_string(),
        };
        let args = json!({ "command": "ls" });

        assert!(matcher.matches(&args));
    }

    // ── AC-2: glob wildcards ─────────────────────────────────────────────────

    #[test]
    fn matches_returns_true_when_star_wildcard_matches_any_run_of_characters() {
        let matcher = ArgMatcher {
            field_path: "command".to_string(),
            pattern: "ls*".to_string(),
        };

        assert!(matcher.matches(&json!({ "command": "ls" })));
        assert!(matcher.matches(&json!({ "command": "ls -la" })));
        assert!(matcher.matches(&json!({ "command": "ls --color=always /tmp" })));
    }

    #[test]
    fn matches_returns_true_when_star_wildcard_matches_empty_string() {
        let matcher = ArgMatcher {
            field_path: "command".to_string(),
            pattern: "ls*".to_string(),
        };
        // "*" at the end matches an empty suffix, so "ls" should match.
        assert!(matcher.matches(&json!({ "command": "ls" })));
    }

    #[test]
    fn matches_returns_true_when_question_mark_matches_exactly_one_character() {
        let matcher = ArgMatcher {
            field_path: "command".to_string(),
            pattern: "l?".to_string(),
        };

        assert!(matcher.matches(&json!({ "command": "ls" })));
        assert!(matcher.matches(&json!({ "command": "ll" })));
    }

    #[test]
    fn matches_returns_false_when_question_mark_does_not_match_zero_characters() {
        let matcher = ArgMatcher {
            field_path: "command".to_string(),
            pattern: "l?".to_string(),
        };

        assert!(!matcher.matches(&json!({ "command": "l" })));
    }

    #[test]
    fn matches_returns_false_when_question_mark_does_not_match_two_characters() {
        let matcher = ArgMatcher {
            field_path: "command".to_string(),
            pattern: "l?".to_string(),
        };

        assert!(!matcher.matches(&json!({ "command": "lss" })));
    }

    #[test]
    fn matches_returns_false_when_literal_characters_do_not_match() {
        let matcher = ArgMatcher {
            field_path: "command".to_string(),
            pattern: "rm".to_string(),
        };

        assert!(!matcher.matches(&json!({ "command": "ls" })));
    }

    // ── AC-2: nested field path ──────────────────────────────────────────────

    #[test]
    fn matches_resolves_nested_dot_separated_field_path() {
        let matcher = ArgMatcher {
            field_path: "opts.force".to_string(),
            pattern: "true".to_string(),
        };
        let args = json!({ "opts": { "force": "true" } });

        assert!(matcher.matches(&args));
    }

    #[test]
    fn matches_resolves_deeply_nested_field_path() {
        let matcher = ArgMatcher {
            field_path: "a.b.c".to_string(),
            pattern: "value".to_string(),
        };
        let args = json!({ "a": { "b": { "c": "value" } } });

        assert!(matcher.matches(&args));
    }

    // ── AC-3: failure cases ──────────────────────────────────────────────────

    #[test]
    fn matches_returns_false_when_field_path_is_absent() {
        let matcher = ArgMatcher {
            field_path: "missing".to_string(),
            pattern: "*".to_string(),
        };
        let args = json!({ "command": "ls" });

        assert!(!matcher.matches(&args));
    }

    #[test]
    fn matches_returns_false_when_intermediate_path_segment_is_absent() {
        let matcher = ArgMatcher {
            field_path: "opts.force".to_string(),
            pattern: "*".to_string(),
        };
        // "opts" key is absent entirely.
        let args = json!({ "command": "ls" });

        assert!(!matcher.matches(&args));
    }

    #[test]
    fn matches_returns_false_when_intermediate_node_is_not_an_object() {
        let matcher = ArgMatcher {
            field_path: "opts.force".to_string(),
            pattern: "*".to_string(),
        };
        // "opts" is a string, not an object — traversal cannot continue.
        let args = json!({ "opts": "some-string" });

        assert!(!matcher.matches(&args));
    }

    #[test]
    fn matches_returns_false_when_intermediate_node_is_an_array() {
        let matcher = ArgMatcher {
            field_path: "opts.force".to_string(),
            pattern: "*".to_string(),
        };
        let args = json!({ "opts": [1, 2, 3] });

        assert!(!matcher.matches(&args));
    }

    #[test]
    fn matches_returns_false_when_value_at_path_is_a_number() {
        let matcher = ArgMatcher {
            field_path: "count".to_string(),
            pattern: "*".to_string(),
        };
        let args = json!({ "count": 42 });

        assert!(!matcher.matches(&args));
    }

    #[test]
    fn matches_returns_false_when_value_at_path_is_a_boolean() {
        let matcher = ArgMatcher {
            field_path: "flag".to_string(),
            pattern: "*".to_string(),
        };
        let args = json!({ "flag": true });

        assert!(!matcher.matches(&args));
    }

    #[test]
    fn matches_returns_false_when_value_at_path_is_null() {
        let matcher = ArgMatcher {
            field_path: "field".to_string(),
            pattern: "*".to_string(),
        };
        let args = json!({ "field": null });

        assert!(!matcher.matches(&args));
    }

    #[test]
    fn matches_returns_false_when_value_at_path_is_an_object() {
        let matcher = ArgMatcher {
            field_path: "nested".to_string(),
            pattern: "*".to_string(),
        };
        let args = json!({ "nested": { "key": "val" } });

        assert!(!matcher.matches(&args));
    }

    #[test]
    fn matches_returns_false_when_arguments_root_is_not_an_object() {
        let matcher = ArgMatcher {
            field_path: "command".to_string(),
            pattern: "*".to_string(),
        };

        assert!(!matcher.matches(&json!("not-an-object")));
        assert!(!matcher.matches(&json!(42)));
        assert!(!matcher.matches(&json!(null)));
    }
}

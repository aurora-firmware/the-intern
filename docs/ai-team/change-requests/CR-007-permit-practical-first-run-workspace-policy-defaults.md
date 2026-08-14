---
id: CR-007
title: permit practical first-run workspace policy defaults
status: completed
created: '2026-08-12'
---

# permit practical first-run workspace policy defaults

## Desired Changes

Amend the policy guidance used by the proposed `bob init <path>` workflow so
that its generated first-run configuration is deliberately permissive and lets
an operator begin using bob without iterative authorization-rule edits.

The generated configuration MUST allow the standard pi tools used by the
shipped skills — `bash`, `read`, `write`, and `edit` — with no argument
matchers. Under the existing policy semantics, each such rule permits every
invocation of that named tool. The generated configuration MUST NOT grant an
unnamed or wildcard tool rule, change default-deny behaviour for tools not in
that four-tool set, disable the extension authorization hook, or alter socket
or filesystem permission boundaries.

S-012's redraft must call this a first-run permissive policy profile, print a
clear warning that it permits those tools for any arguments available to the
process, and direct the operator to review and narrow the generated
`config.toml` after confirming the installation works. It must not present
the profile as a sandbox or as a least-privilege configuration.

## Context

S-012's original workspace-scoped action rules were intended to avoid path
mismatches, but they depended on deploying skills per workspace, a model
superseded by S-011 and ADR-014. Its replacement must still meet the
operator's one-command goal: a newly installed bob should be immediately able
to read skill-local configuration and references, maintain a workspace
worklog, and execute the shipped email workflow without the operator first
discovering every exact pi tool-call argument shape.

The current engine already defines a rule with no `arg_matchers` as allowing
all arguments for its named tool. S-011 also records the accepted risk that
always-active worklog writes require broad coverage across arbitrary working
directories. This request makes that practical, explicit policy choice for
the initial `bob init` configuration rather than leaving an undefined
"generic baseline" to implementation.

## Potential Impact

The generated bootstrap profile gives any supervised session authorization to
run arbitrary shell commands and read, write, or edit paths that the service
process can access. This is intentional for first-run usability but is a
materially broader authority than narrowly matched rules; it must be
documented prominently and never be described as protection against a
compromised prompt, working directory, or skill-install path.

The policy engine and its allow-only, default-deny semantics do not need a new
matching feature. Existing operator configurations are unchanged. S-012's
implementation will need tests that assert exactly the four explicit
unmatched tool rules are generated, an unsupported tool remains denied, and
the warning/review guidance is displayed.

## Possible Spec Amendments

- S-004: add an amendment clarifying that a documented bootstrap profile may
  intentionally use no-matcher rules for a fixed, explicit set of standard pi
  tools, while retaining allow-only/default-deny for every other tool.
- S-010: amend its action-rule constraint to permit the explicitly documented
  `bob init` bootstrap exception: a generated four-tool no-matcher profile is
  allowed for first-run usability, is warned as broad authority, and is not
  the normal least-privilege recommendation. Its existing narrow-rule
  expectation remains authoritative outside that profile.
- S-012: redraft its config-generation and policy requirements around the
  shared S-011 install-path model and this permissive first-run profile.
- S-011: amend its action-rule constraints to record the same bootstrap
  exception. Normal operator configuration continues to scope skill-reference
  reads to the shared install path and needs broad arbitrary-directory
  coverage only for worklogs; the `bob init` profile intentionally permits
  all arguments for the four named tools until an operator narrows it.

## Outcome

Approved and applied by the human on 2026-08-12. S-004, S-010, and S-011 now
record the fixed four-tool bootstrap exception; draft S-012 was redrafted to
generate that profile while retaining shared S-011 skill installation.

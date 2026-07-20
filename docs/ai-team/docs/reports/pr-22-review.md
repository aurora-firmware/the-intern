# PR Review: aurora-firmware/the-intern#22 — docs(architecture): record control plane, trust model, and v1 ingress

## Summary

The follow-up commit addresses the prior architecture review findings by adding
ADR-007/ADR-008, amending the committed scope, correcting the trust and identity
models, and tracking the extension-socket implementation drift. Three additional
documentation issues remain: two stale artifact groups contradict the new
decisions, and B-009 understates the cross-UID exposure it documents.

| Scope | Files | Lines changed | Tier | Findings |
|---|---:|---:|---|---:|
| Documentation | 9 | 651 | full, repository-wide context | 2 |
| Security | 3 flagged files | 396 | full, repository-wide context | 1 |

## Findings

### Documentation

#### [warning] Approved specs still describe SO_PEERCRED as an admission gate — `project/decisions/ADR-007-local-control-plane-over-a-single-json-rpc-unix-domain-socket.md:64`

ADR-007 correctly records `SO_PEERCRED` as audit-only, but the approved specs
that define these surfaces still contradict it. S-002 says Admin-RPC enforces
filesystem permissions plus `SO_PEERCRED`, closes connections that fail the
peer check, and requires peer-gate denial tests; S-005 likewise says
`report.submit` relies on and is enforced by a peer-credential gate. Because
this PR is reconciling the architecture/spec artifact set and already edits
S-002, update those stale gate descriptions to match ADR-005/ADR-007.

#### [warning] User-facing channel docs still promise webhooks after the committed scope removes them — `project/decisions/ADR-008-single-user-local-deployment-scope.md:61`

ADR-008 and the amended S-001/roadmap now define the committed channels as chat,
scheduler, and email-by-polling, but `README.md` and the rendered documentation
still call webhook an upcoming Phase 6 adapter. In particular,
`the-intern/docs/src/operator-guide/index.md` and
`the-intern/docs/src/architecture-overview/index.md` say webhook is planned and
will receive its own specification. Update those pages in this PR so readers do
not receive the superseded roadmap.

### Security

#### [warning] B-009 incorrectly assumes every local process runs as the service UID — `project/bugs/open/B-009-production-extension-sock-bind-omits-the-documented-0700-0660-permission-gate.md:23`

ADR-008 scopes whom bob serves; it does not guarantee that the machine has no
other local accounts or service processes. Those other UIDs are precisely what
the missing `0700` parent-directory gate is intended to exclude. Remove the
claim that practical risk is low because all processes present run as the same
UID, and describe the actual conditional exposure: another local UID can connect
if the existing parent/socket modes permit it.

## Skipped files

None.

## Review notes

- Reviewed the updated head `f8d277424b20342095a5ce39bad308c6a115cbc3`
  against the full architecture/spec/ADR set and relevant implementation.
- The seven findings from the previous architecture-wide review are addressed.
- No existing inline review comments were present.
- All GitHub checks passed: Build, Documentation, Format, Tests, and User
  Documentation.

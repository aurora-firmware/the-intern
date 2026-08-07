---
id: CR-006
title: Email-triage skill content corrections and missing-configuration escalation
status: pending
created: '2026-08-06'
---

# Email-triage skill content corrections and missing-configuration escalation

> **Scope reduced (2026-08-06).** This change request originally also proposed
> bob-side skill loading, an always-active skill set, the worklog skill split,
> and vendor-neutral packaging. An Architecture Consistency Review found those
> to be a new capability contradicting four approved specs rather than a scope
> amendment to `S-010`, and they were routed to a new specification with a
> supporting ADR. What remains here is the `S-010` content and behaviour
> amendment driven by the PR #42 review.

## Desired Changes

### 1. Remove every ai-team artifact identifier from skill content

Skill consumers have no access to this project's specifications, decision
records, tasks, or bugs, so skill text must not reference them. 91 such
references exist across the package, 49 of them inside skill files.

The action-gate specification identifier alone appears 32 times and is
behaviourally load-bearing — the rules governing what the skill does when a
tool call is denied depend on it. These are therefore rewrites into
behavioural language ("denied by the action-authorization gate"), not
deletions. The behaviour must survive intact: a denied call is recorded and
never worked around.

The package README is exempt. It is maintainer and operator documentation
recording validation provenance, not skill content the agent consumes.

### 2. Remove the specification identifier from the configuration template

Same rationale as item 1, applied to the shipped skill-local configuration
template.

### 3. Remove the "Adding a category" section

The category taxonomy index currently presents adding a category as a
supported extension point. Skill content ships with the-intern's releases, so
a user's local edits would be overwritten on upgrade. Inviting them is
misleading. Categories change through releases only.

### 4. Remove the repository-packaging paragraph from the escalation reference

The escalation reference currently explains which configuration file is
committed versus templated and where the real file lives. This is repository
packaging detail that the consuming agent cannot act on, and it belongs in the
package README.

### 5. Escalation must survive a missing skill-local configuration

When the skill-local configuration file holding the manager escalation address
is missing, or its address is absent or malformed, the run must still escalate
rather than hard-stopping the message. The escalation is sent to the mail
account's own address, so it surfaces in the mailbox the human already reads.

The escalation email must additionally state that the configuration file was
missing and the directory where it was expected.

No diary requirement is stated for this case in either skill: the worklog
skill's general journaling discipline already records it.

This replaces the current behaviour, which treats a missing or malformed
address as a hard stop for every message needing escalation in that run.

**How the account's own address is obtained.** Verified against himalaya
v1.2.0: `template write`, invoked with no arguments, emits a draft whose first
line is a `From:` header carrying the account's display name and configured
email address. The address is parsed from that line. This uses a command the
skill already invokes, so it needs no new allow-rule family, no configuration
key, and no read of himalaya's own configuration file.

Two routes were checked and rejected: `account list` reports only account name,
backend, and default flag — in both table and JSON output — and `account
doctor` reports integrity checks without the address.

**If the address cannot be determined**, record it in the worklog and take no
further action on that message this run. Do not hard-stop the run, do not
guess an address, and do not fall back to acting on the message autonomously.
The worklog entry is the record; the operator discovers it there. This
deliberately accepts that an escalation may go nowhere rather than adding a
recovery mechanism for a case that should not occur once an account is
configured.

### 6. Self-escalation must not loop

An escalation addressed to the account's own address arrives back in the same
mailbox as unseen mail and re-enters triage on a later run. If it does not
classify confidently it escalates again, to itself, indefinitely.

The taxonomy needs a terminal category that recognises the skill's own
escalation mail, files it, and never re-escalates it.

### 7. Remove the maintainer's real email address from shipped skill content

The `himalaya` skill's command reference contains a maintainer's real personal
email address in two command transcripts. One predates T-142; the second was
added by it, which copied the existing pattern rather than sanitising it.

Replace both with a clearly non-routable example address, consistent with the
rule the shipped configuration template already states — that examples must
never carry a real address. This matters more once the package is published to
vendor marketplaces (S-011), where the transcripts ship to consumers.

This item was not raised in the PR #42 review. It was found while verifying
T-142 and is grouped here because it is the same class of problem as item 1:
content that must not ship to a skill consumer.

## Context

Five inline review comments on PR #42 identified content that must not ship to
a skill consumer, a section inviting user edits that upgrades would overwrite,
and a failure path that hard-stops where it should degrade.

Items 1 through 4 are content corrections requested directly in that review.
Item 5 is the review's substantive behavioural request. The review asked that a
missing configuration still escalate "to the configured address", which read
literally is impossible — the address lives in the file that is missing. The
resolution is the mail account's own address, which himalaya already knows from
the account configuration and which requires no new configuration key.

Item 6 was not raised in the review. It is a consequence of item 5 that would
otherwise produce an escalation loop in a live mailbox.

## Potential Impact

**Affected artifacts:**

- `S-010` — amended; see "Possible Spec Amendments".
- The email-triage skill content, its escalation and taxonomy references, and
  the shipped configuration template.

**Risks and migration considerations:**

- **The identifier rewrite is the largest risk in this request.** 32 mentions
  of the action-gate identifier carry behavioural rules about denied tool
  calls. A careless find-and-replace could drop the rule that a denied call is
  never worked around, which is the single most safety-relevant behaviour in
  the package. Task work must verify the behaviour survives, not just that the
  identifiers are gone.
- **Live re-validation is required for item 5.** The escalation path was
  validated live against a deployment where a missing address was a hard stop.
  The new degraded path has never run.
- **Item 6 is unvalidated by construction.** The loop it prevents can only be
  observed in a live mailbox over multiple scheduled runs.
- **A previously known gap is not closed here.** The package README records
  that the direct-request and meeting-scheduling reply shapes are statically
  verified but not live-validated. This request does not address that.

## Possible Spec Amendments

> **Architecture Consistency Review (2026-08-06):** the binding set — 13
> accepted ADRs and 9 approved specs — was checked against this request's
> original, wider scope. The findings that applied to bob-side skill loading,
> the always-active skill set, the worklog split, and packaging were routed to
> a new specification and a supporting ADR. The findings below are the ones
> that remain within this request.

`S-010` requires amendment in these places:

- **Component 3 — category extensibility.** The spec presents adding a category
  as a supported extension point, with the taxonomy index and a workflow file
  as the two additions required. Item 3 removes that extension point;
  categories change through releases.
- **Escalation behaviour on missing or malformed configuration.** Currently
  specified as a hard stop for every message needing escalation in that run;
  item 5 replaces it with a degraded escalation to the account's own address.
- **The category taxonomy** gains a terminal category for the skill's own
  escalation mail (item 6).

No other approved spec or accepted ADR is contradicted by this reduced scope.
`ADR-008` §5 was checked specifically: its provision that actions use the
user's own existing credential stores is *upheld* by item 5, since the
account's own address comes from the operator's existing himalaya account
configuration rather than from bob.

### Corrections routed

| Artifact | Owner | Action |
|---|---|---|
| `S-010` | Planner | Approved-spec amendment — the three sections above, with an Amendment Log entry |

### Split out of this request

The following moved to a new specification and supporting ADR, and are **not**
in scope here: bob supplying skills by path independently of the working
directory; one always-active skill set across every session bob spawns; the
worklog extracted as a separate generic skill; the vendor-neutral package
restructure and multi-vendor packaging; and the pi-agent version revalidation
those depend on.

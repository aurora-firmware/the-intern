# Manager Escalation

## Configuration

The escalation address is skill-local configuration, not bob's TOML config
(S-010 Configuration Requirements; ADR-008 §5 — actions use their own
configuration), read from:

```
<workspace>/config/email-triage.toml
```

`<workspace>` is the job's own working directory (the scheduled entry's
per-entry `--cwd`) — the same directory the daily worklog lives in.

This file requires exactly one key:

```toml
manager_address = "someone@example.com"
```

- `manager_address` (required) — a single well-formed email address that
  receives every escalation this skill sends.

This repository ships only the documented template,
`config/email-triage.example.toml`, with no real address filled in. The real
`config/email-triage.toml` exists only in the owner-only deployed workspace
copy of this package (`../../../../README.md`'s "This package is the
repository source of truth only") — it is never committed, and provisioning
the real address is out of scope for this reference (S-010 Exclusions).

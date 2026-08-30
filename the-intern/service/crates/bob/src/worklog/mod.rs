//! The worklog subsystem: the on-disk daily worklog format and its
//! cwd-strict location resolution.
//!
//! Per ADR-015 the worklog resolves strictly to `<cwd>/worklog/<date>.md`
//! relative to a caller-supplied working directory — no upward search and
//! no override. This is a deliberate divergence from `task_board`'s
//! upward-searching board resolver.

pub mod reconcile;
pub mod store;

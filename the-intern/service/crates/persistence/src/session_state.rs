#![forbid(unsafe_code)]

//! In-memory session state store backed by a `HashMap`.
//!
//! `put_session_state` overwrites any existing entry for the given `SessionId`.
//! `get_session_state` returns `Some(state)` when present or `None` when absent.

use std::collections::HashMap;

use bob_core::ports::SessionState;
use bob_core::types::SessionId;

/// In-memory store mapping `SessionId` to `SessionState`.
pub(crate) struct SessionStateStore {
    map: HashMap<SessionId, SessionState>,
}

impl SessionStateStore {
    /// Creates an empty store.
    pub(crate) fn new() -> Self {
        Self {
            map: HashMap::new(),
        }
    }

    /// Inserts or overwrites `state` for `id`.
    pub(crate) fn put(&mut self, id: SessionId, state: SessionState) {
        self.map.insert(id, state);
    }

    /// Returns a clone of the state for `id`, or `None` when absent.
    pub(crate) fn get(&self, id: SessionId) -> Option<SessionState> {
        self.map.get(&id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(data: &str) -> SessionState {
        SessionState {
            data: data.to_owned(),
        }
    }

    // AC-4: put then get returns equal value
    #[test]
    fn get_returns_state_after_put() {
        let mut store = SessionStateStore::new();
        let id = SessionId::new();
        store.put(id, state("{}"));
        assert_eq!(store.get(id), Some(state("{}")));
    }

    #[test]
    fn get_returns_none_when_id_not_stored() {
        let store = SessionStateStore::new();
        let id = SessionId::new();
        assert_eq!(store.get(id), None);
    }

    #[test]
    fn put_overwrites_existing_entry_for_same_id() {
        let mut store = SessionStateStore::new();
        let id = SessionId::new();
        store.put(id, state("first"));
        store.put(id, state("second"));
        assert_eq!(store.get(id), Some(state("second")));
    }

    #[test]
    fn get_returns_none_for_different_id() {
        let mut store = SessionStateStore::new();
        let id_a = SessionId::new();
        let id_b = SessionId::new();
        store.put(id_a, state("for_a"));
        assert_eq!(store.get(id_b), None);
    }

    #[test]
    fn put_multiple_ids_all_retrievable() {
        let mut store = SessionStateStore::new();
        let id_a = SessionId::new();
        let id_b = SessionId::new();
        store.put(id_a, state("a"));
        store.put(id_b, state("b"));
        assert_eq!(store.get(id_a), Some(state("a")));
        assert_eq!(store.get(id_b), Some(state("b")));
    }
}

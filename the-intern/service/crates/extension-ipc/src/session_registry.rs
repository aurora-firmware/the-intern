//! Cross-connection bookkeeping for which live connection currently "owns"
//! each session id.
//!
//! `run_connection` (see `lib.rs`) builds a private, connection-local
//! `SessionMultiplexer` per accepted socket. Nothing observes a *second*
//! connection registering the same `SessionId` while the first is still
//! live — that gap is B-018: an older extension instance, loaded a second
//! time by pi's own `packages` list, opens its own connection under the
//! same session id and silently coexists with the current instance, with no
//! attributable signal anywhere. `SessionRegistry` is a small, listener-level
//! registry, shared across every connection accepted by one `run_listener`,
//! that detects this collision without changing the per-connection
//! routing/back-pressure model documented on `run_connection`.

use std::collections::HashMap;
use std::sync::Mutex;

use bob_core::types::SessionId;

/// Outcome of registering a session id for a given connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistrationOutcome {
    /// No other live connection currently owns this session id.
    Registered,
    /// A different, still-live connection already owns this session id.
    Duplicate { existing_connection_id: u64 },
}

/// Tracks which connection id currently owns each live `SessionId`.
#[derive(Default)]
pub struct SessionRegistry {
    owners: Mutex<HashMap<SessionId, u64>>,
}

impl SessionRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `connection_id` as the owner of `session` unless a
    /// different connection already owns it. Re-registering the same
    /// `(session, connection_id)` pair is always `Registered`, so a
    /// connection may safely call this once per session id it observes.
    ///
    /// # Panics
    ///
    /// Panics if the internal registry lock is poisoned by another thread
    /// having panicked while holding it.
    pub fn register(&self, session: SessionId, connection_id: u64) -> RegistrationOutcome {
        let mut owners = self.owners.lock().expect("session registry lock poisoned");
        match owners.get(&session) {
            Some(existing) if *existing != connection_id => RegistrationOutcome::Duplicate {
                existing_connection_id: *existing,
            },
            _ => {
                owners.insert(session, connection_id);
                RegistrationOutcome::Registered
            }
        }
    }

    /// Releases `connection_id`'s ownership of `session`, if it is still the
    /// owner. A no-op for a connection that never owned the session (for
    /// example, one that only ever observed a `Duplicate` outcome for it).
    ///
    /// # Panics
    ///
    /// Panics if the internal registry lock is poisoned by another thread
    /// having panicked while holding it.
    pub fn release(&self, session: SessionId, connection_id: u64) {
        let mut owners = self.owners.lock().expect("session registry lock poisoned");
        if owners.get(&session) == Some(&connection_id) {
            owners.remove(&session);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_connection_to_register_a_session_id_is_registered() {
        let registry = SessionRegistry::new();
        let session = SessionId::new();

        let outcome = registry.register(session, 1);

        assert_eq!(outcome, RegistrationOutcome::Registered);
    }

    #[test]
    fn second_connection_registering_a_live_session_id_is_reported_as_duplicate() {
        let registry = SessionRegistry::new();
        let session = SessionId::new();

        registry.register(session, 1);
        let outcome = registry.register(session, 2);

        assert_eq!(
            outcome,
            RegistrationOutcome::Duplicate {
                existing_connection_id: 1
            }
        );
    }

    #[test]
    fn same_connection_re_registering_its_own_session_id_is_not_a_duplicate() {
        let registry = SessionRegistry::new();
        let session = SessionId::new();

        registry.register(session, 1);
        let outcome = registry.register(session, 1);

        assert_eq!(outcome, RegistrationOutcome::Registered);
    }

    #[test]
    fn release_only_removes_the_entry_owned_by_the_matching_connection() {
        let registry = SessionRegistry::new();
        let session = SessionId::new();

        registry.register(session, 1);

        // A non-owning connection releasing the session id must not evict
        // the real owner.
        registry.release(session, 2);
        assert_eq!(
            registry.register(session, 2),
            RegistrationOutcome::Duplicate {
                existing_connection_id: 1
            }
        );

        // The real owner releasing frees the session id for reuse.
        registry.release(session, 1);
        assert_eq!(
            registry.register(session, 2),
            RegistrationOutcome::Registered
        );
    }
}

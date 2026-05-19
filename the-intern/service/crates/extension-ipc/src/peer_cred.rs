//! Peer-credential types and helpers for the extension IPC channel.
//!
//! Re-exports the canonical [`bob_core::auth`] items so that callers within
//! this crate continue to import from `crate::peer_cred` without change.

pub use bob_core::auth::{is_allowed, peer_cred_from_fd, PeerCred};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_allowed_returns_true_when_peer_uid_equals_service_uid() {
        assert!(is_allowed(1000, &[], 1000));
    }

    #[test]
    fn is_allowed_returns_true_when_peer_uid_is_in_allowed_uids() {
        assert!(is_allowed(500, &[100, 500, 900], 1000));
    }

    #[test]
    fn is_allowed_returns_false_when_peer_uid_not_in_allowed_set() {
        assert!(!is_allowed(999, &[100, 200], 1000));
    }

    #[test]
    fn is_allowed_returns_false_with_empty_allowed_uids_and_different_service_uid() {
        assert!(!is_allowed(0, &[], 1000));
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn peer_cred_from_fd_returns_current_process_uid_on_real_socket() {
        use std::os::unix::net::UnixListener;
        use tempfile::tempdir;

        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("test.sock");

        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(e) => panic!("bind failed: {e}"),
        };
        let client = std::os::unix::net::UnixStream::connect(&path).expect("connect");
        let (server_side, _addr) = listener.accept().expect("accept");

        let cred = peer_cred_from_fd(&server_side).expect("peer cred");
        let expected_uid = nix::unistd::Uid::current().as_raw();
        assert_eq!(cred.uid, expected_uid);

        let client_cred = peer_cred_from_fd(&client).expect("client peer cred");
        assert_eq!(client_cred.uid, expected_uid);
    }
}

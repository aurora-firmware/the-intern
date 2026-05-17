//! Peer-credential extraction from Unix domain sockets.
//!
//! Platform-specific code is gated behind `#[cfg(target_os = "linux")]` and
//! `#[cfg(target_os = "macos")]` as required by S-002 §Component 4.

use std::os::fd::AsFd;

/// Peer credentials extracted from a connected Unix domain socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCred {
    /// Effective user id of the connecting process.
    pub uid: u32,
}

/// Returns `true` when `peer_uid` is permitted to use the admin RPC channel.
///
/// A uid is allowed when it equals `service_uid` (the process owner of the
/// running service) or when it appears in `allowed_uids`.
pub fn is_allowed(peer_uid: u32, allowed_uids: &[u32], service_uid: u32) -> bool {
    peer_uid == service_uid || allowed_uids.contains(&peer_uid)
}

/// Reads peer credentials from a connected Unix domain socket file descriptor.
///
/// # Errors
///
/// Returns an `std::io::Error` when the syscall fails or when the platform is
/// not supported.
#[cfg(target_os = "linux")]
pub fn peer_cred_from_fd<F: AsFd>(fd: &F) -> std::io::Result<PeerCred> {
    use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
    let raw = getsockopt(fd, PeerCredentials)
        .map_err(|e| std::io::Error::from_raw_os_error(e as i32))?;
    Ok(PeerCred {
        uid: raw.uid(),
    })
}

/// Reads peer credentials from a connected Unix domain socket file descriptor.
///
/// # Errors
///
/// Returns an `std::io::Error` when the syscall fails or when the platform is
/// not supported.
#[cfg(target_os = "macos")]
pub fn peer_cred_from_fd<F: AsFd>(fd: &F) -> std::io::Result<PeerCred> {
    use nix::sys::socket::{getsockopt, sockopt::LocalPeerCred};
    let raw = getsockopt(fd, LocalPeerCred)
        .map_err(|e| std::io::Error::from_raw_os_error(e as i32))?;
    Ok(PeerCred {
        uid: raw.uid(),
    })
}

/// Fallback for platforms other than Linux and macOS.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn peer_cred_from_fd<F: AsFd>(_fd: &F) -> std::io::Result<PeerCred> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "peer credentials are not supported on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // AC-2 / AC-3 policy logic: service uid is always allowed
    #[test]
    fn is_allowed_returns_true_when_peer_uid_equals_service_uid() {
        assert!(is_allowed(1000, &[], 1000));
    }

    // AC-2: uid in allowed_uids list is permitted
    #[test]
    fn is_allowed_returns_true_when_peer_uid_is_in_allowed_uids() {
        assert!(is_allowed(500, &[100, 500, 900], 1000));
    }

    // AC-3: uid not in list and not service uid is rejected
    #[test]
    fn is_allowed_returns_false_when_peer_uid_not_in_allowed_set() {
        assert!(!is_allowed(999, &[100, 200], 1000));
    }

    // AC-3: empty allowed_uids with different service uid rejects peer
    #[test]
    fn is_allowed_returns_false_with_empty_allowed_uids_and_different_service_uid() {
        assert!(!is_allowed(0, &[], 1000));
    }

    // AC-2: peer_cred_from_fd returns the current process uid on a real socket
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn peer_cred_from_fd_returns_current_process_uid_on_real_socket() {
        use std::os::unix::net::UnixListener;
        use tempfile::tempdir;

        let dir = tempdir().expect("temp dir");
        let path = dir.path().join("test.sock");

        // Bind a listener, connect to it, and accept — the accepted stream's
        // peer is the client (same process), whose uid is the current uid.
        let listener = UnixListener::bind(&path).expect("bind");
        let client = std::os::unix::net::UnixStream::connect(&path).expect("connect");
        let (server_side, _addr) = listener.accept().expect("accept");

        let cred = peer_cred_from_fd(&server_side).expect("peer cred");
        let expected_uid = nix::unistd::Uid::current().as_raw();
        assert_eq!(cred.uid, expected_uid);

        // Verify the client side also works
        let client_cred = peer_cred_from_fd(&client).expect("client peer cred");
        assert_eq!(client_cred.uid, expected_uid);
    }
}

//! Peer-credential extraction from Unix domain sockets.
//!
//! Provides a single canonical [`PeerCred`] type shared across all IPC channels.
//! Platform-specific code is gated behind `#[cfg(target_os = "linux")]` and
//! `#[cfg(target_os = "macos")]`.

use std::os::fd::AsFd;

/// Peer credentials extracted from a connected Unix domain socket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCred {
    /// Effective user id of the connecting process.
    pub uid: u32,
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
    let raw =
        getsockopt(fd, PeerCredentials).map_err(|e| std::io::Error::from_raw_os_error(e as i32))?;
    Ok(PeerCred { uid: raw.uid() })
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
    let raw =
        getsockopt(fd, LocalPeerCred).map_err(|e| std::io::Error::from_raw_os_error(e as i32))?;
    Ok(PeerCred { uid: raw.uid() })
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
    use super::PeerCred;

    // AC-1 / behavioural: PeerCred constructs with a uid field.
    #[test]
    fn peer_cred_constructs_with_uid() {
        let cred = PeerCred { uid: 1000 };
        assert_eq!(cred.uid, 1000);
    }

    // PeerCred must be copyable — callers store it by value.
    #[test]
    fn peer_cred_is_copy() {
        let cred = PeerCred { uid: 42 };
        let copy = cred;
        // If Copy is not derived this will fail to compile.
        assert_eq!(cred.uid, copy.uid);
    }

    // PeerCred must support equality comparison.
    #[test]
    fn peer_cred_equality_holds() {
        assert_eq!(PeerCred { uid: 7 }, PeerCred { uid: 7 });
        assert_ne!(PeerCred { uid: 1 }, PeerCred { uid: 2 });
    }

    // peer_cred_from_fd returns the current process uid on a real socket pair.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn peer_cred_from_fd_returns_current_process_uid_on_real_socket() {
        use super::peer_cred_from_fd;
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

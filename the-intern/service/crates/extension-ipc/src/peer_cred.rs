use std::os::fd::AsFd;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCred {
    pub uid: u32,
}

pub fn is_allowed(peer_uid: u32, allowed_uids: &[u32], service_uid: u32) -> bool {
    peer_uid == service_uid || allowed_uids.contains(&peer_uid)
}

#[cfg(target_os = "linux")]
pub fn peer_cred_from_fd<F: AsFd>(fd: &F) -> std::io::Result<PeerCred> {
    use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
    let raw =
        getsockopt(fd, PeerCredentials).map_err(|e| std::io::Error::from_raw_os_error(e as i32))?;
    Ok(PeerCred { uid: raw.uid() })
}

#[cfg(target_os = "macos")]
pub fn peer_cred_from_fd<F: AsFd>(fd: &F) -> std::io::Result<PeerCred> {
    use nix::sys::socket::{getsockopt, sockopt::LocalPeerCred};
    let raw =
        getsockopt(fd, LocalPeerCred).map_err(|e| std::io::Error::from_raw_os_error(e as i32))?;
    Ok(PeerCred { uid: raw.uid() })
}

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

        let listener = UnixListener::bind(&path).expect("bind");
        let client = std::os::unix::net::UnixStream::connect(&path).expect("connect");
        let (server_side, _addr) = listener.accept().expect("accept");

        let cred = peer_cred_from_fd(&server_side).expect("peer cred");
        let expected_uid = nix::unistd::Uid::current().as_raw();
        assert_eq!(cred.uid, expected_uid);

        let client_cred = peer_cred_from_fd(&client).expect("client peer cred");
        assert_eq!(client_cred.uid, expected_uid);
    }
}

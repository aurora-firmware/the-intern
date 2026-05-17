//! Unix domain socket listener for the admin RPC channel.
//!
//! Implements AC-1 through AC-4 from T-018:
//!
//! - Creates the socket's parent directory with mode 0700 if absent.
//! - Unlinks any stale socket file at the configured path (AC-4).
//! - Binds a `UnixListener` and chmods the socket file to 0660 (AC-1).
//! - Accepts connections and gates each one with a peer-credential check
//!   (AC-2/AC-3).

use std::{os::unix::fs::PermissionsExt, path::PathBuf};

use tokio::net::{UnixListener, UnixStream};

use crate::peer_cred::{is_allowed, peer_cred_from_fd};

/// Configuration passed to [`Listener::bind`].
#[derive(Debug, Clone)]
pub struct ListenerConfig {
    /// Filesystem path where the UDS socket file will be created.
    pub admin_sock_path: PathBuf,
    /// Additional UIDs that may connect to the admin socket, beyond the
    /// service's own UID.
    pub admin_allowed_uids: Vec<u32>,
    /// UID of the running service process.  Connections from this UID are
    /// always accepted.
    pub service_uid: u32,
}

/// A bound Unix domain socket listener for the admin RPC channel.
///
/// Created via [`Listener::bind`].  Accepts connections and gates each one
/// with a peer-credential check before handing the stream to the caller.
#[derive(Debug)]
pub struct Listener {
    inner: UnixListener,
    config: ListenerConfig,
}

impl Listener {
    /// Binds the admin Unix domain socket described by `cfg`.
    ///
    /// Steps performed:
    ///
    /// 1. Creates the socket's parent directory with mode 0700 (idempotent).
    /// 2. Unlinks any stale socket file at `cfg.admin_sock_path` (AC-4).
    /// 3. Binds a `UnixListener` at `cfg.admin_sock_path`.
    /// 4. Chmods the socket file to 0660 (AC-1).
    ///
    /// # Errors
    ///
    /// Returns an `std::io::Error` when directory creation, socket bind, or
    /// chmod fails.
    pub fn bind(cfg: ListenerConfig) -> std::io::Result<Self> {
        let sock_path = &cfg.admin_sock_path;

        // Step 1: create parent directory with mode 0700.
        if let Some(parent) = sock_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }

        // Step 2: unlink any stale socket file (AC-4).
        if sock_path.exists() {
            std::fs::remove_file(sock_path)?;
        }

        // Step 3: bind the listener.
        let listener = UnixListener::bind(sock_path)?;

        // Step 4: chmod the socket file to 0660 (AC-1).
        std::fs::set_permissions(sock_path, std::fs::Permissions::from_mode(0o660))?;

        tracing::info!(
            path = %sock_path.display(),
            "admin socket bound"
        );

        Ok(Self {
            inner: listener,
            config: cfg,
        })
    }

    /// Accepts the next incoming connection and performs the peer-credential
    /// gate.
    ///
    /// Returns `Ok(Some(stream))` when the peer is allowed, `Ok(None)` when
    /// the peer was rejected and the connection closed, or `Err` when
    /// `accept()` itself fails.
    ///
    /// AC-2: allowed peers get the stream back.
    /// AC-3: rejected peers trigger a `tracing::warn!` and the stream is
    /// dropped (closing the connection) before any application frame is
    /// exchanged.
    pub async fn accept(&self) -> std::io::Result<Option<UnixStream>> {
        let (stream, _addr) = self.inner.accept().await?;
        match peer_cred_from_fd(&stream) {
            Ok(cred) => {
                if is_allowed(
                    cred.uid,
                    &self.config.admin_allowed_uids,
                    self.config.service_uid,
                ) {
                    Ok(Some(stream))
                } else {
                    tracing::warn!(
                        rejected_uid = cred.uid,
                        "admin socket: rejected connection from unauthorized peer"
                    );
                    // Dropping `stream` closes the connection.
                    drop(stream);
                    Ok(None)
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "admin socket: could not read peer credentials; closing connection"
                );
                drop(stream);
                Ok(None)
            }
        }
    }

    /// Returns a reference to the bound [`UnixListener`].
    pub fn listener(&self) -> &UnixListener {
        &self.inner
    }

    /// Returns the configuration used to bind this listener.
    pub fn config(&self) -> &ListenerConfig {
        &self.config
    }
}

/// Applies the peer-credential gate to a stream that already has a known
/// `peer_uid`.  Used in tests to exercise the allow/reject path without
/// needing a real foreign-uid connection.
///
/// Returns `true` when the connection is accepted, `false` when rejected.
pub fn gate_peer(peer_uid: u32, cfg: &ListenerConfig) -> bool {
    is_allowed(peer_uid, &cfg.admin_allowed_uids, cfg.service_uid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_cfg(tmp: &tempfile::TempDir) -> ListenerConfig {
        ListenerConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            admin_allowed_uids: vec![],
            service_uid: nix::unistd::Uid::current().as_raw(),
        }
    }

    // AC-1: bind creates the socket file
    #[tokio::test(flavor = "current_thread")]
    async fn bind_creates_socket_file_at_configured_path() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);

        let _listener = Listener::bind(cfg.clone()).expect("bind");

        assert!(
            cfg.admin_sock_path.exists(),
            "socket file should exist after bind"
        );
    }

    // AC-1: parent directory is created with mode 0700
    #[tokio::test(flavor = "current_thread")]
    async fn bind_creates_parent_directory_with_mode_0700() {
        let tmp = tempdir().expect("temp dir");
        let sock_path = tmp.path().join("nested").join("dir").join("admin.sock");
        let cfg = ListenerConfig {
            admin_sock_path: sock_path.clone(),
            admin_allowed_uids: vec![],
            service_uid: nix::unistd::Uid::current().as_raw(),
        };

        let _listener = Listener::bind(cfg).expect("bind");

        let parent = sock_path.parent().expect("has parent");
        let meta = std::fs::metadata(parent).expect("metadata");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o700,
            "parent directory mode should be 0700, got {mode:o}"
        );
    }

    // AC-1: socket file has mode 0660
    #[tokio::test(flavor = "current_thread")]
    async fn bind_sets_socket_file_mode_to_0660() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);

        let _listener = Listener::bind(cfg.clone()).expect("bind");

        let meta = std::fs::metadata(&cfg.admin_sock_path).expect("metadata");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o660, "socket file mode should be 0660, got {mode:o}");
    }

    // AC-4: stale regular file at socket path is removed before binding
    #[tokio::test(flavor = "current_thread")]
    async fn bind_removes_stale_file_before_binding() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);

        // Write a regular file at the socket path to simulate a stale socket.
        std::fs::write(&cfg.admin_sock_path, b"stale").expect("write stale file");
        assert!(cfg.admin_sock_path.exists(), "stale file should exist");

        // Bind should succeed despite the pre-existing file.
        let result = Listener::bind(cfg.clone());
        assert!(
            result.is_ok(),
            "bind should succeed when stale file is present: {result:?}"
        );
        assert!(
            cfg.admin_sock_path.exists(),
            "socket file should exist after bind"
        );
    }

    // AC-2: accept returns Some(stream) for allowed peer uid (service uid)
    #[tokio::test(flavor = "current_thread")]
    async fn accept_returns_stream_for_allowed_peer_uid() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);
        // service_uid matches current process uid — connecting from this
        // process is always allowed.
        let listener = Listener::bind(cfg.clone()).expect("bind");

        // Connect from the same process; the peer uid will be our own uid.
        let _client = tokio::net::UnixStream::connect(&cfg.admin_sock_path)
            .await
            .expect("connect");

        let result = listener.accept().await.expect("accept");
        assert!(result.is_some(), "allowed peer should yield Some(stream)");
    }

    // AC-3: gate_peer returns false for uid not in allowed set
    #[test]
    fn gate_peer_rejects_uid_not_in_allowed_set() {
        let tmp = tempdir().expect("temp dir");
        let cfg = ListenerConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            admin_allowed_uids: vec![100, 200],
            service_uid: 1000,
        };
        // uid 999 is not 1000 and not in [100, 200]
        assert!(!gate_peer(999, &cfg));
    }

    // AC-2: gate_peer returns true for uid in allowed_uids
    #[test]
    fn gate_peer_accepts_uid_in_allowed_uids() {
        let tmp = tempdir().expect("temp dir");
        let cfg = ListenerConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            admin_allowed_uids: vec![100, 200],
            service_uid: 1000,
        };
        assert!(gate_peer(100, &cfg));
    }

    // AC-2: gate_peer returns true for service uid
    #[test]
    fn gate_peer_accepts_service_uid() {
        let tmp = tempdir().expect("temp dir");
        let cfg = ListenerConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            admin_allowed_uids: vec![],
            service_uid: 1000,
        };
        assert!(gate_peer(1000, &cfg));
    }
}

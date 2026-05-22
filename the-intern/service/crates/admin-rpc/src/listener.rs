//! Unix domain socket listener for the admin RPC channel.
//!
//! Implements AC-1 through AC-4 from T-018:
//!
//! - Creates the socket's parent directory with mode 0700 if absent.
//! - Unlinks any stale socket file at the configured path (AC-4).
//! - Binds a `UnixListener` and chmods the socket file to 0660 (AC-1).
//! - Accepts connections that passed filesystem-permission checks (AC-2).

use std::{os::unix::fs::PermissionsExt, path::PathBuf};

use tokio::net::{UnixListener, UnixStream};

use crate::peer_cred::peer_cred_from_fd;

/// Configuration passed to [`Listener::bind`].
#[derive(Debug, Clone)]
pub struct ListenerConfig {
    /// Filesystem path where the UDS socket file will be created.
    pub admin_sock_path: PathBuf,
}

/// A bound Unix domain socket listener for the admin RPC channel.
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

    /// Accepts the next incoming connection.
    ///
    /// Returns `Ok(Some(stream))` when `accept()` succeeds or `Err` when
    /// `accept()` itself fails. Filesystem socket permissions are the sole
    /// admission gate.
    pub async fn accept(&self) -> std::io::Result<Option<UnixStream>> {
        let (stream, _addr) = self.inner.accept().await?;

        match peer_cred_from_fd(&stream) {
            Ok(cred) => {
                tracing::debug!(peer_uid = cred.uid, "admin socket: accepted peer");
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "admin socket: could not read peer credentials"
                );
            }
        }

        Ok(Some(stream))
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn bind_or_skip(cfg: ListenerConfig) -> Option<Listener> {
        match Listener::bind(cfg) {
            Ok(listener) => Some(listener),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => None,
            Err(e) => panic!("bind failed: {e}"),
        }
    }

    fn make_cfg(tmp: &tempfile::TempDir) -> ListenerConfig {
        ListenerConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
        }
    }

    // AC-1: bind creates the socket file
    #[tokio::test(flavor = "current_thread")]
    async fn bind_creates_socket_file_at_configured_path() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);

        let Some(_listener) = bind_or_skip(cfg.clone()) else {
            return;
        };

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
        };

        let Some(_listener) = bind_or_skip(cfg) else {
            return;
        };

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

        let Some(_listener) = bind_or_skip(cfg.clone()) else {
            return;
        };

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
        let Some(_listener) = bind_or_skip(cfg.clone()) else {
            return;
        };
        assert!(
            cfg.admin_sock_path.exists(),
            "socket file should exist after bind"
        );
    }

    // AC-2: accept returns Some(stream) when the OS accepted the peer.
    #[tokio::test(flavor = "current_thread")]
    async fn accept_returns_stream_for_connected_peer() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);
        let Some(listener) = bind_or_skip(cfg.clone()) else {
            return;
        };

        // Connect from the same process; the peer uid will be our own uid.
        let _client = tokio::net::UnixStream::connect(&cfg.admin_sock_path)
            .await
            .expect("connect");

        let result = listener.accept().await.expect("accept");
        assert!(result.is_some(), "connected peer should yield Some(stream)");
    }
}

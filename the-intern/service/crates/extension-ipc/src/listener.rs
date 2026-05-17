use std::{os::unix::fs::PermissionsExt, path::PathBuf};

use tokio::net::{UnixListener, UnixStream};

use crate::peer_cred::{is_allowed, peer_cred_from_fd};

#[derive(Debug, Clone)]
pub struct ListenerConfig {
    pub extension_sock_path: PathBuf,
    pub extension_allowed_uids: Vec<u32>,
    pub service_uid: u32,
}

#[derive(Debug)]
pub struct Listener {
    inner: UnixListener,
    config: ListenerConfig,
}

impl Listener {
    pub fn bind(cfg: ListenerConfig) -> std::io::Result<Self> {
        let sock_path = &cfg.extension_sock_path;

        if let Some(parent) = sock_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }

        if sock_path.exists() {
            std::fs::remove_file(sock_path)?;
        }

        let listener = UnixListener::bind(sock_path)?;
        std::fs::set_permissions(sock_path, std::fs::Permissions::from_mode(0o660))?;

        tracing::info!(path = %sock_path.display(), "extension socket bound");
        Ok(Self {
            inner: listener,
            config: cfg,
        })
    }

    pub async fn accept(&self) -> std::io::Result<Option<UnixStream>> {
        let (stream, _addr) = self.inner.accept().await?;
        match peer_cred_from_fd(&stream) {
            Ok(cred) => {
                if is_allowed(
                    cred.uid,
                    &self.config.extension_allowed_uids,
                    self.config.service_uid,
                ) {
                    Ok(Some(stream))
                } else {
                    tracing::warn!(
                        rejected_uid = cred.uid,
                        "extension socket: rejected connection from unauthorized peer"
                    );
                    drop(stream);
                    Ok(None)
                }
            }
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "extension socket: could not read peer credentials; closing connection"
                );
                drop(stream);
                Ok(None)
            }
        }
    }

    pub fn listener(&self) -> &UnixListener {
        &self.inner
    }
}

pub fn gate_peer(peer_uid: u32, cfg: &ListenerConfig) -> bool {
    is_allowed(peer_uid, &cfg.extension_allowed_uids, cfg.service_uid)
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
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_allowed_uids: vec![],
            service_uid: nix::unistd::Uid::current().as_raw(),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bind_creates_socket_file_at_configured_path() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);

        let Some(_listener) = bind_or_skip(cfg.clone()) else {
            return;
        };

        assert!(
            cfg.extension_sock_path.exists(),
            "socket file should exist after bind"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bind_creates_parent_directory_with_mode_0700() {
        let tmp = tempdir().expect("temp dir");
        let sock_path = tmp.path().join("nested").join("dir").join("extension.sock");
        let cfg = ListenerConfig {
            extension_sock_path: sock_path.clone(),
            extension_allowed_uids: vec![],
            service_uid: nix::unistd::Uid::current().as_raw(),
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

    #[tokio::test(flavor = "current_thread")]
    async fn bind_sets_socket_file_mode_to_0660() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);

        let Some(_listener) = bind_or_skip(cfg.clone()) else {
            return;
        };

        let meta = std::fs::metadata(&cfg.extension_sock_path).expect("metadata");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o660, "socket file mode should be 0660, got {mode:o}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bind_removes_stale_file_before_binding() {
        let tmp = tempdir().expect("temp dir");
        let cfg = make_cfg(&tmp);

        std::fs::write(&cfg.extension_sock_path, b"stale").expect("write stale file");
        assert!(cfg.extension_sock_path.exists(), "stale file should exist");

        let Some(_listener) = bind_or_skip(cfg.clone()) else {
            return;
        };
        assert!(
            cfg.extension_sock_path.exists(),
            "socket file should exist after bind"
        );
    }

    #[test]
    fn gate_peer_rejects_uid_not_in_allowed_set() {
        let tmp = tempdir().expect("temp dir");
        let cfg = ListenerConfig {
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_allowed_uids: vec![100, 200],
            service_uid: 1000,
        };
        assert!(!gate_peer(999, &cfg));
    }

    #[test]
    fn gate_peer_accepts_uid_in_allowed_uids() {
        let tmp = tempdir().expect("temp dir");
        let cfg = ListenerConfig {
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_allowed_uids: vec![100, 200],
            service_uid: 1000,
        };
        assert!(gate_peer(100, &cfg));
    }

    #[test]
    fn gate_peer_accepts_service_uid() {
        let tmp = tempdir().expect("temp dir");
        let cfg = ListenerConfig {
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_allowed_uids: vec![],
            service_uid: 1000,
        };
        assert!(gate_peer(1000, &cfg));
    }
}

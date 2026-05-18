use bob_core::{
    ports::{PersistenceStore, SessionState},
    types::SessionId,
};

fn state(data: &str) -> SessionState {
    SessionState {
        data: data.to_owned(),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn stores_and_reads_back_multiple_distinct_session_states() {
    let (handle, task) = persistence::start(persistence::Config {
        command_buffer: 16,
        persistence_inbound_capacity: 8,
    });

    let fixtures = vec![
        (SessionId::new(), state("state-a")),
        (SessionId::new(), state("state-b")),
        (SessionId::new(), state("state-c")),
    ];

    for (id, session_state) in &fixtures {
        handle
            .put_session_state(*id, session_state.clone())
            .await
            .expect("put_session_state should succeed");
    }

    for (id, expected) in &fixtures {
        let actual = handle
            .get_session_state(*id)
            .await
            .expect("get_session_state should succeed");
        assert_eq!(actual, Some(expected.clone()));
    }

    drop(handle);
    task.abort();
}

#[tokio::test(flavor = "current_thread")]
async fn unknown_session_id_returns_none() {
    let (handle, task) = persistence::start(persistence::Config {
        command_buffer: 16,
        persistence_inbound_capacity: 8,
    });

    let unknown = SessionId::new();
    let result = handle
        .get_session_state(unknown)
        .await
        .expect("get_session_state should succeed");

    assert!(result.is_none());

    drop(handle);
    task.abort();
}

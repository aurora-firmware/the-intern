use std::process::Command;

#[test]
fn status_exits_non_zero_and_writes_not_implemented() {
    let output = Command::new(env!("CARGO_BIN_EXE_bob"))
        .arg("status")
        .output()
        .expect("bob binary to run");

    assert_eq!(output.status.code(), Some(1));

    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        stderr.contains("not implemented"),
        "stderr did not include marker: {stderr}"
    );
}

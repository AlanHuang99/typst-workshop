//! The helper binary's JSON-line protocol, exercised through a spawned process.

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(30);

/// A running helper process whose stdout is read line by line on a background thread.
struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    stderr: Arc<Mutex<String>>,
}

impl Helper {
    fn spawn() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_typst-workshop-helper"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn helper");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let mut stderr_pipe = child.stderr.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        let stderr = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr_pipe.read_to_string(&mut text);
            sink.lock().unwrap().push_str(&text);
        });
        Helper {
            child,
            stdin,
            lines,
            stderr,
        }
    }

    /// Writes one request line and returns the parsed response line.
    fn call(&mut self, line: &str) -> serde_json::Value {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
        let reply = self.lines.recv_timeout(TIMEOUT).unwrap_or_else(|_| {
            panic!(
                "no response to {line} within {TIMEOUT:?}; stderr: {}",
                self.stderr.lock().unwrap()
            )
        });
        serde_json::from_str(&reply)
            .unwrap_or_else(|err| panic!("response is not JSON ({err}): {reply}"))
    }

    /// Closes the helper's stdin (end of input).
    fn close_input(&mut self) {
        self.stdin.take();
    }

    fn wait_exit_success(&mut self) -> bool {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.success();
            }
            if Instant::now() > deadline {
                return false;
            }
            std::thread::park_timeout(Duration::from_millis(20));
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn version_flag() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_typst-workshop-helper"))
        .arg("--version")
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "typst-workshop-helper 0.1.0 (typst 0.15.1)"
    );
}

#[test]
fn errors_before_initialize_and_for_bad_input() {
    let mut h = Helper::spawn();
    assert_eq!(
        h.call(r#"{"id":1,"method":"compile","params":{}}"#)["error"]["message"],
        "not initialized"
    );
    assert_eq!(
        h.call(r#"{"id":2,"method":"bogus","params":{}}"#)["error"]["message"],
        "unknown method: bogus"
    );
    let bad = h.call("this is not json");
    assert_eq!(bad["id"], 0);
    assert!(!bad["error"]["message"].as_str().unwrap().is_empty());
    assert!(h.call(r#"{"id":3,"method":"shutdown","params":{}}"#)["result"].is_null());
    assert!(h.wait_exit_success());
}

#[test]
fn malformed_requests_keep_the_helper_running() {
    let mut h = Helper::spawn();
    let no_id = h.call(r#"{"method":"compile","params":{}}"#);
    assert_eq!(no_id["id"], 0);
    assert!(no_id["error"]["message"].is_string());
    let no_method = h.call(r#"{"id":4,"params":{}}"#);
    assert_eq!(no_method["id"], 4);
    assert!(no_method["error"]["message"].is_string());
    let bad_params = h.call(r#"{"id":5,"method":"initialize","params":{"root":1}}"#);
    assert_eq!(bad_params["id"], 5);
    assert!(
        bad_params["error"]["message"]
            .as_str()
            .unwrap()
            .contains("invalid params")
    );
    assert_eq!(
        h.call(r#"{"id":6,"method":"inverse","params":{"page":1,"x":0,"y":0}}"#)["error"]["message"],
        "not initialized"
    );
}

#[test]
fn end_of_input_ends_the_process() {
    let mut h = Helper::spawn();
    assert_eq!(
        h.call(r#"{"id":7,"method":"wordCount","params":{}}"#)["error"]["message"],
        "not initialized"
    );
    h.close_input();
    assert!(h.wait_exit_success());
}

#[test]
fn end_to_end_build_lookups_and_word_count() {
    let (root, _g) = common::fixture_in("basic", "Ä b");
    let params = serde_json::to_value(common::init_params(&root, "main.typ")).unwrap();
    let mut h = Helper::spawn();
    let request = |id: i64, method: &str, params: serde_json::Value| {
        serde_json::json!({ "id": id, "method": method, "params": params }).to_string()
    };

    let init = h.call(&request(1, "initialize", params));
    assert_eq!(
        init,
        serde_json::json!({ "id": 1, "result": { "helperVersion": "0.1.0", "typstVersion": "0.15.1" } })
    );

    let compile = h.call(&request(2, "compile", serde_json::json!({})));
    let result = &compile["result"];
    assert_eq!(
        (result["success"].as_bool(), result["pdfWritten"].as_bool()),
        (Some(true), Some(true)),
        "{compile}"
    );
    assert!(result["durationMs"].as_f64().unwrap() > 0.0);
    assert!(result["pageCount"].as_u64().unwrap() >= 1);
    assert!(
        result["dependencies"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d.as_str().unwrap().ends_with("Ä b/sections/body.typ"))
    );
    assert!(root.join("main.pdf").exists());

    let body = root
        .join("sections/body.typ")
        .to_string_lossy()
        .into_owned();
    let forward = h.call(&request(
        3,
        "forward",
        serde_json::json!({ "path": body, "line": 0, "character": 7 }),
    ));
    let first = &forward["result"]["positions"][0];
    for key in ["page", "left", "bottom", "right", "top", "x", "y"] {
        assert!(first[key].is_number(), "{key} in {forward}");
    }

    let x = first["x"].as_f64().unwrap() + 1.0;
    let inverse = h.call(&request(
        4,
        "inverse",
        serde_json::json!({ "page": first["page"], "x": x, "y": first["y"] }),
    ));
    assert_eq!(inverse["result"]["path"], serde_json::json!(body));
    assert_eq!(inverse["result"]["line"], 0);

    let words = h.call(&request(5, "wordCount", serde_json::json!({})));
    assert!(words["result"]["total"].as_u64().unwrap() > 0, "{words}");

    assert_eq!(
        h.call(&request(6, "shutdown", serde_json::json!({}))),
        serde_json::json!({ "id": 6, "result": null })
    );
    assert!(h.wait_exit_success());
}

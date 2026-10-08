//! Typst Workshop helper: compiles one Typst project with the typst crates, writes the PDF and answers position lookups between the PDF and the sources. The binary speaks JSON lines on stdin/stdout (see [`serve`]).

pub mod compile;
pub mod coords;
pub mod fonts;
pub mod frames;
pub mod lines;
pub mod protocol;
pub mod session;
pub mod sync;
pub mod wordcount;
pub mod world;

use std::io::{self, BufRead, Write};

pub use session::Session;

/// The helper's version, from Cargo.toml.
pub const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The typst version the helper is built with; it must match the `=<version>` pins of the typst crates in Cargo.toml (a unit test checks it against the typst crates). scripts/typst-update.mjs changes both.
pub const TYPST_VERSION: &str = "0.15.1";

/// Reads requests from `input`, one JSON object per line, and writes one response line per request to `output`, flushing after each. Returns after a `shutdown` request (once its response is written) or at the end of `input`.
pub fn serve(mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let mut session = Session::new();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if input.read_until(b'\n', &mut buf)? == 0 {
            return Ok(());
        }
        let (response, exit) = match std::str::from_utf8(&buf) {
            Ok(line) if line.trim().is_empty() => continue,
            Ok(line) => respond(&mut session, line),
            Err(err) => (
                protocol::error_line(0, &format!("invalid request: {err}")),
                false,
            ),
        };
        output.write_all(response.as_bytes())?;
        output.write_all(b"\n")?;
        output.flush()?;
        if exit {
            return Ok(());
        }
    }
}

/// The response line for one request line, and whether the helper exits after writing it.
fn respond(session: &mut Session, line: &str) -> (String, bool) {
    match protocol::parse_request(line) {
        Err((id, message)) => (protocol::error_line(id, &message), false),
        Ok(request) => {
            let response = match session.handle(&request.method, request.params) {
                Ok(result) => protocol::result_line(request.id, result),
                Err(message) => protocol::error_line(request.id, &message),
            };
            (response, request.method == "shutdown")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        serve(input.as_bytes(), &mut out).unwrap();
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn typst_version_matches_the_crates() {
        assert_eq!(TYPST_VERSION, typst::utils::version().raw());
    }

    #[test]
    fn one_response_per_request_and_stop_after_shutdown() {
        let out = run(
            "{\"id\":1,\"method\":\"compile\"}\n\n{\"id\":2,\"method\":\"shutdown\"}\n{\"id\":3,\"method\":\"compile\"}\n",
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["id"], 1);
        assert_eq!(out[0]["error"]["message"], "not initialized");
        assert_eq!(out[1], serde_json::json!({ "id": 2, "result": null }));
    }

    #[test]
    fn invalid_utf8_gets_id_zero_and_the_loop_continues() {
        let mut input = b"\xff\xfe\n".to_vec();
        input.extend_from_slice(b"{\"id\":9,\"method\":\"shutdown\",\"params\":{}}\n");
        let mut out = Vec::new();
        serve(&input[..], &mut out).unwrap();
        let lines: Vec<serde_json::Value> = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["id"], 0);
        assert_eq!(lines[1]["id"], 9);
    }

    #[test]
    fn last_line_without_newline_is_answered() {
        let out = run("{\"id\":4,\"method\":\"bogus\"}");
        assert_eq!(out[0]["error"]["message"], "unknown method: bogus");
    }
}

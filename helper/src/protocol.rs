//! Request and response types of the JSON-line protocol. The TypeScript mirror is `src/helper/protocol.ts`; change both together.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// A position in a text file: 0-based line and UTF-16 code unit (the VS Code convention).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub line: usize,
    pub character: usize,
}

/// A range between two positions in a text file.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// A rectangle on a PDF page (1-based `page`) in pt, PDF user space of that page (origin bottom-left, y up); `(x, y)` is the point for a circle marker.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRect {
    pub page: usize,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub top: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub root: String,
    pub main: String,
    pub output: String,
    #[serde(default)]
    pub font_paths: Vec<String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, String>,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub helper_version: String,
    pub typst_version: String,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEntry {
    pub message: String,
    pub path: Option<String>,
    pub range: Option<Range>,
}

/// A compile error or warning (`HelperDiagnostic` in the TypeScript mirror); `severity` is `"error"` or `"warning"`.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub severity: String,
    pub message: String,
    pub hints: Vec<String>,
    pub path: Option<String>,
    pub range: Option<Range>,
    pub trace: Vec<TraceEntry>,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    pub success: bool,
    pub duration_ms: f64,
    pub page_count: Option<usize>,
    pub pdf_written: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub dependencies: Vec<String>,
}

/// A point on a PDF page (1-based `page`) in PDF user space, as pdf.js `convertToPdfPoint` returns it.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InverseParams {
    pub page: usize,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    pub path: String,
    pub line: usize,
    pub character: usize,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardParams {
    pub path: String,
    pub line: usize,
    pub character: usize,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardResult {
    pub positions: Vec<PdfRect>,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWords {
    pub path: String,
    pub words: usize,
}

/// Word counts; `files` is sorted by words, descending.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordCountResult {
    pub total: usize,
    pub files: Vec<FileWords>,
}

/// One request line: `{"id": <integer>, "method": "<name>", "params": {...}}`.
#[derive(Clone, PartialEq, Debug)]
pub struct Request {
    pub id: i64,
    pub method: String,
    pub params: Value,
}

/// Parses a request line. A line that is not a JSON object with an integer `id` fails with id 0; a missing method fails with the request's id.
pub fn parse_request(line: &str) -> Result<Request, (i64, String)> {
    let value: Value =
        serde_json::from_str(line).map_err(|err| (0, format!("invalid JSON: {err}")))?;
    let id = value
        .get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| (0, "invalid request: missing integer id".to_string()))?;
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| (id, "invalid request: missing method".to_string()))?;
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    Ok(Request {
        id,
        method: method.to_string(),
        params,
    })
}

/// A success response line (without the newline).
pub fn result_line(id: i64, result: Value) -> String {
    json!({ "id": id, "result": result }).to_string()
}

/// A failure response line (without the newline).
pub fn error_line(id: i64, message: &str) -> String {
    json!({ "id": id, "error": { "message": message } }).to_string()
}

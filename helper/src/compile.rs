//! Compiling the project: PDF export with typst-cli 0.15.1's default options, an atomic write of the PDF, diagnostics with UTF-16 ranges, and the project files read.

use std::ffi::OsString;
use std::io;
use std::path::Path;
use std::time::Instant;

use chrono::{Datelike, Timelike};
use typst::World;
use typst::WorldExt;
use typst::diag::{Severity, SourceDiagnostic, Warned};
use typst::foundations::{Datetime, Smart};
use typst::syntax::{DiagSpan, DiagSpanKind};
use typst_layout::PagedDocument;
use typst_pdf::{PdfOptions, PdfStandards, Timestamp};

use crate::protocol::{CompileResult, Diagnostic, Range, TraceEntry};
use crate::world::{HelperWorld, OffsetBase};

/// The outcome of one compilation: the result for the client and, on success, the new document.
pub struct Compiled {
    pub result: CompileResult,
    pub document: Option<PagedDocument>,
}

/// Compiles the project and, on success, writes the PDF to `output` through a temporary file in the same folder and a rename. On failure nothing is written.
pub fn compile(world: &mut HelperWorld, output: &Path) -> Compiled {
    let start = Instant::now();
    world.reset();
    let Warned {
        output: compiled,
        warnings,
    } = typst::compile::<PagedDocument>(world);

    let mut errors = Vec::new();
    let mut document = None;
    let options = pdf_options(world.creation_timestamp());
    match compiled.and_then(|doc| typst_pdf::pdf(&doc, &options).map(|pdf| (doc, pdf))) {
        Ok((doc, pdf)) => match write_atomically(output, &pdf) {
            Ok(()) => document = Some(doc),
            Err(err) => errors.push(write_failure(world, &err)),
        },
        Err(diags) => errors.extend(diags.iter().map(|diag| diagnostic(world, diag))),
    }

    let dependencies = world
        .dependencies()
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let error_count = errors.len();
    let mut diagnostics = errors;
    diagnostics.extend(warnings.iter().map(|diag| diagnostic(world, diag)));
    comemo::evict(10);

    let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
    let page_count = document.as_ref().map(|doc| doc.pages().len());
    eprintln!(
        "compiled in {duration_ms:.0} ms: {}, {error_count} errors, {} warnings",
        match page_count {
            Some(n) => format!("PDF written ({n} pages)"),
            None => "PDF not written".into(),
        },
        diagnostics.len() - error_count,
    );
    Compiled {
        result: CompileResult {
            success: document.is_some(),
            duration_ms,
            page_count,
            pdf_written: document.is_some(),
            diagnostics,
            dependencies,
        },
        document,
    }
}

// Adapted from typst-cli 0.15.1 crates/typst-cli/src/compile.rs (Apache-2.0): the creation timestamp, `pdf_options` and `convert_datetime`.

/// The creation timestamp from the value of `SOURCE_DATE_EPOCH`, read as typst-cli reads it for `--creation-timestamp`: whole seconds since the UNIX epoch, within the range of dates. An unset or empty variable gives `None`.
pub fn creation_timestamp(source_date_epoch: Option<&str>) -> Result<Option<i64>, String> {
    let Some(value) = source_date_epoch.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let seconds: i64 = value
        .parse()
        .map_err(|err| format!("invalid SOURCE_DATE_EPOCH `{value}` ({err})"))?;
    chrono::DateTime::from_timestamp(seconds, 0).ok_or("creation timestamp is out of range")?;
    Ok(Some(seconds))
}

/// The PDF creation timestamp: the fixed creation timestamp in UTC, otherwise the current local time with its UTC offset.
pub fn pdf_timestamp(creation_timestamp: Option<i64>) -> Option<Timestamp> {
    match creation_timestamp {
        Some(seconds) => {
            convert_datetime(chrono::DateTime::from_timestamp(seconds, 0)?).map(Timestamp::new_utc)
        }
        None => {
            let now = chrono::Local::now();
            convert_datetime(now).and_then(|datetime| {
                Timestamp::new_local(datetime, now.offset().local_minus_utc() / 60)
            })
        }
    }
}

/// Converts a chrono datetime to a Typst datetime.
fn convert_datetime<Tz: chrono::TimeZone>(date_time: chrono::DateTime<Tz>) -> Option<Datetime> {
    Datetime::from_ymd_hms(
        date_time.year(),
        date_time.month().try_into().ok()?,
        date_time.day().try_into().ok()?,
        date_time.hour().try_into().ok()?,
        date_time.minute().try_into().ok()?,
        date_time.second().try_into().ok()?,
    )
}

/// PDF options as `typst compile` 0.15.1 uses them by default: no page ranges, no standards, tagged, and the creation timestamp of [`pdf_timestamp`].
fn pdf_options(creation_timestamp: Option<i64>) -> PdfOptions {
    PdfOptions {
        ident: Smart::Auto,
        creator: Smart::Auto,
        timestamp: pdf_timestamp(creation_timestamp),
        page_ranges: None,
        standards: PdfStandards::new(&[]).unwrap_or_default(),
        tagged: true,
        pretty: false,
    }
}

/// Writes `data` to `<dir>/.<name>.tmp-<pid>` and renames it over `path`, so a reader never sees a partly written file. Creates the folder if needed.
fn write_atomically(path: &Path, data: &[u8]) -> io::Result<()> {
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the output path has no file name",
        )
    })?;
    std::fs::create_dir_all(dir)?;
    let mut tmp_name = OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(format!(".tmp-{}", std::process::id()));
    let tmp = dir.join(tmp_name);
    let result = std::fs::write(&tmp, data).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// The error for a PDF that could not be written, placed on the entry file.
fn write_failure(world: &HelperWorld, err: &io::Error) -> Diagnostic {
    Diagnostic {
        severity: "error".into(),
        message: format!("failed to write PDF: {err}"),
        hints: Vec::new(),
        path: world
            .path_of(world.main())
            .map(|path| path.to_string_lossy().into_owned()),
        range: None,
        trace: Vec::new(),
    }
}

/// Converts a typst diagnostic, with its file path and UTF-16 range.
fn diagnostic(world: &HelperWorld, diag: &SourceDiagnostic) -> Diagnostic {
    let (path, range) = locate(world, diag.span);
    Diagnostic {
        severity: match diag.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
        .into(),
        message: diag.message.to_string(),
        hints: diag.hints.iter().map(|hint| hint.v.to_string()).collect(),
        path,
        range,
        trace: diag
            .trace
            .iter()
            .map(|point| {
                let (path, range) = locate(world, point.span.into());
                TraceEntry {
                    message: point.v.to_string(),
                    path,
                    range,
                }
            })
            .collect(),
    }
}

/// The path and range of a diagnostic span: null for detached spans; a package file's path in the package directory; ranges of numbered spans measured in the parsed source, other ranges (such as errors in a `.bib` file) in the file's bytes.
fn locate(world: &HelperWorld, span: DiagSpan) -> (Option<String>, Option<Range>) {
    let Some(id) = span.id() else {
        return (None, None);
    };
    let path = world
        .path_of(id)
        .map(|path| path.to_string_lossy().into_owned());
    let base = match span.get() {
        DiagSpanKind::Number { .. } => OffsetBase::Source,
        _ => OffsetBase::Bytes,
    };
    let range = world.range(span).and_then(|bytes| {
        Some(Range {
            start: world.position(id, bytes.start, base)?,
            end: world.position(id, bytes.end, base)?,
        })
    });
    (path, range)
}

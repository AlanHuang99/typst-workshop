//! `initialize` and `compile` through the library API.

mod common;

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use typst::World;
use typst_workshop_helper::protocol::{Position, Range};
use typst_workshop_helper::world::HelperWorld;
use typst_workshop_helper::{Session, compile, lines};

#[test]
fn world_resolves_project_files() {
    let (root, _g) = common::fixture("basic");
    let world = HelperWorld::new(&root, &root.join("main.typ"), &[], &BTreeMap::new()).unwrap();
    let main = world.main();
    assert!(world.is_project_file(main));
    assert_eq!(world.path_of(main).unwrap(), root.join("main.typ"));
    assert!(world.source(main).unwrap().text().contains("#outline()"));
    let body = world.project_file(&root.join("sections/body.typ")).unwrap();
    assert_eq!(world.path_of(body).unwrap(), root.join("sections/body.typ"));
    assert!(
        world
            .project_file(&root.parent().unwrap().join("other.typ"))
            .is_none()
    );
}

#[test]
fn world_keeps_the_callers_spelling_of_the_root() {
    let (root, g) = common::fixture("basic");
    let link = g.path().join("link to basic");
    std::os::unix::fs::symlink(&root, &link).unwrap();
    let world = HelperWorld::new(&link, &link.join("main.typ"), &[], &BTreeMap::new()).unwrap();
    assert_eq!(world.path_of(world.main()).unwrap(), link.join("main.typ"));
    // The canonical spelling of a project file maps to the same file.
    let body = world.project_file(&root.join("sections/body.typ")).unwrap();
    assert_eq!(world.path_of(body).unwrap(), link.join("sections/body.typ"));
}

#[test]
fn initialize_reports_versions() {
    let (root, _g) = common::fixture("basic");
    let mut s = Session::new();
    let r = s
        .initialize(common::init_params(&root, "main.typ"))
        .unwrap();
    assert_eq!(r.typst_version, "0.15.1");
    assert_eq!(r.helper_version, "0.1.0");
}

#[test]
fn initialize_rejects_bad_paths() {
    let (root, g) = common::fixture("basic");
    let mut s = Session::new();
    let mut p = common::init_params(&root, "missing.typ");
    assert!(s.initialize(p.clone()).unwrap_err().contains("not found"));
    // A file next to the project root, outside it.
    p.main = g.path().join("elsewhere.typ").to_string_lossy().into();
    std::fs::write(&p.main, "x").unwrap();
    assert!(
        s.initialize(p)
            .unwrap_err()
            .contains("source file must be contained in project root")
    );
}

#[test]
fn initialize_rejects_a_missing_root() {
    let (root, _g) = common::fixture("basic");
    let mut p = common::init_params(&root, "main.typ");
    p.root = root.join("no-such-dir").to_string_lossy().into();
    let err = Session::new().initialize(p).unwrap_err();
    assert!(err.contains("root directory not found"), "{err}");
}

#[test]
fn compile_before_initialize_is_an_error() {
    assert_eq!(Session::new().compile().unwrap_err(), "not initialized");
}

#[test]
fn lines_utf16() {
    let t = "Hello.\n😀 #foo\n";
    assert_eq!(
        lines::byte_to_position(t, t.find("foo").unwrap()),
        Position {
            line: 1,
            character: 4
        }
    );
    assert_eq!(
        lines::position_to_byte(
            t,
            Position {
                line: 1,
                character: 4
            }
        ),
        t.find("foo").unwrap()
    );
    assert_eq!(
        lines::position_to_byte(
            t,
            Position {
                line: 9,
                character: 0
            }
        ),
        t.len()
    );
    assert_eq!(
        lines::position_to_byte(
            t,
            Position {
                line: 0,
                character: 99
            }
        ),
        6
    );
}

#[test]
fn lines_edge_cases() {
    // CRLF and lone CR end lines; a position between CR and LF is the end of the line.
    let t = "ab\r\ncd\ref";
    assert_eq!(
        lines::byte_to_position(t, t.find('c').unwrap()),
        Position {
            line: 1,
            character: 0
        }
    );
    assert_eq!(
        lines::byte_to_position(t, t.find('e').unwrap()),
        Position {
            line: 2,
            character: 0
        }
    );
    assert_eq!(
        lines::byte_to_position(t, 3),
        Position {
            line: 0,
            character: 2
        }
    );
    assert_eq!(
        lines::position_to_byte(
            t,
            Position {
                line: 0,
                character: 5
            }
        ),
        2
    );
    assert_eq!(
        lines::position_to_byte(
            t,
            Position {
                line: 2,
                character: 1
            }
        ),
        t.find('f').unwrap()
    );
    // Offsets inside a character and past the end clamp; UTF-16 columns count surrogate pairs as two.
    let t = "ä😀x";
    assert_eq!(
        lines::byte_to_position(t, 1),
        Position {
            line: 0,
            character: 0
        }
    );
    assert_eq!(
        lines::byte_to_position(t, 99),
        Position {
            line: 0,
            character: 4
        }
    );
    assert_eq!(
        lines::position_to_byte(
            t,
            Position {
                line: 0,
                character: 3
            }
        ),
        t.find('x').unwrap()
    );
    assert_eq!(
        lines::position_to_byte(
            t,
            Position {
                line: 0,
                character: 2
            }
        ),
        t.find('x').unwrap()
    );
    assert_eq!(
        lines::position_to_byte(
            "",
            Position {
                line: 0,
                character: 3
            }
        ),
        0
    );
}

#[test]
fn compile_writes_pdf_and_reports_dependencies() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    let r = s.compile().unwrap();
    assert!(r.success && r.pdf_written, "{:?}", r.diagnostics);
    assert!(r.page_count.unwrap() >= 1);
    let pdf = std::fs::read(root.join("main.pdf")).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    for f in ["main.typ", "sections/body.typ", "refs.bib", "img/box.svg"] {
        assert!(
            r.dependencies
                .iter()
                .any(|d| std::path::Path::new(d).canonicalize().ok()
                    == root.join(f).canonicalize().ok()),
            "missing {f}"
        );
    }
    assert!(
        std::fs::read_dir(&root).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp-"))
    );
}

#[test]
fn error_keeps_previous_pdf_and_document() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let before = std::fs::metadata(root.join("main.pdf"))
        .unwrap()
        .modified()
        .unwrap();
    std::fs::write(root.join("sections/body.typ"), "Broken #nope\n").unwrap();
    let r = s.compile().unwrap();
    assert!(!r.success && !r.pdf_written);
    assert_eq!(
        std::fs::metadata(root.join("main.pdf"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert!(
        s.document().is_some(),
        "lookups answer from the last good document"
    );
}

#[test]
fn diagnostic_ranges_are_utf16() {
    let (root, _g) = common::fixture("broken");
    let mut s = common::session_for(&root, "main.typ");
    let r = s.compile().unwrap();
    let d = &r.diagnostics[0];
    assert_eq!(d.severity, "error");
    assert!(d.message.contains("unknown variable: foo"));
    assert_eq!(
        d.range.unwrap().start,
        Position {
            line: 1,
            character: 4
        }
    );
    assert_eq!(
        d.range.unwrap().end,
        Position {
            line: 1,
            character: 7
        }
    );
    assert_eq!(Path::new(d.path.as_deref().unwrap()), root.join("main.typ"));
    assert_eq!((r.page_count, r.pdf_written), (None, false));
    assert!(!root.join("main.pdf").exists());
}

#[test]
fn warnings_reported_on_success() {
    let (root, _g) = common::fixture("warn");
    let r = common::session_for(&root, "main.typ").compile().unwrap();
    assert!(r.success && r.diagnostics.iter().any(|d| d.severity == "warning"));
}

#[test]
fn paths_with_spaces() {
    let (root, _g) = common::fixture_in("basic", "Ä b"); // copies into a temp dir whose last component is "Ä b"
    let r = common::session_for(&root, "main.typ").compile().unwrap();
    assert!(r.success && root.join("main.pdf").exists());
    assert!(r.dependencies.iter().all(|d| d.contains("Ä b")));
}

#[test]
fn pdf_is_replaced_atomically() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let old = std::fs::read(root.join("main.pdf")).unwrap();
    // A reader that opened the old PDF keeps reading the complete old file while the new one is written.
    let mut reader = std::fs::File::open(root.join("main.pdf")).unwrap();
    std::fs::write(root.join("sections/body.typ"), "A different body.\n").unwrap();
    assert!(s.compile().unwrap().pdf_written);
    let mut seen = Vec::new();
    reader.read_to_end(&mut seen).unwrap();
    assert_eq!(seen, old);
    let new = std::fs::read(root.join("main.pdf")).unwrap();
    assert_ne!(new, old);
    assert!(new.starts_with(b"%PDF-") && new.trim_ascii_end().ends_with(b"%%EOF"));
}

#[test]
fn output_directory_is_created_and_write_failures_are_reported() {
    let (root, _g) = common::fixture("bleed");
    let mut s = Session::new();
    let mut p = common::init_params(&root, "main.typ");
    p.output = root.join("build/pdf/out.pdf").to_string_lossy().into();
    s.initialize(p.clone()).unwrap();
    let r = s.compile().unwrap();
    assert!(r.success && r.pdf_written && root.join("build/pdf/out.pdf").exists());

    // The output's parent is a file, so the PDF cannot be written.
    p.output = root.join("main.typ/out.pdf").to_string_lossy().into();
    s.initialize(p).unwrap();
    let r = s.compile().unwrap();
    assert!(!r.success && !r.pdf_written);
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.message.starts_with("failed to write PDF: "))
        .expect("write failure");
    assert_eq!(d.severity, "error");
    assert_eq!(Path::new(d.path.as_deref().unwrap()), root.join("main.typ"));
    assert!(
        s.document().is_none(),
        "no document was written for this session"
    );
}

#[test]
fn errors_in_non_typst_files_have_ranges_from_their_text() {
    let (root, _g) = common::fixture("basic");
    std::fs::write(
        root.join("refs.bib"),
        "@book{knuth1984,\n  author = {Donald E. Knuth,\n",
    )
    .unwrap();
    let r = common::session_for(&root, "main.typ").compile().unwrap();
    assert!(!r.success);
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.path.as_deref().is_some_and(|p| p.ends_with("refs.bib")))
        .expect("a diagnostic in refs.bib");
    assert_eq!(
        d.range,
        Some(Range {
            start: Position {
                line: 2,
                character: 0
            },
            end: Position {
                line: 2,
                character: 0
            },
        }),
        "{d:?}"
    );
}

#[test]
fn a_missing_included_file_is_a_dependency() {
    let (root, _g) = common::fixture("broken");
    std::fs::write(root.join("main.typ"), "Before.\n#include \"missing.typ\"\n").unwrap();
    let mut s = common::session_for(&root, "main.typ");
    let r = s.compile().unwrap();
    assert!(!r.success);
    assert!(
        r.dependencies
            .iter()
            .any(|d| Path::new(d) == root.join("missing.typ")),
        "{:?}",
        r.dependencies
    );
    // Once the file exists, the next build succeeds.
    std::fs::write(root.join("missing.typ"), "Now here.\n").unwrap();
    assert!(s.compile().unwrap().success);
}

#[test]
fn creation_timestamp_from_source_date_epoch() {
    assert_eq!(compile::creation_timestamp(None), Ok(None));
    assert_eq!(compile::creation_timestamp(Some("")), Ok(None));
    assert_eq!(compile::creation_timestamp(Some("0")), Ok(Some(0)));
    assert_eq!(
        compile::creation_timestamp(Some("1700000000")),
        Ok(Some(1_700_000_000))
    );
    assert_eq!(
        compile::creation_timestamp(Some("-86400")),
        Ok(Some(-86_400))
    );
    assert!(
        compile::creation_timestamp(Some("12a"))
            .unwrap_err()
            .contains("SOURCE_DATE_EPOCH")
    );
    assert!(
        compile::creation_timestamp(Some("99999999999999999"))
            .unwrap_err()
            .contains("out of range")
    );
    // The PDF timestamp is the given time in UTC.
    let utc = typst_pdf::Timestamp::new_utc(
        typst::foundations::Datetime::from_ymd_hms(1970, 1, 2, 3, 4, 5).unwrap(),
    );
    assert_eq!(
        format!(
            "{:?}",
            compile::pdf_timestamp(Some(86_400 + 3 * 3600 + 4 * 60 + 5))
        ),
        format!("{:?}", Some(utc))
    );
}

#[test]
fn a_fixed_creation_timestamp_sets_today_and_the_pdf_date() {
    let (root, _g) = common::fixture("broken");
    std::fs::write(root.join("main.typ"), "#datetime.today().display()\n").unwrap();
    let mut world = HelperWorld::new(&root, &root.join("main.typ"), &[], &BTreeMap::new()).unwrap();
    // 366 days after the epoch: 1971-01-02, 00:00 UTC.
    world.set_creation_timestamp(Some(366 * 86_400)).unwrap();
    let out = root.join("main.pdf");
    let compiled = compile::compile(&mut world, &out);
    assert!(compiled.result.success, "{:?}", compiled.result.diagnostics);
    assert!(common::find_text(compiled.document.as_ref().unwrap(), "1971-01-02").is_some());
    let pdf = std::fs::read(&out).unwrap();
    let has = |needle: &[u8]| pdf.windows(needle.len()).any(|w| w == needle);
    assert!(
        has(b"/CreationDate(D:19710102000000Z)"),
        "{}",
        String::from_utf8_lossy(&pdf[pdf.len().saturating_sub(1500)..])
    );
    assert!(world.set_creation_timestamp(Some(i64::MAX)).is_err());
}

#[test]
fn trace_entries_point_at_the_call() {
    let (root, _g) = common::fixture("broken");
    std::fs::write(root.join("main.typ"), "#let f(x) = x + nope\n#f(1)\n").unwrap();
    let r = common::session_for(&root, "main.typ").compile().unwrap();
    let d = &r.diagnostics[0];
    assert!(d.message.contains("unknown variable: nope"), "{d:?}");
    let call = d
        .trace
        .iter()
        .find(|t| t.range.is_some_and(|r| r.start.line == 1))
        .expect("trace entry at the call");
    assert!(call.message.contains('f'), "{call:?}");
    assert!(
        call.path
            .as_deref()
            .is_some_and(|p| p.ends_with("main.typ"))
    );
}

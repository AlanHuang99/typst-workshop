//! Word count through the library API.

mod common;

use typst_workshop_helper::Session;
use typst_workshop_helper::protocol::WordCountResult;

fn words_in(r: &WordCountResult, file: &str) -> Option<usize> {
    r.files
        .iter()
        .find(|x| x.path.ends_with(file))
        .map(|x| x.words)
}

#[test]
fn word_count_skips_import_only_files() {
    let (root, _g) = common::fixture("words-template");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    // The template's header is on both pages.
    assert!(common::find_text(s.document().unwrap(), "Template header words").is_some());
    let r = s.word_count().unwrap();
    assert_eq!(words_in(&r, "main.typ"), Some(4));
    assert_eq!(words_in(&r, "part.typ"), Some(1));
    assert_eq!(words_in(&r, "tpl.typ").unwrap_or(0), 0);
    assert_eq!(r.total, 5);
}

#[test]
fn imported_files_count_when_also_included_and_paths_resolve_like_typst() {
    let (root, _g) = common::fixture("words-template");
    // `lib.typ` is imported and included: it counts. `/tpl/a.typ` (absolute) imports `b.typ` (relative to `tpl/`): both only imported.
    std::fs::write(root.join("main.typ"), "#import \"lib.typ\": x\n#import \"/tpl/a.typ\": h\n#set page(width: 200pt, height: 200pt, header: h)\n#include \"lib.typ\"\n#x\n").unwrap();
    std::fs::write(
        root.join("lib.typ"),
        "#let x = [Library words here]\nIncluded text.\n",
    )
    .unwrap();
    std::fs::create_dir(root.join("tpl")).unwrap();
    std::fs::write(
        root.join("tpl/a.typ"),
        "#import \"b.typ\": inner\n#let h = [Header #inner]\n",
    )
    .unwrap();
    std::fs::write(root.join("tpl/b.typ"), "#let inner = [from b]\n").unwrap();
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    assert!(common::find_text(s.document().unwrap(), "from b").is_some());
    let r = s.word_count().unwrap();
    assert_eq!(words_in(&r, "lib.typ"), Some(5), "{r:?}");
    assert_eq!(words_in(&r, "tpl/a.typ").unwrap_or(0), 0, "{r:?}");
    assert_eq!(words_in(&r, "tpl/b.typ").unwrap_or(0), 0, "{r:?}");
    assert_eq!(r.total, 5);
}

#[test]
fn includes_in_parsed_sources_of_any_extension_count() {
    // `lib.typ` is imported by `main.typ` and included by `chapter.txt`, a markup file parsed as a source: it counts.
    let (root, _g) = common::fixture("words-template");
    std::fs::write(
        root.join("main.typ"),
        "#import \"lib.typ\": x\n#include \"chapter.txt\"\n#x\n",
    )
    .unwrap();
    std::fs::write(
        root.join("chapter.txt"),
        "Chapter words.\n#include \"lib.typ\"\n",
    )
    .unwrap();
    std::fs::write(
        root.join("lib.typ"),
        "#let x = [Library words]\nIncluded library text.\n",
    )
    .unwrap();
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let r = s.word_count().unwrap();
    assert_eq!(words_in(&r, "chapter.txt"), Some(2), "{r:?}");
    assert_eq!(words_in(&r, "lib.typ"), Some(5), "{r:?}");
    assert_eq!(r.total, 7);
}

#[test]
fn word_count_counts_each_source_position_once() {
    let (root, _g) = common::fixture("words-repeat");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    assert_eq!(doc.pages().len(), 2);
    for page in 0..2 {
        assert!(
            common::find_text_on_page(doc, page, "Repeated title words").is_some(),
            "header on page {page}"
        );
    }
    assert_eq!(
        common::count_text(doc, "Heading once"),
        2,
        "outline entry and heading"
    );
    let r = s.word_count().unwrap();
    assert_eq!(r.total, 9, "{r:?}");
    assert_eq!(words_in(&r, "main.typ"), Some(9));
}

#[test]
fn word_count_answers_after_a_failed_compile() {
    let (root, _g) = common::fixture("words-template");
    let mut s = Session::new();
    s.initialize(common::init_params(&root, "main.typ"))
        .unwrap();
    assert!(s.compile().unwrap().success);
    std::fs::write(root.join("part.typ"), "#nope\n").unwrap();
    assert!(!s.compile().unwrap().success);
    assert!(s.word_count().is_ok());
}

#[test]
fn word_count_by_file() {
    let (root, _g) = common::fixture("words");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let r = s.word_count().unwrap();
    let get = |f: &str| {
        r.files
            .iter()
            .find(|x| x.path.ends_with(f))
            .map(|x| x.words)
            .unwrap_or(0)
    };
    assert_eq!(get("main.typ"), 7);
    assert_eq!(get("more.typ"), 10);
    assert_eq!(r.total, 17);
    assert_eq!(r.files[0].words, 10, "sorted by words, descending");
}

#[test]
fn word_count_before_compile_is_an_error() {
    let (root, _g) = common::fixture("words");
    let s = common::session_for(&root, "main.typ");
    assert_eq!(s.word_count().unwrap_err(), "no successful compilation yet");
}

#[test]
fn word_count_after_a_failed_compile_answers_from_the_last_document() {
    let (root, _g) = common::fixture("words");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let before = s.word_count().unwrap();
    let text = std::fs::read_to_string(root.join("more.typ")).unwrap();
    std::fs::write(root.join("more.typ"), format!("{text}#nope\n")).unwrap();
    assert!(!s.compile().unwrap().success);
    assert_eq!(s.word_count(), Ok(before));
}

#[test]
fn words_follow_the_markup_rules() {
    let (root, _g) = common::fixture("broken");
    let cases = [
        // Apostrophes and hyphens between letters or digits join; other punctuation separates.
        ("don't well-known x-ray", 3),
        ("a--b 3.14 -- end -", 5),
        // Code output, strings and math are separators.
        ("#let n = 3\nCount #n #\"code\" $a b$ words.", 2),
        // Each CJK ideograph, kana or hangul syllable is a word.
        ("中文 かな 한글 abc中def", 9),
        // A decomposed accent continues its word.
        ("e\u{301}lan vital", 2),
    ];
    for (text, expected) in cases {
        std::fs::write(root.join("main.typ"), text).unwrap();
        let mut s = common::session_for(&root, "main.typ");
        let r = s.compile().unwrap();
        assert!(r.success, "{text}: {:?}", r.diagnostics);
        assert_eq!(s.word_count().unwrap().total, expected, "{text}");
    }
}

#[test]
fn hyphenated_words_across_lines_count_once() {
    let (root, _g) = common::fixture("broken");
    std::fs::write(
        root.join("main.typ"),
        "#set page(width: 60pt, height: auto, margin: 5pt)\n#set text(hyphenate: true, lang: \"en\")\nincomprehensibilities extraordinarily\n",
    )
    .unwrap();
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    assert!(
        s.document().unwrap().pages()[0].frame.height().to_pt() > 40.0,
        "the words wrap"
    );
    assert_eq!(s.word_count().unwrap().total, 2);
}

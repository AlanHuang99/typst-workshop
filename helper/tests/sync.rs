//! PDF ↔ source lookups through the library API.

mod common;

use std::collections::HashSet;

use typst::layout::{Abs, Point};
use typst_workshop_helper::protocol::{ForwardParams, InverseParams, PdfRect, SourceLocation};
use typst_workshop_helper::{Session, coords};

/// The source position of a click just right of a forward position's marker (inside the marked glyph).
fn inverse_at_marker(s: &Session, p: &PdfRect) -> SourceLocation {
    s.inverse(InverseParams {
        page: p.page,
        x: p.x + 0.5,
        y: p.y,
    })
    .unwrap()
    .unwrap_or_else(|| panic!("no source at the marker of {p:?}"))
}

/// Asserts that a location is in the file ending in `file`, on `line`, at `character` give or take one.
fn assert_at(loc: &SourceLocation, file: &str, line: usize, character: usize) {
    assert!(
        loc.path.ends_with(file) && loc.line == line && loc.character.abs_diff(character) <= 1,
        "{loc:?} is not {file} {line}:{character}"
    );
}

#[test]
fn page_and_line_numbers_fall_back_to_the_nearest_glyph() {
    // The second paragraph runs onto page 2: its start tag is on page 1 and its end tag on page 2, and the margin line numbers and the page number are painted after it. It must not count as enclosing them.
    let (root, _g) = common::fixture("numbered");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    assert!(
        doc.pages().len() >= 2,
        "the second paragraph runs onto page 2"
    );
    let glyphs = common::first_glyphs(doc, 0);
    let click = |point: Point, size: Abs| {
        let (x, y) = common::pdf_point(doc, 0, point + Point::new(Abs::zero(), -size * 0.4));
        s.inverse(InverseParams { page: 1, x, y }).unwrap()
    };

    // Margin line numbers (left of the 40 pt text column) go to the start of the text of their line.
    let numbers: Vec<_> = glyphs
        .iter()
        .filter(|g| g.detached && g.point.x < Abs::pt(40.0))
        .collect();
    assert!(numbers.len() >= 5, "{} line numbers", numbers.len());
    let mut targets = HashSet::new();
    for number in &numbers {
        let line = glyphs
            .iter()
            .find(|g| !g.detached && (g.point.y - number.point.y).abs() < Abs::pt(0.5))
            .expect("text on the numbered line");
        let expected = click(
            line.point + Point::new(Abs::pt(0.5), Abs::zero()),
            line.size,
        );
        let actual = click(
            number.point + Point::new(number.width / 2.0, Abs::zero()),
            number.size,
        );
        assert!(expected.is_some());
        assert_eq!(actual, expected, "line number {}", number.text);
        let loc = actual.unwrap();
        targets.insert((loc.line, loc.character));
    }
    assert_eq!(
        targets.len(),
        numbers.len(),
        "each line number goes to its own line"
    );

    // The page number gives the same as a click straight up on the last line of text.
    let page_number = glyphs
        .iter()
        .find(|g| g.detached && g.point.x >= Abs::pt(40.0))
        .expect("page number");
    let last_line = glyphs
        .iter()
        .filter(|g| !g.detached)
        .max_by_key(|g| g.point.y)
        .unwrap();
    let x = page_number.point.x + page_number.width / 2.0;
    let expected = click(Point::new(x, last_line.point.y), last_line.size);
    assert!(expected.is_some());
    assert_eq!(
        click(Point::new(x, page_number.point.y), page_number.size),
        expected
    );
}

#[test]
fn generated_text_in_template_elements_does_not_jump_into_the_template() {
    // The figure and its caption element are built in the imported `tpl.typ`; the caption prefix "Figure 1:" has no span of its own.
    let (root, _g) = common::fixture("template-figure");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let click = |needle: &str| {
        let (page, pt, size) = common::find_text(doc, needle).unwrap();
        let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(1.0), -size * 0.4));
        s.inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
    };
    // "F" is more than 24 pt from the caption's own words: no location, and not the template.
    assert_eq!(click("Figure"), None);
    // ":" is next to "Caption": the nearest glyph, in the user's file.
    let loc = click(":").expect("nearest glyph");
    assert!(loc.path.ends_with("main.typ"), "{loc:?}");
}

#[test]
fn line_numbers_in_two_columns_and_the_page_number_use_the_nearest_glyph() {
    // Typst lays out the line numbers of a column after that column's content: the paragraph that continues into column 2 is still open (and ends on this page) when column 1's numbers are painted. The numbers are artifacts, where the search for an enclosing element stops.
    let (root, _g) = common::fixture("twocol");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let glyphs = common::first_glyphs(doc, 0);
    let click = |point: Point| {
        let (x, y) = common::pdf_point(doc, 0, point);
        s.inverse(InverseParams { page: 1, x, y }).unwrap()
    };
    let numbers: Vec<_> = glyphs
        .iter()
        .filter(|g| g.detached && g.text.chars().all(|c| c.is_ascii_digit()))
        .collect();
    assert!(
        numbers.len() >= 15,
        "14 line numbers and the page number, got {}",
        numbers.len()
    );
    let mut column_one = HashSet::new();
    let mut column_one_count = 0;
    for number in &numbers {
        let point = number.point + Point::new(number.width / 2.0, -number.size * 0.4);
        let actual = click(point);
        let expected =
            common::nearest_glyph_point(doc, 0, point, |span| !span.is_detached()).and_then(click);
        assert_eq!(
            actual, expected,
            "number {} at {:?}",
            number.text, number.point
        );
        if number.point.x < Abs::pt(40.0) {
            // Column 1 (numbers in the left margin): the start of the text of its own line.
            let line = glyphs
                .iter()
                .find(|g| !g.detached && (g.point.y - number.point.y).abs() < Abs::pt(0.5))
                .expect("text on the numbered line");
            assert_eq!(
                actual,
                click(line.point + Point::new(Abs::pt(0.5), -line.size * 0.4)),
                "number {}",
                number.text
            );
            let loc = actual.unwrap();
            column_one.insert((loc.line, loc.character));
            column_one_count += 1;
        }
    }
    assert_eq!(column_one_count, 10);
    assert_eq!(
        column_one.len(),
        column_one_count,
        "each column 1 number goes to its own line"
    );
}

#[test]
fn template_text_goes_to_the_users_element() {
    // The template writes "Appendix" before each heading's body and the parentheses of equation numbers.
    let (root, _g) = common::fixture("template-text");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let click = |needle: &str| {
        let (page, pt, size) = common::find_text(doc, needle).unwrap();
        let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(1.0), -size * 0.4));
        s.inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
        .expect(needle)
    };
    let at = |needle: &str| {
        let loc = click(needle);
        assert!(loc.path.ends_with("main.typ"), "{needle}: {loc:?}");
        (loc.line, loc.character)
    };
    assert_eq!(at("Appendix"), (3, 0), "the heading `= Results`");
    assert_eq!(at("(1)"), (5, 0), "the equation");
    assert_eq!(
        at("Results"),
        (3, 2),
        "the heading's own words keep their position"
    );
}

#[test]
fn template_text_in_a_header_uses_the_nearest_glyph_outside_the_template() {
    // The header is written in the imported template and is an artifact: the search stops there and the nearest glyph outside the template is used.
    let (root, _g) = common::fixture("words-template");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let (page, pt, size) = common::find_text(doc, "Template").unwrap();
    let point = pt + Point::new(Abs::pt(1.0), -size * 0.4);
    let (x, y) = common::pdf_point(doc, page, point);
    let actual = s
        .inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap();
    let outside_template = |span: typst::syntax::Span| {
        span.id()
            .is_some_and(|id| !id.vpath().get_without_slash().ends_with("tpl.typ"))
    };
    let expected = common::nearest_glyph_point(doc, page, point, outside_template).map(|p| {
        let (x, y) = common::pdf_point(doc, page, p);
        s.inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
        .unwrap()
    });
    assert!(
        expected
            .as_ref()
            .is_some_and(|loc| loc.path.ends_with("main.typ")),
        "{expected:?}"
    );
    assert_eq!(actual, expected);
}

#[test]
fn template_text_inside_a_users_paragraph_uses_the_nearest_glyph() {
    // `todo` writes the label "To do:" in the imported template, inside the user's paragraph. Paragraphs are not targets: the nearest glyph of the user's file is used, not the start of the paragraph.
    let (root, _g) = common::fixture("todo");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let (page, pt, size) = common::find_text(doc, "To do").unwrap();
    let point = pt + Point::new(Abs::pt(1.0), -size * 0.4);
    let (x, y) = common::pdf_point(doc, page, point);
    let actual = s
        .inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap();
    let in_main = |span: typst::syntax::Span| {
        span.id()
            .is_some_and(|id| id.vpath().get_without_slash().ends_with("main.typ"))
    };
    let expected = common::nearest_glyph_point(doc, page, point, in_main)
        .map(|p| {
            let (x, y) = common::pdf_point(doc, page, p);
            s.inverse(InverseParams {
                page: page + 1,
                x,
                y,
            })
            .unwrap()
            .unwrap()
        })
        .expect("a glyph of main.typ within 24 pt");
    assert!(
        expected.path.ends_with("main.typ") && (expected.line, expected.character) != (2, 0),
        "{expected:?}"
    );
    assert_eq!(actual, Some(expected));
}

#[test]
fn user_text_in_a_header_keeps_its_position() {
    // `title` is written in main.typ and shown in the header of every page.
    let (root, _g) = common::fixture("words-repeat");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    for page in 0..2 {
        let (pt, size) = common::find_text_on_page(doc, page, "Repeated").unwrap();
        let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(1.0), -size * 0.4));
        let loc = s
            .inverse(InverseParams {
                page: page + 1,
                x,
                y,
            })
            .unwrap()
            .unwrap();
        assert_eq!((loc.line, loc.character), (0, 14), "page {page}");
    }
}

#[test]
fn forward_on_word_and_round_trip() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let body = root
        .join("sections/body.typ")
        .to_string_lossy()
        .into_owned();
    let r = s
        .forward(ForwardParams {
            path: body.clone(),
            line: 0,
            character: 7,
        })
        .unwrap();
    let p = &r.positions[0];
    assert!(p.left < p.x && p.x < p.right && p.bottom < p.y && p.y < p.top);
    assert_at(&inverse_at_marker(&s, p), "sections/body.typ", 0, 7);
}

#[test]
fn forward_in_a_wrapped_paragraph_marks_the_line_of_the_cursor() {
    // The paragraph is one line of source and one `Text` node; it wraps onto several lines of the PDF, each a run of glyphs with that span.
    let (root, _g) = common::fixture("wrapped");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let text: Vec<_> = common::glyphs(doc)
        .into_iter()
        .filter(|g| g.page == 0 && !g.span.is_detached())
        .collect();
    let lines = common::baselines(doc, 0, text[0].span);
    assert!(lines.len() >= 3, "{} lines", lines.len());
    // The cursor before the second word of the third line (ASCII text from column 0, so the byte offset is the character).
    let third: Vec<_> = text
        .iter()
        .filter(|g| (g.baseline - lines[2]).abs() < Abs::pt(0.5))
        .collect();
    let glyph = third
        .windows(2)
        .find(|w| w[0].text == " " && w[1].text.chars().all(char::is_alphabetic))
        .map(|w| w[1])
        .expect("a word start on the third line");
    let character = usize::from(glyph.offset);
    let main = root.join("main.typ").to_string_lossy().into_owned();
    let p = s
        .forward(ForwardParams {
            path: main,
            line: 1,
            character,
        })
        .unwrap()
        .positions[0];
    let (left, baseline) = common::pdf_point(doc, 0, Point::new(glyph.left, glyph.baseline));
    let (right, _) = common::pdf_point(doc, 0, Point::new(glyph.right, glyph.baseline));
    assert_eq!(p.page, 1);
    assert!(
        p.bottom < baseline && baseline < p.top,
        "{p:?} is not on the third line (baseline {baseline})"
    );
    assert!(
        (p.x - left).abs() < 0.01 && p.x < right,
        "marker at {} instead of the glyph at {left}..{right}",
        p.x
    );
    assert_at(&inverse_at_marker(&s, &p), "main.typ", 1, character);
}

#[test]
fn forward_after_an_emoji_marks_the_word_at_the_cursor() {
    // The emoji and the words after it are one `Text` node set in two fonts: two runs on one line.
    let (root, _g) = common::fixture("emoji");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    assert_eq!(
        common::count_text(doc, "😀 zebra"),
        0,
        "the emoji and \"zebra\" are separate text items"
    );
    let main = root.join("main.typ").to_string_lossy().into_owned();
    // "😀 " is 2 + 1 UTF-16 units: the cursor is before "zebra".
    let p = s
        .forward(ForwardParams {
            path: main,
            line: 1,
            character: 3,
        })
        .unwrap()
        .positions[0];
    let (page, pt, _) = common::find_text(doc, "zebra").unwrap();
    let (zx, _) = common::pdf_point(doc, page, pt);
    assert_eq!(p.page, page + 1);
    assert!(
        (p.x - zx).abs() < 0.01,
        "marker at {} instead of the \"z\" at {zx}",
        p.x
    );
    assert_at(&inverse_at_marker(&s, &p), "main.typ", 1, 3);
}

#[test]
fn forward_on_a_title_prefers_the_title_block_to_the_running_header() {
    // `title` is shown in the header of both pages (an artifact) and in a 14 pt title block on page 1, which is painted after that page's header.
    let (root, _g) = common::fixture("running-title");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let main = root.join("main.typ").to_string_lossy().into_owned();
    // The cursor on the "R" of `#let title = [Running title words]`.
    let ps = s
        .forward(ForwardParams {
            path: main,
            line: 0,
            character: 14,
        })
        .unwrap()
        .positions;
    assert_eq!(ps.len(), 3, "{ps:?}");
    let first = ps[0];
    assert_eq!(first.page, 1);
    assert!(
        ((first.top - first.bottom) / 1.25 - 14.0).abs() < 0.01,
        "the 14 pt title block comes first: {ps:?}"
    );
    assert_at(&inverse_at_marker(&s, &first), "main.typ", 0, 14);
}

#[test]
fn forward_from_code_line_uses_nearest_text() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let main = root.join("main.typ").to_string_lossy().into_owned();
    assert!(
        !s.forward(ForwardParams {
            path: main,
            line: 1,
            character: 5
        })
        .unwrap()
        .positions
        .is_empty()
    );
}

#[test]
fn forward_prefers_body_over_outline_entry() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let body = root
        .join("sections/body.typ")
        .to_string_lossy()
        .into_owned();
    let ps = s
        .forward(ForwardParams {
            path: body,
            line: 8,
            character: 4,
        })
        .unwrap()
        .positions;
    assert!(
        ps.len() >= 2,
        "heading appears in the outline and in the body"
    );
    // Reading order is (page ascending, top descending); the body heading is the later one and must be listed first.
    let first = &ps[0];
    assert!(
        ps[1..]
            .iter()
            .all(|o| (o.page, -o.top) < (first.page, -first.top)),
        "body heading comes first"
    );
}

#[test]
fn forward_tolerates_stale_positions() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let body = root
        .join("sections/body.typ")
        .to_string_lossy()
        .into_owned();
    assert!(
        s.forward(ForwardParams {
            path: body,
            line: 500,
            character: 3
        })
        .is_ok()
    );
    let other = root.join("not-in-doc.typ");
    std::fs::write(&other, "Text").unwrap();
    assert!(
        s.forward(ForwardParams {
            path: other.to_string_lossy().into_owned(),
            line: 0,
            character: 1
        })
        .unwrap()
        .positions
        .is_empty()
    );
}

#[test]
fn forward_past_the_end_uses_the_last_text() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let body = root
        .join("sections/body.typ")
        .to_string_lossy()
        .into_owned();
    let p = s
        .forward(ForwardParams {
            path: body,
            line: 500,
            character: 3,
        })
        .unwrap()
        .positions[0];
    // The last glyph of the last text line, the "." of "Epsilon zeta eta.".
    assert_at(&inverse_at_marker(&s, &p), "sections/body.typ", 9, 16);
}

#[test]
fn forward_marks_the_glyph_at_the_cursor() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let doc = s.document().unwrap();
    let body = root
        .join("sections/body.typ")
        .to_string_lossy()
        .into_owned();
    // The cursor before "gamma" (character 11) marks the left edge of its "g".
    let p = s
        .forward(ForwardParams {
            path: body,
            line: 0,
            character: 11,
        })
        .unwrap()
        .positions[0];
    let (page, pt, size) = common::find_text(doc, "gamma").unwrap();
    let (gx, baseline) = common::pdf_point(doc, page, pt);
    assert_eq!(p.page, page + 1);
    assert!((p.x - gx).abs() < 0.01, "{} vs {gx}", p.x);
    let size = size.to_pt();
    assert!(
        (p.top - (baseline + size)).abs() < 0.01
            && (p.bottom - (baseline - 0.25 * size)).abs() < 0.01,
        "{p:?}"
    );
    assert!((p.y - (p.top + p.bottom) / 2.0).abs() < 0.01);
    assert_at(&inverse_at_marker(&s, &p), "sections/body.typ", 0, 11);
}

#[test]
fn forward_on_math_and_after_a_failed_compile() {
    let (root, _g) = common::fixture("words");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let more = root.join("more.typ").to_string_lossy().into_owned();
    // The cursor on the "y" of `$x + y$` (line 7).
    let ps = s
        .forward(ForwardParams {
            path: more.clone(),
            line: 7,
            character: 5,
        })
        .unwrap()
        .positions;
    assert_eq!(ps.len(), 1, "{ps:?}");
    // An error appended to the file: lookups still answer from the last good document.
    let text = std::fs::read_to_string(root.join("more.typ")).unwrap();
    std::fs::write(root.join("more.typ"), format!("{text}#nope\n")).unwrap();
    assert!(!s.compile().unwrap().success);
    let again = s
        .forward(ForwardParams {
            path: more,
            line: 7,
            character: 5,
        })
        .unwrap()
        .positions;
    assert_eq!(again, ps);
}

#[test]
fn forward_outside_the_project_and_before_compile() {
    let (root, g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    let body = root
        .join("sections/body.typ")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        s.forward(ForwardParams {
            path: body,
            line: 0,
            character: 0
        })
        .unwrap_err(),
        "no successful compilation yet"
    );
    s.compile().unwrap();
    let outside = g.path().join("outside.typ");
    std::fs::write(&outside, "Alpha beta").unwrap();
    for path in [outside, root.join("missing.typ")] {
        let r = s
            .forward(ForwardParams {
                path: path.to_string_lossy().into_owned(),
                line: 0,
                character: 1,
            })
            .unwrap();
        assert!(r.positions.is_empty());
    }
}

#[test]
fn inverse_on_prose_word() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let (page, pt, size) = common::find_text(s.document().unwrap(), "beta").unwrap();
    let (x, y) = common::pdf_point(
        s.document().unwrap(),
        page,
        pt + Point::new(Abs::pt(2.0), -size * 0.4),
    );
    let loc = s
        .inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
        .unwrap();
    assert!(loc.path.ends_with("sections/body.typ"));
    assert_eq!(loc.line, 0);
    assert!((6..=10).contains(&loc.character));
}

#[test]
fn inverse_on_citation_and_reference_returns_source_not_link() {
    // The citation label (rendered "[1]" in the default IEEE style) and "Section 1" (reference) are links; inverse must land on line 2 of body.typ.
    for needle in ["[1]", "Section"] {
        let (root, _g) = common::fixture("basic");
        let mut s = common::session_for(&root, "main.typ");
        s.compile().unwrap();
        let (page, pt, size) =
            common::find_text_after(s.document().unwrap(), needle, "See").unwrap();
        let (x, y) = common::pdf_point(
            s.document().unwrap(),
            page,
            pt + Point::new(Abs::pt(1.0), -size * 0.4),
        );
        let loc = s
            .inverse(InverseParams {
                page: page + 1,
                x,
                y,
            })
            .unwrap()
            .expect(needle);
        assert!(loc.path.ends_with("sections/body.typ"), "{needle}");
        assert_eq!(loc.line, 2, "{needle}");
    }
}

#[test]
fn inverse_on_generated_text_goes_to_the_element_that_produced_it() {
    // "Section 1" has no source span of its own; its enclosing `ref` element is `@sec:intro`.
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let doc = s.document().unwrap();
    for (dx, size_factor) in [(1.0, 0.4), (20.0, 0.2)] {
        let (page, pt, size) = common::find_text_after(doc, "Section", "See").unwrap();
        let (x, y) =
            common::pdf_point(doc, page, pt + Point::new(Abs::pt(dx), -size * size_factor));
        let loc = s
            .inverse(InverseParams {
                page: page + 1,
                x,
                y,
            })
            .unwrap()
            .unwrap();
        assert!(loc.path.ends_with("sections/body.typ"), "{loc:?}");
        assert_eq!((loc.line, loc.character), (2, 4), "the `@` of `@sec:intro`");
    }
}

#[test]
fn inverse_on_generated_text_without_a_project_element_falls_back_to_the_nearest_glyph() {
    // The page number is generated inside elements without source spans (`artifact`, `counter-display`).
    let (root, _g) = common::fixture("bleed");
    for (height, expected) in [(60.0, Some(1)), (100.0, None)] {
        std::fs::write(
            root.join("main.typ"),
            format!("#set page(width: 200pt, height: {height}pt, margin: 20pt, numbering: \"1\")\n#align(center)[Body word.]\n"),
        )
        .unwrap();
        let mut s = common::session_for(&root, "main.typ");
        s.compile().unwrap();
        let doc = s.document().unwrap();
        let (page, pt, size) = common::find_text_after(doc, "1", "Body").unwrap();
        let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(1.0), -size * 0.4));
        let loc = s
            .inverse(InverseParams {
                page: page + 1,
                x,
                y,
            })
            .unwrap();
        assert_eq!(loc.map(|loc| loc.line), expected, "page height {height}");
    }
}

#[test]
fn inverse_on_table_cell_and_image() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let doc = s.document().unwrap();
    let (page, pt, size) = common::find_text(doc, "two").unwrap();
    let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(1.0), -size * 0.4));
    let loc = s
        .inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
        .unwrap();
    assert_eq!(loc.line, 4);
    let (ipage, ipt) = common::find_image(doc).unwrap(); // top-left of the image item
    let (x, y) = common::pdf_point(doc, ipage, ipt + Point::new(Abs::pt(25.0), Abs::pt(25.0)));
    let loc = s
        .inverse(InverseParams {
            page: ipage + 1,
            x,
            y,
        })
        .unwrap()
        .unwrap();
    assert_eq!(loc.line, 6);
}

#[test]
fn clicks_on_decorations_go_to_the_decorated_word() {
    // Strikes and underlines are lines without spans drawn over or under the words, highlights are rectangles without spans behind them; `del`, `add` and `mark` draw them from the imported template.
    let (root, _g) = common::fixture("decorations");
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let source = std::fs::read_to_string(root.join("main.typ")).unwrap();
    let shapes = common::shapes(doc);
    let mut wrong = Vec::new();
    for (word, drawn_as_line) in [
        ("struck", true),
        ("lined", true),
        ("marked", false),
        ("removed", true),
        ("inserted", true),
        ("noted", false),
    ] {
        let w = common::find_word(doc, word).expect(word);
        let middle = (w.left + w.right) / 2.0;
        let click = if drawn_as_line {
            // A point on the strike or underline across the word.
            let line = shapes
                .iter()
                .find(|sh| {
                    sh.page == w.page
                        && sh.detached
                        && sh.line
                        && sh.min.x < middle
                        && middle < sh.max.x
                        && (sh.min.y - w.baseline).abs() < w.size
                })
                .unwrap_or_else(|| panic!("no line across {word}"));
            Point::new(middle, line.min.y)
        } else {
            // A point of the highlight below the baseline, outside the glyphs' hit boxes.
            let point = Point::new(middle, w.baseline + w.size * 0.1);
            assert!(
                shapes.iter().any(|sh| sh.page == w.page
                    && sh.detached
                    && !sh.line
                    && sh.min.x < point.x
                    && point.x < sh.max.x
                    && sh.min.y < point.y
                    && point.y < sh.max.y),
                "no highlight under {word}"
            );
            point
        };
        let (x, y) = common::pdf_point(doc, w.page, click);
        let loc = s
            .inverse(InverseParams {
                page: w.page + 1,
                x,
                y,
            })
            .unwrap()
            .unwrap_or_else(|| panic!("{word}: no source"));
        let needle = format!("[{word}]");
        let (line, text) = source
            .lines()
            .enumerate()
            .find(|(_, text)| text.contains(&needle))
            .unwrap();
        let start = text.find(&needle).unwrap() + 1;
        if !(loc.path.ends_with("main.typ")
            && loc.line == line
            && (start..=start + word.len()).contains(&loc.character))
        {
            wrong.push(format!(
                "{word}: {}:{}, expected {line}:{start}..={}",
                loc.line,
                loc.character,
                start + word.len()
            ));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn inverse_far_from_content_is_null_and_near_text_snaps() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    assert!(
        s.inverse(InverseParams {
            page: 1,
            x: 2.0,
            y: 2.0
        })
        .unwrap()
        .is_none()
    );
    let (page, pt, _) = common::find_text(s.document().unwrap(), "Alpha").unwrap();
    let (x, y) = common::pdf_point(
        s.document().unwrap(),
        page,
        pt + Point::new(Abs::pt(1.0), Abs::pt(3.0)),
    ); // just below the baseline
    assert!(
        s.inverse(InverseParams {
            page: page + 1,
            x,
            y
        })
        .unwrap()
        .is_some()
    );
}

#[test]
fn bleed_coordinates() {
    let (root, _g) = common::fixture("bleed");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let doc = s.document().unwrap();
    let (page, pt, size) = common::find_text(doc, "Bleed").unwrap();
    let (x, y) = common::pdf_point(doc, page, pt);
    assert!((x - 15.0).abs() < 0.01, "x = margin 10 + bleed 5, got {x}");
    assert!(y > 0.0 && y < 110.0);
    let (cx, cy) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(2.0), -size * 0.4));
    assert_eq!(
        s.inverse(InverseParams {
            page: 1,
            x: cx,
            y: cy
        })
        .unwrap()
        .unwrap()
        .line,
        1
    );
}

#[test]
fn pdf_and_frame_coordinates_round_trip() {
    let (root, _g) = common::fixture("bleed");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let page = &s.document().unwrap().pages()[0];
    // Frame 200 × 100 pt with 5 pt bleed: the MediaBox is 210 × 110 pt, the frame origin is at PDF (5, 105).
    assert_eq!(coords::frame_to_pdf(page, Point::zero()), (5.0, 105.0));
    assert_eq!(
        coords::frame_to_pdf(page, Point::new(Abs::pt(200.0), Abs::pt(100.0))),
        (205.0, 5.0)
    );
    let back = coords::pdf_to_frame(page, 42.5, 17.25);
    assert_eq!(coords::frame_to_pdf(page, back), (42.5, 17.25));
}

#[test]
fn inverse_location_is_utf16() {
    let (root, _g) = common::fixture("broken");
    std::fs::write(root.join("main.typ"), "Hello.\n😀 ünïcode word\n").unwrap();
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let (page, pt, size) = common::find_text(doc, "word").unwrap();
    let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(1.0), -size * 0.4));
    let loc = s
        .inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
        .unwrap();
    // "😀 ünïcode " is 2 + 1 + 7 + 1 UTF-16 units.
    assert_eq!((loc.line, loc.character), (1, 11));
}

#[test]
fn inverse_in_an_included_file_with_a_bom_and_another_extension() {
    // Offsets of glyphs count in the parsed source, which (like the editor) has no byte order mark.
    let (root, _g) = common::fixture("broken");
    std::fs::write(root.join("main.typ"), "#include \"chapter.txt\"\n").unwrap();
    std::fs::write(root.join("chapter.txt"), "\u{FEFF}Alpha beta gamma.\n").unwrap();
    let mut s = common::session_for(&root, "main.typ");
    assert!(s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let (page, pt, size) = common::find_text(doc, "beta").unwrap();
    let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(1.0), -size * 0.4));
    let loc = s
        .inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
        .unwrap();
    assert!(loc.path.ends_with("chapter.txt"), "{loc:?}");
    assert_eq!((loc.line, loc.character), (0, 6));
}

#[test]
fn inverse_answers_from_the_last_good_document_after_a_failed_compile() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    let body = std::fs::read_to_string(root.join("sections/body.typ")).unwrap();
    std::fs::write(root.join("sections/body.typ"), format!("{body}#nope\n")).unwrap();
    assert!(!s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let (page, pt, size) = common::find_text(doc, "beta").unwrap();
    let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(2.0), -size * 0.4));
    let loc = s
        .inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
        .unwrap();
    assert!(loc.path.ends_with("sections/body.typ"));
    assert_eq!(loc.line, 0);
    assert!((6..=10).contains(&loc.character));
}

#[test]
fn inverse_tolerates_a_file_removed_since_the_last_build() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    s.compile().unwrap();
    std::fs::remove_file(root.join("sections/body.typ")).unwrap();
    assert!(!s.compile().unwrap().success);
    let doc = s.document().unwrap();
    let (page, pt, size) = common::find_text(doc, "beta").unwrap();
    let (x, y) = common::pdf_point(doc, page, pt + Point::new(Abs::pt(2.0), -size * 0.4));
    if let Some(loc) = s
        .inverse(InverseParams {
            page: page + 1,
            x,
            y,
        })
        .unwrap()
    {
        assert!(!loc.path.ends_with("sections/body.typ"), "{loc:?}");
    }
}

#[test]
fn inverse_on_a_missing_page_is_null_and_before_compile_an_error() {
    let (root, _g) = common::fixture("basic");
    let mut s = common::session_for(&root, "main.typ");
    assert_eq!(
        s.inverse(InverseParams {
            page: 1,
            x: 50.0,
            y: 50.0
        })
        .unwrap_err(),
        "no successful compilation yet"
    );
    s.compile().unwrap();
    for page in [0, 2, 99] {
        assert!(
            s.inverse(InverseParams {
                page,
                x: 50.0,
                y: 50.0
            })
            .unwrap()
            .is_none()
        );
    }
}

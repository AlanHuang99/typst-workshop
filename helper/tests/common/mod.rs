//! Shared helpers for the helper's integration tests: fixture copies in temporary directories and initialized sessions.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tempfile::TempDir;
use typst::layout::{Abs, Frame, FrameItem, Point, Transform};
use typst::syntax::Span;
use typst::text::TextItem;
use typst::visualize::Geometry;
use typst_layout::PagedDocument;
use typst_workshop_helper::protocol::InitializeParams;
use typst_workshop_helper::{Session, coords};

/// The fixture directory `tests/fixtures/<name>`.
pub fn fixture_source(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// Copies the fixture into a fresh temporary directory; returns the copy's root and the guard that keeps it alive.
pub fn fixture(name: &str) -> (PathBuf, TempDir) {
    fixture_in(name, name)
}

/// Like [`fixture`], but the copy's last path component is `dir_name`.
pub fn fixture_in(name: &str, dir_name: &str) -> (PathBuf, TempDir) {
    let guard = TempDir::new().expect("create temporary directory");
    let root = guard.path().join(dir_name);
    copy_dir(&fixture_source(name), &root);
    (root, guard)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// Initialize parameters for `<root>/<main_rel>` with the PDF at `<root>/<stem>.pdf`, no font paths and no inputs.
pub fn init_params(root: &Path, main_rel: &str) -> InitializeParams {
    let main = root.join(main_rel);
    let stem = main.file_stem().unwrap().to_string_lossy().into_owned();
    InitializeParams {
        root: root.to_string_lossy().into_owned(),
        main: main.to_string_lossy().into_owned(),
        output: root
            .join(format!("{stem}.pdf"))
            .to_string_lossy()
            .into_owned(),
        font_paths: Vec::new(),
        inputs: BTreeMap::new(),
    }
}

/// A session already initialized with [`init_params`].
pub fn session_for(root: &Path, main_rel: &str) -> Session {
    let mut session = Session::new();
    session
        .initialize(init_params(root, main_rel))
        .expect("initialize");
    session
}

/// The PDF point (PDF user space of the page) of a point in the page frame.
pub fn pdf_point(doc: &PagedDocument, page_index: usize, frame_point: Point) -> (f64, f64) {
    coords::frame_to_pdf(&doc.pages()[page_index], frame_point)
}

/// A text item in paint order: page index, the transform from the item's frame to the page frame, the item's position in its frame, and the item.
struct PlacedText<'a> {
    page: usize,
    ts: Transform,
    pos: Point,
    item: &'a TextItem,
}

fn text_items(doc: &PagedDocument) -> Vec<PlacedText<'_>> {
    fn walk<'a>(page: usize, frame: &'a Frame, ts: Transform, out: &mut Vec<PlacedText<'a>>) {
        for (pos, item) in frame.items() {
            match item {
                FrameItem::Group(group) => {
                    let inner = ts
                        .pre_concat(Transform::translate(pos.x, pos.y))
                        .pre_concat(group.transform);
                    walk(page, &group.frame, inner, out);
                }
                FrameItem::Text(text) => out.push(PlacedText {
                    page,
                    ts,
                    pos: *pos,
                    item: text,
                }),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    for (page, p) in doc.pages().iter().enumerate() {
        walk(page, &p.frame, Transform::identity(), &mut out);
    }
    out
}

/// The page-frame point at the baseline-left of the glyph covering byte `index` of the item's text.
fn glyph_point(text: &PlacedText, index: usize) -> Option<Point> {
    let mut x = text.pos.x;
    for glyph in &text.item.glyphs {
        if glyph.range().end > index {
            return Some(Point::new(x, text.pos.y).transform(text.ts));
        }
        x += glyph.x_advance.at(text.item.size);
    }
    None
}

/// The first text item (paint order) whose text contains `needle`: its page index, the page-frame point at the baseline-left of the needle's first glyph, and the font size.
pub fn find_text(doc: &PagedDocument, needle: &str) -> Option<(usize, Point, Abs)> {
    text_items(doc).iter().find_map(|text| {
        let index = text.item.text.find(needle)?;
        Some((text.page, glyph_point(text, index)?, text.item.size))
    })
}

/// The first glyph of a text item on a page.
pub struct FirstGlyph {
    /// The page-frame point at the glyph's baseline-left.
    pub point: Point,
    /// The glyph's advance width.
    pub width: Abs,
    /// The font size.
    pub size: Abs,
    /// Whether the glyph has no source span (generated text).
    pub detached: bool,
    /// The item's text.
    pub text: String,
}

/// The first glyphs of the text items on the page with index `page`, in paint order.
pub fn first_glyphs(doc: &PagedDocument, page: usize) -> Vec<FirstGlyph> {
    text_items(doc)
        .iter()
        .filter(|text| text.page == page)
        .filter_map(|text| {
            let glyph = text.item.glyphs.first()?;
            Some(FirstGlyph {
                point: Point::new(text.pos.x, text.pos.y).transform(text.ts),
                width: glyph.x_advance.at(text.item.size),
                size: text.item.size,
                detached: glyph.span.0.is_detached(),
                text: text.item.text.to_string(),
            })
        })
        .collect()
}

/// Where the nearest-glyph rule (step 5 of the inverse lookup: the nearest glyph within 24 pt of its hit box) snaps a click on the page, computed independently of the helper: a point inside the nearest glyph that `keep` accepts, on the same side of the glyph's middle as the click, so that a click there gives the same source position. `None` when no such glyph is within 24 pt. Assumes no rotated text.
pub fn nearest_glyph_point(
    doc: &PagedDocument,
    page: usize,
    click: Point,
    keep: impl Fn(Span) -> bool,
) -> Option<Point> {
    let mut best: Option<(Abs, Point)> = None;
    for text in text_items(doc).iter().filter(|text| text.page == page) {
        let mut x = text.pos.x;
        for glyph in &text.item.glyphs {
            let width = glyph.x_advance.at(text.item.size);
            if keep(glyph.span.0) {
                let a = Point::new(x, text.pos.y - text.item.size).transform(text.ts);
                let b = Point::new(x + width, text.pos.y).transform(text.ts);
                let (min, max) = (a.min(b), a.max(b));
                let dx = (min.x - click.x).max(click.x - max.x).max(Abs::zero());
                let dy = (min.y - click.y).max(click.y - max.y).max(Abs::zero());
                let distance = Point::new(dx, dy).hypot();
                if distance <= Abs::pt(24.0) && best.is_none_or(|(d, _)| distance < d) {
                    let middle = (min.x + max.x) / 2.0;
                    let inside_x = if click.x > middle {
                        (middle + max.x) / 2.0
                    } else {
                        (min.x + middle) / 2.0
                    };
                    best = Some((distance, Point::new(inside_x, (min.y + max.y) / 2.0)));
                }
            }
            x += width;
        }
    }
    best.map(|(_, point)| point)
}

/// A glyph as placed on a page, in page-frame coordinates (assumes no rotated text).
pub struct PlacedGlyph {
    pub page: usize,
    /// Left and right edges (the glyph's advance).
    pub left: Abs,
    pub right: Abs,
    pub baseline: Abs,
    /// The font size.
    pub size: Abs,
    pub span: Span,
    /// The glyph's byte offset within its span's node.
    pub offset: u16,
    /// The text the glyph shows.
    pub text: String,
}

/// Every glyph of the document, in paint order.
pub fn glyphs(doc: &PagedDocument) -> Vec<PlacedGlyph> {
    let mut out = Vec::new();
    for text in text_items(doc) {
        let mut x = text.pos.x;
        for glyph in &text.item.glyphs {
            let width = glyph.x_advance.at(text.item.size);
            let a = Point::new(x, text.pos.y).transform(text.ts);
            let b = Point::new(x + width, text.pos.y).transform(text.ts);
            out.push(PlacedGlyph {
                page: text.page,
                left: a.x.min(b.x),
                right: a.x.max(b.x),
                baseline: a.y,
                size: text.item.size,
                span: glyph.span.0,
                offset: glyph.span.1,
                text: text.item.text[glyph.range()].to_string(),
            });
            x += width;
        }
    }
    out
}

/// The baselines of the lines of text with glyphs of `span` on the page with index `page`, top to bottom.
pub fn baselines(doc: &PagedDocument, page: usize, span: Span) -> Vec<Abs> {
    let mut lines: Vec<Abs> = Vec::new();
    for glyph in glyphs(doc) {
        if glyph.page == page
            && glyph.span == span
            && !lines
                .iter()
                .any(|y| (*y - glyph.baseline).abs() < Abs::pt(0.5))
        {
            lines.push(glyph.baseline);
        }
    }
    lines.sort();
    lines
}

/// Where a word is shown, in page-frame coordinates.
pub struct WordBox {
    pub page: usize,
    pub left: Abs,
    pub right: Abs,
    pub baseline: Abs,
    pub size: Abs,
}

/// The first occurrence (paint order) of `needle` within one text item (assumes no rotated text).
pub fn find_word(doc: &PagedDocument, needle: &str) -> Option<WordBox> {
    text_items(doc).iter().find_map(|text| {
        let index = text.item.text.find(needle)?;
        let end = index + needle.len();
        let mut x = text.pos.x;
        let (mut left, mut right) = (None, None);
        for glyph in &text.item.glyphs {
            let width = glyph.x_advance.at(text.item.size);
            let range = glyph.range();
            if range.end > index && range.start < end {
                left.get_or_insert(x);
                right = Some(x + width);
            }
            x += width;
        }
        let a = Point::new(left?, text.pos.y).transform(text.ts);
        let b = Point::new(right?, text.pos.y).transform(text.ts);
        Some(WordBox {
            page: text.page,
            left: a.x.min(b.x),
            right: a.x.max(b.x),
            baseline: a.y,
            size: text.item.size,
        })
    })
}

/// A filled or stroked shape as placed on a page: its bounding box in page-frame coordinates.
pub struct PlacedShape {
    pub page: usize,
    pub min: Point,
    pub max: Point,
    /// Whether it is a line (`Geometry::Line`), as decoration lines are.
    pub line: bool,
    pub detached: bool,
}

/// Every shape of the document, in paint order (assumes no rotation).
pub fn shapes(doc: &PagedDocument) -> Vec<PlacedShape> {
    fn walk(page: usize, frame: &Frame, ts: Transform, out: &mut Vec<PlacedShape>) {
        for (pos, item) in frame.items() {
            match item {
                FrameItem::Group(group) => walk(
                    page,
                    &group.frame,
                    ts.pre_concat(Transform::translate(pos.x, pos.y))
                        .pre_concat(group.transform),
                    out,
                ),
                FrameItem::Shape(shape, span) => {
                    let (from, to, line) = match &shape.geometry {
                        Geometry::Line(to) => (Point::zero(), *to, true),
                        Geometry::Rect(size) => (Point::zero(), size.to_point(), false),
                        Geometry::Curve(curve) => {
                            let bbox = curve.bbox(None);
                            (bbox.min, bbox.max, false)
                        }
                    };
                    let a = (*pos + from).transform(ts);
                    let b = (*pos + to).transform(ts);
                    out.push(PlacedShape {
                        page,
                        min: a.min(b),
                        max: a.max(b),
                        line,
                        detached: span.is_detached(),
                    });
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    for (page, p) in doc.pages().iter().enumerate() {
        walk(page, &p.frame, Transform::identity(), &mut out);
    }
    out
}

/// Like [`find_text`], restricted to the page with index `page`.
pub fn find_text_on_page(doc: &PagedDocument, page: usize, needle: &str) -> Option<(Point, Abs)> {
    text_items(doc)
        .iter()
        .filter(|text| text.page == page)
        .find_map(|text| {
            let index = text.item.text.find(needle)?;
            Some((glyph_point(text, index)?, text.item.size))
        })
}

/// How many text items contain `needle`.
pub fn count_text(doc: &PagedDocument, needle: &str) -> usize {
    text_items(doc)
        .iter()
        .filter(|text| text.item.text.contains(needle))
        .count()
}

/// Like [`find_text`], but the first occurrence of `needle` after the first text item containing `earlier`, on the same page.
pub fn find_text_after(
    doc: &PagedDocument,
    needle: &str,
    earlier: &str,
) -> Option<(usize, Point, Abs)> {
    let items = text_items(doc);
    let first = items
        .iter()
        .position(|text| text.item.text.contains(earlier))?;
    let page = items[first].page;
    let mut from = items[first].item.text.find(earlier)? + earlier.len();
    for text in items[first..].iter().take_while(|text| text.page == page) {
        if let Some(index) = text.item.text[from..].find(needle) {
            return Some((page, glyph_point(text, from + index)?, text.item.size));
        }
        from = 0;
    }
    None
}

/// The first image item: its page index and the page-frame point of its top-left corner.
pub fn find_image(doc: &PagedDocument) -> Option<(usize, Point)> {
    fn walk(frame: &Frame, ts: Transform) -> Option<Point> {
        frame.items().find_map(|(pos, item)| match item {
            FrameItem::Group(group) => walk(
                &group.frame,
                ts.pre_concat(Transform::translate(pos.x, pos.y))
                    .pre_concat(group.transform),
            ),
            FrameItem::Image(..) => Some(pos.transform(ts)),
            _ => None,
        })
    }
    doc.pages()
        .iter()
        .enumerate()
        .find_map(|(page, p)| Some((page, walk(&p.frame, Transform::identity())?)))
}

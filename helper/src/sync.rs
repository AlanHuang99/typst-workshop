//! Lookups between the PDF and the sources: a click on a page to a source position (inverse) and a cursor position to rectangles on the pages (forward).
//!
//! Adapted from typst-ide 0.15.1 crates/typst-ide/src/jump.rs (Apache-2.0).

use std::collections::HashSet;

use typst::World;
use typst::WorldExt;
use typst::introspection::{Location, Tag};
use typst::layout::{Abs, Frame, FrameItem, Point, Size, Transform};
use typst::model::ParElem;
use typst::pdf::ArtifactElem;
use typst::syntax::{FileId, LinkedNode, Side, Source, Span, SpanKind, SyntaxKind, SyntaxNode};
use typst::text::{Glyph, TextItem};
use typst::visualize::{Curve, CurveItem, FillRule, Geometry};
use typst_layout::PagedDocument;

use crate::frames::for_each_item;
use crate::protocol::{PdfRect, SourceLocation};
use crate::world::{HelperWorld, OffsetBase};
use crate::{coords, lines};

/// How far (in pt) from a glyph's hit box a click may land and still snap to that glyph.
const SNAP_DISTANCE_PT: f64 = 24.0;

/// How many lines below, then above, the cursor line the forward lookup searches for text when the cursor line has none.
const NEARBY_LINES: usize = 30;

/// A position in a file: a byte offset and what it was measured in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FilePosition {
    pub id: FileId,
    pub offset: usize,
    pub base: OffsetBase,
}

/// The source position for a click at a point of a page frame. Like `typst_ide::jump_from_click_in_frame` without the link-first step, so a click on a citation or a cross-reference finds its source rather than the link target:
///
/// 1. Items in reverse paint order; groups honour their clip and inverse transform.
/// 2. Text glyphs (hit box from baseline minus font size to the baseline): for `Text` and `MathText` nodes the exact byte offset, rounded to the nearer glyph edge; for other nodes the node start.
/// 3. Filled or stroked shapes and images: the start of their span. Shapes and images whose span is detached or lies in a file of `import_only` (decoration lines such as underlines and strikes, highlights, rules drawn by a template) are skipped and the search continues to the items below them.
/// 4. Hits in package files are skipped and the search continues. A hit whose span is detached (generated text such as the "Section 1" of a reference, line numbers, page numbers) or lies in a file of `import_only` (literal text written in a template) counts as generated text. Generated text goes to the start of the innermost element other than a paragraph that encloses it on the same page (its start and end introspection tags both on that page) and whose span lies in a project file outside `import_only`; the outward walk stops at the first enclosing artifact (page headers, footers and line numbers), and then step 5 applies.
/// 5. If nothing is hit, or generated text has no such element, the nearest glyph within 24 pt of the click (distance to its hit box) whose span lies in a project file outside `import_only`.
pub fn source_from_click(
    world: &HelperWorld,
    frame: &Frame,
    click: Point,
    import_only: &HashSet<FileId>,
) -> Option<FilePosition> {
    let lookup = Lookup {
        world,
        page: frame,
        import_only,
    };
    match hit_in_frame(&lookup, frame, click) {
        Some(Hit::Source(found)) => Some(found),
        Some(Hit::GeneratedWithoutElement) | None => nearest_glyph(&lookup, frame, click),
    }
}

/// What a click lookup reads besides the frame being searched.
struct Lookup<'a> {
    world: &'a HelperWorld,
    /// The page frame, for the introspection tags.
    page: &'a Frame,
    /// Files (templates and function libraries) whose text counts as generated text and whose elements do not receive clicks.
    import_only: &'a HashSet<FileId>,
}

/// Where a hit item's span leads.
enum Origin {
    /// A project file outside `import_only`: the item's own position.
    Own,
    /// Detached or in an import-only file: generated text.
    Generated,
    /// A package file: skipped.
    Package,
}

/// The outcome of the search for the item under the click (steps 1–4).
enum Hit {
    Source(FilePosition),
    /// Generated text with no enclosing element to go to: step 5 applies.
    GeneratedWithoutElement,
}

impl Lookup<'_> {
    fn origin(&self, span: Span) -> Origin {
        match span.id() {
            None => Origin::Generated,
            Some(id) if !self.world.is_project_file(id) => Origin::Package,
            Some(id) if self.import_only.contains(&id) => Origin::Generated,
            Some(_) => Origin::Own,
        }
    }

    /// The hit for generated text: its enclosing element, if any.
    fn generated(&self, item: &FrameItem) -> Hit {
        enclosing_element(self, item).map_or(Hit::GeneratedWithoutElement, Hit::Source)
    }

    /// The hit for a shape or image with the given span; `None` to continue the search. Shapes and images without a span of the user's own (decoration lines, highlights, rules drawn by a template) are skipped like those of packages.
    fn span_hit(&self, span: Span) -> Option<Hit> {
        match self.origin(span) {
            Origin::Own => span_target(self.world, span).map(Hit::Source),
            Origin::Generated | Origin::Package => None,
        }
    }
}

/// Steps 1–4: the topmost item under the click in `frame` (a frame of the page) that leads somewhere.
fn hit_in_frame(lookup: &Lookup, frame: &Frame, click: Point) -> Option<Hit> {
    for &(mut pos, ref item) in frame.items().rev() {
        match item {
            FrameItem::Group(group) => {
                let pos = click - pos;
                if let Some(clip) = &group.clip
                    && !clip.contains(FillRule::NonZero, pos)
                {
                    continue;
                }
                // Realistic transforms should always be invertible. An example of one that isn't is a scale of 0, which would not be clickable anyway.
                let Some(inv_transform) = group.transform.invert() else {
                    continue;
                };
                let pos = pos.transform_inf(inv_transform);
                if let Some(hit) = hit_in_frame(lookup, &group.frame, pos) {
                    return Some(hit);
                }
            }

            FrameItem::Text(text) => {
                for glyph in &text.glyphs {
                    let width = glyph.x_advance.at(text.size);
                    if is_in_rect(
                        Point::new(pos.x, pos.y - text.size),
                        Size::new(width, text.size),
                        click,
                    ) {
                        match lookup.origin(glyph.span.0) {
                            Origin::Own => {
                                let right_half = (click.x - pos.x) > width / 2.0;
                                if let Some(found) = glyph_target(lookup.world, glyph, right_half) {
                                    return Some(Hit::Source(found));
                                }
                            }
                            Origin::Generated => return Some(lookup.generated(item)),
                            Origin::Package => {}
                        }
                    }
                    pos.x += width;
                }
            }

            FrameItem::Shape(shape, span) => {
                let in_fill = shape.fill.is_some()
                    && match &shape.geometry {
                        Geometry::Line(..) => false,
                        Geometry::Rect(size) => is_in_rect(pos, *size, click),
                        Geometry::Curve(curve) => curve.contains(shape.fill_rule, click - pos),
                    };
                let in_stroke = shape.stroke.as_ref().is_some_and(|stroke| {
                    !stroke.thickness.approx_empty() && {
                        // This curve is rooted at (0, 0), not `pos`.
                        let base_curve = match &shape.geometry {
                            Geometry::Line(to) => &Curve(vec![CurveItem::Line(*to)]),
                            Geometry::Rect(size) => &Curve::rect(*size),
                            Geometry::Curve(curve) => curve,
                        };
                        base_curve.stroke_contains(stroke, click - pos)
                    }
                });
                if (in_fill || in_stroke)
                    && let Some(hit) = lookup.span_hit(*span)
                {
                    return Some(hit);
                }
            }

            FrameItem::Image(_, size, span) if is_in_rect(pos, *size, click) => {
                if let Some(hit) = lookup.span_hit(*span) {
                    return Some(hit);
                }
            }

            _ => {}
        }
    }

    None
}

/// The start of the innermost element other than a paragraph that encloses the item `target` on the page and whose span lies in a project file outside `import_only`: its `Tag::Start` comes before the item and its `Tag::End` after it, both on this page (read in paint order through groups). An element that continues onto another page does not count. Paragraphs are passed over: text a template writes into a paragraph, and floats painted while a paragraph is open, belong to the nearest glyph rather than to the paragraph's start. The walk outward stops at the first enclosing artifact: page headers, footers and line numbers are painted after the content of the page or column, where elements of the content can still be open.
fn enclosing_element(lookup: &Lookup, target: &FrameItem) -> Option<FilePosition> {
    struct Open {
        location: Location,
        span: Span,
        artifact: bool,
        paragraph: bool,
    }

    let mut open: Vec<Open> = Vec::new();
    let mut open_at_target: Option<Vec<Open>> = None;
    let mut ended_after_target = HashSet::new();
    for_each_item(lookup.page, &mut |item, _, _| match item {
        FrameItem::Tag(Tag::Start(element, _)) if open_at_target.is_none() => {
            if let Some(location) = element.location() {
                open.push(Open {
                    location,
                    span: element.span(),
                    artifact: element.is::<ArtifactElem>(),
                    paragraph: element.is::<ParElem>(),
                });
            }
        }
        FrameItem::Tag(Tag::End(location, ..)) => {
            if open_at_target.is_some() {
                ended_after_target.insert(*location);
            } else if let Some(index) = open.iter().rposition(|open| open.location == *location) {
                open.remove(index);
            }
        }
        _ if open_at_target.is_none() && std::ptr::eq(item, target) => {
            open_at_target = Some(std::mem::take(&mut open));
        }
        _ => {}
    });
    for element in open_at_target?.iter().rev() {
        if element.artifact {
            return None;
        }
        if !element.paragraph
            && ended_after_target.contains(&element.location)
            && let Some(found) = span_target(lookup.world, element.span)
            && !lookup.import_only.contains(&found.id)
        {
            return Some(found);
        }
    }
    None
}

/// Step 5: the nearest glyph within [`SNAP_DISTANCE_PT`] of the click whose span lies in a project file outside `import_only` and resolves.
fn nearest_glyph(lookup: &Lookup, frame: &Frame, click: Point) -> Option<FilePosition> {
    let mut candidates = Vec::new();
    for_each_item(frame, &mut |item, pos, ts| {
        if let FrameItem::Text(text) = item {
            collect_near_glyphs(lookup, text, pos, ts, click, &mut candidates);
        }
    });
    candidates.sort_by_key(|c| c.distance);
    candidates
        .into_iter()
        .find_map(|c| glyph_target(lookup.world, c.glyph, c.right_half))
}

/// A glyph near the click.
struct NearGlyph<'a> {
    glyph: &'a Glyph,
    /// Distance from the click to the glyph's hit box.
    distance: Abs,
    /// Whether the click lies right of the glyph's middle.
    right_half: bool,
}

/// Collects the glyphs of a text item at `pos` (in a frame with transform `ts` to the page) from project files outside `import_only` whose hit box (bounding box of its corners in page coordinates) lies within [`SNAP_DISTANCE_PT`] of the click.
fn collect_near_glyphs<'a>(
    lookup: &Lookup,
    text: &'a TextItem,
    pos: Point,
    ts: Transform,
    click: Point,
    out: &mut Vec<NearGlyph<'a>>,
) {
    let mut x = pos.x;
    for glyph in &text.glyphs {
        let width = glyph.x_advance.at(text.size);
        if matches!(lookup.origin(glyph.span.0), Origin::Own) {
            let (min, max) = bounding_box(
                ts,
                Point::new(x, pos.y - text.size),
                Point::new(x + width, pos.y),
            );
            let dx = (min.x - click.x).max(click.x - max.x).max(Abs::zero());
            let dy = (min.y - click.y).max(click.y - max.y).max(Abs::zero());
            let distance = Point::new(dx, dy).hypot();
            if distance.to_pt() <= SNAP_DISTANCE_PT {
                out.push(NearGlyph {
                    glyph,
                    distance,
                    right_half: click.x > (min.x + max.x) / 2.0,
                });
            }
        }
        x += width;
    }
}

/// The source position of a glyph: for `Text` and `MathText` nodes the glyph's exact byte offset, or its end when `right_half`; for other nodes the node start. `None` for detached spans, package files and spans that do not resolve.
fn glyph_target(world: &HelperWorld, glyph: &Glyph, right_half: bool) -> Option<FilePosition> {
    let (span, span_offset) = glyph.span;
    let id = span.id()?;
    if !world.is_project_file(id) {
        return None;
    }
    let source = world.source(id).ok()?;
    let node = source.find(span)?;
    let offset = if is_text_kind(node.kind()) {
        let range = node.range();
        let mut offset = range.start + usize::from(span_offset);
        if right_half {
            offset += glyph.range().len();
        }
        offset.min(range.end)
    } else {
        node.offset()
    };
    Some(FilePosition {
        id,
        offset,
        base: OffsetBase::Source,
    })
}

/// The start of a span in a project file, measured in the parsed source for numbered spans and in the file's bytes for range spans; `None` for detached spans and package files.
fn span_target(world: &HelperWorld, span: Span) -> Option<FilePosition> {
    let id = span.id()?;
    if !world.is_project_file(id) {
        return None;
    }
    let base = match span.get() {
        SpanKind::Range { .. } => OffsetBase::Bytes,
        _ => OffsetBase::Source,
    };
    Some(FilePosition {
        id,
        offset: world.range(span)?.start,
        base,
    })
}

/// Whether a rectangle with the given size at the given position contains the click position.
fn is_in_rect(pos: Point, size: Size, click: Point) -> bool {
    pos.x <= click.x && pos.x + size.x >= click.x && pos.y <= click.y && pos.y + size.y >= click.y
}

/// The path, line and UTF-16 character of a position in a file.
pub fn location(world: &HelperWorld, target: FilePosition) -> Option<SourceLocation> {
    let path = world.path_of(target.id)?;
    let position = world.position(target.id, target.offset, target.base)?;
    Some(SourceLocation {
        path: path.to_string_lossy().into_owned(),
        line: position.line,
        character: position.character,
    })
}

/// The rectangles on the pages that show the text at a byte offset of a source (the `forward` request):
///
/// 1. The `Text` or `MathText` leaf at the cursor (`Side::Before`, then `Side::After`); otherwise the nearest such leaf on the same line (right, then left), then on the next 30 lines, then on the previous 30 lines, considering only leaves that appear in the document.
/// 2. Every run of glyphs carrying that leaf's span on every page: `left`/`right` from the run's first and last glyph, `top` = baseline − font size, `bottom` = baseline + 0.25 × font size; `(x, y)` = the left edge of the glyph whose span offset is the largest one not after the cursor, at mid-height.
/// 3. The runs that contain the cursor (the glyph with the largest span offset not after the cursor among all runs) first: a `Text` node is a whole stretch of prose, which wraps across lines and switches fonts. Then runs not covered by a link area (so a heading's body comes before its outline entry), then runs outside artifacts (so a title block comes before the same title in a running header), then by page and vertical position.
pub fn positions_for_cursor(doc: &PagedDocument, source: &Source, byte: usize) -> Vec<PdfRect> {
    let shown = spans_in_document(doc);
    let Some((leaf_start, span)) = leaf_for_cursor(source, byte, &shown) else {
        return Vec::new();
    };
    let cursor = byte as i64 - leaf_start as i64;

    struct Found {
        marker_offset: Option<i64>,
        in_link: bool,
        in_artifact: bool,
        page: usize,
        top: Abs,
        rect: PdfRect,
    }

    let mut found = Vec::new();
    for (index, page) in doc.pages().iter().enumerate() {
        let mut runs = Vec::new();
        let mut links = Vec::new();
        // The elements open at each item in paint order, and whether each is an artifact (page headers, footers, line numbers).
        let mut open: Vec<(Location, bool)> = Vec::new();
        for_each_item(&page.frame, &mut |item, pos, ts| match item {
            FrameItem::Text(text) => {
                let in_artifact = open.iter().any(|&(_, artifact)| artifact);
                collect_runs(text, pos, ts, span, cursor, in_artifact, &mut runs);
            }
            FrameItem::Link(_, size) => links.push(bounding_box(ts, pos, pos + size.to_point())),
            FrameItem::Tag(Tag::Start(element, _)) => {
                if let Some(location) = element.location() {
                    open.push((location, element.is::<ArtifactElem>()));
                }
            }
            FrameItem::Tag(Tag::End(location, ..)) => {
                if let Some(index) = open.iter().rposition(|(open, _)| open == location) {
                    open.remove(index);
                }
            }
            _ => {}
        });
        for run in runs {
            let center = (run.min + run.max) / 2.0;
            let in_link = links.iter().any(|(min, max): &(Point, Point)| {
                min.x <= center.x && center.x <= max.x && min.y <= center.y && center.y <= max.y
            });
            let (left, top) = coords::frame_to_pdf(page, run.min);
            let (right, bottom) = coords::frame_to_pdf(page, run.max);
            let (x, y) = coords::frame_to_pdf(page, run.marker);
            found.push(Found {
                marker_offset: run.marker_offset,
                in_link,
                in_artifact: run.in_artifact,
                page: index,
                top: run.min.y,
                rect: PdfRect {
                    page: index + 1,
                    left,
                    bottom,
                    right,
                    top,
                    x,
                    y,
                },
            });
        }
    }
    let at_cursor = found.iter().filter_map(|f| f.marker_offset).max();
    found.sort_by_key(|f| {
        (
            at_cursor.is_none() || f.marker_offset != at_cursor,
            f.in_link,
            f.in_artifact,
            f.page,
            f.top,
        )
    });
    found.into_iter().map(|f| f.rect).collect()
}

/// The spans of all glyphs in the document.
fn spans_in_document(doc: &PagedDocument) -> HashSet<Span> {
    let mut spans = HashSet::new();
    for page in doc.pages() {
        for_each_item(&page.frame, &mut |item, _, _| {
            if let FrameItem::Text(text) = item {
                spans.extend(text.glyphs.iter().map(|glyph| glyph.span.0));
            }
        });
    }
    spans
}

fn is_text_kind(kind: SyntaxKind) -> bool {
    matches!(kind, SyntaxKind::Text | SyntaxKind::MathText)
}

/// The start offset and span of the text leaf for a cursor (step 1 of [`positions_for_cursor`]).
fn leaf_for_cursor(source: &Source, byte: usize, shown: &HashSet<Span>) -> Option<(usize, Span)> {
    let root = LinkedNode::new(source.root());
    for side in [Side::Before, Side::After] {
        if let Some(leaf) = root.leaf_at(byte, side)
            && is_text_kind(leaf.kind())
            && shown.contains(&leaf.span())
        {
            return Some((leaf.offset(), leaf.span()));
        }
    }

    let mut leaves = Vec::new();
    collect_text_leaves(source.root(), 0, shown, &mut leaves);
    let starts = lines::line_starts(source.text());
    let line_of = |offset: usize| lines::line_of(&starts, offset);
    let line = line_of(byte);
    let on_line = |&&(start, _): &&(usize, Span)| line_of(start) == line;
    let right = leaves
        .iter()
        .filter(on_line)
        .find(|(start, _)| *start >= byte);
    let left = leaves
        .iter()
        .filter(on_line)
        .rfind(|(start, _)| *start < byte);
    let below = || {
        leaves
            .iter()
            .find(|(start, _)| (line + 1..=line + NEARBY_LINES).contains(&line_of(*start)))
    };
    let above = || {
        leaves.iter().rfind(|(start, _)| {
            (line.saturating_sub(NEARBY_LINES)..line).contains(&line_of(*start))
        })
    };
    right.or(left).or_else(below).or_else(above).copied()
}

/// Collects the text leaves (start offset and span) whose span appears in the document, in source order.
fn collect_text_leaves(
    node: &SyntaxNode,
    offset: usize,
    shown: &HashSet<Span>,
    out: &mut Vec<(usize, Span)>,
) {
    if node.children().len() == 0 {
        if is_text_kind(node.kind()) && shown.contains(&node.span()) {
            out.push((offset, node.span()));
        }
        return;
    }
    let mut offset = offset;
    for child in node.children() {
        collect_text_leaves(child, offset, shown, out);
        offset += child.len();
    }
}

/// A run of consecutive glyphs carrying one span, in page-frame coordinates.
struct Run {
    /// The corners of the run's rectangle (the bounding box after group transforms).
    min: Point,
    max: Point,
    /// The marker point.
    marker: Point,
    /// The span offset of the marker glyph, if one is not after the cursor.
    marker_offset: Option<i64>,
    /// Whether the run lies in an artifact (page header, footer, line number).
    in_artifact: bool,
}

/// A run being collected, in the coordinates of its text item's frame.
struct RunBuilder {
    /// Left edge of the first glyph.
    left: Abs,
    /// Right edge of the last glyph so far.
    right: Abs,
    /// Left edge of the marker glyph: the glyph with the largest span offset not after the cursor, else the first glyph.
    marker_x: Abs,
    /// The span offset of the marker glyph, if one is not after the cursor.
    marker_offset: Option<i64>,
}

/// Collects the runs of glyphs with `span` in one text item at `pos` (in a frame with transform `ts` to the page).
fn collect_runs(
    text: &TextItem,
    pos: Point,
    ts: Transform,
    span: Span,
    cursor: i64,
    in_artifact: bool,
    runs: &mut Vec<Run>,
) {
    let mut finish = |run: RunBuilder| {
        let (top, bottom) = (pos.y - text.size, pos.y + text.size * 0.25);
        let (min, max) = bounding_box(ts, Point::new(run.left, top), Point::new(run.right, bottom));
        let marker = Point::new(run.marker_x, (top + bottom) / 2.0).transform(ts);
        runs.push(Run {
            min,
            max,
            marker,
            marker_offset: run.marker_offset,
            in_artifact,
        });
    };
    let mut current: Option<RunBuilder> = None;
    let mut x = pos.x;
    for glyph in &text.glyphs {
        let width = glyph.x_advance.at(text.size);
        if glyph.span.0 == span {
            let run = current.get_or_insert(RunBuilder {
                left: x,
                right: x,
                marker_x: x,
                marker_offset: None,
            });
            run.right = x + width;
            let offset = i64::from(glyph.span.1);
            if offset <= cursor && run.marker_offset.is_none_or(|best| offset > best) {
                run.marker_x = x;
                run.marker_offset = Some(offset);
            }
        } else if let Some(run) = current.take() {
            finish(run);
        }
        x += width;
    }
    if let Some(run) = current.take() {
        finish(run);
    }
}

/// The axis-aligned bounding box (in the outer coordinates) of a rectangle given by two corners in a frame with transform `ts`.
fn bounding_box(ts: Transform, a: Point, b: Point) -> (Point, Point) {
    let corners =
        [a, Point::new(b.x, a.y), Point::new(a.x, b.y), b].map(|corner| corner.transform(ts));
    let min = corners.iter().fold(corners[0], |acc, p| acc.min(*p));
    let max = corners.iter().fold(corners[0], |acc, p| acc.max(*p));
    (min, max)
}

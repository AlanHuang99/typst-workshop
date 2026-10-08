//! Conversions between page-frame points (pt, origin top-left, y down) and PDF points (pt, PDF user space of the page: origin bottom-left of the MediaBox, y up), as typst-pdf places the frame on the page.

use typst::layout::{Abs, Point};
use typst_layout::Page;

/// The height of the page's MediaBox: the frame height plus the top and bottom bleed (typst-pdf makes pages at least 3 pt high).
fn media_height(page: &Page) -> Abs {
    (page.frame.height() + page.bleed.top + page.bleed.bottom).max(Abs::pt(3.0))
}

/// The PDF point of a page-frame point.
pub fn frame_to_pdf(page: &Page, p: Point) -> (f64, f64) {
    let x = p.x + page.bleed.left;
    let y = media_height(page) - (p.y + page.bleed.top);
    (x.to_pt(), y.to_pt())
}

/// The page-frame point of a PDF point.
pub fn pdf_to_frame(page: &Page, x: f64, y: f64) -> Point {
    Point::new(
        Abs::pt(x) - page.bleed.left,
        media_height(page) - Abs::pt(y) - page.bleed.top,
    )
}

//! Walking the items of a page frame and its groups.

use typst::layout::{Frame, FrameItem, Point, Transform};

/// Calls `f` for every item of `frame` and its groups except the groups themselves, in paint order, with the item's position in its own frame and the transform from that frame to `frame` (group positions and transforms composed).
pub fn for_each_item<'a>(frame: &'a Frame, f: &mut impl FnMut(&'a FrameItem, Point, Transform)) {
    walk(frame, Transform::identity(), f);
}

fn walk<'a>(frame: &'a Frame, ts: Transform, f: &mut impl FnMut(&'a FrameItem, Point, Transform)) {
    for (pos, item) in frame.items() {
        match item {
            FrameItem::Group(group) => {
                let inner = ts
                    .pre_concat(Transform::translate(pos.x, pos.y))
                    .pre_concat(group.transform);
                walk(&group.frame, inner, f);
            }
            _ => f(item, *pos, ts),
        }
    }
}

#[cfg(test)]
mod tests {
    use typst::layout::{Abs, GroupItem, Ratio, Size};
    use typst::syntax::Span;
    use typst::visualize::{Color, Geometry};

    use super::*;

    fn square() -> FrameItem {
        FrameItem::Shape(
            Geometry::Rect(Size::splat(Abs::pt(1.0))).filled(Color::BLACK),
            Span::detached(),
        )
    }

    #[test]
    fn items_in_paint_order_with_composed_transforms() {
        let mut inner = Frame::soft(Size::splat(Abs::pt(10.0)));
        inner.push(Point::new(Abs::pt(1.0), Abs::pt(2.0)), square());
        let mut group = GroupItem::new(inner);
        group.transform = Transform::scale(Ratio::new(2.0), Ratio::new(2.0));
        let mut outer = Frame::hard(Size::splat(Abs::pt(50.0)));
        outer.push(
            Point::new(Abs::pt(5.0), Abs::pt(5.0)),
            FrameItem::Group(group),
        );
        outer.push(Point::new(Abs::pt(3.0), Abs::pt(4.0)), square());
        let mut seen = Vec::new();
        for_each_item(&outer, &mut |_, pos, ts| seen.push(pos.transform(ts)));
        // The nested square at (1, 2), scaled by 2 and moved by (5, 5); then the outer square.
        assert_eq!(
            seen,
            vec![
                Point::new(Abs::pt(7.0), Abs::pt(9.0)),
                Point::new(Abs::pt(3.0), Abs::pt(4.0))
            ]
        );
    }
}

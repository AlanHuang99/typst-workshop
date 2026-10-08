//! Word count of the user's own markup text in a compiled document (the `wordCount` request).
//!
//! - A glyph counts as markup text when its span resolves to a project file and its syntax node kind is `Text`, `Space`, `SmartQuote`, `Shorthand` or `Escape`. All other glyphs (code output, math, references, citation labels, heading numbers, bibliography) act as word separators.
//! - Files that the project only imports (templates, function libraries; see [`import_only_files`]) do not count: their glyphs act as word separators.
//! - Text items are read in paint order; a new text item starts a new word unless the previous item ends in a hyphen and the next one starts with a lowercase letter on a later line (end-of-line hyphenation), in which case the parts join and the hyphen is dropped. Typst sets the hyphen of a hyphenated word as its own text item on the line; such an item belongs to the item before it.
//! - A word is a maximal run of letters, digits, and apostrophes or hyphens between letters or digits; it must contain a letter or a digit. Each CJK ideograph, kana or hangul syllable is one word.
//! - Each word is attributed to the file of its first glyph.
//! - Each word counts once per position in the source: a word whose first glyph has the same span and span offset as a word already counted (a title repeated in the running header, a heading repeated in the outline) is not counted again.

use std::collections::{HashMap, HashSet};

use typst::World;
use typst::foundations::PathOrStr;
use typst::layout::{Abs, FrameItem};
use typst::syntax::{FileId, RootedPath, Source, Span, SyntaxKind, SyntaxNode, ast};
use typst::text::TextItem;
use typst_layout::PagedDocument;

use crate::frames::for_each_item;
use crate::protocol::{FileWords, WordCountResult};
use crate::world::HelperWorld;

/// The project files that the project only imports: targets of a literal-path `import` in the project files the last compilation read as Typst sources (whatever their extension) that no literal-path `include` names, other than the main file. Paths resolve as Typst resolves them: relative to the importing file, a leading `/` relative to the root.
pub fn import_only_files(world: &HelperWorld) -> HashSet<FileId> {
    let main = world.main();
    let mut imported = HashSet::new();
    let mut included = HashSet::new();
    for &id in world.sources_read() {
        if let Ok(source) = world.source(id) {
            collect_module_edges(source.root(), id, &mut imported, &mut included);
        }
    }
    imported.retain(|id| *id != main && !included.contains(id) && world.is_project_file(*id));
    imported
}

/// Collects the targets of `import` and `include` with a string literal path in a syntax tree of the file `from`.
fn collect_module_edges(
    node: &SyntaxNode,
    from: FileId,
    imported: &mut HashSet<FileId>,
    included: &mut HashSet<FileId>,
) {
    if let Some(import) = node.cast::<ast::ModuleImport>() {
        imported.extend(literal_target(import.source(), from));
    } else if let Some(include) = node.cast::<ast::ModuleInclude>() {
        included.extend(literal_target(include.source(), from));
    }
    for child in node.children() {
        collect_module_edges(child, from, imported, included);
    }
}

/// The file a string-literal module path names, resolved like Typst resolves it; `None` for other expressions and packages.
fn literal_target(source: ast::Expr, from: FileId) -> Option<FileId> {
    let ast::Expr::Str(path) = source else {
        return None;
    };
    let path = path.get();
    if path.starts_with('@') {
        return None;
    }
    PathOrStr::Str(path.into())
        .resolve(from)
        .ok()
        .map(RootedPath::intern)
}

/// Counts the words of the document by project file, leaving out the files in `import_only` (see [`import_only_files`]).
pub fn count(
    world: &HelperWorld,
    doc: &PagedDocument,
    import_only: &HashSet<FileId>,
) -> WordCountResult {
    let mut counter = Counter::new(world, import_only);
    for (index, page) in doc.pages().iter().enumerate() {
        for_each_item(&page.frame, &mut |item, pos, ts| {
            if let FrameItem::Text(text) = item {
                let line = Line {
                    page: index,
                    baseline: pos.transform(ts).y,
                    size: text.size,
                };
                counter.text(text, line);
            }
        });
    }
    counter.end_word();

    let mut files: Vec<FileWords> = counter
        .words
        .into_iter()
        .filter_map(|(id, words)| {
            let path = world.path_of(id)?.to_string_lossy().into_owned();
            Some(FileWords { path, words })
        })
        .collect();
    files.sort_by(|a, b| b.words.cmp(&a.words).then_with(|| a.path.cmp(&b.path)));
    WordCountResult {
        total: files.iter().map(|file| file.words).sum(),
        files,
    }
}

/// Where a text item sits: page index, baseline in page coordinates and font size.
#[derive(Clone, Copy)]
struct Line {
    page: usize,
    baseline: Abs,
    size: Abs,
}

impl Line {
    /// Whether `next` is on another line than `self` (another page, or a baseline more than half the font size away).
    fn differs(self, next: Line) -> bool {
        self.page != next.page
            || (next.baseline - self.baseline).abs() > self.size.max(next.size) / 2.0
    }
}

/// The glyph a character of markup text comes from: its file, span and span offset.
#[derive(Clone, Copy)]
struct Mark {
    file: FileId,
    span: Span,
    offset: u16,
}

struct Counter<'a> {
    world: &'a HelperWorld,
    /// Files whose glyphs are word separators.
    excluded: &'a HashSet<FileId>,
    /// The project file of each glyph span that is markup text, or `None`.
    markup: HashMap<Span, Option<FileId>>,
    /// The parsed sources by file.
    sources: HashMap<FileId, Option<Source>>,
    /// Words by file.
    words: HashMap<FileId, usize>,
    /// The span and span offset of the first glyph of every word counted.
    counted: HashSet<(Span, u16)>,
    /// The first glyph of the word being read.
    word: Option<Mark>,
    /// Whether the last character read was an apostrophe or hyphen after a letter or digit of the current word.
    after_joiner: bool,
    /// Where the previous text item sits.
    last_line: Option<Line>,
    /// Set when the previous text item ended in a hyphen after a letter or digit (the hyphen dropped): the line of that item.
    hyphen_break: Option<Line>,
}

impl<'a> Counter<'a> {
    fn new(world: &'a HelperWorld, excluded: &'a HashSet<FileId>) -> Self {
        Counter {
            world,
            excluded,
            markup: HashMap::new(),
            sources: HashMap::new(),
            words: HashMap::new(),
            counted: HashSet::new(),
            word: None,
            after_joiner: false,
            last_line: None,
            hyphen_break: None,
        }
    }

    /// Reads one text item; text items are read in paint order.
    fn text(&mut self, text: &TextItem, line: Line) {
        let mut chars = self.chars(text);
        let previous = self.last_line.replace(line);

        // A hyphen set as its own item on the same line ends the item before it.
        if !chars.is_empty()
            && chars.iter().all(|&(c, _)| is_hyphen(c))
            && previous.is_some_and(|prev| !prev.differs(line))
        {
            if self.word.is_some() && !self.after_joiner {
                self.hyphen_break = Some(line);
            }
            return;
        }

        let joins = self
            .hyphen_break
            .take()
            .is_some_and(|prev| prev.differs(line))
            && chars
                .first()
                .is_some_and(|&(c, mark)| mark.is_some() && c.is_lowercase());
        if !joins {
            self.end_word();
        }

        let trailing_hyphen = chars.last().is_some_and(|&(c, _)| is_hyphen(c));
        if trailing_hyphen {
            chars.pop();
        }
        for (c, mark) in chars {
            self.char(c, mark);
        }
        if trailing_hyphen && self.word.is_some() && !self.after_joiner {
            self.hyphen_break = Some(line);
        }
    }

    /// The characters of a text item in text order, each with its glyph when the glyph is markup text. Characters without a glyph are separators.
    fn chars(&mut self, text: &TextItem) -> Vec<(char, Option<Mark>)> {
        let mut glyphs: Vec<_> = text
            .glyphs
            .iter()
            .map(|glyph| (glyph.range(), glyph.span))
            .collect();
        glyphs.sort_by_key(|(range, _)| range.start);
        let mut chars = Vec::with_capacity(text.text.len());
        let mut covered = 0;
        for (range, (span, offset)) in glyphs {
            if range.start < covered {
                // Another glyph of the same cluster.
                continue;
            }
            if range.start > covered {
                chars.push((' ', None));
            }
            let mark = self
                .markup_file(span)
                .map(|file| Mark { file, span, offset });
            chars.extend(
                text.text
                    .get(range.clone())
                    .unwrap_or_default()
                    .chars()
                    .map(|c| (c, mark)),
            );
            covered = range.end;
        }
        chars
    }

    /// The project file of a glyph span whose syntax node is markup text, unless the file is excluded.
    fn markup_file(&mut self, span: Span) -> Option<FileId> {
        if let Some(&file) = self.markup.get(&span) {
            return file;
        }
        let file = span
            .id()
            .filter(|&id| self.world.is_project_file(id) && !self.excluded.contains(&id))
            .filter(|&id| {
                let world = self.world;
                let source = self
                    .sources
                    .entry(id)
                    .or_insert_with(|| world.source(id).ok());
                source
                    .as_ref()
                    .and_then(|source| source.find(span))
                    .is_some_and(|node| {
                        matches!(
                            node.kind(),
                            SyntaxKind::Text
                                | SyntaxKind::Space
                                | SyntaxKind::SmartQuote
                                | SyntaxKind::Shorthand
                                | SyntaxKind::Escape
                        )
                    })
            });
        self.markup.insert(span, file);
        file
    }

    /// Reads one character.
    fn char(&mut self, c: char, mark: Option<Mark>) {
        let Some(mark) = mark else {
            self.end_word();
            return;
        };
        if is_cjk(c) {
            self.end_word();
            self.count(mark);
        } else if c.is_alphanumeric() {
            self.word.get_or_insert(mark);
            self.after_joiner = false;
        } else if is_combining_mark(c) && self.word.is_some() && !self.after_joiner {
            // A combining mark continues its letter.
        } else if is_joiner(c) && self.word.is_some() && !self.after_joiner {
            self.after_joiner = true;
        } else {
            self.end_word();
        }
    }

    /// Ends the word being read and counts it.
    fn end_word(&mut self) {
        if let Some(mark) = self.word.take() {
            self.count(mark);
        }
        self.after_joiner = false;
        self.hyphen_break = None;
    }

    /// Counts a word with the given first glyph for its file, unless a word with the same first glyph position was counted already.
    fn count(&mut self, first: Mark) {
        if self.counted.insert((first.span, first.offset)) {
            *self.words.entry(first.file).or_default() += 1;
        }
    }
}

/// Hyphens, including the soft hyphen Typst sets at a hyphenated line end.
fn is_hyphen(c: char) -> bool {
    matches!(c, '-' | '\u{00AD}' | '\u{2010}' | '\u{2011}')
}

/// Apostrophes and hyphens, which join letters or digits on both sides into one word.
fn is_joiner(c: char) -> bool {
    is_hyphen(c) || matches!(c, '\'' | '\u{2019}' | '\u{02BC}')
}

/// CJK ideographs, kana and hangul syllables.
fn is_cjk(c: char) -> bool {
    let punctuation = matches!(c, '\u{30A0}' | '\u{30FB}'); // ゠ and ・ in the Katakana block
    !punctuation
        && matches!(c,
            '\u{3040}'..='\u{30FF}'       // Hiragana, Katakana
            | '\u{31F0}'..='\u{31FF}'     // Katakana Phonetic Extensions
            | '\u{3400}'..='\u{4DBF}'     // CJK Unified Ideographs Extension A
            | '\u{4E00}'..='\u{9FFF}'     // CJK Unified Ideographs
            | '\u{AC00}'..='\u{D7AF}'     // Hangul Syllables
            | '\u{F900}'..='\u{FAFF}'     // CJK Compatibility Ideographs
            | '\u{FF66}'..='\u{FF9D}'     // Halfwidth Katakana
            | '\u{20000}'..='\u{2FA1F}'   // CJK Unified Ideographs Extensions B to F, Compatibility Supplement
            | '\u{30000}'..='\u{323AF}'   // CJK Unified Ideographs Extensions G and H
        )
}

/// Combining marks of the general combining blocks (a decomposed accent continues its letter).
fn is_combining_mark(c: char) -> bool {
    matches!(c,
        '\u{0300}'..='\u{036F}'
        | '\u{1AB0}'..='\u{1AFF}'
        | '\u{1DC0}'..='\u{1DFF}'
        | '\u{20D0}'..='\u{20FF}'
        | '\u{FE20}'..='\u{FE2F}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn character_classes() {
        assert!(
            is_cjk('中')
                && is_cjk('か')
                && is_cjk('カ')
                && is_cjk('한')
                && !is_cjk('a')
                && !is_cjk('。')
                && !is_cjk('・')
        );
        assert!(is_joiner('\'') && is_joiner('’') && is_joiner('-') && !is_joiner('–'));
        assert!(is_hyphen('\u{ad}') && !is_hyphen('\''));
        assert!(is_combining_mark('\u{301}') && !is_combining_mark('e'));
    }

    #[test]
    fn lines_differ_by_page_or_baseline() {
        let at = |page, y: f64| Line {
            page,
            baseline: Abs::pt(y),
            size: Abs::pt(10.0),
        };
        assert!(!at(0, 100.0).differs(at(0, 103.0)));
        assert!(at(0, 100.0).differs(at(0, 112.0)));
        assert!(at(0, 100.0).differs(at(1, 100.0)));
    }
}

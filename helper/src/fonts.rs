//! Font discovery in the order of typst-cli 0.15.1's `discover_fonts`: system fonts, then Typst's embedded fonts, then each font path.
//!
//! Adapted from typst-cli 0.15.1 crates/typst-cli/src/fonts.rs (Apache-2.0).

use std::path::PathBuf;
use std::time::Instant;

use typst_kit::fonts::{self, FontStore};

/// Discovers the fonts for a project with the given extra font folders.
pub fn discover_fonts(font_paths: &[PathBuf]) -> FontStore {
    let start = Instant::now();
    let mut store = FontStore::new();
    let system: Vec<_> = fonts::system().collect();
    let embedded: Vec<_> = fonts::embedded().collect();
    let mut count = system.len() + embedded.len();
    store.extend(system);
    store.extend(embedded);
    for path in font_paths {
        let found: Vec<_> = fonts::scan(path).collect();
        count += found.len();
        store.extend(found);
    }
    eprintln!(
        "discovered {count} fonts in {:.2} s",
        start.elapsed().as_secs_f64()
    );
    store
}

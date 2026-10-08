//! Typst Workshop helper: compiles one Typst project and answers position lookups over JSON lines on stdin/stdout.

use typst_workshop_helper::{HELPER_VERSION, TYPST_VERSION, serve};

// The static Linux build uses mimalloc: with musl's allocator, compiles take about 1.5 times as long.
#[cfg(target_env = "musl")]
#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("typst-workshop-helper {HELPER_VERSION} (typst {TYPST_VERSION})");
        return;
    }
    if let Err(err) = serve(std::io::stdin().lock(), std::io::stdout().lock()) {
        eprintln!("typst-workshop-helper: {err}");
        std::process::exit(1);
    }
}

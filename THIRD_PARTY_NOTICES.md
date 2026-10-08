# Third-party notices

Typst Workshop includes or adapts code from the projects below. The text of the Apache License 2.0 is in `licenses/Apache-2.0.txt`. The licences of all Rust crates the helper is built from, the licence of OpenSSL (built into the linux-x64 helper) and the notices of typst-assets (the fonts and data files the helper embeds), hayagriva (its CSL styles and locales) and subsetter are in `helper/THIRD_PARTY_LICENSES.md`, generated with `npm run licenses:helper`.

## Typst

- Project: https://github.com/typst/typst (version 0.15.1)
- Licence: Apache License 2.0 (`licenses/Apache-2.0.txt`); typst's NOTICE file at v0.15.1, verbatim: `licenses/typst-NOTICE.txt`
- Use: the helper links the `typst`, `typst-layout`, `typst-pdf`, `typst-ide` and `typst-kit` crates. `helper/src/world.rs` and `helper/src/fonts.rs` adapt `crates/typst-cli/src/world.rs` and `crates/typst-cli/src/fonts.rs`, and the PDF options and timestamp code in `helper/src/compile.rs` adapts `crates/typst-cli/src/compile.rs`; `helper/src/sync.rs` adapts `crates/typst-ide/src/jump.rs` (the click lookup no longer follows links, and a nearest-text fallback was added). The adapted files carry a header naming their source. The release binary also contains Typst's embedded fonts and data files from typst-assets 0.15.1 (https://github.com/typst/typst-assets), under the licences listed in its notice, which `helper/THIRD_PARTY_LICENSES.md` reproduces. The embedded fonts are distributed unmodified; their sources are available in the typst-assets repository (https://github.com/typst/typst-assets), as for Typst's own binaries.

## PDF.js

- Project: https://github.com/mozilla/pdf.js (pdfjs-dist 6.4.299)
- Licence: Apache License 2.0 (`licenses/Apache-2.0.txt`)
- Use: `dist/webview/viewer.js` bundles `pdfjs-dist/build/pdf.mjs` and `pdfjs-dist/web/pdf_viewer.mjs`; `dist/webview/pdf.worker.mjs`, `dist/webview/pdf_viewer.css` and `dist/webview/images/` are copied unchanged from pdfjs-dist.

## musl

- Project: https://musl.libc.org (version 1.2.5)
- Licence: MIT (`licenses/musl-COPYRIGHT.txt`)
- Use: the linux-x64 helper is a static executable that contains musl's C library, as provided by Rust's `x86_64-unknown-linux-musl` target.

## LaTeX Workshop

- Project: https://github.com/James-Yu/LaTeX-Workshop
- Licence: MIT
- Use: the PDF tab's reload in place (`webview/reload.ts`) adapts the snapshot technique of `viewer/components/refresh.ts`.

```
The MIT License (MIT)

Copyright (c) 2016 James Yu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

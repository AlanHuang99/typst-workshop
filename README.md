# Typst Workshop

A VS Code extension for writing Typst documents with the PDF beside the editor:

- the project's entry file is compiled to PDF whenever a file it uses changes, including files rewritten by other programs;
- the PDF opens in a VS Code tab that reloads in place and keeps its page, zoom and scroll position;
- Ctrl+click in the PDF opens the source at the clicked character, and Ctrl+Alt+J shows the cursor's position in the PDF;
- compile errors and warnings appear in the Problems panel, and a status bar item shows the build state;
- a word count of the document, by file;
- a sidebar showing the entry file of the active Typst file and why it was chosen, with its PDF, last build and word count, the commands, and the most-changed settings;
- editing basics for `.typ` files: comment toggling, bracket matching, headings in the Outline view, folding, and clickable file paths.

Compilation uses the Typst 0.15.1 compiler crates, built into the extension's helper program.

Platform: Linux x64. The extension runs where VS Code's extension host runs, so it also works from macOS or Windows clients connected over Remote-SSH to a Linux x64 host.

## Install

- Editors that install extensions from [Open VSX](https://open-vsx.org/extension/alanhuang/typst-workshop): install `alanhuang.typst-workshop` from the Extensions view.
- VS Code: download `typst-workshop-linux-x64-<version>.vsix` from the [Releases page](https://github.com/AlanHuang99/typst-workshop/releases) and run `code --install-extension <file>`. Over Remote-SSH, the extension runs on the remote host: run the command in a terminal of the remote window.

## Use

Open the folder that contains the Typst project and any `.typ` file in it.

| Action | Key | Command |
|---|---|---|
| Build the project | Ctrl+Alt+B | Typst Workshop: Build Project |
| Open the PDF tab | Ctrl+Alt+V | Typst Workshop: View PDF |
| Show the cursor in the PDF | Ctrl+Alt+J | Typst Workshop: Show Cursor Position in PDF |
| Open the source of a point in the PDF | Ctrl+click in the PDF (or double-click, see `sync.keybinding`) | |
| Stop a running build | | Typst Workshop: Stop Build |
| Word count by file | | Typst Workshop: Count Words |
| Pin the entry file | | Typst Workshop: Set Current File as Entry |
| Forget the pinned entry and the entry choices made in the picker | | Typst Workshop: Clear Entry Setting |
| Open the log | | Typst Workshop: Show Log |
| Open the settings of this extension | | Typst Workshop: Open Settings |

On a macOS client, use Cmd instead of Ctrl. The keys work in Typst editors; in the PDF tab, Ctrl+Alt+B builds the project. The title bar of Typst editors has Build and View PDF buttons, and the title bar of the PDF tab has the Build button.

Automatic builds follow `typst-workshop.autoBuild.run`. When the window opens or reloads, the project of the active Typst editor is built once, and so is the project of each restored PDF tab when that tab is first shown, unless the setting is `never`.

### Entry file

The extension compiles the project's entry file, not the file being edited. It finds the entry in this order:

1. a comment `// !TYPST root = Manuscript.typ` in the first lines of the file (path relative to the file);
2. the file pinned with "Set Current File as Entry";
3. the setting `typst-workshop.mainFile`;
4. the project whose last build used the file;
5. the `#include` and `#import` lines of the workspace (commented-out lines are ignored): the top file that includes the edited file;
6. the file itself.

A file that no other file includes or imports is built automatically when it includes other files itself, or when the workspace folder has no other such top-level file that includes other files. Otherwise it is not built automatically, so editing a section that is temporarily left out of the document does not produce a stray PDF; Ctrl+Alt+B still builds it on its own.

The PDF is named after the entry file (`Manuscript.typ` → `Manuscript.pdf`) and, by default, written next to it, as `typst compile` does; the setting `typst-workshop.outDir` chooses another folder. A failed build leaves the previous PDF in place.

### PDF tab

The toolbar has the page number, zoom, find and a dark-mode button. Keys: Ctrl with `+`, `-` and `0` to zoom; Ctrl+F to find; Alt+← and Alt+→ to go back and forward after a jump; Home and End for the first and last page. Links to other parts of the document move within the tab; web links open in the browser.

### Sidebar

The Typst Workshop icon in the Activity Bar opens three views.

- **Project**: the entry file of the active Typst file or, while a PDF tab is focused, the entry file that writes that PDF ("writes the focused PDF"). Beside the entry of a Typst file is the step of the list under "Entry file" that chose it, in plain words and in the order of that list: "set by // !TYPST root", "pinned", "set in mainFile", "built before", "found through #include" or "entry file"; the tooltip names the step. A file that is not built automatically is shown with a note saying so; its buttons build it on its own and open its PDF. Under the entry: its PDF (click to open the PDF tab; the project is built first if the PDF is missing), the last build (time, duration and pages, the number of errors, or stopped; click to open the log, or the Problems panel after a build with errors), and the word count of the last successful build when it is known, that is after each successful build while `wordCount.statusBar` is on and otherwise after Count Words (click for the count by file). The other projects built in the window follow, with the same items. The buttons on an entry build it, open its PDF, and pin it as the entry file of its folder or clear the pin; clicking the entry opens the file.
- **Commands**: Build Project, View PDF, Show Cursor Position in PDF, Stop Build, Count Words, Set Current File as Entry, Clear Entry Setting and Show Log; click one to run it.
- **Settings**: seven settings in plain words with their current values: Automatic builds (`autoBuild.run`), Jump from the PDF (`sync.keybinding`), Marker in the PDF (`sync.indicator`), Dark PDF pages (`view.pdf.invertMode`), Show the cursor after builds (`sync.afterBuild`), Word count in the status bar (`wordCount.statusBar`) and PDF zoom (`view.pdf.zoom`, a number shown as a percentage); the tooltip has the setting's name and description. Clicking one offers its allowed values in plain words, each with its stored value below it (for PDF zoom also a percentage from 10 to 1000, typed under "Other value…" and stored as the zoom factor: 125 becomes 1.25), and writes the choice to the workspace settings if the setting is set there, otherwise to the user settings. "Open all settings" and the gear button open the Settings editor filtered to this extension.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `typst-workshop.mainFile` | `""` | Entry file, relative to the workspace folder or absolute |
| `typst-workshop.rootDir` | `""` | Project root; empty means the entry file's folder; placeholders `%DIR%`, `%WORKSPACE_FOLDER%` |
| `typst-workshop.outDir` | `"%DIR%"` | Folder for the PDF; placeholders `%DIR%`, `%WORKSPACE_FOLDER%`, `%TMPDIR%` |
| `typst-workshop.fontPaths` | `[]` | Extra font folders |
| `typst-workshop.inputs` | `{}` | `sys.inputs` key/value pairs |
| `typst-workshop.autoBuild.run` | `"onFileChange"` | `never`, `onSave` (saves in VS Code), or `onFileChange` (any change on disk to a file the last build read, and to a `.typ` file of the workspace that no build has read yet) |
| `typst-workshop.autoBuild.delay` | `250` | Quiet period in milliseconds before an automatic build |
| `typst-workshop.helperPath` | `""` | Helper binary; empty means the bundled one |
| `typst-workshop.diagnostics.enabled` | `true` | Errors and warnings in the Problems panel |
| `typst-workshop.message.error.show` | `false` | Popup when a build fails |
| `typst-workshop.view.pdf.tab.editorGroup` | `"right"` | `right` (beside the editor) or `current` |
| `typst-workshop.view.pdf.zoom` | `"page-width"` | `auto`, `page-width`, `page-fit`, `page-actual`, or a number such as `1.25` |
| `typst-workshop.view.pdf.scrollMode` | `"vertical"` | `vertical`, `horizontal`, `wrapped`, `page` |
| `typst-workshop.view.pdf.spreadMode` | `"none"` | `none`, `odd`, `even` |
| `typst-workshop.view.pdf.invertMode` | `"never"` | `never`, `auto` (with a dark VS Code theme), `always` |
| `typst-workshop.view.pdf.invert` | `0.9` | Strength of the inversion |
| `typst-workshop.sync.keybinding` | `"ctrl-click"` | `ctrl-click` or `double-click` |
| `typst-workshop.sync.indicator` | `"circle"` | Marker after Ctrl+Alt+J: `circle`, `rectangle`, `none` |
| `typst-workshop.sync.afterBuild` | `false` | Show the cursor position in the open PDF tab after each build |
| `typst-workshop.wordCount.statusBar` | `true` | Word count in the status bar |
| `typst-workshop.editing.enabled` | `"auto"` | Editing basics; `auto` turns them off when Tinymist is installed |

## Word count

The word count covers the text written in the project's files that appears in the PDF: prose, headings, captions, table cells and footnotes. Text that Typst generates (heading and line numbers, citation labels, the bibliography), text written in files that are only imported (templates such as the running header), math, and text produced by code are not counted. Text that the PDF shows several times from the same place in the source (the title in a running header, a heading in the outline) counts once. Comments shown only in draft mode count only in draft mode.

## Tinymist

Syntax colouring, completion, hover and formatting come from Tinymist, which can be installed alongside. With Tinymist installed, the editing basics of this extension switch off (setting `editing.enabled`) to avoid duplicate outline entries and links; builds, the PDF tab and the jumps are unaffected.

## Building from source

Building needs Node.js 22 or later and Rust 1.92 or later; the scripts use the `cargo` on PATH, else the one in `$CARGO_HOME/bin` or `~/.cargo/bin`.

```bash
npm ci
npm run package          # builds the helper and the bundles, writes typst-workshop-<platform>-<version>.vsix for this machine
code --install-extension typst-workshop-<platform>-<version>.vsix
```

The package is for the platform of the machine that builds it. The published Linux package contains a static helper, built with `npm run package -- --helper-target x86_64-unknown-linux-musl --features vendored-openssl` (needs `musl-tools` and `rustup target add x86_64-unknown-linux-musl`).

## Development

```bash
npm run build             # helper (release) and bundles
npm test                  # unit tests
npm run test:helper       # helper tests
npm run test:viewer       # PDF tab tests in headless Chromium (needs the typst CLI 0.15.1 on PATH and npx playwright install chromium)
npm run test:extension    # extension-host tests in VS Code
npm run licenses:helper   # regenerates helper/THIRD_PARTY_LICENSES.md (needs cargo-about: cargo install cargo-about --locked --features cli)
npm run icon              # renders media/icon.png from media/icon.svg
```

The extension-host tests run in the VS Code given by the environment variable `VSCODE_EXECUTABLE`, else in `/usr/share/code/code` when it exists, else in VS Code stable downloaded into `.vscode-test/`; on Linux without a display they run under `xvfb-run -a`. F5 starts an Extension Development Host on `test/fixtures/workspace`.

The helper is compiled against the Typst crates pinned in `helper/Cargo.toml` (`=0.15.1`). To move to a newer Typst release, change those pins and `TYPST_VERSION` in `helper/src/lib.rs`, run `npm run test:helper` and `npm run licenses:helper`, replace `licenses/typst-NOTICE.txt` with the `NOTICE` file of the new Typst release (and its version in `THIRD_PARTY_NOTICES.md`), and rebuild the package.

## Licence

MIT, see [LICENSE](LICENSE). The extension includes third-party code under its own licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [helper/THIRD_PARTY_LICENSES.md](helper/THIRD_PARTY_LICENSES.md).

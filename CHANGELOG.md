# Changelog

## 0.2.1 (2026-10-08)

- Packages for macOS on Apple silicon (`darwin-arm64`), on the Releases page and on Open VSX.
- On macOS, Ctrl+click in the PDF opens the source, as Cmd+click does.
- Jumps between the PDF and the source are listed in the log (Show Log) with the page, file, line and character, or with a note that nothing was found.
- The PDF tab shows the Typst Workshop icon.
- If the extension cannot start, an error message gives the reason and suggests reloading the window, and the log has the error.

## 0.2.0 (2026-10-08)

First public release, for Linux x64 (including Linux x64 hosts reached over Remote-SSH).

- Builds the project's entry file to PDF with Typst 0.15.1, built into the extension's helper program: whenever a file the last build read changes on disk (including files rewritten by other programs), on save, or only on request (`autoBuild.run`).
- Finds the entry file from a `// !TYPST root = …` comment, a pinned file, the `mainFile` setting, the project whose last build used the file, or the `#include` and `#import` lines of the workspace.
- Shows the PDF in a VS Code tab that reloads in place and keeps its page, zoom and scroll position, with page navigation, zoom, find, back and forward after jumps, and dark-mode inversion.
- Ctrl+click (Cmd+click on a macOS client) or, with `sync.keybinding`, double-click in the PDF opens the source at the clicked character; Show Cursor Position in PDF (Ctrl+Alt+J, Cmd+Alt+J on a macOS client) marks the cursor's position in the PDF.
- Compile errors and warnings in the Problems panel; a status bar item with the build state and the word count.
- Word count of the document, by file.
- Sidebar with the Project, Commands and Settings views.
- Editing basics for `.typ` files: comment toggling, bracket matching, headings in the Outline view, folding and clickable file paths; off by default when the Tinymist extension is installed.

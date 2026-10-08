//! Conversions between byte offsets and positions (0-based line, UTF-16 character) in a text, with the VS Code line breaks `\n`, `\r\n` and `\r`.

use crate::protocol::Position;

/// The position of a byte offset. Offsets inside a character move back to its start, offsets past the end clamp to the end, and an offset between `\r` and `\n` is the end of that line.
pub fn byte_to_position(text: &str, byte: usize) -> Position {
    let mut byte = byte.min(text.len());
    while !text.is_char_boundary(byte) {
        byte -= 1;
    }
    let bytes = text.as_bytes();
    if byte > 0 && bytes[byte - 1] == b'\r' && bytes.get(byte) == Some(&b'\n') {
        byte -= 1;
    }
    let starts = line_starts(&text[..byte]);
    let start = starts[starts.len() - 1];
    Position {
        line: starts.len() - 1,
        character: utf16_len(&text[start..byte]),
    }
}

/// The byte offset of a position. A character past the end of its line clamps to the line end (before the line break), and a line past the end of the text clamps to the end of the text.
pub fn position_to_byte(text: &str, pos: Position) -> usize {
    let Some(&start) = line_starts(text).get(pos.line) else {
        return text.len();
    };
    let end = start
        + text[start..]
            .find(['\n', '\r'])
            .unwrap_or(text.len() - start);
    let mut units = 0;
    for (i, c) in text[start..end].char_indices() {
        if units >= pos.character {
            return start + i;
        }
        units += c.len_utf16();
    }
    end
}

/// The byte offsets at which the lines of `text` start; the first is 0, and a text ending in a line break has an empty last line.
pub fn line_starts(text: &str) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut starts = vec![0];
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                starts.push(i + 2);
                i += 2;
                continue;
            }
            b'\r' | b'\n' => starts.push(i + 1),
            _ => {}
        }
        i += 1;
    }
    starts
}

/// The 0-based line containing a byte offset, given the line starts of the text.
pub fn line_of(starts: &[usize], byte: usize) -> usize {
    starts
        .partition_point(|&start| start <= byte)
        .saturating_sub(1)
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

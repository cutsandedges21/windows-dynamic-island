// What Island reads in a terminal's output on its way to the phones:
// - the title a program gives its window (OSC 0 or 2: ESC ] 0 ; title, ending in BEL or ESC \);
// - on Windows, the cursor question ConPTY asks once at start (ESC [ 6 n, because portable-pty
//   asks it to inherit the cursor). ConPTY waits for the answer before the program can run, so
//   Island answers it itself (top left) and takes it out of the output: a terminal opened with
//   no phone attached still starts, and a phone that attaches later never answers it again (its
//   answer would arrive as a key press, F3 to cmd).

/// The cursor question.
const ASK: &[u8] = b"\x1b[6n";
/// Island's answer: row 1, column 1.
pub const ANSWER: &[u8] = b"\x1b[1;1R";
/// ConPTY asks first thing; after this much output Island stops looking.
const ASK_WITHIN: usize = 16 * 1024;
/// A window title is cut at this many characters.
pub const TITLE_MAX: usize = 80;
/// An OSC sequence longer than this isn't a title.
const OSC_MAX: usize = 4096;

/// One chunk of output, looked at.
#[derive(Debug, Default, PartialEq)]
pub struct Seen {
    /// The bytes to keep (the cursor question taken out).
    pub out: Vec<u8>,
    /// The last title the chunk set ("" when a program cleared it).
    pub title: Option<String>,
    /// Whether ConPTY asked where the cursor is (Island answers with ANSWER).
    pub asked: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum St {
    Ground,
    Esc,
    Osc,
    /// ESC inside an OSC: `\` ends it.
    OscEsc,
}

pub struct Vt {
    st: St,
    osc: Vec<u8>,
    osc_long: bool,
    /// Still looking for the cursor question.
    asking: bool,
    looked: usize,
    /// The start of a question cut at the end of the last chunk.
    held: Vec<u8>,
}

impl Vt {
    /// `answer`: look for ConPTY's cursor question (Windows).
    pub fn new(answer: bool) -> Vt {
        Vt { st: St::Ground, osc: Vec::new(), osc_long: false, asking: answer, looked: 0, held: Vec::new() }
    }

    pub fn feed(&mut self, chunk: &[u8]) -> Seen {
        let mut seen = Seen::default();
        let mut bytes = std::mem::take(&mut self.held);
        bytes.extend_from_slice(chunk);
        if self.asking {
            if let Some(i) = find(&bytes, ASK) {
                bytes.drain(i..i + ASK.len());
                seen.asked = true;
                self.asking = false;
            } else {
                self.looked += chunk.len();
                if self.looked > ASK_WITHIN {
                    self.asking = false;
                } else {
                    let keep = cut_start(&bytes, ASK);
                    self.held = bytes.split_off(bytes.len() - keep);
                }
            }
        }
        for &b in &bytes {
            self.step(b, &mut seen.title);
        }
        seen.out = bytes;
        seen
    }

    fn step(&mut self, b: u8, title: &mut Option<String>) {
        match self.st {
            St::Ground => {
                if b == 0x1b {
                    self.st = St::Esc;
                }
            }
            St::Esc => {
                self.st = match b {
                    b']' => {
                        self.osc.clear();
                        self.osc_long = false;
                        St::Osc
                    }
                    0x1b => St::Esc,
                    _ => St::Ground,
                }
            }
            St::Osc => match b {
                0x07 => {
                    self.end_osc(title);
                    self.st = St::Ground;
                }
                0x1b => self.st = St::OscEsc,
                // CAN and SUB cancel a sequence.
                0x18 | 0x1a => self.st = St::Ground,
                _ if self.osc.len() < OSC_MAX => self.osc.push(b),
                _ => self.osc_long = true,
            },
            St::OscEsc => {
                if b == b'\\' {
                    self.end_osc(title);
                    self.st = St::Ground;
                } else {
                    // Another sequence starts: this one is dropped.
                    self.st = St::Esc;
                    self.step(b, title);
                }
            }
        }
    }

    fn end_osc(&mut self, title: &mut Option<String>) {
        if self.osc_long {
            return;
        }
        let Some(semi) = self.osc.iter().position(|&b| b == b';') else { return };
        if matches!(&self.osc[..semi], b"0" | b"2") {
            *title = Some(clean_title(&String::from_utf8_lossy(&self.osc[semi + 1..])));
        }
    }
}

/// A title as shown: no control characters, trimmed, at most TITLE_MAX characters.
pub fn clean_title(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect();
    t.trim().chars().take(TITLE_MAX).collect::<String>().trim_end().to_string()
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// How many bytes at the end of `bytes` are the start of `needle` (never all of it).
fn cut_start(bytes: &[u8], needle: &[u8]) -> usize {
    (1..needle.len()).rev().find(|&n| bytes.ends_with(&needle[..n])).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(vt: &mut Vt, chunks: &[&[u8]]) -> Vec<String> {
        chunks.iter().filter_map(|c| vt.feed(c).title).collect()
    }

    #[test]
    fn titles_come_from_osc_0_and_2_with_either_ending() {
        let mut vt = Vt::new(false);
        assert_eq!(titles(&mut vt, &[b"\x1b]0;PowerShell\x07$ "]), ["PowerShell"]);
        assert_eq!(titles(&mut vt, &[b"x\x1b]2;\xe2\x9c\xb3 Fix the tests\x1b\\y"]), ["✳ Fix the tests"]);
        // The icon name (1) and other OSCs (8: links) are not titles.
        assert!(titles(&mut vt, &[b"\x1b]1;icon\x07\x1b]8;;https://a.b\x07link\x1b]8;;\x07"]).is_empty());
        // The last title of a chunk wins; a cleared title is "".
        assert_eq!(vt.feed(b"\x1b]0;one\x07\x1b]0;two\x07").title.as_deref(), Some("two"));
        assert_eq!(vt.feed(b"\x1b]0;\x07").title.as_deref(), Some(""));
    }

    #[test]
    fn a_title_cut_across_chunks_is_still_read() {
        let text = b"ab\x1b]0;Claude Code\x07cd";
        for size in 1..text.len() {
            let mut vt = Vt::new(false);
            let got: Vec<String> = text.chunks(size).filter_map(|c| vt.feed(c).title).collect();
            assert_eq!(got, ["Claude Code"], "chunks of {size}");
        }
    }

    #[test]
    fn broken_or_endless_sequences_are_not_titles() {
        let mut vt = Vt::new(false);
        // Cancelled by CAN, then interrupted by another escape sequence.
        assert!(titles(&mut vt, &[b"\x1b]0;half\x18 text", b"\x1b]0;cut\x1b[0m more"]).is_empty());
        // Too long to be a title; the next one still works.
        let mut long = b"\x1b]0;".to_vec();
        long.extend(vec![b'x'; OSC_MAX + 10]);
        long.push(0x07);
        assert!(vt.feed(&long).title.is_none());
        assert_eq!(vt.feed(b"\x1b]0;ok\x07").title.as_deref(), Some("ok"));
    }

    #[test]
    fn titles_are_cleaned() {
        assert_eq!(clean_title("  a\tb\u{7}c  "), "abc");
        assert_eq!(clean_title(&"y".repeat(200)).chars().count(), TITLE_MAX);
    }

    #[test]
    fn the_cursor_question_is_answered_once_and_taken_out() {
        let mut vt = Vt::new(true);
        let seen = vt.feed(b"\x1b[?9001h\x1b[?1004h\x1b[6n");
        assert!(seen.asked);
        assert_eq!(seen.out, b"\x1b[?9001h\x1b[?1004h");
        // A program asking later is left to the phone's terminal.
        let seen = vt.feed(b"\x1b[6n");
        assert!(!seen.asked);
        assert_eq!(seen.out, b"\x1b[6n");
    }

    #[test]
    fn a_question_cut_across_chunks_is_found_and_nothing_is_lost() {
        let text = b"\x1b[?9001h\x1b[6nPrompt> ";
        for size in 1..text.len() {
            let mut vt = Vt::new(true);
            let mut out = Vec::new();
            let mut asked = 0;
            for c in text.chunks(size) {
                let seen = vt.feed(c);
                out.extend(seen.out);
                asked += seen.asked as usize;
            }
            assert_eq!((out.as_slice(), asked), (&b"\x1b[?9001hPrompt> "[..], 1), "chunks of {size}");
        }
    }

    #[test]
    fn without_the_question_island_stops_looking() {
        let mut vt = Vt::new(true);
        let big = vec![b'x'; ASK_WITHIN + 1];
        assert_eq!(vt.feed(&big).out.len(), big.len());
        let seen = vt.feed(b"\x1b[6n");
        assert!(!seen.asked, "too late to be ConPTY's");
        // A Mac never looks.
        let mut vt = Vt::new(false);
        assert_eq!(vt.feed(b"\x1b[6n").out, b"\x1b[6n");
        // Bytes that only look like the start of a question come out with the next chunk.
        let mut vt = Vt::new(true);
        assert_eq!(vt.feed(b"a\x1b[").out, b"a");
        assert_eq!(vt.feed(b"0m").out, b"\x1b[0m");
    }
}

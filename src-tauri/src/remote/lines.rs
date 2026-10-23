// Control lines: one JSON object per line, `\n` after each, at most MAX_LINE bytes with its
// newline. `Lines` cuts a byte stream into them; `Outbox` is what waits for a phone, keeping
// only the newest `pill` and `view` when the phone falls behind.

use std::collections::VecDeque;
use std::sync::Arc;

use iroh::endpoint::RecvStream;
use serde_json::Value;

/// One line as it goes out, newline included (shared when it goes to several phones).
pub type Line = Arc<[u8]>;

/// `msg` as a line.
pub fn line(msg: &Value) -> Line {
    let mut bytes = serde_json::to_vec(msg).unwrap_or_default();
    bytes.push(b'\n');
    Arc::from(bytes)
}

#[derive(Debug, PartialEq, Eq)]
pub struct TooLong;

/// Cuts bytes into lines of at most `max` bytes, the newline included.
pub struct Lines {
    buf: Vec<u8>,
    /// Where the line not yet returned starts, and how far it was searched for its newline.
    start: usize,
    scanned: usize,
    max: usize,
}

impl Lines {
    pub fn new(max: usize) -> Lines {
        Lines { buf: Vec::new(), start: 0, scanned: 0, max }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if self.start > 0 {
            self.buf.drain(..self.start);
            self.scanned -= self.start;
            self.start = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// The next whole line (without its newline), None until one is in.
    pub fn next_line(&mut self) -> Result<Option<Vec<u8>>, TooLong> {
        let from = self.scanned.max(self.start);
        match self.buf[from..].iter().position(|&b| b == b'\n') {
            Some(i) => {
                let end = from + i;
                if end - self.start + 1 > self.max {
                    return Err(TooLong);
                }
                let line = self.buf[self.start..end].to_vec();
                self.start = end + 1;
                self.scanned = self.start;
                Ok(Some(line))
            }
            None => {
                self.scanned = self.buf.len();
                // Even a newline next would make it longer than allowed.
                if self.buf.len() - self.start >= self.max {
                    return Err(TooLong);
                }
                Ok(None)
            }
        }
    }

    /// What came after the last line returned (a file's first bytes, after its header).
    pub fn rest(&self) -> &[u8] {
        &self.buf[self.start..]
    }
}

#[derive(Debug)]
pub enum LineError {
    TooLong,
    /// The stream broke (or the connection closed).
    Read,
}

/// Lines from a QUIC stream.
pub struct LineReader {
    recv: RecvStream,
    lines: Lines,
}

impl LineReader {
    pub fn new(recv: RecvStream, max: usize) -> LineReader {
        LineReader { recv, lines: Lines::new(max) }
    }

    /// The next line; None when the other side finished the stream.
    pub async fn next_line(&mut self) -> Result<Option<Vec<u8>>, LineError> {
        loop {
            if let Some(line) = self.lines.next_line().map_err(|_| LineError::TooLong)? {
                return Ok(Some(line));
            }
            match self.recv.read_chunk(64 * 1024).await {
                Ok(Some(chunk)) => self.lines.push(&chunk),
                Ok(None) => return Ok(None),
                Err(_) => return Err(LineError::Read),
            }
        }
    }

    /// The stream, and the bytes already read past the last line.
    pub fn into_parts(self) -> (RecvStream, Vec<u8>) {
        let rest = self.lines.rest().to_vec();
        (self.recv, rest)
    }
}

// ------------------------------------------------------------------ the outbox

/// How a line waits: `pill` and `view` lines replace the one of their kind still waiting (only
/// the newest matters), every other line waits its turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Fifo,
    View,
    Pill,
}

pub fn kind_of(msg: &Value) -> Kind {
    match msg.get("t").and_then(Value::as_str) {
        Some("pill") => Kind::Pill,
        Some("view") => Kind::View,
        _ => Kind::Fifo,
    }
}

/// How the connection closes once the outbox is empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct End {
    pub code: u32,
    pub reason: &'static [u8],
}

#[derive(Debug, PartialEq, Eq)]
pub struct Full;

/// What waits for one phone. Lines in turn go first, then the newest view, then the newest pill.
pub struct Outbox {
    fifo: VecDeque<Line>,
    view: Option<Line>,
    pill: Option<Line>,
    cap: usize,
    end: Option<End>,
}

impl Outbox {
    pub fn new(cap: usize) -> Outbox {
        Outbox { fifo: VecDeque::new(), view: None, pill: None, cap, end: None }
    }

    /// Full: more than `cap` lines wait their turn, so the phone is too slow to keep.
    pub fn push(&mut self, kind: Kind, line: Line) -> Result<(), Full> {
        if self.end.is_some() {
            return Ok(());
        }
        match kind {
            Kind::View => self.view = Some(line),
            Kind::Pill => self.pill = Some(line),
            Kind::Fifo if self.fifo.len() >= self.cap => return Err(Full),
            Kind::Fifo => self.fifo.push_back(line),
        }
        Ok(())
    }

    pub fn pop(&mut self) -> Option<Line> {
        self.fifo.pop_front().or_else(|| self.view.take()).or_else(|| self.pill.take())
    }

    /// `last` goes after the lines in turn (a waiting pill and view are dropped), then nothing
    /// more; the connection closes with `end`.
    pub fn end(&mut self, last: Option<Line>, end: End) {
        if self.end.is_some() {
            return;
        }
        self.view = None;
        self.pill = None;
        self.fifo.extend(last);
        self.end = Some(end);
    }

    pub fn ending(&self) -> Option<End> {
        self.end
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn all(lines: &mut Lines) -> Vec<String> {
        let mut out = Vec::new();
        while let Some(l) = lines.next_line().unwrap() {
            out.push(String::from_utf8(l).unwrap());
        }
        out
    }

    #[test]
    fn lines_come_whole_however_the_bytes_are_cut() {
        let text = b"{\"t\":\"ping\"}\n{\"t\":\"nav\",\"open\":\"grid\"}\n\n{\"t\":\"act\"}\n";
        for size in [1, 2, 3, 7, 64] {
            let mut lines = Lines::new(1024);
            let mut got = Vec::new();
            for chunk in text.chunks(size) {
                lines.push(chunk);
                got.extend(all(&mut lines));
            }
            assert_eq!(got, ["{\"t\":\"ping\"}", "{\"t\":\"nav\",\"open\":\"grid\"}", "", "{\"t\":\"act\"}"], "chunks of {size}");
            assert!(lines.rest().is_empty());
        }
    }

    #[test]
    fn a_line_with_its_newline_may_be_max_bytes_and_no_more() {
        let mut lines = Lines::new(10);
        lines.push(b"123456789\n");
        assert_eq!(lines.next_line(), Ok(Some(b"123456789".to_vec())));
        lines.push(b"1234567890\n");
        assert_eq!(lines.next_line(), Err(TooLong));
        // Too long already before its newline comes.
        let mut lines = Lines::new(10);
        lines.push(b"123456789");
        assert_eq!(lines.next_line(), Ok(None));
        lines.push(b"0");
        assert_eq!(lines.next_line(), Err(TooLong));
    }

    #[test]
    fn what_follows_a_header_is_kept() {
        let mut lines = Lines::new(100);
        lines.push(b"{\"t\":\"file\"}\nBYTES");
        assert_eq!(lines.next_line(), Ok(Some(b"{\"t\":\"file\"}".to_vec())));
        assert_eq!(lines.rest(), b"BYTES");
        assert_eq!(lines.next_line(), Ok(None));
        assert_eq!(lines.rest(), b"BYTES");
    }

    #[test]
    fn a_long_line_in_small_pieces_is_found_in_linear_time() {
        let mut lines = Lines::new(1024 * 1024);
        let piece = vec![b'x'; 1000];
        for _ in 0..1000 {
            lines.push(&piece);
            assert_eq!(lines.next_line(), Ok(None));
        }
        lines.push(b"\n");
        assert_eq!(lines.next_line().unwrap().unwrap().len(), 1_000_000);
    }

    fn l(s: &str) -> Line {
        line(&json!({ "t": s }))
    }

    fn text(l: Option<Line>) -> Option<String> {
        l.map(|l| String::from_utf8(l.to_vec()).unwrap())
    }

    #[test]
    fn only_the_newest_pill_and_view_wait_and_the_rest_keeps_its_order() {
        let mut out = Outbox::new(10);
        let pill = |n: u32| line(&json!({ "t": "pill", "n": n }));
        let view = |n: u32| line(&json!({ "t": "view", "n": n }));
        out.push(Kind::Pill, pill(1)).unwrap();
        out.push(Kind::View, view(1)).unwrap();
        out.push(Kind::Fifo, l("hello")).unwrap();
        out.push(Kind::Pill, pill(2)).unwrap();
        out.push(Kind::View, view(2)).unwrap();
        out.push(Kind::Fifo, l("toast")).unwrap();
        assert_eq!(text(out.pop()).unwrap(), "{\"t\":\"hello\"}\n");
        assert_eq!(text(out.pop()).unwrap(), "{\"t\":\"toast\"}\n");
        assert_eq!(text(out.pop()).unwrap(), "{\"t\":\"view\",\"n\":2}\n");
        assert_eq!(text(out.pop()).unwrap(), "{\"t\":\"pill\",\"n\":2}\n");
        assert_eq!(out.pop(), None);
    }

    #[test]
    fn a_phone_that_falls_too_far_behind_is_full() {
        let mut out = Outbox::new(3);
        for _ in 0..3 {
            out.push(Kind::Fifo, l("toast")).unwrap();
        }
        assert_eq!(out.push(Kind::Fifo, l("toast")), Err(Full));
        // Pills and views never fill it: they replace each other.
        for _ in 0..100 {
            out.push(Kind::Pill, l("pill")).unwrap();
            out.push(Kind::View, l("view")).unwrap();
        }
    }

    #[test]
    fn a_last_line_goes_after_the_rest_and_nothing_after_it() {
        let mut out = Outbox::new(3);
        out.push(Kind::Fifo, l("toast")).unwrap();
        out.push(Kind::Pill, l("pill")).unwrap();
        let end = End { code: 410, reason: b"removed" };
        out.end(Some(l("bye")), end);
        out.push(Kind::Fifo, l("late")).unwrap();
        assert_eq!(text(out.pop()).unwrap(), "{\"t\":\"toast\"}\n");
        assert_eq!(text(out.pop()).unwrap(), "{\"t\":\"bye\"}\n");
        assert_eq!(out.pop(), None);
        assert_eq!(out.ending(), Some(end));
    }

    #[test]
    fn kinds_come_from_t() {
        assert_eq!(kind_of(&json!({ "t": "pill", "frame": {} })), Kind::Pill);
        assert_eq!(kind_of(&json!({ "t": "view" })), Kind::View);
        assert_eq!(kind_of(&json!({ "t": "toast" })), Kind::Fifo);
        assert_eq!(kind_of(&json!({})), Kind::Fifo);
    }
}

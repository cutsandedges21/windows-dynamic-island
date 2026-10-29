// The last bytes a terminal printed, so a phone that attaches sees what is on the screen: the
// phone clears its screen and writes them before the live output.

/// What a terminal keeps of its output.
pub const REPLAY_MAX: usize = 256 * 1024;
/// When older bytes were dropped, the replay starts after the first line break this close to
/// its start (so it doesn't begin halfway through a line or an escape sequence).
const CLEAN_START_WITHIN: usize = 4096;

pub struct Ring {
    buf: Vec<u8>,
    cap: usize,
    /// Where the oldest byte is once the buffer is full (the next byte goes there).
    head: usize,
    /// Whether bytes were dropped to make room.
    wrapped: bool,
}

impl Ring {
    pub fn new(cap: usize) -> Ring {
        Ring { buf: Vec::new(), cap, head: 0, wrapped: false }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if self.cap == 0 || bytes.is_empty() {
            return;
        }
        if bytes.len() >= self.cap {
            self.wrapped |= !self.buf.is_empty() || bytes.len() > self.cap;
            self.buf.clear();
            self.buf.extend_from_slice(&bytes[bytes.len() - self.cap..]);
            self.head = 0;
            return;
        }
        let mut rest = bytes;
        if self.buf.len() < self.cap {
            let n = (self.cap - self.buf.len()).min(rest.len());
            self.buf.extend_from_slice(&rest[..n]);
            rest = &rest[n..];
        }
        if rest.is_empty() {
            return;
        }
        self.wrapped = true;
        while !rest.is_empty() {
            let n = (self.cap - self.head).min(rest.len());
            self.buf[self.head..self.head + n].copy_from_slice(&rest[..n]);
            self.head = (self.head + n) % self.cap;
            rest = &rest[n..];
        }
    }

    /// Everything it holds, oldest first.
    pub fn raw(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.buf.len());
        out.extend_from_slice(&self.buf[self.head..]);
        out.extend_from_slice(&self.buf[..self.head]);
        out
    }

    /// What a phone that attaches gets: everything, oldest first; when older bytes were dropped,
    /// from a clean place (after the first line break near the start, else at a whole character).
    pub fn replay(&self) -> Vec<u8> {
        let mut out = self.raw();
        if self.wrapped {
            let skip = clean_start(&out);
            out.drain(..skip);
        }
        out
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.buf.len()
    }
}

/// Where bytes cut at an arbitrary place start cleanly.
fn clean_start(bytes: &[u8]) -> usize {
    let near = &bytes[..bytes.len().min(CLEAN_START_WITHIN)];
    if let Some(i) = near.iter().position(|&b| b == b'\n') {
        return i + 1;
    }
    // UTF-8 continuation bytes belong to a character whose start was dropped.
    bytes.iter().take(3).take_while(|&&b| (0x80..0xc0).contains(&b)).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_keeps_everything_until_full() {
        let mut r = Ring::new(10);
        r.push(b"abc");
        r.push(b"");
        r.push(b"def");
        assert_eq!(r.raw(), b"abcdef");
        assert_eq!(r.replay(), b"abcdef", "nothing dropped: the replay is all of it");
        r.push(b"ghij");
        assert_eq!(r.raw(), b"abcdefghij");
        assert_eq!(r.len(), 10);
    }

    #[test]
    fn it_wraps_and_keeps_the_newest_bytes_in_order() {
        let mut r = Ring::new(10);
        r.push(b"0123456789");
        r.push(b"ab");
        assert_eq!(r.raw(), b"23456789ab");
        r.push(b"cdefg");
        assert_eq!(r.raw(), b"789abcdefg");
        // Many small pushes, cut every way.
        let text: Vec<u8> = (0..1000u32).map(|i| b'a' + (i % 26) as u8).collect();
        for size in [1, 3, 7, 9, 10, 11, 64] {
            let mut r = Ring::new(10);
            for chunk in text.chunks(size) {
                r.push(chunk);
            }
            assert_eq!(r.raw(), &text[text.len() - 10..], "chunks of {size}");
            assert_eq!(r.len(), 10);
        }
    }

    #[test]
    fn a_push_bigger_than_it_keeps_its_end() {
        let mut r = Ring::new(4);
        r.push(b"xy");
        r.push(b"abcdefgh");
        assert_eq!(r.raw(), b"efgh");
        r.push(b"ij");
        assert_eq!(r.raw(), b"ghij");
        let mut r = Ring::new(4);
        r.push(b"abcd");
        assert_eq!(r.replay(), b"abcd", "exactly full drops nothing");
    }

    #[test]
    fn a_replay_after_a_wrap_starts_at_a_line() {
        let mut r = Ring::new(16);
        r.push(b"first line\r\nsecond\r\nthird\r\n");
        assert_eq!(r.raw(), b"\nsecond\r\nthird\r\n");
        assert_eq!(r.replay(), b"second\r\nthird\r\n");
        // No line break near the start: it starts at a whole character.
        let mut r = Ring::new(4);
        r.push("aé€".as_bytes());
        assert_eq!(r.raw(), [0xa9, 0xe2, 0x82, 0xac]);
        assert_eq!(r.replay(), "€".as_bytes());
    }

    #[test]
    fn the_real_size_holds_256_kib() {
        let mut r = Ring::new(REPLAY_MAX);
        let block = vec![b'x'; 100_000];
        for _ in 0..5 {
            r.push(&block);
        }
        r.push(b"\nend");
        assert_eq!(r.len(), REPLAY_MAX);
        assert!(r.raw().ends_with(b"\nend"));
    }
}

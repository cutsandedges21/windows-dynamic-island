//! Terminal stream frames (docs/superpowers/specs/2026-10-28-phone-terminal-claude-screen-design.md).
//! After a terminal stream's header line and the island's `term-ok`, both directions carry
//! `[kind: u8][len: u32 big-endian][payload: len bytes]`, the payload at most 64 KiB.
//! Plain Rust with no iroh in it: the fake island (fake-island/src/main.rs) speaks it too, and
//! these tests run natively there (CARGO_TARGET_DIR outside OneDrive, as scripts/phone.mjs sets):
//! `cargo test --manifest-path phone/wasm/Cargo.toml -p fake-island`.

/// protocol.ts TERM_DATA: raw bytes (PC → phone: output; phone → PC: keyboard input).
pub const DATA: u8 = 0;
/// protocol.ts TERM_RESIZE: phone → PC, JSON `{"cols","rows"}`.
pub const RESIZE: u8 = 1;
/// protocol.ts TERM_EXIT: PC → phone, JSON `{"code": int|null}`; the PC finishes the stream after it.
pub const EXIT: u8 = 2;
/// protocol.ts TERM_TITLE: PC → phone, JSON `{"title"}`.
pub const TITLE: u8 = 3;
/// protocol.ts TERM_FRAME_MAX: the largest payload.
pub const FRAME_MAX: usize = 64 * 1024;
/// The kind byte and the length.
const HEAD: usize = 5;

/// One frame as it goes on the stream; None if the payload is over FRAME_MAX.
pub fn encode(kind: u8, payload: &[u8]) -> Option<Vec<u8>> {
    if payload.len() > FRAME_MAX {
        return None;
    }
    let mut out = Vec::with_capacity(HEAD + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Some(out)
}

/// Bytes as data frames, one after another, cut at FRAME_MAX (nothing for no bytes).
pub fn encode_data(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + HEAD * bytes.len().div_ceil(FRAME_MAX));
    for piece in bytes.chunks(FRAME_MAX) {
        out.push(DATA);
        out.extend_from_slice(&(piece.len() as u32).to_be_bytes());
        out.extend_from_slice(piece);
    }
    out
}

/// A frame said its payload is longer than FRAME_MAX (the length it gave): the stream is broken.
#[derive(Debug, PartialEq, Eq)]
pub struct TooLong(pub usize);

/// Cuts a stream into frames: push what arrives, take whole frames out with `next`.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
    /// Where the frames not taken out yet start in `buf`.
    at: usize,
}

impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) {
        if self.at > 0 {
            self.buf.drain(..self.at);
            self.at = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// The next whole frame (kind, payload); None until more bytes come.
    pub fn next(&mut self) -> Result<Option<(u8, Vec<u8>)>, TooLong> {
        let rest = &self.buf[self.at..];
        if rest.len() < HEAD {
            return Ok(None);
        }
        let len = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        if len > FRAME_MAX {
            return Err(TooLong(len));
        }
        if rest.len() < HEAD + len {
            return Ok(None);
        }
        let frame = (rest[0], rest[HEAD..HEAD + len].to_vec());
        self.at += HEAD + len;
        Ok(Some(frame))
    }

    /// Bytes held that aren't a whole frame yet (a stream that ends with some was cut short).
    pub fn pending(&self) -> usize {
        self.buf.len() - self.at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(d: &mut Decoder) -> Vec<(u8, Vec<u8>)> {
        let mut out = Vec::new();
        while let Some(f) = d.next().unwrap() {
            out.push(f);
        }
        out
    }

    #[test]
    fn a_frame_is_kind_length_payload() {
        assert_eq!(encode(TITLE, b"{}").unwrap(), vec![3, 0, 0, 0, 2, b'{', b'}']);
        assert_eq!(encode(DATA, b"").unwrap(), vec![0, 0, 0, 0, 0]);
        let big = encode(DATA, &[7u8; FRAME_MAX]).unwrap();
        assert_eq!(&big[..5], &[0, 0, 1, 0, 0]);
        assert_eq!(big.len(), 5 + FRAME_MAX);
        assert_eq!(encode(DATA, &[7u8; FRAME_MAX + 1]), None);
    }

    #[test]
    fn data_longer_than_a_frame_goes_as_several() {
        assert!(encode_data(b"").is_empty());
        let bytes: Vec<u8> = (0..2 * FRAME_MAX + 1).map(|i| (i % 251) as u8).collect();
        let mut d = Decoder::default();
        d.push(&encode_data(&bytes));
        let frames = all(&mut d);
        assert_eq!(frames.iter().map(|(k, p)| (*k, p.len())).collect::<Vec<_>>(), vec![(DATA, FRAME_MAX), (DATA, FRAME_MAX), (DATA, 1)]);
        assert_eq!(frames.iter().flat_map(|(_, p)| p.iter().copied()).collect::<Vec<u8>>(), bytes);
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn frames_come_out_whole_however_the_bytes_arrive() {
        let mut stream = Vec::new();
        let sent: Vec<(u8, Vec<u8>)> = vec![(DATA, b"PS C:\\> ".to_vec()), (TITLE, br#"{"title":"pwsh"}"#.to_vec()), (DATA, vec![]), (EXIT, br#"{"code":0}"#.to_vec())];
        for (k, p) in &sent {
            stream.extend(encode(*k, p).unwrap());
        }
        // All at once, a byte at a time, and in uneven pieces.
        for piece in [stream.len(), 1, 3, 7] {
            let mut d = Decoder::default();
            let mut got = Vec::new();
            for chunk in stream.chunks(piece) {
                d.push(chunk);
                got.extend(all(&mut d));
            }
            assert_eq!(got, sent, "pieces of {piece}");
            assert_eq!(d.pending(), 0);
        }
    }

    #[test]
    fn a_cut_frame_waits_and_shows_as_pending() {
        let mut d = Decoder::default();
        d.push(&[DATA, 0, 0]);
        assert_eq!(d.next(), Ok(None));
        d.push(&[0, 3, b'a', b'b']);
        assert_eq!(d.next(), Ok(None));
        assert_eq!(d.pending(), 7);
        d.push(b"c");
        assert_eq!(d.next(), Ok(Some((DATA, b"abc".to_vec()))));
        assert_eq!(d.pending(), 0);
    }

    #[test]
    fn a_frame_over_64_kib_breaks_the_stream_before_its_payload() {
        let mut d = Decoder::default();
        d.push(&encode(DATA, b"ok").unwrap());
        d.push(&[DATA, 0, 1, 0, 1]);
        assert_eq!(d.next(), Ok(Some((DATA, b"ok".to_vec()))));
        assert_eq!(d.next(), Err(TooLong(FRAME_MAX + 1)));
    }
}

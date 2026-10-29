// Terminals for a phone (design: docs/superpowers/specs/2026-10-28-phone-terminal-claude-screen-design.md;
// the terminals themselves are src/term). Rust answers the control lines `term-list` and
// `term-kill` (the island's TypeScript never sees them) and sends every phone `terms` when the
// list changes. Each terminal a phone shows is a bi-stream of its own: the header line
// `{"t":"term","id":null|"<id>","cols","rows","cwd","shell"}` (no id: open a new one), one answer
// line (`term-ok` with its id and title, or `term-error` and the stream ends), then frames both
// ways: [kind u8][len u32 big-endian][payload, at most 64 KiB]. To the phone: the kept output
// first, then the live output, title changes, and `exit` when the program ends (the stream ends
// after it). From the phone: keys and sizes. A stream that closes only lets go of the terminal,
// which keeps running. Phones get terminals only while the PC allows it (`remote_term_allow`).

use std::ops::RangeInclusive;
use std::sync::atomic::Ordering;

use iroh::endpoint::{RecvStream, SendStream};
use tokio::sync::mpsc;

use super::lines::{Kind, LineReader};
use super::*;
use crate::term::{Attached, Open, Out, TermInfo};

pub const TERM_DATA: u8 = 0;
pub const TERM_RESIZE: u8 = 1;
pub const TERM_EXIT: u8 = 2;
pub const TERM_TITLE: u8 = 3;
/// A frame's payload is at most this many bytes.
pub const TERM_FRAME_MAX: usize = 64 * 1024;
const FRAME_HEAD: usize = 5;
/// What a phone hears while the PC doesn't let phones have terminals.
pub const NOT_ALLOWED: &str = "Turned on in Settings › Your phone on the PC";
/// Columns and rows a phone may ask for.
const SIZES: RangeInclusive<u64> = 1..=crate::term::SIZE_MAX as u64;
/// A folder in a header is at most this long.
const CWD_MAX: usize = 4096;
/// How long a `term-error` gets to reach the phone.
const ERROR_WITHIN: Duration = Duration::from_secs(3);

/// One frame; the payload must fit (`data_frames` cuts longer output).
pub(super) fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    debug_assert!(payload.len() <= TERM_FRAME_MAX);
    let mut f = Vec::with_capacity(FRAME_HEAD + payload.len());
    f.push(kind);
    f.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    f.extend_from_slice(payload);
    f
}

/// Output as `data` frames of at most TERM_FRAME_MAX bytes each.
pub(super) fn data_frames(bytes: &[u8]) -> impl Iterator<Item = Vec<u8>> + '_ {
    bytes.chunks(TERM_FRAME_MAX).map(|c| frame(TERM_DATA, c))
}

fn json_frame(kind: u8, v: &Value) -> Vec<u8> {
    frame(kind, &serde_json::to_vec(v).unwrap_or_default())
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct TooBig;

/// Cuts a byte stream into frames.
#[derive(Default)]
pub(super) struct Frames {
    buf: Vec<u8>,
    start: usize,
}

impl Frames {
    pub fn push(&mut self, bytes: &[u8]) {
        if self.start > 0 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        self.buf.extend_from_slice(bytes);
    }

    /// The next whole frame (its kind and payload), None until one is in. A frame that says it
    /// is longer than TERM_FRAME_MAX is TooBig.
    pub fn next_frame(&mut self) -> Result<Option<(u8, Vec<u8>)>, TooBig> {
        let rest = &self.buf[self.start..];
        if rest.len() < FRAME_HEAD {
            return Ok(None);
        }
        let len = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        if len > TERM_FRAME_MAX {
            return Err(TooBig);
        }
        if rest.len() < FRAME_HEAD + len {
            return Ok(None);
        }
        let kind = rest[0];
        let payload = rest[FRAME_HEAD..FRAME_HEAD + len].to_vec();
        self.start += FRAME_HEAD + len;
        Ok(Some((kind, payload)))
    }
}

/// A `resize` frame's size, when it is one Island takes: `{"cols","rows"}`, 1..=500 each.
pub(super) fn read_size(payload: &[u8]) -> Option<(u16, u16)> {
    let v: Value = serde_json::from_slice(payload).ok()?;
    let cols = v["cols"].as_u64().filter(|n| SIZES.contains(n))?;
    let rows = v["rows"].as_u64().filter(|n| SIZES.contains(n))?;
    Some((cols as u16, rows as u16))
}

/// A terminal stream's first line.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct TermHeader {
    /// None: open a new terminal.
    pub id: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub shell: Option<String>,
}

/// Whether a stream's first line asks for a terminal.
pub(super) fn is_term(line: &[u8]) -> bool {
    serde_json::from_slice::<Value>(line).is_ok_and(|v| v["t"] == "term")
}

/// The header, if it is one. Sizes out of range are brought into it (missing: 80×24).
pub(super) fn read_term_header(line: &[u8]) -> Option<TermHeader> {
    let v: Value = serde_json::from_slice(line).ok()?;
    if v["t"] != "term" {
        return None;
    }
    let id = match &v["id"] {
        Value::Null => None,
        Value::String(s) if !s.is_empty() && s.len() <= 64 => Some(s.clone()),
        _ => return None,
    };
    let size = |key: &str, default: u16| v[key].as_u64().map_or(default, |n| n.clamp(*SIZES.start(), *SIZES.end()) as u16);
    let text = |key: &str| -> Result<Option<String>, ()> {
        match &v[key] {
            Value::Null => Ok(None),
            Value::String(s) if s.len() <= CWD_MAX => Ok(Some(s.trim().to_string()).filter(|s| !s.is_empty())),
            _ => Err(()),
        }
    };
    Some(TermHeader { id, cols: size("cols", 80), rows: size("rows", 24), cwd: text("cwd").ok()?, shell: text("shell").ok()? })
}

fn reply(msg: Value) -> Vec<u8> {
    line(&msg).to_vec()
}

impl Remote {
    pub(super) fn term_allowed(&self) -> bool {
        self.term_allowed.load(Ordering::Relaxed)
    }

    /// `{"t":"terms","items","allowed"}`: no items while phones may not have terminals.
    fn terms_line(&self, list: &[TermInfo]) -> Line {
        let allowed = self.term_allowed();
        let items: &[TermInfo] = if allowed { list } else { &[] };
        line(&json!({ "t": "terms", "items": items, "allowed": allowed }))
    }

    /// The list to one phone, or to every connected one (None).
    pub(super) fn send_terms(&self, phone: Option<&str>, list: &[TermInfo]) {
        let l = self.terms_line(list);
        let targets: Vec<Arc<Session>> = {
            let sessions = self.sessions.lock().unwrap();
            match phone {
                Some(id) => sessions.get(id).cloned().into_iter().collect(),
                None => sessions.values().cloned().collect(),
            }
        };
        for s in targets {
            s.send(Kind::Terms, l.clone());
        }
    }

    /// Whether phones may have terminals (Settings › Your phone, and not while Windows Hello
    /// guards Allow). Turning it off lets go of every terminal a phone shows.
    pub fn term_allow(&self, on: bool) {
        if self.term_allowed.swap(on, Ordering::Relaxed) == on {
            return;
        }
        crate::log::line(format!("remote: terminals from a phone {}", if on { "on" } else { "off" }));
        if !on {
            self.terms.detach_all();
        }
        self.send_terms(None, &self.terms.list());
    }

    /// `term-list`, or `term-kill` (which ends that terminal and takes it off the list); either
    /// way the phone hears `terms`.
    pub(super) fn term_control(&self, phone: &str, msg: &serde_json::Map<String, Value>) {
        if msg.get("t").and_then(Value::as_str) == Some("term-kill") && self.term_allowed() {
            if let Some(id) = msg.get("id").and_then(Value::as_str) {
                if self.terms.kill(id) {
                    crate::log::line("remote: a phone ended a terminal");
                }
            }
        }
        self.send_terms(Some(phone), &self.terms.list());
    }

    /// A terminal stream, after its first line.
    pub(super) async fn term_stream(self: Arc<Self>, phone: String, mut send: SendStream, reader: LineReader, head: Vec<u8>) {
        let (id, attached) = match self.term_start(&phone, &head).await {
            Ok(a) => a,
            Err(e) => {
                let _ = timeout(ERROR_WITHIN, async {
                    if send.write_all(&reply(json!({ "t": "term-error", "error": e }))).await.is_ok() && send.finish().is_ok() {
                        let _ = send.stopped().await;
                    }
                })
                .await;
                return;
            }
        };
        let Attached { key, title, replay, rx } = attached;
        let mut first = reply(json!({ "t": "term-ok", "id": id, "title": title }));
        for f in data_frames(&replay) {
            first.extend_from_slice(&f);
        }
        if send.write_all(&first).await.is_ok() {
            let (recv, rest) = reader.into_parts();
            self.term_pump(&id, &mut send, recv, rest, rx).await;
        }
        self.terms.detach(&id, key);
        let _ = send.finish();
    }

    /// Opens or finds the terminal a header asks for and attaches to it.
    async fn term_start(&self, phone: &str, head: &[u8]) -> Result<(String, Attached), String> {
        let h = read_term_header(head).ok_or_else(|| "Island didn't understand that terminal request.".to_string())?;
        if !self.term_allowed() {
            return Err(NOT_ALLOWED.into());
        }
        if let Some(id) = h.id {
            let attached = self.terms.attach(&id)?;
            self.terms.resize(&id, h.cols, h.rows);
            return Ok((id, attached));
        }
        let terms = self.terms.clone();
        let open = Open { cwd: h.cwd, shell: h.shell, cols: Some(h.cols), rows: Some(h.rows), ..Open::default() };
        let info = tokio::task::spawn_blocking(move || terms.open(open)).await.map_err(|_| "Island couldn't open a terminal.".to_string())??;
        crate::log::line(format!("remote: a phone opened a terminal ({})", info.shell));
        (self.emit)("term-opened", json!({ "phone": phone, "id": info.id, "title": info.title }));
        let attached = self.terms.attach(&info.id)?;
        Ok((info.id, attached))
    }

    /// Frames both ways until the program ends, the phone lets go, or the connection drops.
    async fn term_pump(&self, id: &str, send: &mut SendStream, mut recv: RecvStream, rest: Vec<u8>, mut rx: mpsc::Receiver<Out>) {
        let terms = &self.terms;
        let keys = async {
            let mut frames = Frames::default();
            frames.push(&rest);
            loop {
                loop {
                    match frames.next_frame() {
                        Ok(Some((TERM_DATA, bytes))) => {
                            terms.write(id, &bytes);
                        }
                        Ok(Some((TERM_RESIZE, payload))) => {
                            if let Some((cols, rows)) = read_size(&payload) {
                                terms.resize(id, cols, rows);
                            }
                        }
                        // The other kinds only go to the phone.
                        Ok(Some(_)) => {}
                        Ok(None) => break,
                        Err(TooBig) => return,
                    }
                }
                match recv.read_chunk(FRAME_HEAD + TERM_FRAME_MAX).await {
                    Ok(Some(chunk)) => frames.push(&chunk),
                    _ => return,
                }
            }
        };
        let output = async {
            while let Some(out) = rx.recv().await {
                let bytes = match &out {
                    Out::Data(b) => data_frames(b).flatten().collect(),
                    Out::Title(t) => json_frame(TERM_TITLE, &json!({ "title": t })),
                    Out::Exit(code) => json_frame(TERM_EXIT, &json!({ "code": code })),
                };
                if send.write_all(&bytes).await.is_err() || matches!(out, Out::Exit(_)) {
                    return;
                }
            }
        };
        tokio::select! {
            _ = keys => {}
            _ = output => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_go_out_and_come_back_however_the_bytes_are_cut() {
        let mut wire = frame(TERM_DATA, b"echo hi\r");
        wire.extend(frame(TERM_RESIZE, br#"{"cols":100,"rows":30}"#));
        wire.extend(frame(TERM_DATA, b""));
        wire.extend(frame(TERM_EXIT, br#"{"code":0}"#));
        assert_eq!(&wire[..5], &[0, 0, 0, 0, 8], "kind, then the length big-endian");
        for size in [1, 2, 4, 5, 6, 13, 1000] {
            let mut frames = Frames::default();
            let mut got = Vec::new();
            for chunk in wire.chunks(size) {
                frames.push(chunk);
                while let Some(f) = frames.next_frame().unwrap() {
                    got.push(f);
                }
            }
            assert_eq!(got, [(TERM_DATA, b"echo hi\r".to_vec()), (TERM_RESIZE, br#"{"cols":100,"rows":30}"#.to_vec()), (TERM_DATA, vec![]), (TERM_EXIT, br#"{"code":0}"#.to_vec())], "chunks of {size}");
        }
    }

    #[test]
    fn a_frame_may_carry_64_kib_and_no_more() {
        let mut frames = Frames::default();
        frames.push(&frame(TERM_DATA, &vec![7u8; TERM_FRAME_MAX]));
        assert_eq!(frames.next_frame().unwrap().unwrap().1.len(), TERM_FRAME_MAX);
        // Too long is known from the length alone, before the payload comes.
        let mut frames = Frames::default();
        frames.push(&[TERM_DATA, 0, 1, 0, 1]);
        assert_eq!(frames.next_frame(), Err(TooBig));
        // Output longer than a frame goes as several.
        let out = vec![1u8; TERM_FRAME_MAX * 2 + 10];
        let sizes: Vec<usize> = data_frames(&out).map(|f| f.len() - FRAME_HEAD).collect();
        assert_eq!(sizes, [TERM_FRAME_MAX, TERM_FRAME_MAX, 10]);
        assert_eq!(data_frames(b"").count(), 0);
    }

    #[test]
    fn sizes_are_taken_only_in_range() {
        assert_eq!(read_size(br#"{"cols":80,"rows":24}"#), Some((80, 24)));
        assert_eq!(read_size(br#"{"cols":500,"rows":1}"#), Some((500, 1)));
        assert_eq!(read_size(br#"{"cols":0,"rows":24}"#), None);
        assert_eq!(read_size(br#"{"cols":501,"rows":24}"#), None);
        assert_eq!(read_size(br#"{"cols":80}"#), None);
        assert_eq!(read_size(br#"{"cols":-1,"rows":24}"#), None);
        assert_eq!(read_size(b"80x24"), None);
    }

    #[test]
    fn headers_are_read() {
        let h = read_term_header(br#"{"t":"term","id":null,"cols":45,"rows":20,"cwd":null,"shell":"powershell"}"#).unwrap();
        assert_eq!(h, TermHeader { id: None, cols: 45, rows: 20, cwd: None, shell: Some("powershell".into()) });
        let h = read_term_header(br#"{"t":"term","id":"3fa9c021","cols":1000,"rows":0,"cwd":" C:\\Users\\moss\\island ","shell":null}"#).unwrap();
        assert_eq!(h, TermHeader { id: Some("3fa9c021".into()), cols: 500, rows: 1, cwd: Some(r"C:\Users\moss\island".into()), shell: None });
        // Missing fields are the defaults.
        assert_eq!(read_term_header(br#"{"t":"term"}"#).unwrap(), TermHeader { id: None, cols: 80, rows: 24, cwd: None, shell: None });
        assert!(read_term_header(br#"{"t":"term","id":""}"#).is_none());
        assert!(read_term_header(br#"{"t":"term","id":7}"#).is_none());
        assert!(read_term_header(br#"{"t":"term","shell":["bash"]}"#).is_none());
        assert!(read_term_header(format!(r#"{{"t":"term","cwd":"{}"}}"#, "x".repeat(CWD_MAX + 1)).as_bytes()).is_none());
        assert!(read_term_header(br#"{"t":"file","id":null}"#).is_none());
        assert!(read_term_header(b"term").is_none());
        assert!(is_term(br#"{"t":"term","id":null}"#));
        assert!(!is_term(br#"{"t":"file","id":"a","name":"x","size":1}"#));
        assert!(!is_term(b"not json"));
    }

    #[test]
    fn json_frames_say_exit_and_title() {
        let f = json_frame(TERM_EXIT, &json!({ "code": null }));
        assert_eq!((f[0], &f[FRAME_HEAD..]), (TERM_EXIT, &br#"{"code":null}"#[..]));
        let f = json_frame(TERM_TITLE, &json!({ "title": "✳ Claude Code" }));
        let mut frames = Frames::default();
        frames.push(&f);
        let (kind, payload) = frames.next_frame().unwrap().unwrap();
        assert_eq!((kind, serde_json::from_slice::<Value>(&payload).unwrap()), (TERM_TITLE, json!({ "title": "✳ Claude Code" })));
    }
}

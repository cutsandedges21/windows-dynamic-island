//! A stand-in for the island's phone side (src-tauri/src/remote), for phone/e2e. Its endpoint is
//! built like Island's (presets::N0, its own key, ALPN island-phone/1) and it speaks the
//! island's half of src/remote/protocol.ts, kept small:
//!   `pair` with FAKE_CODE -> `paired`; `hi` from a paired id -> a session; else `denied`
//!   a session starts with `hello` and a tiny `view`; `ping` -> `pong`; `act` -> a `toast`
//!   carrying the action; `act:test:push-file` sends the phone a file; `act:test:remove` -> `bye`
//!   a file stream from the phone is read whole (sha256) and answered `file-ok`
//!   a terminal stream (`{"t":"term",…}`) gets a pretend shell that echoes what is typed and
//!   answers lines: `exit` ends it, `title <words>` renames it, anything else is printed back;
//!   `term-list` -> `terms`, `term-kill` ends one (frames: ../src/frames.rs, shared with the phone)
//!
//! usage: fake-island <state dir>   (its key and paired phones live there, so a restart keeps them)
//! stdout: `READY {...}` once online, then `EVENT {...}` lines; stdin: `quit` closes it cleanly.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use iroh::endpoint::{presets, Connection, Incoming, RecvStream, SendStream, VarInt};
use iroh::{Endpoint, SecretKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncBufReadExt;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

/// Terminal stream frames, the phone's own code (phone/wasm/src/frames.rs).
#[path = "../../src/frames.rs"]
mod frames;

const ALPN: &[u8] = b"island-phone/1";
const NAME: &str = "FakeIsland";
/// The one pairing code this fake takes (32 hex characters, like the island's).
const FAKE_CODE: &str = "00112233445566778899aabbccddeeff";
const MAX_LINE: usize = 1024 * 1024;
const MAX_UPLOAD: u64 = 2 * 1024 * 1024 * 1024;
const FILE_LINE: usize = 64 * 1024;
/// protocol.ts TERM_REPLAY_MAX: a terminal's output kept for streams that attach later.
const TERM_REPLAY_MAX: usize = 256 * 1024;
const PROMPT: &str = "PS C:\\fake> ";

type Phones = Arc<Mutex<BTreeSet<String>>>;
type Out = mpsc::UnboundedSender<Value>;
/// The pretend terminals, by id; they outlive the phone's connections, as the island's do.
type Terms = Arc<Mutex<BTreeMap<String, FakeTerm>>>;

struct FakeTerm {
    title: String,
    cwd: String,
    shell: String,
    started: u64,
    /// Its output so far (the last TERM_REPLAY_MAX bytes).
    out: Vec<u8>,
    exit: Option<i32>,
    attached: u32,
}

impl FakeTerm {
    fn info(&self, id: &str) -> Value {
        json!({ "id": id, "title": self.title, "cwd": self.cwd, "shell": self.shell, "pid": 4242, "started": self.started, "exit": self.exit, "attached": self.attached, "claude": false })
    }

    fn keep(&mut self, bytes: &[u8]) {
        self.out.extend_from_slice(bytes);
        if self.out.len() > TERM_REPLAY_MAX {
            let cut = self.out.len() - TERM_REPLAY_MAX;
            self.out.drain(..cut);
        }
    }
}

fn terms_msg(terms: &Terms) -> Value {
    let items: Vec<Value> = terms.lock().unwrap().iter().map(|(id, t)| t.info(id)).collect();
    json!({ "t": "terms", "items": items, "allowed": true })
}

fn event(v: Value) {
    println!("EVENT {v}");
}

fn load_or_create_key(file: &Path) -> Result<SecretKey> {
    if let Ok(bytes) = std::fs::read(file) {
        if let Ok(secret) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(SecretKey::from_bytes(&secret));
        }
    }
    let key = SecretKey::generate();
    std::fs::write(file, key.to_bytes()).context("save the key")?;
    Ok(key)
}

fn save_phones(dir: &Path, phones: &BTreeSet<String>) {
    let _ = std::fs::write(dir.join("phones.json"), serde_json::to_vec(phones).unwrap_or_default());
}

/// `https://host./` -> `https://host/`: what the pairing payload carries (browsers need it).
fn no_dot(url: &str) -> String {
    let Some(at) = url.find("://") else { return url.to_string() };
    let host_end = url[at + 3..].find(['/', ':']).map(|i| at + 3 + i).unwrap_or(url.len());
    let host = url[at + 3..host_end].trim_end_matches('.');
    format!("{}{}{}", &url[..at + 3], host, &url[host_end..])
}

#[tokio::main]
async fn main() -> Result<()> {
    let dir = PathBuf::from(std::env::args().nth(1).context("usage: fake-island <state dir>")?);
    std::fs::create_dir_all(&dir)?;
    let key = load_or_create_key(&dir.join("fake-island.key"))?;
    let known: BTreeSet<String> = std::fs::read(dir.join("phones.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let phones: Phones = Arc::new(Mutex::new(known));
    let terms: Terms = Arc::default();

    let t0 = Instant::now();
    let ep = Endpoint::builder(presets::N0).secret_key(key).alpns(vec![ALPN.to_vec()]).bind().await.context("bind")?;
    timeout(Duration::from_secs(30), ep.online()).await.context("no home relay in 30 s")?;
    let relays: Vec<String> = ep.addr().relay_urls().map(|u| no_dot(&u.to_string())).collect();
    let payload = json!({ "v": 1, "id": ep.id().to_string(), "relays": relays, "code": FAKE_CODE, "name": NAME });
    let pair = BASE64URL_NOPAD.encode(payload.to_string().as_bytes());
    println!("READY {}", json!({ "id": ep.id().to_string(), "relays": relays, "pair": pair, "onlineMs": t0.elapsed().as_millis() as u64 }));

    let quit = ep.clone();
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim() == "quit" {
                quit.close().await;
                event(json!({ "e": "quit" }));
                std::process::exit(0);
            }
        }
    });

    while let Some(incoming) = ep.accept().await {
        let (phones, dir, terms) = (phones.clone(), dir.clone(), terms.clone());
        tokio::spawn(async move {
            if let Err(e) = handle(incoming, phones, dir, terms).await {
                event(json!({ "e": "error", "error": format!("{e:#}") }));
            }
        });
    }
    Ok(())
}

/// Lines of one stream, each at most MAX_LINE with its newline.
struct Lines {
    recv: RecvStream,
    buf: Vec<u8>,
}

impl Lines {
    async fn next(&mut self, max: usize) -> Result<Option<String>> {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            if let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
                let rest = self.buf.split_off(pos + 1);
                let line = std::mem::replace(&mut self.buf, rest);
                return Ok(Some(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned()));
            }
            if self.buf.len() >= max {
                bail!("line over {max} bytes");
            }
            match self.recv.read(&mut chunk).await? {
                Some(n) => self.buf.extend_from_slice(&chunk[..n]),
                None => return Ok(None),
            }
        }
    }
}

fn writer(mut send: SendStream) -> (Out, tokio::task::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let task = tokio::spawn(async move {
        while let Some(v) = rx.recv().await {
            if send.write_all(format!("{v}\n").as_bytes()).await.is_err() {
                return;
            }
        }
        let _ = send.finish();
        let _ = timeout(Duration::from_secs(3), send.stopped()).await;
    });
    (tx, task)
}

async fn handle(incoming: Incoming, phones: Phones, dir: PathBuf, terms: Terms) -> Result<()> {
    let conn = incoming.accept()?.await?;
    let phone = conn.remote_id().to_string();
    // The phone opens the control stream; streams appear here once it writes the first line.
    let Ok(Ok((send, recv))) = timeout(Duration::from_secs(10), conn.accept_bi()).await else {
        conn.close(VarInt::from_u32(408), b"no first line in 10 s");
        return Ok(());
    };
    let mut lines = Lines { recv, buf: Vec::new() };
    let first: Value = match timeout(Duration::from_secs(10), lines.next(MAX_LINE)).await {
        Ok(Ok(Some(l))) => serde_json::from_str(&l).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let (tx, writer_task) = writer(send);
    let mode = first["t"].as_str().unwrap_or("").to_string();
    let known = phones.lock().unwrap().contains(&phone);
    let deny = match mode.as_str() {
        _ if first["v"] != 1 => Some("version"),
        "pair" if first["code"] != FAKE_CODE => Some("code"),
        "pair" => None,
        "hi" if !known => Some("unknown"),
        "hi" => None,
        _ => Some("version"),
    };
    event(json!({ "e": "first", "phone": phone, "mode": mode, "denied": deny, "name": first["name"] }));
    if let Some(why) = deny {
        // The line must reach the phone before the connection closes.
        tx.send(json!({ "t": "denied", "why": why })).ok();
        drop(tx);
        let _ = writer_task.await;
        conn.close(VarInt::from_u32(403), why.as_bytes());
        return Ok(());
    }
    if mode == "pair" {
        let mut p = phones.lock().unwrap();
        p.insert(phone.clone());
        save_phones(&dir, &p);
        tx.send(json!({ "t": "paired", "name": NAME })).ok();
    }
    tx.send(json!({ "t": "hello", "v": 1, "name": NAME, "platform": "windows", "version": "0.0.0-fake", "allow": true, "vapid": null, "term": true, "screen": null, "folders": [] })).ok();
    tx.send(json!({ "t": "view", "nav": { "open": "grid" }, "view": { "key": "fake/grid", "blocks": [] }, "urgent": null })).ok();
    tokio::spawn(accept_files(conn.clone(), phone.clone(), terms.clone()));

    let end = loop {
        let line = match lines.next(MAX_LINE).await {
            Ok(Some(l)) => l,
            Ok(None) => break "the phone ended the control stream".to_string(),
            Err(e) => {
                conn.close(VarInt::from_u32(413), b"line too long");
                break format!("{e:#}");
            }
        };
        let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        match v["t"].as_str().unwrap_or("") {
            "ping" => {
                tx.send(json!({ "t": "pong" })).ok();
            }
            "term-list" => {
                tx.send(terms_msg(&terms)).ok();
            }
            "term-kill" => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                let found = terms.lock().unwrap().remove(&id).is_some();
                event(json!({ "e": "term-kill", "id": id, "found": found }));
                tx.send(terms_msg(&terms)).ok();
            }
            "nav" => {
                tx.send(json!({ "t": "view", "nav": v, "view": { "key": "fake/nav", "blocks": [] }, "urgent": null })).ok();
            }
            "act" => {
                let action = v["action"].as_str().unwrap_or("").to_string();
                if action == "act:test:push-file" {
                    let size = v["arg"]["size"].as_u64().unwrap_or(300_000);
                    tokio::spawn(push_file(conn.clone(), tx.clone(), size));
                } else if action == "act:test:remove" {
                    {
                        let mut p = phones.lock().unwrap();
                        p.remove(&phone);
                        save_phones(&dir, &p);
                    }
                    tx.send(json!({ "t": "bye", "why": "removed" })).ok();
                    sleep(Duration::from_millis(800)).await;
                    conn.close(VarInt::from_u32(410), b"removed");
                    break "removed".to_string();
                } else {
                    tx.send(json!({ "t": "toast", "text": action, "tone": "info" })).ok();
                }
            }
            other => event(json!({ "e": "line", "phone": phone, "t": other, "len": line.len() })),
        }
    };
    event(json!({ "e": "closed", "phone": phone, "why": end, "conn": conn.close_reason().map(|r| r.to_string()) }));
    Ok(())
}

/// The PC sending the phone a file: header, `size` bytes of a fixed pattern, the phone's answer.
async fn push_file(conn: Connection, tx: Out, size: u64) {
    let started = Instant::now();
    let data: Vec<u8> = (0..size).map(|i| (i * 31 % 251) as u8).collect();
    let sha = HEXLOWER.encode(&Sha256::digest(&data));
    let id = format!("pc-{}", started.elapsed().as_nanos() ^ size as u128);
    let res: Result<String> = async {
        let (mut send, recv) = conn.open_bi().await?;
        let header = json!({ "t": "file", "id": id, "name": "from-pc.bin", "size": size, "mime": "application/octet-stream" });
        send.write_all(format!("{header}\n").as_bytes()).await?;
        send.write_all(&data).await?;
        send.finish()?;
        let mut lines = Lines { recv, buf: Vec::new() };
        Ok(lines.next(FILE_LINE).await?.unwrap_or_default())
    }
    .await;
    let (reply, error) = match res {
        Ok(r) => (r, None),
        Err(e) => (String::new(), Some(format!("{e:#}"))),
    };
    event(json!({ "e": "file-out", "id": id, "size": size, "sha256": sha, "reply": reply, "error": error, "ms": started.elapsed().as_millis() as u64 }));
    tx.send(json!({ "t": "toast", "text": format!("file-out {}", if error.is_none() { "answered" } else { "failed" }), "tone": "info" })).ok();
}

async fn accept_files(conn: Connection, phone: String, terms: Terms) {
    while let Ok((send, recv)) = conn.accept_bi().await {
        let (phone, terms) = (phone.clone(), terms.clone());
        tokio::spawn(async move {
            let started = Instant::now();
            let mut lines = Lines { recv, buf: Vec::new() };
            let header: Value = match lines.next(FILE_LINE).await {
                Ok(Some(l)) => serde_json::from_str(&l).unwrap_or(Value::Null),
                _ => Value::Null,
            };
            if header["t"] == "term" {
                if let Err(e) = term_stream(send, lines, header, terms).await {
                    event(json!({ "e": "term-fail", "error": format!("{e:#}") }));
                }
                return;
            }
            let (tx, _w) = writer(send);
            let id = header["id"].as_str().unwrap_or("").to_string();
            let name = header["name"].as_str().unwrap_or("file").to_string();
            let Some(size) = header["size"].as_u64().filter(|s| *s <= MAX_UPLOAD) else {
                tx.send(json!({ "t": "file-error", "id": id, "error": "bad header" })).ok();
                return;
            };
            let mut hasher = Sha256::new();
            let mut got = lines.buf.len() as u64;
            hasher.update(&lines.buf);
            let mut chunk = vec![0u8; 256 * 1024];
            let error = loop {
                match lines.recv.read(&mut chunk).await {
                    Ok(Some(n)) => {
                        got += n as u64;
                        hasher.update(&chunk[..n]);
                    }
                    Ok(None) if got == size => break None,
                    Ok(None) => break Some(format!("got {got} of {size} bytes")),
                    Err(e) => break Some(e.to_string()),
                }
            };
            let sha = HEXLOWER.encode(&hasher.finalize());
            match &error {
                None => tx.send(json!({ "t": "file-ok", "id": id, "name": name })).ok(),
                Some(e) => tx.send(json!({ "t": "file-error", "id": id, "error": e })).ok(),
            };
            event(json!({ "e": "file-in", "phone": phone, "id": id, "name": name, "size": got, "sha256": sha, "mime": header["mime"], "error": error, "ms": started.elapsed().as_millis() as u64 }));
        });
    }
}

/// A terminal stream from the phone: the header (already read), `term-ok` or `term-error`, the
/// terminal's output so far, then a pretend shell until it exits or the phone closes the stream.
async fn term_stream(mut send: SendStream, lines: Lines, header: Value, terms: Terms) -> Result<()> {
    let Lines { mut recv, buf } = lines;
    let size = (header["cols"].as_u64().unwrap_or(0), header["rows"].as_u64().unwrap_or(0));
    let opened: Result<(String, String, Vec<u8>), &str> = {
        let mut all = terms.lock().unwrap();
        match header["id"].as_str() {
            _ if !(1..=500).contains(&size.0) || !(1..=500).contains(&size.1) => Err("That terminal size is out of range."),
            None => {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                let mut n = now.subsec_nanos() ^ std::process::id().rotate_left(16);
                while all.contains_key(&format!("{n:08x}")) {
                    n = n.wrapping_add(1);
                }
                let id = format!("{n:08x}");
                let mut t = FakeTerm {
                    title: "Fake shell".into(),
                    cwd: header["cwd"].as_str().unwrap_or("C:\\fake").into(),
                    shell: header["shell"].as_str().unwrap_or("powershell").into(),
                    started: now.as_millis() as u64,
                    out: Vec::new(),
                    exit: None,
                    attached: 1,
                };
                t.keep(format!("Fake island terminal\r\n{PROMPT}").as_bytes());
                let opened = (id.clone(), t.title.clone(), t.out.clone());
                all.insert(id, t);
                Ok(opened)
            }
            Some(id) => match all.get_mut(id) {
                Some(t) if t.exit.is_none() => {
                    t.attached += 1;
                    Ok((id.to_string(), t.title.clone(), t.out.clone()))
                }
                _ => Err("That terminal isn't open anymore."),
            },
        }
    };
    let (id, title, replay) = match opened {
        Ok(o) => o,
        Err(error) => {
            send.write_all(format!("{}\n", json!({ "t": "term-error", "error": error })).as_bytes()).await?;
            send.finish()?;
            event(json!({ "e": "term-refused", "id": header["id"], "error": error }));
            return Ok(());
        }
    };
    event(json!({ "e": if header["id"].is_null() { "term-open" } else { "term-attach" }, "id": id, "cols": size.0, "rows": size.1, "cwd": header["cwd"], "shell": header["shell"], "replay": replay.len() }));
    send.write_all(format!("{}\n", json!({ "t": "term-ok", "id": id, "title": title })).as_bytes()).await?;
    send.write_all(&frames::encode_data(&replay)).await?;

    let mut decoder = frames::Decoder::default();
    decoder.push(&buf);
    let mut chunk = vec![0u8; 64 * 1024];
    let (mut line, mut got_in) = (String::new(), 0u64);
    let end = 'stream: loop {
        loop {
            let (kind, payload) = match decoder.next() {
                Ok(Some(f)) => f,
                Ok(None) => break,
                Err(frames::TooLong(n)) => break 'stream format!("a frame of {n} bytes"),
            };
            match kind {
                frames::DATA => {
                    got_in += payload.len() as u64;
                    let mut out = Vec::new();
                    let mut title_to = None;
                    let mut exit = false;
                    for c in String::from_utf8_lossy(&payload).chars() {
                        if c != '\r' {
                            line.push(c);
                            out.extend_from_slice(c.to_string().as_bytes());
                            continue;
                        }
                        let typed = std::mem::take(&mut line);
                        out.extend_from_slice(b"\r\n");
                        match typed.trim() {
                            "exit" => {
                                exit = true;
                                break;
                            }
                            t if t.starts_with("title ") => title_to = Some(t[6..].trim().to_string()),
                            t => out.extend_from_slice(format!("you typed: {t}\r\n").as_bytes()),
                        }
                        out.extend_from_slice(PROMPT.as_bytes());
                    }
                    if let Some(t) = terms.lock().unwrap().get_mut(&id) {
                        t.keep(&out);
                        if let Some(title) = &title_to {
                            t.title = title.clone();
                        }
                        if exit {
                            t.exit = Some(0);
                        }
                    }
                    let mut reply = frames::encode_data(&out);
                    if let Some(title) = title_to {
                        reply.extend(frames::encode(frames::TITLE, json!({ "title": title }).to_string().as_bytes()).unwrap_or_default());
                    }
                    if exit {
                        reply.extend(frames::encode(frames::EXIT, br#"{"code":0}"#).unwrap_or_default());
                    }
                    if let Err(e) = send.write_all(&reply).await {
                        break 'stream format!("writing: {e}");
                    }
                    if exit {
                        break 'stream "exit".to_string();
                    }
                }
                frames::RESIZE => {
                    let v: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
                    event(json!({ "e": "term-resize", "id": id, "cols": v["cols"], "rows": v["rows"] }));
                }
                other => event(json!({ "e": "term-frame", "id": id, "kind": other, "len": payload.len() })),
            }
        }
        match recv.read(&mut chunk).await {
            Ok(Some(n)) => decoder.push(&chunk[..n]),
            Ok(None) if decoder.pending() > 0 => break "the phone cut a frame short".to_string(),
            Ok(None) => break "the phone closed it".to_string(),
            Err(e) => break e.to_string(),
        }
    };
    if let Some(t) = terms.lock().unwrap().get_mut(&id) {
        t.attached = t.attached.saturating_sub(1);
    }
    let _ = send.finish();
    event(json!({ "e": "term-detach", "id": id, "why": end, "inBytes": got_in }));
    Ok(())
}

//! A stand-in for the island's phone side (src-tauri/src/remote), for phone/e2e. Its endpoint is
//! built like Island's (presets::N0, its own key, ALPN island-phone/1) and it speaks the
//! island's half of src/remote/protocol.ts, kept small:
//!   `pair` with FAKE_CODE -> `paired`; `hi` from a paired id -> a session; else `denied`
//!   a session starts with `hello` and a tiny `view`; `ping` -> `pong`; `act` -> a `toast`
//!   carrying the action; `act:test:push-file` sends the phone a file; `act:test:remove` -> `bye`
//!   a file stream from the phone is read whole (sha256) and answered `file-ok`
//!
//! usage: fake-island <state dir>   (its key and paired phones live there, so a restart keeps them)
//! stdout: `READY {...}` once online, then `EVENT {...}` lines; stdin: `quit` closes it cleanly.

use std::collections::BTreeSet;
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

const ALPN: &[u8] = b"island-phone/1";
const NAME: &str = "FakeIsland";
/// The one pairing code this fake takes (32 hex characters, like the island's).
const FAKE_CODE: &str = "00112233445566778899aabbccddeeff";
const MAX_LINE: usize = 1024 * 1024;
const MAX_UPLOAD: u64 = 2 * 1024 * 1024 * 1024;
const FILE_LINE: usize = 64 * 1024;

type Phones = Arc<Mutex<BTreeSet<String>>>;
type Out = mpsc::UnboundedSender<Value>;

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
        let (phones, dir) = (phones.clone(), dir.clone());
        tokio::spawn(async move {
            if let Err(e) = handle(incoming, phones, dir).await {
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

async fn handle(incoming: Incoming, phones: Phones, dir: PathBuf) -> Result<()> {
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
    tx.send(json!({ "t": "hello", "v": 1, "name": NAME, "platform": "windows", "version": "0.0.0-fake", "allow": true, "vapid": null })).ok();
    tx.send(json!({ "t": "view", "nav": { "open": "grid" }, "view": { "key": "fake/grid", "blocks": [] }, "urgent": null })).ok();
    tokio::spawn(accept_files(conn.clone(), phone.clone()));

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

async fn accept_files(conn: Connection, phone: String) {
    while let Ok((send, recv)) = conn.accept_bi().await {
        let phone = phone.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let (tx, _w) = writer(send);
            let mut lines = Lines { recv, buf: Vec::new() };
            let header: Value = match lines.next(FILE_LINE).await {
                Ok(Some(l)) => serde_json::from_str(&l).unwrap_or(Value::Null),
                _ => Value::Null,
            };
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

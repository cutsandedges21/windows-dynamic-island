// The remote end to end: a native "phone" endpoint dials the island's through a relay running in
// the test (like Land anywhere's tests), the way the phone website does: by the key and relay in
// the pairing code. `cargo test --lib remote`.

use base64::Engine;
use iroh::endpoint::{presets, Connection, ConnectionError, SendStream, VarInt};
use iroh::{EndpointAddr, RelayUrl, SecretKey};

use super::lines::LineReader;
use super::*;
#[cfg(windows)]
use crate::term::tests::plain;

const WAIT: Duration = Duration::from_secs(20);

type Events = Arc<Mutex<Vec<(String, Value)>>>;

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("island-remote-{tag}-{}-{}", std::process::id(), now_ms()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct Rig {
    island: Arc<Remote>,
    events: Events,
    map: iroh::RelayMap,
    dir: PathBuf,
    _relay: iroh_relay::server::Server,
}

async fn rig(tag: &str) -> Rig {
    let (map, _url, relay) = crate::anywhere::tests::local_relay().await;
    let dir = temp_dir(tag);
    let events: Events = Arc::default();
    let log = events.clone();
    let emit: Emit = Arc::new(move |e: &str, v: Value| log.lock().unwrap().push((e.to_string(), v)));
    let cfg = Config { dir: dir.clone(), downloads: Some(dir.join("Downloads")), name: Some("Test PC".into()), relays: Relays::Local(map.clone()), pair_for: PAIR_FOR };
    Rig { island: Remote::new(cfg, emit, Terms::new()), events, map, dir, _relay: relay }
}

impl Rig {
    /// The oldest `name` event not taken yet.
    async fn take(&self, name: &str) -> Value {
        for _ in 0..400 {
            {
                let mut events = self.events.lock().unwrap();
                if let Some(i) = events.iter().position(|(e, _)| e == name) {
                    return events.remove(i).1;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no {name} event");
    }

    fn count(&self, name: &str) -> usize {
        self.events.lock().unwrap().iter().filter(|(e, _)| e == name).count()
    }
}

/// A phone: a key of its own, through the test's relay only.
async fn phone(map: &iroh::RelayMap) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .relay_mode(iroh::RelayMode::Custom(map.clone()))
        .ca_tls_config(iroh::tls::CaTlsConfig::insecure_skip_verify())
        .clear_ip_transports()
        .secret_key(SecretKey::generate())
        .bind()
        .await
        .unwrap()
}

/// What a pairing URL holds.
fn decode(url: &str) -> Value {
    let payload = url.split("#pair=").nth(1).unwrap();
    serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap()
}

/// Dials the island by the key and first relay in a pairing code.
async fn dial(phone: &Endpoint, code: &Value) -> Connection {
    let id: iroh::EndpointId = code["id"].as_str().unwrap().parse().unwrap();
    let relay: RelayUrl = code["relays"][0].as_str().unwrap().parse().unwrap();
    timeout(WAIT, phone.connect(EndpointAddr::new(id).with_relay_url(relay), ALPN)).await.unwrap().unwrap()
}

/// The phone's control stream.
struct Control {
    send: SendStream,
    lines: LineReader,
}

impl Control {
    async fn open(conn: &Connection, first: Value) -> Control {
        let (mut send, recv) = conn.open_bi().await.unwrap();
        send.write_all(&line(&first)).await.unwrap();
        Control { send, lines: LineReader::new(recv, MAX_LINE) }
    }

    async fn say(&mut self, msg: Value) {
        self.send.write_all(&line(&msg)).await.unwrap();
    }

    async fn hear(&mut self) -> Value {
        let l = timeout(WAIT, self.lines.next_line()).await.unwrap().unwrap().unwrap();
        serde_json::from_slice(&l).unwrap()
    }

    /// Lines until a `terms` one that `want` takes (the list also comes whenever it changes).
    #[cfg(windows)]
    async fn terms_until(&mut self, want: impl Fn(&Value) -> bool) -> Value {
        loop {
            let v = self.hear().await;
            if v["t"] == "terms" && want(&v) {
                return v;
            }
        }
    }
}

/// Whether the island closed the connection with `code`.
async fn closed_with(conn: &Connection, code: u32) -> bool {
    match timeout(WAIT, conn.closed()).await {
        Ok(ConnectionError::ApplicationClosed(c)) => c.error_code == VarInt::from_u32(code),
        other => {
            eprintln!("closed: {other:?}");
            false
        }
    }
}

/// Pairs a new phone: its endpoint, the code, its connection and control stream.
async fn paired_phone(rig: &Rig, name: &str) -> (Endpoint, Value, Connection, Control) {
    let info = rig.island.pair_start("https://islandphone.vercel.app").await.unwrap();
    let code = decode(&info.url);
    let me = phone(&rig.map).await;
    let conn = dial(&me, &code).await;
    let mut c = Control::open(&conn, json!({ "t": "pair", "v": 1, "code": code["code"], "name": name })).await;
    assert_eq!(c.hear().await, json!({ "t": "paired", "name": "Test PC" }));
    rig.take("remote-paired").await;
    (me, code, conn, c)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_pairs_talks_and_is_removed() {
    let rig = rig("pair").await;
    let info = rig.island.pair_start("https://islandphone.vercel.app/").await.unwrap();
    assert!(info.url.starts_with("https://islandphone.vercel.app/#pair="), "{}", info.url);
    assert_eq!(info.qr.len(), info.size * info.size);
    assert!(info.expires > now_ms() + 9 * 60_000);
    let code = decode(&info.url);
    let ep = rig.island.endpoint().await.unwrap();
    assert_eq!(code["v"], 1);
    assert_eq!(code["id"], ep.id().to_string());
    assert_eq!(code["name"], "Test PC");
    let relay = code["relays"][0].as_str().unwrap();
    assert!(relay.starts_with("https://127.0.0.1:") && relay.ends_with('/'), "the home relay: {relay}");
    assert_eq!(code["code"].as_str().unwrap().len(), 32);

    let me = phone(&rig.map).await;
    let my_id = me.id().to_string();
    let conn = dial(&me, &code).await;
    let mut c = Control::open(&conn, json!({ "t": "pair", "v": 1, "code": code["code"], "name": " Moss’s iPhone " })).await;
    assert_eq!(c.hear().await, json!({ "t": "paired", "name": "Test PC" }));
    assert_eq!(rig.take("remote-paired").await, json!({ "phone": my_id, "name": "Moss’s iPhone" }));
    let phones = rig.island.phones();
    assert_eq!(phones.len(), 1);
    assert_eq!((phones[0].id.as_str(), phones[0].name.as_str(), phones[0].connected, phones[0].push), (my_id.as_str(), "Moss’s iPhone", true, false));
    let listed = rig.take("remote-phones").await;
    assert_eq!(listed[0]["connected"], true);
    assert!(listed[0]["pairedAt"].as_u64().unwrap() > 0 && listed[0]["lastSeen"].as_u64().is_some());
    let saved: Value = serde_json::from_slice(&std::fs::read(rig.dir.join("phones.json")).unwrap()).unwrap();
    assert_eq!(saved[0]["id"], my_id);

    // Lines Rust doesn't handle go to the island's TypeScript, and the island's reach the phone.
    c.say(json!({ "t": "nav", "open": "grid" })).await;
    assert_eq!(rig.take("remote-msg").await, json!({ "phone": my_id, "msg": { "t": "nav", "open": "grid" } }));
    assert!(rig.island.send(Some(&my_id), &json!({ "t": "toast", "text": "Sent", "tone": "good" })));
    assert_eq!(c.hear().await["text"], "Sent");
    assert!(rig.island.send(None, &json!({ "t": "view", "nav": { "open": "grid" }, "view": null, "urgent": null })));
    assert_eq!(c.hear().await["t"], "view");
    assert!(!rig.island.send(Some("someone else"), &json!({ "t": "toast" })));
    assert!(!rig.island.send(None, &json!("not an object")));
    assert!(!rig.island.send(None, &json!({ "t": "toast", "text": "x".repeat(MAX_LINE) })), "too long for a line");
    c.say(json!({ "t": "ping" })).await;
    assert_eq!(c.hear().await, json!({ "t": "pong" }));
    // Its push subscription is kept (and only a real one).
    let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4u8; 65]);
    let auth = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9u8; 16]);
    c.say(json!({ "t": "push-sub", "sub": { "endpoint": "https://web.push.apple.com/x", "keys": { "p256dh": key, "auth": auth } } })).await;
    c.say(json!({ "t": "ping" })).await;
    assert_eq!(c.hear().await, json!({ "t": "pong" }));
    assert!(rig.island.phones()[0].push);
    assert_eq!(rig.count("remote-msg"), 0, "ping and push-sub stay in Rust");

    // The same phone again (its page reloaded): "hi" gets in and the old connection goes.
    let conn2 = dial(&me, &code).await;
    let mut c2 = Control::open(&conn2, json!({ "t": "hi", "v": 1 })).await;
    c2.say(json!({ "t": "ping" })).await;
    assert_eq!(c2.hear().await, json!({ "t": "pong" }));
    assert!(closed_with(&conn, CLOSE_REPLACED).await);
    assert!(rig.island.phones()[0].connected);
    assert!(rig.island.rename(&my_id, "Work phone"));
    assert_eq!(rig.island.phones()[0].name, "Work phone");

    // The code worked once.
    let other = phone(&rig.map).await;
    let conn3 = dial(&other, &code).await;
    let mut c3 = Control::open(&conn3, json!({ "t": "pair", "v": 1, "code": code["code"], "name": "Someone" })).await;
    assert_eq!(c3.hear().await, json!({ "t": "denied", "why": "expired" }));
    assert!(closed_with(&conn3, CLOSE_DENIED).await);
    assert_eq!(rig.island.phones().len(), 1);

    // Removed: it hears bye and goes; with no phones left the endpoint stops.
    let forgetting = tokio::spawn({
        let (island, id) = (rig.island.clone(), my_id.clone());
        async move { island.forget(&id).await }
    });
    assert_eq!(c2.hear().await, json!({ "t": "bye", "why": "removed" }));
    conn2.close(VarInt::from_u32(0), b"heard");
    assert!(forgetting.await.unwrap());
    assert!(rig.island.phones().is_empty());
    assert!(!rig.island.running().await);
    me.close().await;
    other.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn strangers_wrong_codes_and_other_versions_are_turned_away() {
    let rig = rig("deny").await;
    // A paired phone keeps the endpoint running throughout.
    let (me, _, _conn, _c) = paired_phone(&rig, "iPhone").await;
    let info = rig.island.pair_start("https://islandphone.vercel.app").await.unwrap();
    let code = decode(&info.url);
    let stranger = phone(&rig.map).await;
    let ask = |first: Value| {
        let (stranger, code) = (&stranger, &code);
        async move {
            let conn = dial(stranger, code).await;
            let mut c = Control::open(&conn, first).await;
            let heard = c.hear().await;
            conn.close(VarInt::from_u32(0), b"heard");
            heard
        }
    };
    assert_eq!(ask(json!({ "t": "hi", "v": 1 })).await, json!({ "t": "denied", "why": "unknown" }));
    assert_eq!(ask(json!({ "t": "hi", "v": 2 })).await, json!({ "t": "denied", "why": "version" }));
    assert_eq!(ask(json!({ "t": "pair", "v": 2, "code": code["code"], "name": "x" })).await, json!({ "t": "denied", "why": "version" }));
    for _ in 0..5 {
        assert_eq!(ask(json!({ "t": "pair", "v": 1, "code": "0".repeat(32), "name": "x" })).await, json!({ "t": "denied", "why": "code" }));
    }
    // Five wrong tries ended the code: the right one is too late.
    assert_eq!(ask(json!({ "t": "pair", "v": 1, "code": code["code"], "name": "x" })).await, json!({ "t": "denied", "why": "expired" }));
    assert_eq!(rig.island.phones().len(), 1);
    assert_eq!(rig.count("remote-paired"), 0);
    // Not a phone at all.
    let conn = dial(&stranger, &code).await;
    let _c = Control::open(&conn, json!({ "t": "nav", "open": "grid" })).await;
    assert!(closed_with(&conn, CLOSE_BAD).await);
    // With the phone gone and no code waiting, the endpoint stops.
    assert!(rig.island.forget(&me.id().to_string()).await);
    assert!(!rig.island.running().await);
    stranger.close().await;
    me.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_line_too_long_or_not_utf8_closes_the_connection() {
    let rig = rig("long").await;
    let (me, code, conn, mut c) = paired_phone(&rig, "iPhone").await;
    // (The island may close before all of it is written.)
    let _ = c.send.write_all(&vec![b'x'; MAX_LINE + 10]).await;
    assert!(closed_with(&conn, CLOSE_TOO_LONG).await);
    let conn = dial(&me, &code).await;
    let mut c = Control::open(&conn, json!({ "t": "hi", "v": 1 })).await;
    c.send.write_all(b"{\"t\":\"nav\",\"open\":\"\xff\"}\n").await.unwrap();
    assert!(closed_with(&conn, CLOSE_BAD).await);
    assert_eq!(rig.count("remote-msg"), 0);
    // A line of exactly MAX_LINE bytes with its newline is fine.
    let conn = dial(&me, &code).await;
    let mut c = Control::open(&conn, json!({ "t": "hi", "v": 1 })).await;
    let msg = json!({ "t": "big", "pad": "" });
    let pad = MAX_LINE - line(&msg).len();
    c.say(json!({ "t": "big", "pad": "y".repeat(pad) })).await;
    assert_eq!(rig.take("remote-msg").await["msg"]["pad"].as_str().unwrap().len(), pad);
    me.close().await;
    rig.island.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_endpoint_starts_at_launch_only_with_a_paired_phone() {
    let dir = temp_dir("launch");
    let emit: Emit = Arc::new(|_: &str, _: Value| {});
    let cfg = |dir: &PathBuf| Config { dir: dir.clone(), downloads: None, name: Some("Test PC".into()), relays: Relays::Off, pair_for: PAIR_FOR };
    let island = Remote::new(cfg(&dir), emit.clone(), Terms::new());
    island.start_if_paired().await;
    assert!(!island.running().await);
    let id = SecretKey::generate().public().to_string();
    std::fs::write(dir.join("phones.json"), json!([{ "id": id, "name": "iPhone", "pairedAt": 1, "lastSeen": 2, "push": null }]).to_string()).unwrap();
    let island = Remote::new(cfg(&dir), emit, Terms::new());
    island.start_if_paired().await;
    assert!(island.running().await);
    let key = std::fs::read(dir.join("phone-endpoint.key")).unwrap();
    assert_eq!(key.len(), 32, "its own key, kept");
    assert_eq!(island.phones()[0].name, "iPhone");
    assert!(!island.phones()[0].connected);
    island.close().await;
}

/// One file from the phone: its header and bytes, and the island's answer.
async fn upload(conn: &Connection, header: Value, bytes: &[u8]) -> Value {
    let (mut send, recv) = conn.open_bi().await.unwrap();
    send.write_all(&line(&header)).await.unwrap();
    for chunk in bytes.chunks(7000) {
        send.write_all(chunk).await.unwrap();
    }
    send.finish().unwrap();
    let mut answer = LineReader::new(recv, MAX_LINE);
    serde_json::from_slice(&timeout(WAIT, answer.next_line()).await.unwrap().unwrap().unwrap()).unwrap()
}

fn landing_files(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir).map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".landing")).count()).unwrap_or(0)
}

#[tokio::test(flavor = "multi_thread")]
async fn files_go_from_the_phone_to_downloads() {
    let rig = rig("files-in").await;
    let (me, _code, conn, _c) = paired_phone(&rig, "iPhone").await;
    let downloads = rig.dir.join("Downloads");
    let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    for (i, saved) in ["IMG 0001.JPG", "IMG 0001 (1).JPG"].into_iter().enumerate() {
        let id = format!("f{i}");
        let reply = upload(&conn, json!({ "t": "file", "id": id, "name": "IMG 0001.JPG", "size": data.len(), "mime": "image/jpeg" }), &data).await;
        assert_eq!(reply, json!({ "t": "file-ok", "id": id, "name": saved }));
        assert_eq!(std::fs::read(downloads.join(saved)).unwrap(), data, "never over the file already there");
        let ev = rig.take("remote-file").await;
        assert_eq!(ev, json!({ "phone": me.id().to_string(), "id": id, "name": saved, "path": downloads.join(saved).to_string_lossy(), "size": 200_000, "mime": "image/jpeg" }));
    }
    // A name that would leave Downloads stays in it.
    let reply = upload(&conn, json!({ "t": "file", "id": "n", "name": r"..\..\notes.txt", "size": 2, "mime": "text/plain" }), b"hi").await;
    assert_eq!(reply["t"], "file-ok");
    let name = reply["name"].as_str().unwrap();
    assert!(!name.contains(['/', '\\']), "{name}");
    assert_eq!(std::fs::read(downloads.join(name)).unwrap(), b"hi");
    rig.take("remote-file").await;
    // Bytes that stop short, or run long, leave nothing behind.
    let reply = upload(&conn, json!({ "t": "file", "id": "short", "name": "cut.bin", "size": 1000, "mime": "" }), &[1u8; 10]).await;
    assert_eq!((reply["t"].as_str(), reply["id"].as_str()), (Some("file-error"), Some("short")));
    let reply = upload(&conn, json!({ "t": "file", "id": "long", "name": "long.bin", "size": 5, "mime": "" }), &[1u8; 10]).await;
    assert_eq!(reply["t"], "file-error");
    assert!(!downloads.join("cut.bin").exists() && !downloads.join("long.bin").exists());
    assert_eq!(landing_files(&downloads), 0, "no temp files left");
    // Too big is refused before a byte is written.
    let reply = upload(&conn, json!({ "t": "file", "id": "big", "name": "big.mov", "size": files::MAX_UPLOAD + 1, "mime": "video/quicktime" }), b"").await;
    assert!(reply["error"].as_str().unwrap().contains("2 GB"), "{reply}");
    assert_eq!(rig.count("remote-file"), 0);
    me.close().await;
    rig.island.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn files_go_from_the_pc_to_a_phone() {
    let rig = rig("files-out").await;
    let (me, _code, conn, _c) = paired_phone(&rig, "iPhone").await;
    let my_id = me.id().to_string();
    let src = rig.dir.join("report.pdf");
    let data: Vec<u8> = (0..150_000u32).map(|i| (i % 241) as u8).collect();
    std::fs::write(&src, &data).unwrap();
    // The phone keeps the first and says no to the second.
    for (keep, expect) in [(true, Ok("report.pdf".to_string())), (false, Err("No room on this phone.".to_string()))] {
        let sending = tokio::spawn({
            let (island, id, src) = (rig.island.clone(), my_id.clone(), src.clone());
            async move { island.send_file(&id, &src).await }
        });
        let (mut send, recv) = timeout(WAIT, conn.accept_bi()).await.unwrap().unwrap();
        let mut lines = LineReader::new(recv, MAX_LINE);
        let head: Value = serde_json::from_slice(&timeout(WAIT, lines.next_line()).await.unwrap().unwrap().unwrap()).unwrap();
        assert_eq!((head["t"].as_str(), head["name"].as_str(), head["size"].as_u64(), head["mime"].as_str()), (Some("file"), Some("report.pdf"), Some(150_000), Some("application/pdf")));
        let (mut recv, mut got) = lines.into_parts();
        while let Some(chunk) = timeout(WAIT, recv.read_chunk(65536)).await.unwrap().unwrap() {
            got.extend_from_slice(&chunk);
        }
        assert_eq!(got, data);
        let answer = if keep { json!({ "t": "file-ok", "id": head["id"], "name": "report.pdf" }) } else { json!({ "t": "file-error", "id": head["id"], "error": "No room on this phone." }) };
        send.write_all(&line(&answer)).await.unwrap();
        send.finish().unwrap();
        assert_eq!(sending.await.unwrap(), expect);
        let ev = rig.take("remote-file-sent").await;
        match &expect {
            Ok(_) => assert_eq!(ev, json!({ "phone": my_id, "name": "report.pdf", "ok": true })),
            Err(e) => assert_eq!(ev, json!({ "phone": my_id, "name": "report.pdf", "ok": false, "error": e })),
        }
    }
    // Too big for a phone, a folder, a phone that isn't connected: nothing is sent.
    let big = rig.dir.join("big.bin");
    std::fs::File::create(&big).unwrap().set_len(files::MAX_DOWNLOAD + 1).unwrap();
    assert!(rig.island.send_file(&my_id, &big).await.unwrap_err().contains("200 MB"));
    assert!(rig.island.send_file(&my_id, &rig.dir).await.unwrap_err().contains("folders"));
    assert!(rig.island.send_file("not-a-phone", &src).await.unwrap_err().contains("isn't connected"));
    assert_eq!(rig.take("remote-file-sent").await["ok"], false);
    me.close().await;
    rig.island.close().await;
}

/// A terminal stream from the phone's side: the header, the island's answer, then frames.
#[cfg(windows)]
struct TermStream {
    send: SendStream,
    recv: iroh::endpoint::RecvStream,
    frames: terms::Frames,
    answer: Value,
}

#[cfg(windows)]
impl TermStream {
    async fn open(conn: &Connection, header: Value) -> TermStream {
        let (mut send, recv) = conn.open_bi().await.unwrap();
        send.write_all(&line(&header)).await.unwrap();
        let mut lines = LineReader::new(recv, MAX_LINE);
        let answer = serde_json::from_slice(&timeout(WAIT, lines.next_line()).await.unwrap().unwrap().unwrap()).unwrap();
        let (recv, rest) = lines.into_parts();
        let mut frames = terms::Frames::default();
        frames.push(&rest);
        TermStream { send, recv, frames, answer }
    }

    /// The next frame; None once the island finished the stream.
    async fn frame(&mut self) -> Option<(u8, Vec<u8>)> {
        loop {
            if let Some(f) = self.frames.next_frame().unwrap() {
                return Some(f);
            }
            match timeout(Duration::from_secs(30), self.recv.read_chunk(65536)).await.expect("a frame in time") {
                Ok(Some(chunk)) => self.frames.push(&chunk),
                _ => return None,
            }
        }
    }

    /// Output until `want` holds for its text (escape sequences left out).
    async fn output_until(&mut self, text: &mut Vec<u8>, want: impl Fn(&str) -> bool) {
        while !want(&plain(text)) {
            match self.frame().await {
                Some((terms::TERM_DATA, bytes)) => text.extend_from_slice(&bytes),
                Some(_) => {}
                None => panic!("the stream ended; the output: {:?}", plain(text)),
            }
        }
    }

    /// Frames until the stream ends: the exit's payload, if one came.
    async fn to_the_end(&mut self) -> Option<Value> {
        let mut exit = None;
        while let Some((kind, payload)) = self.frame().await {
            if kind == terms::TERM_EXIT {
                exit = Some(serde_json::from_slice(&payload).unwrap());
            }
        }
        exit
    }

    async fn keys(&mut self, text: &str) {
        self.send.write_all(&terms::frame(terms::TERM_DATA, text.as_bytes())).await.unwrap();
    }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_phone_opens_a_terminal_types_and_reads_it_back() {
    let rig = rig("term").await;
    let (me, _code, conn, mut c) = paired_phone(&rig, "iPhone").await;
    let my_id = me.id().to_string();
    // Off until the PC allows it: no list and no terminal.
    c.say(json!({ "t": "term-list" })).await;
    assert_eq!(c.terms_until(|_| true).await, json!({ "t": "terms", "items": [], "allowed": false }));
    let header = json!({ "t": "term", "id": null, "cols": 100, "rows": 30, "cwd": null, "shell": "cmd" });
    let mut refused = TermStream::open(&conn, header.clone()).await;
    assert_eq!(refused.answer, json!({ "t": "term-error", "error": terms::NOT_ALLOWED }));
    assert!(refused.frame().await.is_none(), "then the stream ends");
    assert!(rig.island.terms.list().is_empty());
    rig.island.term_allow(true);
    assert_eq!(c.terms_until(|_| true).await, json!({ "t": "terms", "items": [], "allowed": true }));

    // A new terminal: term-ok, the island hears which phone opened it, and keys go in.
    let mut t = TermStream::open(&conn, header).await;
    assert_eq!(t.answer["t"], "term-ok", "{}", t.answer);
    let id = t.answer["id"].as_str().unwrap().to_string();
    assert_eq!(id.len(), 8);
    let opened = rig.take("term-opened").await;
    assert_eq!((opened["phone"].as_str(), opened["id"].as_str()), (Some(my_id.as_str()), Some(id.as_str())));
    assert_eq!(opened["title"], t.answer["title"]);
    let mut text = Vec::new();
    t.output_until(&mut text, |s| s.contains('>')).await;
    // `^` keeps the typed line from holding the words it prints.
    t.keys("echo is^land-hi\r").await;
    t.output_until(&mut text, |s| s.contains("island-hi")).await;
    t.send.write_all(&terms::frame(terms::TERM_RESIZE, br#"{"cols":120,"rows":40}"#)).await.unwrap();
    let listed = c.terms_until(|v| v["items"][0]["attached"] == 1).await;
    let item = &listed["items"][0];
    assert_eq!((item["id"].as_str(), item["shell"].as_str(), item["exit"].is_null(), item["claude"].as_bool()), (Some(id.as_str()), Some("cmd"), true, Some(false)));
    assert_eq!(rig.island.terms.list().len(), 1);

    // Letting go leaves it running; attaching again replays what it printed.
    t.send.finish().unwrap();
    assert!(t.to_the_end().await.is_none(), "no exit: it still runs");
    c.terms_until(|v| v["items"][0]["attached"] == 0).await;
    let mut again = TermStream::open(&conn, json!({ "t": "term", "id": id, "cols": 80, "rows": 24, "cwd": null, "shell": null })).await;
    assert_eq!((again.answer["t"].as_str(), again.answer["id"].as_str()), (Some("term-ok"), Some(id.as_str())));
    let mut replay = Vec::new();
    again.output_until(&mut replay, |s| s.contains("island-hi")).await;
    let gone = TermStream::open(&conn, json!({ "t": "term", "id": "00000000", "cols": 80, "rows": 24 })).await;
    assert_eq!(gone.answer, json!({ "t": "term-error", "error": "That terminal isn't open anymore." }));

    // Turned off on the PC: the stream is let go, new ones are refused, and none can be ended.
    rig.island.term_allow(false);
    assert!(again.to_the_end().await.is_none());
    c.terms_until(|v| v["allowed"] == false && v["items"] == json!([])).await;
    let refused = TermStream::open(&conn, json!({ "t": "term", "id": id, "cols": 80, "rows": 24 })).await;
    assert_eq!(refused.answer["error"], terms::NOT_ALLOWED);
    c.say(json!({ "t": "term-kill", "id": id })).await;
    c.terms_until(|v| v["allowed"] == false).await;
    assert_eq!(rig.island.terms.list().len(), 1);

    // Allowed again: term-kill ends it, the attached stream hears the exit, the list empties.
    rig.island.term_allow(true);
    let mut last = TermStream::open(&conn, json!({ "t": "term", "id": id, "cols": 80, "rows": 24 })).await;
    assert_eq!(last.answer["t"], "term-ok");
    c.say(json!({ "t": "term-kill", "id": id })).await;
    c.terms_until(|v| v["allowed"] == true && v["items"] == json!([])).await;
    let exit = last.to_the_end().await.expect("an exit frame before the end");
    assert!(exit["code"].is_i64(), "{exit}");
    assert!(rig.island.terms.list().is_empty());
    assert_eq!(rig.count("remote-msg"), 0, "terminal lines stay in Rust");
    me.close().await;
    rig.island.close().await;
}

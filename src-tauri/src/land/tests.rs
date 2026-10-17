// Land's tests: names and files, offers, and whole transfers between two Lands in one process.

use super::*;

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("island-land-{tag}-{}-{}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn hello_round_trips_and_rejects_forgeries() {
    let me = Identity::generate().unwrap();
    let h = Hello::new("here", &me, "Moss's PC", 5000);
    let (back, key) = Hello::decode(&h.encode()).unwrap();
    assert_eq!(back.id, me.id);
    assert_eq!(back.name, "Moss's PC");
    assert_eq!(key, me.public);
    // An id that is not the key's.
    let other = Identity::generate().unwrap();
    let forged = Hello { id: other.id.clone(), ..h.clone() };
    assert!(Hello::decode(&forged.encode()).is_none());
    // Another app, another version, another kind, junk.
    assert!(Hello::decode(&Hello { land: 2, ..h.clone() }.encode()).is_none());
    assert!(Hello::decode(&Hello { t: "hi".into(), ..h.clone() }.encode()).is_none());
    assert!(Hello::decode(b"{\"land\":1}").is_none());
    assert!(Hello::decode(&[b'x'; 3000]).is_none());
    // Names and systems are cleaned.
    let odd = Hello { name: "  \u{7}Lab\nPC  ".into(), os: "plan9".into(), ..h };
    let (clean, _) = Hello::decode(&odd.encode()).unwrap();
    assert_eq!(clean.name, "LabPC");
    assert_eq!(clean.os, "other");
}

#[test]
fn device_ids_are_short_and_stable() {
    let me = Identity::generate().unwrap();
    assert_eq!(me.id.len(), 16);
    assert_eq!(device_id(&me.public), me.id);
    let dir = temp_dir("key");
    let file = dir.join("land.key");
    let a = Identity::load_or_create(&file).unwrap();
    let b = Identity::load_or_create(&file).unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(a.private, b.private);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn only_the_local_network_counts() {
    let nets = [Net { ip: Ipv4Addr::new(192, 168, 1, 20), prefix: 24 }, Net { ip: Ipv4Addr::new(100, 101, 102, 103), prefix: 32 }];
    assert!(is_local("192.168.1.77".parse().unwrap(), &nets));
    assert!(is_local("127.0.0.1".parse().unwrap(), &nets));
    assert!(is_local("::ffff:192.168.1.5".parse().unwrap(), &nets));
    assert!(!is_local("192.168.2.77".parse().unwrap(), &nets), "another subnet");
    assert!(!is_local("8.8.8.8".parse().unwrap(), &nets), "the internet");
    assert!(!is_local("100.101.102.104".parse().unwrap(), &nets), "a VPN's /32 is no local network");
    assert!(!is_local("fe80::1".parse().unwrap(), &nets));
    let n = Net { ip: Ipv4Addr::new(10, 0, 5, 9), prefix: 16 };
    assert_eq!(n.broadcast(), Ipv4Addr::new(10, 0, 255, 255));
    assert!(n.contains(Ipv4Addr::new(10, 0, 200, 1)));
}

#[test]
fn incoming_names_cannot_escape_or_break_windows() {
    assert_eq!(clean_rel("../../etc/passwd"), vec!["etc", "passwd"]);
    assert_eq!(clean_rel("..\\..\\Windows\\win.ini"), vec!["Windows", "win.ini"]);
    assert_eq!(clean_rel("/abs/path.txt"), vec!["abs", "path.txt"]);
    assert_eq!(clean_rel("C:\\x\\y.txt"), vec!["C_", "x", "y.txt"]);
    assert_eq!(clean_rel("a<b>c?.txt"), vec!["a_b_c_.txt"]);
    assert_eq!(clean_rel("con.txt"), vec!["_con.txt"]);
    assert_eq!(clean_rel("COM1"), vec!["_COM1"]);
    assert_eq!(clean_rel("notes. . "), vec!["notes"]);
    assert_eq!(clean_rel("..."), vec!["file"]);
    assert_eq!(clean_rel(""), vec!["file"]);
    let long = format!("{}.jpeg", "x".repeat(400));
    let c = clean_rel(&long);
    assert_eq!(c[0].chars().count(), 150);
    assert!(c[0].ends_with(".jpeg"));
    assert_eq!(clean_rel(&"a/".repeat(100)).len(), MAX_DEPTH);
}

#[test]
fn names_get_a_number_instead_of_replacing() {
    assert_eq!(candidate("photo.jpg", 0, false), "photo.jpg");
    assert_eq!(candidate("photo.jpg", 2, false), "photo (2).jpg");
    assert_eq!(candidate(".bashrc", 1, false), ".bashrc (1)");
    assert_eq!(candidate("my.folder", 1, true), "my.folder (1)");
    let dir = temp_dir("place");
    std::fs::write(dir.join("a.txt"), "old").unwrap();
    let temp = dir.join("a.txt.landing");
    std::fs::write(&temp, "new").unwrap();
    let at = place(&temp, &dir, "a.txt").unwrap();
    assert_eq!(at, dir.join("a (1).txt"));
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "old");
    assert_eq!(std::fs::read_to_string(&at).unwrap(), "new");
    assert!(!temp.exists());
    assert_eq!(reserve_dir(&dir, "Photos").unwrap(), dir.join("Photos"));
    assert_eq!(reserve_dir(&dir, "Photos").unwrap(), dir.join("Photos (1)"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn files_group_into_what_was_dropped() {
    let files = |names: &[(&str, u64)]| names.iter().map(|(n, s)| OfferFile { name: n.to_string(), size: *s, mtime: 0 }).collect::<Vec<_>>();
    let t = tops(&files(&[("Trip/a.jpg", 3), ("notes.txt", 1), ("trip/b/c.jpg", 4), ("../Trip", 9)]));
    assert_eq!(
        t,
        vec![
            Top { name: "Trip".into(), size: 7, files: 2, dir: true },
            Top { name: "notes.txt".into(), size: 1, files: 1, dir: false },
            Top { name: "Trip".into(), size: 9, files: 1, dir: false },
        ]
    );
    let many: Vec<OfferFile> = (0..50).map(|i| OfferFile { name: format!("f{i}"), size: 1, mtime: 0 }).collect();
    let tr = Transfer::new("x", "in", PeerInfo { id: "p".into(), name: "P".into(), os: "macos".into(), anywhere: None }, &many);
    assert_eq!((tr.count, tr.total, tr.items.len()), (50, 50, LISTED));
}

#[test]
fn text_offers_are_checked() {
    let o = Offer::parse(&json!({ "t": "offer", "from": "Lab", "os": "windows", "files": [], "text": "  https://example.com/a\u{7}  " })).unwrap();
    assert_eq!(o.text.as_deref(), Some("https://example.com/a"));
    assert_eq!((o.files.len(), o.total), (0, 0));
    assert_eq!(clean_text("line one\nline two").as_deref(), Some("line one\nline two"));
    assert!(Offer::parse(&json!({ "t": "offer", "files": [], "text": "   " })).is_none(), "blank text");
    assert!(Offer::parse(&json!({ "t": "offer", "files": [], "text": "x".repeat(MAX_TEXT + 1) })).is_none(), "too long");
    assert!(Offer::parse(&json!({ "t": "offer", "files": [], "text": 5 })).is_none());
}

#[test]
fn offers_are_checked() {
    let ok = json!({ "t": "offer", "from": "Lab\u{1}PC", "os": "macos", "files": [{ "name": "a.txt", "size": 3 }, { "name": "b/c.txt", "size": 4 }] });
    let o = Offer::parse(&ok).unwrap();
    assert_eq!(o.total, 7);
    assert_eq!(o.from, "LabPC");
    assert_eq!(o.files.len(), 2);
    assert!(Offer::parse(&json!({ "t": "offer", "files": [] })).is_none());
    assert!(Offer::parse(&json!({ "t": "offer", "files": [{ "name": "", "size": 1 }] })).is_none());
    assert!(Offer::parse(&json!({ "t": "offer", "files": [{ "name": "a", "size": -1 }] })).is_none());
    assert!(Offer::parse(&json!({ "t": "offer", "files": [{ "name": "a", "size": u64::MAX }, { "name": "b", "size": 1 }] })).is_none(), "an overflowing total");
    assert!(Offer::parse(&json!({ "t": "accept" })).is_none());
}

#[test]
fn folders_are_walked_without_links_or_junk() {
    let dir = temp_dir("walk");
    let top = dir.join("Trip");
    std::fs::create_dir_all(top.join("day 1")).unwrap();
    std::fs::write(top.join("day 1").join("beach.jpg"), b"12345").unwrap();
    std::fs::write(top.join("notes.txt"), b"hi").unwrap();
    std::fs::write(top.join(".DS_Store"), b"junk").unwrap();
    std::fs::write(dir.join("solo.pdf"), b"pdf!").unwrap();
    let mut items = collect(&[top.clone(), dir.join("solo.pdf")]).unwrap();
    items.sort_by(|a, b| a.name.cmp(&b.name));
    let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, vec!["Trip/day 1/beach.jpg", "Trip/notes.txt", "solo.pdf"]);
    assert_eq!(items.iter().map(|i| i.size).sum::<u64>(), 11);
    let s = stage(&top.to_string_lossy());
    assert!(s.dir);
    assert_eq!((s.files, s.size), (2, 7));
    assert!(stage(&dir.join("missing").to_string_lossy()).error.is_some());
    let _ = std::fs::remove_dir_all(dir);
}

// ---------------------------------------------------------------- end to end, over loopback

type Events = Arc<Mutex<Vec<(String, Value)>>>;

fn recorder() -> (Emit, Events) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    (Arc::new(move |e: &str, v: Value| sink.lock().unwrap().push((e.to_string(), v))), events)
}

fn last_state(events: &Events, dir: &str) -> Option<Value> {
    events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["dir"] == dir).map(|(_, v)| v.clone())
}

async fn wait_for(events: &Events, dir: &str, state: &str) -> Value {
    for _ in 0..400 {
        if let Some(v) = last_state(events, dir) {
            if v["state"] == state {
                return v;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("no {dir} transfer reached {state}: {:?}", last_state(events, dir));
}

async fn wait_id(events: &Events, id: &str, state: &str) -> Value {
    for _ in 0..400 {
        let last = events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["id"] == id).map(|(_, v)| v.clone());
        if let Some(v) = last.filter(|v| v["state"] == state) {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("transfer {id} never reached {state}");
}

/// Land anywhere without relays, its friends kept in `dir`.
fn far_setup(dir: &Path) -> Option<crate::anywhere::Setup> {
    Some(crate::anywhere::Setup { key: iroh::SecretKey::generate(), relays: crate::anywhere::Relays::Off, book: dir.join("land-friends.json") })
}

#[tokio::test]
async fn land_asks_friends_under_its_current_name() {
    let (ea, _) = recorder();
    let (eb, b_events) = recorder();
    let a = start(Identity::generate().unwrap(), Options { name: "Moss".into(), visible: false, downloads: temp_dir("far-a"), discovery: 0, anywhere: far_setup(&temp_dir("far-a-book")) }, ea).await.unwrap();
    let b = start(Identity::generate().unwrap(), Options { name: "Alex".into(), visible: false, downloads: temp_dir("far-b"), discovery: 0, anywhere: far_setup(&temp_dir("far-b-book")) }, eb).await.unwrap();
    a.rename("Moss's laptop").await;
    let (fa, fb) = (a.far().unwrap(), b.far().unwrap());
    let asking = tokio::spawn({
        let (fa, to) = (fa.clone(), fb.addr());
        async move { fa.ask(to).await }
    });
    let mut ask = None;
    for _ in 0..400 {
        ask = b_events.lock().unwrap().iter().find(|(e, v)| e == "land-friend-ask" && v["state"] == "asking").map(|(_, v)| v.clone());
        if ask.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let ask = ask.expect("the request reached Alex's island");
    assert_eq!(ask["from"]["name"], "Moss's laptop");
    assert!(fb.answer(ask["id"].as_str().unwrap(), crate::anywhere::Reply::Add));
    assert_eq!(asking.await.unwrap().unwrap().name, "Alex");
    a.shutdown().await;
    b.shutdown().await;
}

// ------------------------------------------------------------ resume after a drop

/// Whether an event with this transfer id and state was ever published.
async fn wait_seen(events: &Events, id: &str, state: &str) {
    for _ in 0..400 {
        if events.lock().unwrap().iter().any(|(e, v)| e == "land-transfer" && v["id"] == id && v["state"] == state) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("transfer {id} was never {state}");
}

/// Retries come fast in tests.
fn quick(run: &Running) {
    run.set_timing(Timing { retry_first: Duration::from_millis(50), retry_max: Duration::from_millis(400), retry_for: Duration::from_secs(20), pause_keep: Duration::from_secs(20), ..Timing::default() });
}

fn landing_files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.to_string_lossy().ends_with(".landing") {
                found.push(path);
            }
        }
    }
    found
}

fn asks(events: &Events) -> usize {
    events.lock().unwrap().iter().filter(|(e, v)| e == "land-transfer" && v["state"] == "asking").count()
}

/// A megabyte where every byte's place shows (a resume that skips or repeats one fails).
fn megabyte() -> Vec<u8> {
    (0..1_000_000u32).map(|i| (i % 251) as u8).collect()
}

async fn resumes(p: Pair, to: String) {
    quick(&p.a);
    quick(&p.b);
    let data = megabyte();
    std::fs::write(p.source.join("big.bin"), &data).unwrap();
    p.a.cut_after(300_000);
    let id = p.a.send(&to, vec![p.source.join("big.bin")]).await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    let in_id = ask["id"].as_str().unwrap().to_string();
    p.b.answer(&in_id, true);
    wait_seen(&p.b_events, &in_id, "paused").await;
    wait_seen(&p.a_events, &id, "paused").await;
    wait_id(&p.a_events, &id, "done").await;
    wait_id(&p.b_events, &in_id, "done").await;
    assert_eq!(std::fs::read(p.downloads.join("big.bin")).unwrap(), data);
    assert_eq!(asks(&p.b_events), 1, "the second offer was the same transfer, already accepted");
    assert!(landing_files(&p.downloads).is_empty());
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn a_dropped_transfer_picks_up_where_it_left_off() {
    let p = pair("resume").await;
    let to = p.b.me.id.clone();
    resumes(p, to).await;
}

#[tokio::test]
async fn a_dropped_transfer_to_a_friend_picks_up_where_it_left_off() {
    let p = far_pair("resume-far").await;
    let to = p.b.far().unwrap().id().to_string();
    resumes(p, to).await;
}

#[tokio::test]
async fn cancelling_a_paused_transfer_stops_the_retries_and_its_files() {
    let p = pair("resume-cancel").await;
    quick(&p.b);
    p.a.set_timing(Timing { retry_first: Duration::from_millis(800), retry_max: Duration::from_secs(2), retry_for: Duration::from_secs(20), pause_keep: Duration::from_secs(20), ..Timing::default() });
    std::fs::write(p.source.join("big.bin"), megabyte()).unwrap();
    p.a.cut_after(300_000);
    let id = p.a.send(&p.b.me.id, vec![p.source.join("big.bin")]).await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    let in_id = ask["id"].as_str().unwrap().to_string();
    p.b.answer(&in_id, true);
    wait_seen(&p.b_events, &in_id, "paused").await;
    assert!(p.b.cancel(&in_id));
    wait_id(&p.b_events, &in_id, "cancelled").await;
    let t = wait_id(&p.a_events, &id, "cancelled").await;
    assert_eq!(t["error"], "Receiver cancelled.");
    assert!(landing_files(&p.downloads).is_empty());
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn a_paused_transfer_nobody_resumes_is_cleaned_up() {
    let p = pair("resume-expire").await;
    // The sender gives up at once; the receiver keeps the pieces a moment.
    p.a.set_timing(Timing { retry_first: Duration::from_millis(50), retry_max: Duration::from_millis(50), retry_for: Duration::ZERO, pause_keep: Duration::from_secs(20), ..Timing::default() });
    p.b.set_timing(Timing { retry_first: Duration::from_millis(50), retry_max: Duration::from_millis(50), retry_for: Duration::ZERO, pause_keep: Duration::from_millis(300), ..Timing::default() });
    std::fs::write(p.source.join("big.bin"), megabyte()).unwrap();
    p.a.cut_after(300_000);
    let id = p.a.send(&p.b.me.id, vec![p.source.join("big.bin")]).await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    let in_id = ask["id"].as_str().unwrap().to_string();
    p.b.answer(&in_id, true);
    let t = wait_id(&p.a_events, &id, "failed").await;
    assert!(t["error"].as_str().unwrap().contains("didn't come back"), "{t}");
    let t = wait_id(&p.b_events, &in_id, "failed").await;
    assert!(t["error"].as_str().unwrap().contains("didn't come back"), "{t}");
    assert!(landing_files(&p.downloads).is_empty());
    p.a.shutdown().await;
    p.b.shutdown().await;
}

// ------------------------------------------------------------ friends who are away

/// A Land with Land anywhere on, its friends and waiting sends in `dir`: start it again with
/// the same key and dir to restart that Island.
async fn far_land(name: &str, key: &iroh::SecretKey, dir: &Path, events: Emit) -> Arc<Running> {
    let anywhere = Some(crate::anywhere::Setup { key: key.clone(), relays: crate::anywhere::Relays::Off, book: dir.join("land-friends.json") });
    start(Identity::generate().unwrap(), Options { name: name.into(), visible: false, downloads: dir.join("Downloads"), discovery: 0, anywhere }, events).await.unwrap()
}

/// Dialling someone away fails fast, the regular try is far off (so only a hello can be what
/// sends), and a starting Island says hello at once.
fn waits(run: &Running) {
    run.set_timing(Timing { far_connect: Duration::from_millis(500), queue_retry: Duration::from_secs(60), hello_after: Duration::from_millis(50), ..Timing::default() });
}

struct Away {
    root: PathBuf,
    ka: iroh::SecretKey,
    kb: iroh::SecretKey,
    a: Arc<Running>,
    a_events: Events,
    id: String,
}

/// `a` sends a note to its friend `b`, whose Island is off: the send waits.
async fn send_to_someone_away(tag: &str) -> Away {
    let root = temp_dir(tag);
    let (ka, kb) = (iroh::SecretKey::generate(), iroh::SecretKey::generate());
    let (ea, a_events) = recorder();
    let a = far_land("Sender", &ka, &root.join("a"), ea).await;
    waits(&a);
    a.far().unwrap().add_known(&kb.public().to_string(), "Receiver");
    // b's friends already include a, for when b starts.
    let mut book = crate::anywhere::Book::default();
    book.add(&ka.public().to_string(), "Sender");
    book.save(&root.join("b").join("land-friends.json")).unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src").join("note.txt"), b"for when you're back").unwrap();
    let id = a.send(&kb.public().to_string(), vec![root.join("src").join("note.txt")]).await.unwrap();
    wait_seen(&a_events, &id, "queued").await;
    Away { root, ka, kb, a, a_events, id }
}

/// `b` starts; each learns where the other is (in real life the relays' lookup does that).
async fn comes_back(w: &Away, a: &Arc<Running>) -> (Arc<Running>, Events) {
    let (eb, b_events) = recorder();
    let b = far_land("Receiver", &w.kb, &w.root.join("b"), eb).await;
    b.far().unwrap().remember(a.far().unwrap().addr());
    waits(&b);
    a.far().unwrap().remember(b.far().unwrap().addr());
    (b, b_events)
}

#[tokio::test]
async fn a_send_to_a_friend_who_is_away_waits_and_goes_when_they_are_back() {
    let w = send_to_someone_away("away").await;
    let (b, b_events) = comes_back(&w, &w.a).await;
    // b's hello wakes the waiting send at once; the regular try is a minute away.
    let ask = wait_for(&b_events, "in", "asking").await;
    assert_eq!(ask["peer"]["name"], "Sender");
    b.answer(ask["id"].as_str().unwrap(), true);
    wait_id(&w.a_events, &w.id, "done").await;
    assert_eq!(std::fs::read(w.root.join("b").join("Downloads").join("note.txt")).unwrap(), b"for when you're back");
    assert!(!std::fs::read_to_string(w.root.join("a").join("land-queue.json")).unwrap_or_default().contains(&w.id), "no longer waiting");
    w.a.shutdown().await;
    b.shutdown().await;
}

#[tokio::test]
async fn a_waiting_send_can_be_cancelled_and_is_forgotten() {
    let w = send_to_someone_away("away-cancel").await;
    assert!(std::fs::read_to_string(w.root.join("a").join("land-queue.json")).unwrap().contains(&w.id));
    assert!(w.a.cancel(&w.id));
    wait_id(&w.a_events, &w.id, "cancelled").await;
    assert!(!std::fs::read_to_string(w.root.join("a").join("land-queue.json")).unwrap_or_default().contains(&w.id));
    w.a.shutdown().await;
}

#[tokio::test]
async fn a_waiting_send_outlives_a_restart() {
    let w = send_to_someone_away("away-restart").await;
    w.a.shutdown().await;
    // The sender's Island starts again: the send is still waiting, under the same id.
    let (ea2, a2_events) = recorder();
    let a2 = far_land("Sender", &w.ka, &w.root.join("a"), ea2).await;
    waits(&a2);
    wait_seen(&a2_events, &w.id, "queued").await;
    let (b, b_events) = comes_back(&w, &a2).await;
    let ask = wait_for(&b_events, "in", "asking").await;
    b.answer(ask["id"].as_str().unwrap(), true);
    wait_id(&a2_events, &w.id, "done").await;
    assert_eq!(std::fs::read(w.root.join("b").join("Downloads").join("note.txt")).unwrap(), b"for when you're back");
    a2.shutdown().await;
    b.shutdown().await;
}

#[tokio::test]
async fn a_send_nobody_comes_back_for_gives_up() {
    let root = temp_dir("away-expire");
    let kb = iroh::SecretKey::generate();
    let (ea, a_events) = recorder();
    let a = far_land("Sender", &iroh::SecretKey::generate(), &root.join("a"), ea).await;
    a.set_timing(Timing { far_connect: Duration::from_millis(300), queue_retry: Duration::from_millis(100), queue_for: Duration::from_millis(600), ..Timing::default() });
    a.far().unwrap().add_known(&kb.public().to_string(), "Receiver");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src").join("x.txt"), b"x").unwrap();
    let id = a.send(&kb.public().to_string(), vec![root.join("src").join("x.txt")]).await.unwrap();
    let t = wait_id(&a_events, &id, "failed").await;
    assert!(t["error"].as_str().unwrap().contains("didn't come online"), "{t}");
    assert!(!std::fs::read_to_string(root.join("a").join("land-queue.json")).unwrap_or_default().contains(&id));
    a.shutdown().await;
}

/// Two Lands with Land anywhere on, not friends yet: `a` sends, `b` receives (taking files
/// from computers nearby only when `b_visible`). No relays, so `a` is told where `b` is.
async fn far_lands(tag: &str, b_visible: bool) -> Pair {
    let root = temp_dir(tag);
    let downloads = root.join("Downloads");
    let source = root.join("source");
    std::fs::create_dir_all(&source).unwrap();
    let (ea, a_events) = recorder();
    let (eb, b_events) = recorder();
    let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: far_setup(&root.join("a")) }, ea).await.unwrap();
    let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: b_visible, downloads: downloads.clone(), discovery: 0, anywhere: far_setup(&root.join("b")) }, eb).await.unwrap();
    a.far().unwrap().remember(b.far().unwrap().addr());
    Pair { a, b, a_events, b_events, downloads, source }
}

/// Two Lands that are friends on other networks (`b` doesn't take files from computers nearby,
/// which friends don't need).
async fn far_pair(tag: &str) -> Pair {
    let p = far_lands(tag, false).await;
    let (fa, fb) = (p.a.far().unwrap(), p.b.far().unwrap());
    fa.add_known(&fb.id().to_string(), "Receiver");
    fb.add_known(&fa.id().to_string(), "Sender");
    p
}

/// `b` as `a` would know it after hearing its announcement on the network.
fn heard_of(p: &Pair) {
    let ak = p.b.far().map(|f| f.id().to_string());
    p.a.add_peer(PeerInfo { id: p.b.me.id.clone(), name: "Receiver".into(), os: "windows".into(), anywhere: ak }, SocketAddr::from((Ipv4Addr::LOCALHOST, p.b.port)), p.b.me.public.clone());
}

#[tokio::test]
async fn the_friend_key_in_an_announcement_is_signed_and_a_borrowed_one_is_dropped() {
    let p = far_lands("hello-ak", true).await;
    let far_id = p.b.far().unwrap().id().to_string();
    let (h, _) = Hello::decode(&p.b.hello("here").encode()).unwrap();
    assert_eq!(h.ak.as_deref(), Some(far_id.as_str()));
    // Someone else's Land key with that friend key and signature: the claim goes, the packet stays.
    let thief = Identity::generate().unwrap();
    let mut stolen = Hello::new("here", &thief, "Thief", 4000);
    stolen.ak = h.ak.clone();
    stolen.aks = h.aks.clone();
    let (got, _) = Hello::decode(&stolen.encode()).unwrap();
    assert_eq!(got.name, "Thief");
    assert_eq!(got.ak, None);
    // Without Land anywhere, no friend key at all (older Islands see the packet they know).
    let plain = String::from_utf8(Hello::new("here", &thief, "Plain", 4000).encode()).unwrap();
    assert!(!plain.contains("\"ak\""), "{plain}");
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn a_computer_nearby_that_announces_a_friend_key_is_marked_with_it() {
    let p = far_lands("heard-ak", true).await;
    // An address on one of this computer's networks (none: nothing to check here).
    let Some(ip) = p.a.nets.lock().unwrap().first().map(|n| n.ip) else { return };
    p.a.heard(&p.b.hello("here").encode(), SocketAddr::from((ip, 50_000))).await;
    let peers = p.a.peers();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].anywhere, Some(p.b.far().unwrap().id().to_string()));
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn a_friend_nearby_gets_files_over_the_network_nearby() {
    let p = far_lands("near-friend", true).await;
    let (fa, fb) = (p.a.far().unwrap(), p.b.far().unwrap());
    fa.add_known(&fb.id().to_string(), "Receiver");
    fb.add_known(&fa.id().to_string(), "Sender");
    heard_of(&p);
    std::fs::write(p.source.join("n.txt"), b"near").unwrap();
    // Sent to the friend's key, it goes the fast way: TCP on this network.
    let id = p.a.send(&fb.id().to_string(), vec![p.source.join("n.txt")]).await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    p.b.answer(ask["id"].as_str().unwrap(), true);
    let done = wait_id(&p.a_events, &id, "done").await;
    assert_eq!(done["via"], "lan");
    assert_eq!(std::fs::read(p.downloads.join("n.txt")).unwrap(), b"near");
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn a_computer_nearby_can_be_asked_to_be_friends_without_a_code() {
    let p = far_lands("befriend", true).await;
    heard_of(&p);
    let asking = tokio::spawn({
        let (a, id) = (p.a.clone(), p.b.me.id.clone());
        async move { a.befriend(&id).await }
    });
    let mut ask = None;
    for _ in 0..400 {
        ask = p.b_events.lock().unwrap().iter().find(|(e, v)| e == "land-friend-ask" && v["state"] == "asking").map(|(_, v)| v.clone());
        if ask.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let ask = ask.expect("the computer nearby was asked");
    assert!(p.b.far().unwrap().answer(ask["id"].as_str().unwrap(), crate::anywhere::Reply::Add));
    assert_eq!(asking.await.unwrap().unwrap().name, "Receiver");
    // One that announced no friend key can't be asked.
    assert!(p.a.befriend("0000000000000000").await.is_err());
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn files_reach_a_friend_on_another_network_after_consent() {
    let p = far_pair("far-send").await;
    std::fs::write(p.source.join("note.txt"), b"hello from far away").unwrap();
    std::fs::create_dir_all(p.source.join("Trip")).unwrap();
    std::fs::write(p.source.join("Trip").join("day1.txt"), vec![7u8; 300_000]).unwrap();
    let friend = p.b.far().unwrap().id().to_string();
    let id = p.a.send(&friend, vec![p.source.join("note.txt"), p.source.join("Trip")]).await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    assert_eq!(ask["peer"]["name"], "Sender");
    assert_eq!(ask["peer"]["id"], p.a.far().unwrap().id().to_string());
    assert!(p.b.answer(ask["id"].as_str().unwrap(), true));
    let done = wait_id(&p.a_events, &id, "done").await;
    assert_eq!(done["via"], "direct");
    wait_for(&p.b_events, "in", "done").await;
    assert_eq!(std::fs::read(p.downloads.join("note.txt")).unwrap(), b"hello from far away");
    assert_eq!(std::fs::read(p.downloads.join("Trip").join("day1.txt")).unwrap().len(), 300_000);
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn a_friend_on_another_network_can_decline() {
    let p = far_pair("far-decline").await;
    std::fs::write(p.source.join("x.txt"), b"x").unwrap();
    let friend = p.b.far().unwrap().id().to_string();
    let id = p.a.send(&friend, vec![p.source.join("x.txt")]).await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    p.b.answer(ask["id"].as_str().unwrap(), false);
    let t = wait_id(&p.a_events, &id, "declined").await;
    assert_eq!(t["error"], "Receiver declined.");
    assert!(!p.downloads.join("x.txt").exists());
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn someone_who_removed_you_does_not_get_your_files() {
    let p = far_pair("far-removed").await;
    std::fs::write(p.source.join("x.txt"), b"x").unwrap();
    p.b.far().unwrap().remove(&p.a.far().unwrap().id().to_string());
    let friend = p.b.far().unwrap().id().to_string();
    let id = p.a.send(&friend, vec![p.source.join("x.txt")]).await.unwrap();
    let t = wait_id(&p.a_events, &id, "failed").await;
    assert!(t["error"].as_str().unwrap().contains("isn't taking files from you"), "{t}");
    assert!(last_state(&p.b_events, "in").is_none(), "nothing reached the other island");
    p.a.shutdown().await;
    p.b.shutdown().await;
}

/// Two Lands that know each other only by key send 2 MB through n0's real lookup and relays,
/// first the normal way (direct when it can), then relay only:
/// `cargo test --lib land::tests::files_reach_a_friend_through_n0 -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn files_reach_a_friend_through_n0() {
    for relays in [crate::anywhere::Relays::N0, crate::anywhere::Relays::N0RelayOnly] {
        let root = temp_dir("n0-send");
        let (downloads, source) = (root.join("Downloads"), root.join("source"));
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("two-mb.bin"), vec![42u8; 2_000_000]).unwrap();
        let setup = |dir: &str| Some(crate::anywhere::Setup { key: iroh::SecretKey::generate(), relays: relays.clone(), book: root.join(dir).join("land-friends.json") });
        let (ea, a_events) = recorder();
        let (eb, b_events) = recorder();
        let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: setup("a") }, ea).await.unwrap();
        let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: false, downloads: downloads.clone(), discovery: 0, anywhere: setup("b") }, eb).await.unwrap();
        let (fa, fb) = (a.far().unwrap(), b.far().unwrap());
        fa.add_known(&fb.id().to_string(), "Receiver");
        fb.add_known(&fa.id().to_string(), "Sender");
        // Time to reach a home relay and publish where it is.
        tokio::time::sleep(Duration::from_secs(4)).await;
        let started = Instant::now();
        let id = a.send(&fb.id().to_string(), vec![source.join("two-mb.bin")]).await.unwrap();
        let ask = wait_for(&b_events, "in", "asking").await;
        b.answer(ask["id"].as_str().unwrap(), true);
        let mut done = None;
        for _ in 0..1200 {
            let last = a_events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["id"] == id).map(|(_, v)| v.clone());
            if let Some(v) = last.filter(|v| v["state"] != "waiting" && v["state"] != "sending") {
                done = Some(v);
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let done = done.expect("the send ended within 2 minutes");
        println!("{relays:?}: {} via {} in {:.1} s", done["state"], done["via"], started.elapsed().as_secs_f64());
        assert_eq!(done["state"], "done", "{done}");
        assert_eq!(std::fs::read(downloads.join("two-mb.bin")).unwrap().len(), 2_000_000);
        a.shutdown().await;
        b.shutdown().await;
    }
}

/// Two friends whose only way to each other is a relay (here, one running on this computer):
/// they meet through it and the files go through it.
#[tokio::test(flavor = "multi_thread")]
async fn friends_meet_and_send_through_a_relay() {
    let (map, url, _server) = crate::anywhere::tests::local_relay().await;
    let root = temp_dir("own-relay");
    let (downloads, source) = (root.join("Downloads"), root.join("source"));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("via-relay.txt"), vec![9u8; 500_000]).unwrap();
    let setup = |dir: &str| Some(crate::anywhere::Setup { key: iroh::SecretKey::generate(), relays: crate::anywhere::Relays::Local(map.clone()), book: root.join(dir).join("land-friends.json") });
    let (ea, a_events) = recorder();
    let (eb, b_events) = recorder();
    let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: setup("a") }, ea).await.unwrap();
    let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: false, downloads: downloads.clone(), discovery: 0, anywhere: setup("b") }, eb).await.unwrap();
    let (fa, fb) = (a.far().unwrap(), b.far().unwrap());
    fa.add_known(&fb.id().to_string(), "Receiver");
    fb.add_known(&fa.id().to_string(), "Sender");
    // All `a` knows is which relay `b` uses.
    fa.remember(iroh::EndpointAddr::new(fb.id()).with_relay_url(url.clone()));
    tokio::time::sleep(Duration::from_secs(2)).await;
    let id = a.send(&fb.id().to_string(), vec![source.join("via-relay.txt")]).await.unwrap();
    let ask = wait_for(&b_events, "in", "asking").await;
    b.answer(ask["id"].as_str().unwrap(), true);
    let done = wait_id(&a_events, &id, "done").await;
    assert_eq!(done["via"], "relay");
    assert_eq!(std::fs::read(downloads.join("via-relay.txt")).unwrap().len(), 500_000);
    a.shutdown().await;
    b.shutdown().await;
}

/// How fast bytes go through a relay, timed from the first byte to "saved" (no setup):
/// `cargo test --lib land::tests::relay_speed -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn relay_speed() {
    let mb: usize = std::env::var("RELAY_TEST_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
    let root = temp_dir("relay-speed");
    let (downloads, source) = (root.join("Downloads"), root.join("source"));
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("big.bin"), vec![7u8; mb * 1_000_000]).unwrap();
    let setup = |dir: &str| Some(crate::anywhere::Setup { key: iroh::SecretKey::generate(), relays: crate::anywhere::Relays::N0RelayOnly, book: root.join(dir).join("land-friends.json") });
    let (ea, a_events) = recorder();
    let (eb, b_events) = recorder();
    let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: setup("a") }, ea).await.unwrap();
    let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: false, downloads: downloads.clone(), discovery: 0, anywhere: setup("b") }, eb).await.unwrap();
    let (fa, fb) = (a.far().unwrap(), b.far().unwrap());
    fa.add_known(&fb.id().to_string(), "Receiver");
    fb.add_known(&fa.id().to_string(), "Sender");
    tokio::time::sleep(Duration::from_secs(4)).await;
    let id = a.send(&fb.id().to_string(), vec![source.join("big.bin")]).await.unwrap();
    let ask = wait_for(&b_events, "in", "asking").await;
    b.answer(ask["id"].as_str().unwrap(), true);
    wait_id(&a_events, &id, "sending").await;
    let started = Instant::now();
    let mut end = None;
    for _ in 0..6000 {
        let last = a_events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["id"] == id).map(|(_, v)| v.clone());
        if let Some(v) = last.filter(|v| v["state"] != "sending") {
            end = Some(v);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let secs = started.elapsed().as_secs_f64();
    let end = end.expect("the send ended within 10 minutes");
    println!("{mb} MB through n0's relay: {} in {secs:.1} s = {:.2} MB/s", end["state"], mb as f64 / secs);
    a.shutdown().await;
    b.shutdown().await;
}

#[tokio::test]
async fn friends_online_are_the_ones_that_answer() {
    let p = far_pair("far-online").await;
    let fa = p.a.far().unwrap();
    // A friend whose Island is nowhere to be found.
    fa.add_known(&iroh::SecretKey::generate().public().to_string(), "Away");
    let online = fa.online().await;
    assert_eq!(online, vec![p.b.far().unwrap().id().to_string()]);
    p.a.shutdown().await;
    p.b.shutdown().await;
}

struct Pair {
    a: Arc<Running>,
    b: Arc<Running>,
    a_events: Events,
    b_events: Events,
    downloads: PathBuf,
    source: PathBuf,
}

/// Two devices in one process: `a` sends, `b` receives into its own Downloads.
async fn pair(tag: &str) -> Pair {
    let root = temp_dir(tag);
    let downloads = root.join("Downloads");
    let source = root.join("source");
    std::fs::create_dir_all(&source).unwrap();
    let (ea, a_events) = recorder();
    let (eb, b_events) = recorder();
    let a = start(Identity::generate().unwrap(), Options { name: "Sender".into(), visible: false, downloads: root.join("unused"), discovery: 0, anywhere: None }, ea).await.unwrap();
    let b = start(Identity::generate().unwrap(), Options { name: "Receiver".into(), visible: true, downloads: downloads.clone(), discovery: 0, anywhere: None }, eb).await.unwrap();
    a.add_peer(PeerInfo { id: b.me.id.clone(), name: "Receiver".into(), os: "windows".into(), anywhere: None }, SocketAddr::from((Ipv4Addr::LOCALHOST, b.port)), b.me.public.clone());
    Pair { a, b, a_events, b_events, downloads, source }
}

#[tokio::test]
async fn files_and_folders_arrive_whole_after_consent() {
    let p = pair("e2e").await;
    let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(p.source.join("big.bin"), &big).unwrap();
    std::fs::create_dir_all(p.source.join("Album").join("inner")).unwrap();
    std::fs::write(p.source.join("Album").join("inner").join("x.txt"), b"inner").unwrap();
    std::fs::write(p.source.join("Album").join("empty.txt"), b"").unwrap();
    // Already in Downloads: must survive untouched.
    std::fs::create_dir_all(&p.downloads).unwrap();
    std::fs::write(p.downloads.join("big.bin"), b"keep me").unwrap();

    let id = p.a.send(&p.b.me.id, vec![p.source.join("big.bin"), p.source.join("Album")]).await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    assert_eq!(ask["count"], 3);
    assert_eq!(ask["total"], 200_005);
    assert_eq!(ask["peer"]["name"], "Sender");
    assert!(ask["expires"].as_u64().unwrap() > now_ms());
    // Nothing written before the answer.
    assert_eq!(std::fs::read_dir(&p.downloads).unwrap().count(), 1);
    assert_eq!(wait_for(&p.a_events, "out", "waiting").await["id"], id);

    assert!(p.b.answer(ask["id"].as_str().unwrap(), true));
    let done = wait_for(&p.b_events, "in", "done").await;
    wait_for(&p.a_events, "out", "done").await;
    assert_eq!(done["done"], 200_005);
    assert_eq!(std::fs::read(p.downloads.join("big (1).bin")).unwrap(), big);
    assert_eq!(std::fs::read(p.downloads.join("big.bin")).unwrap(), b"keep me");
    assert_eq!(std::fs::read(p.downloads.join("Album").join("inner").join("x.txt")).unwrap(), b"inner");
    assert_eq!(std::fs::read(p.downloads.join("Album").join("empty.txt")).unwrap(), b"");
    let saved: Vec<String> = done["saved"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
    assert_eq!(saved, vec![p.downloads.join("big (1).bin").to_string_lossy().to_string(), p.downloads.join("Album").to_string_lossy().to_string()]);
    // Marked as coming from another computer, like a browser download.
    #[cfg(windows)]
    {
        let mut zone = p.downloads.join("big (1).bin").into_os_string();
        zone.push(":Zone.Identifier");
        assert!(std::fs::read_to_string(zone).unwrap().contains("ZoneId=3"));
    }
    // No temp files left behind.
    let leftovers = std::fs::read_dir(&p.downloads).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".landing")).count();
    assert_eq!(leftovers, 0);
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn text_reaches_a_computer_nearby_after_consent() {
    let p = pair("text").await;
    let id = p.a.send_text(&p.b.me.id, "https://example.com/recipe").await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    assert_eq!(ask["text"], "https://example.com/recipe");
    assert_eq!(ask["count"], 0);
    assert!(p.b.answer(ask["id"].as_str().unwrap(), true));
    let done = wait_id(&p.a_events, &id, "done").await;
    assert_eq!(done["text"], "https://example.com/recipe");
    let got = wait_for(&p.b_events, "in", "done").await;
    assert_eq!(got["text"], "https://example.com/recipe");
    assert!(!p.downloads.exists() || std::fs::read_dir(&p.downloads).unwrap().count() == 0, "nothing written to Downloads");
    assert!(p.a.send_text(&p.b.me.id, "   ").await.is_err());
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn text_to_a_friend_who_is_away_waits_and_goes() {
    let root = temp_dir("away-text");
    let (ka, kb) = (iroh::SecretKey::generate(), iroh::SecretKey::generate());
    let (ea, a_events) = recorder();
    let a = far_land("Sender", &ka, &root.join("a"), ea).await;
    waits(&a);
    a.far().unwrap().add_known(&kb.public().to_string(), "Receiver");
    let mut book = crate::anywhere::Book::default();
    book.add(&ka.public().to_string(), "Sender");
    book.save(&root.join("b").join("land-friends.json")).unwrap();
    let id = a.send_text(&kb.public().to_string(), "see you at 6").await.unwrap();
    wait_seen(&a_events, &id, "queued").await;
    assert!(std::fs::read_to_string(root.join("a").join("land-queue.json")).unwrap().contains("see you at 6"));
    let w = Away { root: root.clone(), ka, kb, a: a.clone(), a_events: a_events.clone(), id: id.clone() };
    let (b, b_events) = comes_back(&w, &a).await;
    let ask = wait_for(&b_events, "in", "asking").await;
    assert_eq!(ask["text"], "see you at 6");
    b.answer(ask["id"].as_str().unwrap(), true);
    wait_id(&a_events, &id, "done").await;
    a.shutdown().await;
    b.shutdown().await;
}

#[tokio::test]
async fn a_declined_offer_writes_nothing() {
    let p = pair("decline").await;
    std::fs::write(p.source.join("secret.txt"), b"no").unwrap();
    p.a.send(&p.b.me.id, vec![p.source.join("secret.txt")]).await.unwrap();
    let ask = wait_for(&p.b_events, "in", "asking").await;
    assert!(p.b.answer(ask["id"].as_str().unwrap(), false));
    let out = wait_for(&p.a_events, "out", "declined").await;
    assert_eq!(out["error"], "Receiver declined.");
    wait_for(&p.b_events, "in", "declined").await;
    assert!(!p.downloads.exists() || std::fs::read_dir(&p.downloads).unwrap().count() == 0);
    // Asking again at once is turned away without bothering the user.
    let asks = p.b_events.lock().unwrap().iter().filter(|(_, v)| v["state"] == "asking").count();
    let id = p.a.send(&p.b.me.id, vec![p.source.join("secret.txt")]).await.unwrap();
    let again = wait_id(&p.a_events, &id, "declined").await;
    assert_eq!(again["error"], "Receiver is busy with other files. Try again in a moment.");
    assert_eq!(p.b_events.lock().unwrap().iter().filter(|(_, v)| v["state"] == "asking").count(), asks);
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn the_sender_can_cancel_while_asking() {
    let p = pair("cancel").await;
    std::fs::write(p.source.join("a.txt"), b"a").unwrap();
    let id = p.a.send(&p.b.me.id, vec![p.source.join("a.txt")]).await.unwrap();
    wait_for(&p.b_events, "in", "asking").await;
    assert!(p.a.cancel(&id));
    wait_for(&p.a_events, "out", "cancelled").await;
    let theirs = wait_for(&p.b_events, "in", "cancelled").await;
    assert_eq!(theirs["error"], "Sender cancelled.");
    p.a.shutdown().await;
    p.b.shutdown().await;
}

#[tokio::test]
async fn a_key_that_does_not_match_the_announcement_stops_the_send() {
    let p = pair("impostor").await;
    std::fs::write(p.source.join("a.txt"), b"a").unwrap();
    // The device announced some other key than the one that answers.
    let stranger = Identity::generate().unwrap();
    p.a.add_peer(PeerInfo { id: p.b.me.id.clone(), name: "Receiver".into(), os: "windows".into(), anywhere: None }, SocketAddr::from((Ipv4Addr::LOCALHOST, p.b.port)), stranger.public.clone());
    p.a.send(&p.b.me.id, vec![p.source.join("a.txt")]).await.unwrap();
    let out = wait_for(&p.a_events, "out", "failed").await;
    assert!(out["error"].as_str().unwrap().contains("different key"));
    assert!(last_state(&p.b_events, "in").is_none(), "the receiver never got an offer");
    p.a.shutdown().await;
    p.b.shutdown().await;
}

/// Two devices find each other over this computer's real network (multicast and broadcast
/// loop back to it). Needs a network, so it runs by hand: `cargo test --lib land -- --ignored`.
#[tokio::test]
#[ignore]
async fn devices_find_each_other_on_the_network() {
    let port = 47900 + (std::process::id() % 90) as u16;
    let (ea, a_events) = recorder();
    let (eb, _) = recorder();
    let a = start(Identity::generate().unwrap(), Options { name: "Finder".into(), visible: true, downloads: temp_dir("find-a"), discovery: port, anywhere: None }, ea).await.unwrap();
    let b = start(Identity::generate().unwrap(), Options { name: "Found".into(), visible: true, downloads: temp_dir("find-b"), discovery: port, anywhere: None }, eb).await.unwrap();
    let mut seen = false;
    for _ in 0..40 {
        a.scan().await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        if a.peers().iter().any(|p| p.id == b.me.id && p.name == "Found") {
            seen = true;
            break;
        }
    }
    assert!(seen, "a never heard b: {:?}", a_events.lock().unwrap());
    // b leaving says so at once.
    b.shutdown().await;
    for _ in 0..40 {
        if a.peers().iter().all(|p| p.id != b.me.id) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(a.peers().iter().all(|p| p.id != b.me.id), "b's bye was not heard");
    a.shutdown().await;
}

/// Offers a small text file to the Island running on this computer, as another computer
/// would, so its card can be seen and answered on the real island:
/// `cargo test --lib land::tests::offer_the_island -- --ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn offer_the_island_running_here_a_file() {
    let udp = bind_udp(0).unwrap();
    let me = Identity::generate().unwrap();
    udp.send_to(&Hello::new("ask", &me, "Land test", 0).encode(), (Ipv4Addr::LOCALHOST, DISCOVERY_PORT)).await.unwrap();
    let mut buf = vec![0u8; 4096];
    let (n, from) = timeout(Duration::from_secs(3), udp.recv_from(&mut buf)).await.expect("no Island answered on this computer").unwrap();
    let (h, key) = Hello::decode(&buf[..n]).expect("an Island hello");
    println!("found {} ({}), taking files on port {}", h.name, h.id, h.port);
    let (emit, events) = recorder();
    let run = start(me, Options { name: "Land test".into(), visible: false, downloads: temp_dir("probe"), discovery: 0, anywhere: None }, emit).await.unwrap();
    run.add_peer(PeerInfo { id: h.id.clone(), name: h.name.clone(), os: h.os.clone(), anywhere: None }, SocketAddr::new(from.ip(), h.port), key);
    let file = temp_dir("probe-src").join("Land test.txt");
    std::fs::write(&file, "Sent by Land's test, from this computer.").unwrap();
    let id = run.send(&h.id, vec![file]).await.unwrap();
    println!("offered: answer it on the island (it waits 2 minutes)");
    for _ in 0..600 {
        let last = events.lock().unwrap().iter().rev().find(|(e, v)| e == "land-transfer" && v["id"] == id.as_str()).map(|(_, v)| v.clone());
        if let Some(v) = last.filter(|v| !matches!(v["state"].as_str(), Some("waiting") | Some("sending"))) {
            println!("{} {}", v["state"], v["error"]);
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    run.shutdown().await;
}

#[tokio::test]
async fn nobody_listening_is_a_clear_failure() {
    let (e, events) = recorder();
    let a = start(Identity::generate().unwrap(), Options { name: "A".into(), visible: false, downloads: temp_dir("none"), discovery: 0, anywhere: None }, e).await.unwrap();
    let ghost = Identity::generate().unwrap();
    let port = {
        let l = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        l.local_addr().unwrap().port()
    };
    a.add_peer(PeerInfo { id: ghost.id.clone(), name: "Ghost".into(), os: "macos".into(), anywhere: None }, SocketAddr::from((Ipv4Addr::LOCALHOST, port)), ghost.public.clone());
    let file = temp_dir("none-src").join("x.txt");
    std::fs::write(&file, b"x").unwrap();
    a.send(&ghost.id, vec![file]).await.unwrap();
    let out = wait_for(&events, "out", "failed").await;
    assert!(out["error"].as_str().unwrap().starts_with("Couldn't reach Ghost"));
    assert!(a.send("nobody", vec![]).await.is_err());
    a.shutdown().await;
}

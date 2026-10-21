use super::paths::{check_one, expand};
use super::*;
use serde_json::json;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("island-ws-{name}-{}-{}", std::process::id(), stamp()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn fields(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn ids(doc: &Value) -> Vec<String> {
    doc["workspaces"].as_array().unwrap().iter().map(|w| w["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn no_file_is_nothing_saved() {
    let dir = temp_dir("none");
    let (doc, recovered, blocked) = load_from(&dir.join(FILE));
    assert!(doc.is_null());
    assert!(recovered.is_none() && blocked.is_none());
}

#[test]
fn an_unreadable_file_is_set_aside_not_overwritten() {
    for bad in ["{ not json", "[1, 2]", "\"text\""] {
        let dir = temp_dir("bad");
        let path = dir.join(FILE);
        std::fs::write(&path, bad).unwrap();
        let (doc, recovered, blocked) = load_from(&path);
        assert!(doc.is_null());
        assert!(blocked.is_none());
        let aside = PathBuf::from(recovered.expect("says where it went"));
        assert_eq!(std::fs::read_to_string(&aside).unwrap(), bad, "the bytes are kept");
        assert!(!path.exists(), "moved, so a save can't overwrite it");
    }
}

#[test]
fn a_bom_is_fine() {
    let dir = temp_dir("bom");
    let path = dir.join(FILE);
    std::fs::write(&path, b"\xEF\xBB\xBF{\"version\":1,\"workspaces\":[]}").unwrap();
    let (doc, recovered, _) = load_from(&path);
    assert_eq!(doc["version"], 1);
    assert!(recovered.is_none());
}

#[test]
fn upsert_adds_first_and_merges_fields() {
    let mut doc = json!({ "version": 1, "workspaces": [{ "id": "ws_a", "name": "A", "history": [1] }] });
    upsert(&mut doc, "ws_b", fields(json!({ "name": "B" }))).unwrap();
    assert_eq!(ids(&doc), ["ws_b", "ws_a"]);
    // Only the given fields change; an id inside the fields is ignored.
    upsert(&mut doc, "ws_a", fields(json!({ "name": "A2", "id": "ws_evil" }))).unwrap();
    assert_eq!(doc["workspaces"][1], json!({ "id": "ws_a", "name": "A2", "history": [1] }));
    assert!(upsert(&mut doc, "bad id!", Map::new()).is_err());
    assert!(upsert(&mut json!(null), "ws_a", Map::new()).is_err(), "nothing set up yet");
}

#[test]
fn remove_and_reorder() {
    let mut doc = json!({ "workspaces": [{ "id": "a" }, { "id": "b" }, { "id": "c" }, { "id": "d" }] });
    reorder(&mut doc, &["c".into(), "zzz".into(), "a".into(), "c".into()]).unwrap();
    assert_eq!(ids(&doc), ["c", "a", "b", "d"], "listed first, unknown ids skipped, the rest as they were");
    remove(&mut doc, "a").unwrap();
    remove(&mut doc, "a").unwrap();
    assert_eq!(ids(&doc), ["c", "b", "d"]);
}

#[test]
fn the_store_saves_before_a_change_counts() {
    let dir = temp_dir("store");
    let path = dir.join(FILE);
    let store = WsStore::default();
    assert!(store.load(&path).doc.is_null());

    let mut heard = Vec::new();
    let first = store.init(&path, json!({ "version": 1, "workspaces": [] }), |_, rev| heard.push(rev)).unwrap();
    assert_eq!(first.rev, 1);
    // A second init leaves what is there alone and says nothing.
    let again = store.init(&path, json!({ "version": 1, "workspaces": [{ "id": "x" }] }), |_, rev| heard.push(rev)).unwrap();
    assert_eq!(again.rev, 1);
    assert_eq!(again.doc["workspaces"], json!([]));

    let rev = store.mutate(&path, |d, _| upsert(d, "ws_a", fields(json!({ "name": "School" }))), |_, rev| heard.push(rev)).unwrap();
    assert_eq!(rev, 2);
    assert_eq!(heard, [1, 2]);
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(on_disk["workspaces"][0]["name"], "School");
    // No temporary files left beside it.
    let names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    assert_eq!(names, [FILE]);

    // A change that fails leaves everything as it was.
    assert!(store.mutate(&path, |d, _| upsert(d, "no good", Map::new()), |_, _| panic!("not announced")).is_err());
    assert_eq!(store.load(&path).rev, 2);

    // A fresh store (Island restarted) reads it back.
    let reread = WsStore::default().load(&path);
    assert_eq!(reread.doc["workspaces"][0]["name"], "School");
}

#[test]
fn replace_needs_the_revision_it_read_and_keeps_the_old_version() {
    let dir = temp_dir("replace");
    let path = dir.join(FILE);
    std::fs::write(&path, r#"{"version":1,"workspaces":[{"id":"a"}]}"#).unwrap();
    let store = WsStore::default();
    let read = store.load(&path);
    assert_eq!(read.rev, 0);
    store.mutate(&path, |d, _| upsert(d, "b", Map::new()), |_, _| {}).unwrap();
    // Something changed since revision 0 was read: refused.
    let stale = store.replace(&path, json!({ "version": 2, "workspaces": [] }), 0, |_, _| {});
    assert_eq!(stale, Err("changed".to_string()));
    // With the current revision it goes through, and the version-1 file is kept.
    let rev = store.replace(&path, json!({ "version": 2, "workspaces": [{ "id": "a" }, { "id": "b" }] }), 1, |_, _| {}).unwrap();
    assert_eq!(rev, 2);
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("workspaces.v1.json")).unwrap()).unwrap();
    assert_eq!(kept["version"], 1);
    assert_eq!(ids(&kept), ["b", "a"]);
}

#[test]
fn a_blocked_store_writes_nothing() {
    let dir = temp_dir("blocked");
    let path = dir.join(FILE);
    let store = WsStore::default();
    {
        let mut inner = store.inner.lock().unwrap();
        inner.loaded = true;
        inner.blocked = Some("can't read it".into());
    }
    assert!(store.init(&path, json!({ "version": 1, "workspaces": [] }), |_, _| {}).is_err());
    assert!(store.mutate(&path, |d, _| upsert(d, "a", Map::new()), |_, _| {}).is_err());
    assert!(!path.exists());
}

#[test]
fn paths_expand_variables_quotes_and_home() {
    std::env::set_var("ISLAND_WS_TEST_DIR", "C:\\Projects");
    assert_eq!(expand(" \"%ISLAND_WS_TEST_DIR%\\app\" "), "C:\\Projects\\app");
    assert_eq!(expand("%NO_SUCH_VAR_ISLAND%\\x"), "%NO_SUCH_VAR_ISLAND%\\x");
    assert_eq!(expand("100% sure"), "100% sure");
    let home = super::paths::resolve("~", "").unwrap();
    assert!(home.is_absolute());
}

#[test]
fn paths_report_what_is_there() {
    let dir = temp_dir("paths");
    let file = dir.join("notes.txt");
    std::fs::write(&file, "x").unwrap();
    let base = dir.display().to_string();
    assert_eq!(check_one(&file.display().to_string(), "").state, "file");
    assert_eq!(check_one(&base, "").state, "dir");
    assert_eq!(check_one(&dir.join("gone.txt").display().to_string(), "").state, "missing");
    assert_eq!(check_one("", "").state, "invalid");
    // Relative to the project folder.
    let rel = check_one("notes.txt", &base);
    assert_eq!(rel.state, "file");
    assert_eq!(rel.resolved.as_deref(), Some(file.display().to_string().as_str()));
}

#[cfg(windows)]
#[test]
fn a_bare_program_name_is_found_like_windows_finds_it() {
    let found = check_one("cmd", "");
    assert_eq!(found.state, "file");
    assert!(found.resolved.unwrap().to_ascii_lowercase().ends_with("cmd.exe"));
}

// ------------------------------------------------------------------ launching

use super::launch::{cmd_script, encode_ps, ps_script, split_args};

#[test]
fn a_powershell_command_is_titled_placed_and_shown() {
    let s = ps_script("npm run dev", Some(r"C:\Code\it's mine"), "Dev server");
    assert!(s.starts_with("$Host.UI.RawUI.WindowTitle = 'Dev server'\n"));
    assert!(s.contains("Set-Location -LiteralPath 'C:\\Code\\it''s mine'\n"));
    assert!(s.contains("@'\n> npm run dev\n'@\n"), "shows the command first");
    assert!(s.ends_with("npm run dev\n"));
    // A line that would end the here-string: only the first line is shown, quoted.
    let tricky = ps_script("echo 1\n'@ oops", None, "x");
    assert!(tricky.contains("Write-Host -ForegroundColor DarkGray '> echo 1'"));
}

#[test]
fn an_encoded_command_is_utf16_base64() {
    use base64::Engine;
    let encoded = encode_ps("Write-Host 'é;\"'");
    assert!(encoded.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='), "nothing Terminal could split");
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
    let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    assert_eq!(String::from_utf16(&units).unwrap(), "Write-Host 'é;\"'");
}

#[test]
fn a_command_prompt_command_is_a_utf8_batch_file() {
    let s = cmd_script("npm install\nnpm run dev", Some(r"D:\proj"), "Build & run");
    assert_eq!(s, "@chcp 65001 >nul\r\n@title Build  run\r\n@cd /d \"D:\\proj\"\r\nnpm install\r\nnpm run dev\r\n");
}

#[test]
fn arguments_split_like_a_shell_keeps_quotes() {
    assert_eq!(split_args(r#"--new-window "D:\My Notes" -x"#), ["--new-window", r"D:\My Notes", "-x"]);
    assert_eq!(split_args("  "), Vec::<String>::new());
    assert_eq!(split_args(r#""""#), [""]);
}

#[cfg(windows)]
#[test]
fn installed_apps_are_programs_or_store_apps() {
    let apps = super::launch::ws_apps_now();
    for a in &apps {
        assert!(!a.name.trim().is_empty());
        let t = a.target.to_lowercase();
        assert!(t.starts_with("shell:appsfolder\\") || (t.ends_with(".exe") && std::path::Path::new(&a.target).is_file()), "{a:?}");
    }
}

#[cfg(windows)]
#[test]
fn windows_on_screen_have_a_program_and_a_place() {
    for w in super::layout::list_now() {
        assert!(!w.exe.is_empty() && !w.title.trim().is_empty(), "{w:?}");
        assert!(w.rect.width > 0 && w.rect.height > 0, "{w:?}");
        assert!(["normal", "maximized", "minimized"].contains(&w.state));
    }
}

/// Starts Character Map, finds it running, moves its window, closes it. Run by hand:
/// cargo test --lib workspaces::tests::start_find_and_place_charmap -- --ignored --nocapture
#[cfg(windows)]
#[test]
#[ignore]
fn start_find_and_place_charmap() {
    use super::launch::Launch;
    let started = super::launch::launch_now(Launch::App { path: "charmap".into(), args: String::new(), cwd: String::new() }, "").expect("starts");
    eprintln!("started {started:?}");
    let mut found = None;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        found = super::launch::running_now("charmap", "").filter(|r| r.hwnd.is_some());
        if found.is_some() {
            break;
        }
    }
    let running = found.expect("its window shows");
    let hwnd = running.hwnd.unwrap();
    let placed = super::layout::place_now(&super::layout::Place { hwnd, rect: super::layout::Rect { x: 120, y: 140, width: 700, height: 500 }, state: "normal".into() });
    assert!(placed.ok, "{placed:?}");
    let w = super::layout::list_now().into_iter().find(|w| w.hwnd == hwnd).expect("listed");
    eprintln!("now at {:?}", w.rect);
    assert_eq!((w.rect.x, w.rect.y, w.rect.width, w.rect.height), (120, 140, 700, 500));
    let _ = std::process::Command::new("taskkill").args(["/PID", &running.pid.to_string(), "/F"]).status();
}

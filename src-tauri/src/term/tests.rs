// Terminals: titles, folders, the list's pace, and (on Windows) real ConPTY terminals: a program's
// output and exit code, typing into PowerShell, resizing, ending, and the limit of 8.
// `cargo test --lib term`.

use std::sync::atomic::AtomicUsize;

#[cfg(windows)]
use tokio::time::timeout;

use super::*;

/// Output without its escape sequences (CSI and OSC), to look for text in it.
pub(crate) fn plain(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[test]
fn plain_text_drops_escape_sequences() {
    assert_eq!(plain(b"\x1b[?25l\x1b[32mgreen\x1b[0m \x1b]0;title\x07text\x1b]2;t\x1b\\!"), "green text!");
}

#[test]
fn titles_say_something_or_nothing() {
    assert_eq!(tidy_title("✳ Claude Code").as_deref(), Some("✳ Claude Code"));
    // What a Windows console shows before a program names itself.
    assert_eq!(tidy_title(r"C:\WINDOWS\system32\cmd.exe"), None);
    assert_eq!(tidy_title(r"C:\Program Files\PowerShell\7\pwsh.exe"), None);
    assert_eq!(tidy_title(r"Administrator: C:\WINDOWS\system32\cmd.exe"), None);
    // cmd.exe names the command it runs after its path.
    assert_eq!(tidy_title(r"C:\WINDOWS\system32\cmd.exe - npm  test").as_deref(), Some("npm  test"));
    assert_eq!(tidy_title(r"C:\x\tool.EXE -").as_deref(), None);
    assert_eq!(tidy_title(r"C:\x\tool.exe and more").as_deref(), Some(r"C:\x\tool.exe and more"));
    assert_eq!(tidy_title("npm test - C:\\x\\node.exe").as_deref(), Some("npm test - C:\\x\\node.exe"));
    assert_eq!(tidy_title("setup.exe").as_deref(), Some("setup.exe"));
    assert_eq!(tidy_title(""), None);
}

#[test]
fn folders_default_to_home_and_must_be_there() {
    let home = crate::claude::home();
    assert_eq!(folder(None).unwrap(), home);
    assert_eq!(folder(Some("  ")).unwrap(), home);
    assert_eq!(folder(Some("~")).unwrap(), home);
    let temp = std::env::temp_dir();
    assert_eq!(folder(Some(&temp.to_string_lossy())).unwrap(), temp);
    let missing = temp.join("island-no-such-folder");
    assert_eq!(folder(Some(&missing.to_string_lossy())).unwrap_err(), format!("There's no folder {} on the PC.", missing.to_string_lossy()));
    assert!(folder(Some("relative/folder")).is_err());
    assert!(folder(Some("~/island-no-such-folder")).is_err());
}

#[test]
fn a_default_title_is_what_runs_and_where() {
    let dir = std::env::temp_dir().join("windows-dynamic-island");
    assert_eq!(default_title("PowerShell", &dir), "PowerShell · windows-dynamic-island");
    let root = if cfg!(windows) { PathBuf::from(r"C:\") } else { PathBuf::from("/") };
    assert_eq!(default_title("Git Bash", &root), format!("Git Bash · {}", root.to_string_lossy()));
}

#[test]
fn the_list_goes_out_at_most_four_times_a_second() {
    let terms = Terms::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    terms.listen(Arc::new(move |list: &[TermInfo]| {
        assert!(list.is_empty());
        c.fetch_add(1, Ordering::SeqCst);
    }));
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1000) {
        terms.signal.poke();
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(500));
    let n = calls.load(Ordering::SeqCst);
    // 1.5 s: at most one at once and one every 250 ms after it.
    assert!((3..=7).contains(&n), "{n} lists");
    // Nothing changes, nothing goes out.
    std::thread::sleep(Duration::from_millis(300));
    let quiet = calls.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(calls.load(Ordering::SeqCst), quiet);
}

#[test]
fn nothing_is_there_to_attach_write_resize_or_end() {
    let terms = Terms::new();
    assert_eq!(terms.attach("0badc0de").err().as_deref(), Some("That terminal isn't open anymore."));
    assert!(!terms.write("0badc0de", b"x"));
    assert!(!terms.resize("0badc0de", 80, 24));
    assert!(!terms.kill("0badc0de"));
    assert!(terms.list().is_empty());
}

// ------------------------------------------------------------------ real terminals (Windows)

#[cfg(windows)]
const WAIT: Duration = Duration::from_secs(30);

/// What an attached stream gets until `want` holds for its text, or the program ends: the text
/// so far, and the exit when it came.
#[cfg(windows)]
async fn read_until(rx: &mut mpsc::Receiver<Out>, text: &mut Vec<u8>, want: impl Fn(&str) -> bool) -> Option<Option<i64>> {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !want(&plain(text)) {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some(Out::Data(b))) => text.extend_from_slice(&b),
            Ok(Some(Out::Title(_))) => {}
            Ok(Some(Out::Exit(code))) => return Some(code),
            Ok(None) => panic!("the stream ended; the output: {:?}", plain(text)),
            Err(_) => panic!("timed out; the output: {:?}", plain(text)),
        }
    }
    None
}

#[cfg(windows)]
fn cmd(args: &[&str], cwd: Option<&Path>) -> Open {
    Open { program: Some("cmd".into()), args: args.iter().map(|a| a.to_string()).collect(), cwd: cwd.map(|c| c.to_string_lossy().to_string()), ..Open::default() }
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_program_runs_and_its_output_and_exit_code_come_back() {
    let terms = Terms::new();
    let heard: Arc<Mutex<Vec<Vec<TermInfo>>>> = Arc::default();
    let h = heard.clone();
    terms.listen(Arc::new(move |list: &[TermInfo]| h.lock().unwrap().push(list.to_vec())));
    let info = terms.open(cmd(&["/c", "echo island-hi& exit /b 3"], None)).unwrap();
    assert_eq!(info.id.len(), 8);
    assert!(info.id.bytes().all(|b| b.is_ascii_hexdigit()), "{}", info.id);
    assert!(info.pid > 0);
    assert_eq!((info.shell.as_str(), info.claude, info.exit), ("cmd", false, None));
    assert_eq!(info.cwd, crate::claude::home().to_string_lossy());
    let a = terms.attach(&info.id).unwrap();
    let mut rx = a.rx;
    let mut text = a.replay;
    let mut exit = read_until(&mut rx, &mut text, |t| t.contains("island-hi")).await;
    if exit.is_none() {
        exit = read_until(&mut rx, &mut text, |_| false).await;
    }
    assert_eq!(exit, Some(Some(3)));
    assert!(plain(&text).contains("island-hi"), "{:?}", plain(&text));
    assert!(!String::from_utf8_lossy(&text).contains("\x1b[6n"), "ConPTY's cursor question was answered and taken out");
    // The stream ends after the exit.
    assert!(timeout(WAIT, rx.recv()).await.unwrap().is_none());
    let listed = terms.list();
    assert_eq!((listed.len(), listed[0].exit, listed[0].attached), (1, Some(3), 0));
    assert!(!terms.write(&info.id, b"x"), "an ended terminal takes no keys");
    // A stream attaching now gets what it printed and the exit.
    let mut late = terms.attach(&info.id).unwrap();
    assert!(plain(&late.replay).contains("island-hi"));
    assert_eq!(late.rx.recv().await, Some(Out::Exit(Some(3))));
    // The listeners heard it open and end.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let lists = heard.lock().unwrap().clone();
    assert!(lists.iter().any(|l| l.len() == 1 && l[0].exit.is_none()), "{lists:?}");
    assert_eq!(lists.last().unwrap()[0].exit, Some(3));
    // Ten minutes after it ended it leaves the list.
    assert!(!terms.sweep(Instant::now()));
    assert!(terms.sweep(Instant::now() + KEEP_ENDED));
    assert!(terms.list().is_empty());
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn powershell_takes_keys_resizes_and_is_ended() {
    let terms = Terms::new();
    let info = terms.open(Open { cols: Some(90), rows: Some(30), claude: true, title: Some("Claude · island".into()), ..Open::default() }).unwrap();
    assert_eq!((info.shell.as_str(), info.claude), ("powershell", true));
    let a = terms.attach(&info.id).unwrap();
    assert_eq!(a.title, "Claude · island", "the given title, until the program gives one");
    let (mut rx, mut text) = (a.rx, a.replay);
    assert_eq!(terms.list()[0].attached, 1);
    // Typed before the prompt shows is fine too: the console keeps it.
    assert!(terms.write(&info.id, b"Write-Output (\"island\" + \"-hi\")\r"));
    assert_eq!(read_until(&mut rx, &mut text, |t| t.contains("island-hi")).await, None, "{:?}", plain(&text));
    assert!(terms.resize(&info.id, 120, 40));
    assert!(terms.resize(&info.id, 0, 9999), "brought into range");
    // Ended: the stream hears the exit, the list loses it, and keys go nowhere.
    assert!(terms.kill(&info.id));
    assert!(terms.list().is_empty());
    assert!(!terms.write(&info.id, b"x"));
    let exit = read_until(&mut rx, &mut text, |_| false).await;
    assert!(exit.is_some(), "the exit came");
    assert!(timeout(WAIT, rx.recv()).await.unwrap().is_none());
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn eight_at_most_and_ended_ones_make_room() {
    let terms = Terms::new();
    let dir = std::env::temp_dir().join(format!("island-term-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let done = terms.open(cmd(&["/c", "exit 0"], Some(&dir))).unwrap();
    for _ in 0..100 {
        if terms.list()[0].exit.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(terms.list()[0].exit, Some(0));
    let mut ids = vec![done.id.clone()];
    for i in 0..MAX_TERMS {
        let title = (i == 0).then(|| "  Build \u{7}".to_string());
        let info = terms.open(Open { shell: Some("cmd".into()), cwd: Some(dir.to_string_lossy().to_string()), title, ..Open::default() }).unwrap();
        let folder_name = dir.file_name().unwrap().to_string_lossy().to_string();
        let want = if i == 0 { "Build".to_string() } else { format!("Command Prompt · {folder_name}") };
        assert_eq!(info.title, want);
        assert!(!ids.contains(&info.id));
        ids.push(info.id);
    }
    let listed = terms.list();
    assert_eq!(listed.len(), MAX_TERMS, "the ended one made room");
    assert!(listed.iter().all(|t| t.exit.is_none() && t.id != done.id));
    assert_eq!(terms.open(Open::default()).unwrap_err(), "8 terminals are open on the PC. End one first.");
    terms.kill_all();
    assert!(terms.list().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

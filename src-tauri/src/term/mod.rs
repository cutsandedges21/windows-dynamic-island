// Terminals on this computer: the ones a phone opens (src/remote/terms.rs streams them) and the
// Claude chats a phone starts (src/activities/claude runs `claude` in one). Design:
// docs/superpowers/specs/2026-10-28-phone-terminal-claude-screen-design.md.
//
// Each is a pseudo-terminal from portable-pty (ConPTY on Windows, a Unix pty on a Mac) with a
// shell or one program in it, an id of 8 hex characters, and its last 256 KiB of output for
// whoever attaches next. At most 8 run at once. They keep running with nothing attached and end
// when Island quits (on Windows even when it crashes: each is in a job, spawn.rs). One that
// ended stays listed with its exit code for 10 minutes. Changes to the list reach the listeners
// (the windows' `term-changed`, the phones' `terms`) at most 4 times a second.
//
// Three threads per terminal: one reads its output (the kept output, the title, the attached
// streams), one waits for its program to end, and one writes what is typed, so a busy program
// never holds up whoever types.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{Child, ChildKiller, MasterPty};
use ring::rand::SecureRandom;
use serde::Serialize;
use tokio::sync::mpsc;

mod ringbuf;
mod spawn;
mod vt;
#[cfg(test)]
pub(crate) mod tests;

pub use ringbuf::REPLAY_MAX;
use ringbuf::Ring;
use vt::Vt;

/// Terminals running at once.
pub const MAX_TERMS: usize = 8;
/// How long an ended terminal stays listed.
pub const KEEP_ENDED: Duration = Duration::from_secs(10 * 60);
/// Columns and rows a terminal takes, each at most this.
pub const SIZE_MAX: u16 = 500;
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
/// The list goes out at most this often (4 a second).
const LIST_GAP: Duration = Duration::from_millis(250);
/// How often ended terminals are looked at.
const SWEEP_EVERY: Duration = Duration::from_secs(15);
/// Pieces of output waiting for one attached stream; a stream further behind is let go (it
/// attaches again and starts from the kept output).
const BACKLOG: usize = 256;
/// One read of output.
const READ_CHUNK: usize = 16 * 1024;
/// After its program ends, a terminal's last output is waited for until it has been quiet this
/// long (ConPTY keeps drawing for a moment)…
const QUIET: Duration = Duration::from_millis(200);
/// …or this long at most.
const SETTLE_WITHIN: Duration = Duration::from_secs(1);
/// After that, its output is read to the end for at most this long.
const DRAIN_WITHIN: Duration = Duration::from_secs(3);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A terminal as the island and phones list it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TermInfo {
    pub id: String,
    pub title: String,
    pub cwd: String,
    /// `powershell`, `cmd`, `bash` (a Mac: `zsh`…), or the program's name (`claude`).
    pub shell: String,
    pub pid: u32,
    /// ms since 1970.
    pub started: u64,
    /// The program's exit code once it ended.
    pub exit: Option<i64>,
    /// Phone streams showing it.
    pub attached: usize,
    /// Started by Island for a Claude chat.
    pub claude: bool,
}

/// What an attached stream gets, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    Data(Arc<[u8]>),
    Title(String),
    /// The program ended (its code when known); nothing follows.
    Exit(Option<i64>),
}

/// What to open.
#[derive(Clone, Debug, Default)]
pub struct Open {
    /// The folder it starts in (None: the user's home; `~` is home too).
    pub cwd: Option<String>,
    /// `powershell`, `cmd` or `bash` (None: PowerShell); not used with a program.
    pub shell: Option<String>,
    /// A program to run directly instead of a shell, and its arguments.
    pub program: Option<String>,
    pub args: Vec<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Its title until the program gives one (None: the shell and the folder's name).
    pub title: Option<String>,
    pub claude: bool,
}

/// A stream attached to a terminal.
pub struct Attached {
    /// For `detach`.
    pub key: u64,
    pub title: String,
    /// The kept output (sent first: the phone clears its screen and writes it).
    pub replay: Vec<u8>,
    pub rx: mpsc::Receiver<Out>,
}

struct Term {
    id: String,
    cwd: String,
    shell: String,
    pid: u32,
    started: u64,
    claude: bool,
    state: Mutex<State>,
    /// What is typed goes to the writing thread (None once the program ended).
    input: Mutex<Option<std_mpsc::Sender<Vec<u8>>>>,
    /// For resizing; dropped when the program ends (on Windows that closes the console).
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    #[cfg(windows)]
    job: Mutex<Option<spawn::Job>>,
    /// When output last came, in ms after `born`.
    last_out: AtomicU64,
    born: Instant,
}

struct State {
    /// The title the program gave, when it gave one that says something.
    given: Option<String>,
    /// Its title until then.
    named: String,
    ring: Ring,
    attached: Vec<(u64, mpsc::Sender<Out>)>,
    /// Once ended: its exit code (if known) and when.
    ended: Option<(Option<i64>, Instant)>,
    /// Ended by Island (End, or Island quitting), not by itself.
    stopped: bool,
}

impl State {
    fn title(&self) -> String {
        self.given.clone().unwrap_or_else(|| self.named.clone())
    }

    /// Sends to every attached stream; one too far behind (or gone) is let go. True when one was.
    fn tell(&mut self, out: &Out) -> bool {
        let before = self.attached.len();
        self.attached.retain(|(_, tx)| tx.try_send(out.clone()).is_ok());
        self.attached.len() != before
    }
}

impl Term {
    fn info(&self) -> TermInfo {
        let s = self.state.lock().unwrap();
        TermInfo {
            id: self.id.clone(),
            title: s.title(),
            cwd: self.cwd.clone(),
            shell: self.shell.clone(),
            pid: self.pid,
            started: self.started,
            exit: s.ended.map(|(code, _)| code.unwrap_or(-1)),
            attached: s.attached.len(),
            claude: self.claude,
        }
    }

    fn running(&self) -> bool {
        self.state.lock().unwrap().ended.is_none()
    }

    fn type_in(&self, bytes: Vec<u8>) -> bool {
        self.input.lock().unwrap().as_ref().is_some_and(|tx| tx.send(bytes).is_ok())
    }

    fn quiet_for(&self) -> Duration {
        let now = self.born.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last_out.load(Ordering::Relaxed)))
    }

    /// Ends its program and everything it started (on a Mac: SIGHUP, then SIGKILL after 200 ms).
    fn stop(&self) {
        {
            let mut s = self.state.lock().unwrap();
            if s.ended.is_some() {
                return;
            }
            s.stopped = true;
        }
        #[cfg(windows)]
        if let Some(job) = self.job.lock().unwrap().as_ref() {
            job.kill();
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

/// Whether a title a program gave says something: what follows a program's path ("C:\…\cmd.exe -
/// npm test" is "npm test"), and nothing for the bare path a Windows console shows before a
/// program sets its own.
fn tidy_title(t: &str) -> Option<String> {
    let lower = t.to_ascii_lowercase();
    if let Some(i) = lower.find(".exe") {
        let path = &t[..i + 4];
        if path.contains(['\\', '/']) && !path.contains(" - ") {
            let rest = t[i + 4..].trim_start();
            let rest = rest.strip_prefix('-').map(str::trim).unwrap_or(if rest.is_empty() { "" } else { t });
            return (!rest.is_empty()).then(|| rest.to_string());
        }
    }
    (!t.is_empty()).then(|| t.to_string())
}

/// Reads the program's output until it ends: keeps it, passes it to the attached streams, and
/// follows the title.
fn read_loop(term: Arc<Term>, mut reader: Box<dyn Read + Send>, signal: Arc<Signal>, done: std_mpsc::Sender<()>) {
    let mut vt = Vt::new(cfg!(windows));
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        term.last_out.store(term.born.elapsed().as_millis() as u64, Ordering::Relaxed);
        let seen = vt.feed(&buf[..n]);
        if seen.asked {
            term.type_in(vt::ANSWER.to_vec());
        }
        let mut changed = false;
        {
            let mut s = term.state.lock().unwrap();
            if !seen.out.is_empty() {
                s.ring.push(&seen.out);
                changed |= s.tell(&Out::Data(Arc::from(seen.out)));
            }
            if let Some(title) = seen.title {
                let given = tidy_title(&title);
                if given != s.given {
                    s.given = given;
                    let title = s.title();
                    s.tell(&Out::Title(title));
                    changed = true;
                }
            }
        }
        if changed {
            signal.poke();
        }
    }
    let _ = done.send(());
}

/// Waits for the program to end, then for its last output, and tells everyone.
fn wait_loop(term: Arc<Term>, mut child: Box<dyn Child + Send + Sync>, signal: Arc<Signal>, drained: std_mpsc::Receiver<()>) {
    let code = child.wait().ok().map(|s| s.exit_code() as i32 as i64);
    let ended = Instant::now();
    while term.quiet_for() < QUIET && ended.elapsed() < SETTLE_WITHIN {
        std::thread::sleep(Duration::from_millis(50));
    }
    // Closing the console ends its output (Windows); a Unix pty's ended with the program.
    let master = term.master.lock().unwrap().take();
    drop(master);
    let _ = drained.recv_timeout(DRAIN_WITHIN);
    let stopped = {
        let mut s = term.state.lock().unwrap();
        s.ended = Some((code, Instant::now()));
        s.tell(&Out::Exit(code));
        // The streams end once they sent the exit.
        s.attached.clear();
        s.stopped
    };
    term.input.lock().unwrap().take();
    #[cfg(windows)]
    if let Some(job) = term.job.lock().unwrap().take() {
        // Ended by itself: what it started in the background keeps running.
        if !stopped {
            job.release();
        }
    }
    let how = if stopped { "ended by Island" } else { "ended" };
    crate::log::line(format!("term: {} {how} ({})", term.id, code.map_or("no code".into(), |c| c.to_string())));
    signal.poke();
}

/// Types what it is given, in order.
fn write_loop(mut writer: Box<dyn Write + Send>, rx: std_mpsc::Receiver<Vec<u8>>) {
    for bytes in rx {
        if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
            break;
        }
    }
}

/// "The list changed", from any thread, for the thread that tells the listeners.
#[derive(Default)]
struct Signal {
    /// (changed, closed)
    state: Mutex<(bool, bool)>,
    cv: Condvar,
}

impl Signal {
    fn poke(&self) {
        self.state.lock().unwrap().0 = true;
        self.cv.notify_one();
    }

    fn close(&self) {
        self.state.lock().unwrap().1 = true;
        self.cv.notify_one();
    }

    /// Waits up to `within`: Some(true) when poked, Some(false) when not, None once closed.
    fn wait(&self, within: Duration) -> Option<bool> {
        let mut st = self.state.lock().unwrap();
        if !st.0 && !st.1 {
            st = self.cv.wait_timeout(st, within).unwrap().0;
        }
        if st.1 {
            return None;
        }
        Some(std::mem::replace(&mut st.0, false))
    }
}

/// Tells the listeners about changes, at most every LIST_GAP, and takes old ended terminals off
/// the list. Ends with the Terms.
fn tell_loop(terms: Weak<Terms>, signal: Arc<Signal>) {
    while let Some(changed) = signal.wait(SWEEP_EVERY) {
        let Some(terms) = terms.upgrade() else { return };
        let swept = terms.sweep(Instant::now());
        if changed || swept {
            terms.tell();
            drop(terms);
            std::thread::sleep(LIST_GAP);
        }
    }
}

pub type Listener = Arc<dyn Fn(&[TermInfo]) + Send + Sync>;

/// Every terminal on this computer.
pub struct Terms {
    list: Mutex<Vec<Arc<Term>>>,
    /// One opens at a time, so two can't both take the last place.
    opening: Mutex<()>,
    keys: AtomicU64,
    listeners: Mutex<Vec<Listener>>,
    signal: Arc<Signal>,
}

impl Terms {
    pub fn new() -> Arc<Terms> {
        let signal = Arc::new(Signal::default());
        let terms = Arc::new(Terms { list: Mutex::default(), opening: Mutex::default(), keys: AtomicU64::new(1), listeners: Mutex::default(), signal: signal.clone() });
        let weak = Arc::downgrade(&terms);
        let _ = std::thread::Builder::new().name("terms".into()).spawn(move || tell_loop(weak, signal));
        terms
    }

    /// `f` hears the list whenever it changes (at most 4 times a second).
    pub fn listen(&self, f: Listener) {
        self.listeners.lock().unwrap().push(f);
    }

    pub fn list(&self) -> Vec<TermInfo> {
        let list = self.list.lock().unwrap().clone();
        list.iter().map(|t| t.info()).collect()
    }

    fn tell(&self) {
        let list = self.list();
        let listeners = self.listeners.lock().unwrap().clone();
        for f in listeners {
            f(&list);
        }
    }

    fn find(&self, id: &str) -> Option<Arc<Term>> {
        self.list.lock().unwrap().iter().find(|t| t.id == id).cloned()
    }

    /// Takes terminals that ended KEEP_ENDED ago off the list; true when one went.
    fn sweep(&self, now: Instant) -> bool {
        let mut list = self.list.lock().unwrap();
        let before = list.len();
        list.retain(|t| t.state.lock().unwrap().ended.is_none_or(|(_, at)| now.duration_since(at) < KEEP_ENDED));
        list.len() != before
    }

    /// Room for one more: at most MAX_TERMS run; ended ones make way, oldest first.
    fn make_room(&self) -> Result<(), String> {
        let mut list = self.list.lock().unwrap();
        if list.iter().filter(|t| t.running()).count() >= MAX_TERMS {
            return Err(format!("{MAX_TERMS} terminals are open on the PC. End one first."));
        }
        while list.len() >= MAX_TERMS {
            let Some(i) = list.iter().position(|t| !t.running()) else { break };
            list.remove(i);
        }
        Ok(())
    }

    /// 8 random hex characters no terminal here has.
    fn new_id(&self) -> Result<String, String> {
        loop {
            let mut b = [0u8; 4];
            ring::rand::SystemRandom::new().fill(&mut b).map_err(|_| "This computer gave Island no random numbers.".to_string())?;
            let id: String = b.iter().map(|b| format!("{b:02x}")).collect();
            if self.find(&id).is_none() {
                return Ok(id);
            }
        }
    }

    /// Starts a terminal (a shell, or `program` directly) and lists it.
    pub fn open(self: &Arc<Self>, o: Open) -> Result<TermInfo, String> {
        let _one = self.opening.lock().unwrap();
        self.make_room()?;
        let cwd = folder(o.cwd.as_deref())?;
        let spec = match o.program.as_deref() {
            Some(p) => spawn::program(p, &o.args)?,
            None => spawn::shell(o.shell.as_deref())?,
        };
        let cols = o.cols.unwrap_or(DEFAULT_COLS).clamp(1, SIZE_MAX);
        let rows = o.rows.unwrap_or(DEFAULT_ROWS).clamp(1, SIZE_MAX);
        let id = self.new_id()?;
        let started = spawn::start(&spec, &cwd, cols, rows)?;
        let named = o.title.as_deref().map(vt::clean_title).filter(|t| !t.is_empty()).unwrap_or_else(|| default_title(&spec.label, &cwd));
        let (input, typed) = std_mpsc::channel();
        let term = Arc::new(Term {
            id: id.clone(),
            cwd: cwd.to_string_lossy().to_string(),
            shell: spec.shell.clone(),
            pid: started.pid,
            started: now_ms(),
            claude: o.claude,
            state: Mutex::new(State { given: None, named, ring: Ring::new(REPLAY_MAX), attached: Vec::new(), ended: None, stopped: false }),
            input: Mutex::new(Some(input)),
            master: Mutex::new(Some(started.master)),
            killer: Mutex::new(started.killer),
            #[cfg(windows)]
            job: Mutex::new(started.job),
            last_out: AtomicU64::new(0),
            born: Instant::now(),
        });
        let (done, drained) = std_mpsc::channel();
        let threads = [
            spawn_named("term-write", {
                let writer = started.writer;
                move || write_loop(writer, typed)
            }),
            spawn_named("term-read", {
                let (term, reader, signal) = (term.clone(), started.reader, self.signal.clone());
                move || read_loop(term, reader, signal, done)
            }),
            spawn_named("term-wait", {
                let (term, child, signal) = (term.clone(), started.child, self.signal.clone());
                move || wait_loop(term, child, signal, drained)
            }),
        ];
        if threads.iter().any(|ok| !ok) {
            term.stop();
            return Err("Island couldn't keep a terminal going.".into());
        }
        self.list.lock().unwrap().push(term.clone());
        crate::log::line(format!("term: {id} opened ({}{})", spec.shell, if o.claude { ", a Claude chat" } else { "" }));
        self.signal.poke();
        Ok(term.info())
    }

    /// Attaches a stream: it gets the kept output, then everything new until it detaches or the
    /// program ends.
    pub fn attach(&self, id: &str) -> Result<Attached, String> {
        let term = self.find(id).ok_or_else(|| "That terminal isn't open anymore.".to_string())?;
        let (tx, rx) = mpsc::channel(BACKLOG);
        let key = self.keys.fetch_add(1, Ordering::Relaxed);
        let (title, replay) = {
            let mut s = term.state.lock().unwrap();
            match s.ended {
                Some((code, _)) => {
                    let _ = tx.try_send(Out::Exit(code));
                }
                None => s.attached.push((key, tx)),
            }
            (s.title(), s.ring.replay())
        };
        self.signal.poke();
        Ok(Attached { key, title, replay, rx })
    }

    pub fn detach(&self, id: &str, key: u64) {
        let Some(term) = self.find(id) else { return };
        let gone = {
            let mut s = term.state.lock().unwrap();
            let before = s.attached.len();
            s.attached.retain(|(k, _)| *k != key);
            s.attached.len() != before
        };
        if gone {
            self.signal.poke();
        }
    }

    /// Lets every attached stream go (phones may no longer have terminals).
    pub fn detach_all(&self) {
        for t in self.list.lock().unwrap().iter() {
            t.state.lock().unwrap().attached.clear();
        }
        self.signal.poke();
    }

    /// Types into a running terminal.
    pub fn write(&self, id: &str, bytes: &[u8]) -> bool {
        !bytes.is_empty() && self.find(id).is_some_and(|t| t.running() && t.type_in(bytes.to_vec()))
    }

    /// The last size asked for wins.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> bool {
        let Some(t) = self.find(id) else { return false };
        let master = t.master.lock().unwrap();
        master.as_ref().is_some_and(|m| m.resize(spawn::size(cols.clamp(1, SIZE_MAX), rows.clamp(1, SIZE_MAX))).is_ok())
    }

    /// Ends a terminal (and what it started, if it still runs) and takes it off the list.
    pub fn kill(&self, id: &str) -> bool {
        let term = {
            let mut list = self.list.lock().unwrap();
            let Some(i) = list.iter().position(|t| t.id == id) else { return false };
            list.remove(i)
        };
        // A Mac waits up to 200 ms for the program to go; nobody waits for that.
        std::thread::spawn(move || term.stop());
        self.signal.poke();
        true
    }

    /// Ends every terminal (Island is quitting).
    pub fn kill_all(&self) {
        let list = std::mem::take(&mut *self.list.lock().unwrap());
        let stops: Vec<_> = list.into_iter().map(|t| std::thread::spawn(move || t.stop())).collect();
        for s in stops {
            let _ = s.join();
        }
    }
}

impl Drop for Terms {
    fn drop(&mut self) {
        self.kill_all();
        self.signal.close();
    }
}

fn spawn_named(name: &str, f: impl FnOnce() + Send + 'static) -> bool {
    std::thread::Builder::new().name(name.into()).spawn(f).is_ok()
}

/// The folder a terminal starts in: `cwd` (`~` is home), else the user's home.
fn folder(cwd: Option<&str>) -> Result<PathBuf, String> {
    let Some(c) = cwd.map(str::trim).filter(|c| !c.is_empty()) else { return Ok(crate::claude::home()) };
    let path = match c.strip_prefix('~') {
        Some("") => crate::claude::home(),
        Some(rest) if rest.starts_with(['/', '\\']) => crate::claude::home().join(&rest[1..]),
        _ => PathBuf::from(c),
    };
    if path.is_absolute() && path.is_dir() {
        Ok(path)
    } else {
        Err(format!("There's no folder {c} on the PC."))
    }
}

/// "PowerShell · Documents": what runs and where.
fn default_title(label: &str, cwd: &Path) -> String {
    let place = cwd.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| cwd.to_string_lossy().to_string());
    vt::clean_title(&format!("{label} · {place}"))
}

// ------------------------------------------------------------------ commands

/// The app's terminals.
pub struct TermState(pub Arc<Terms>);

impl Default for TermState {
    fn default() -> Self {
        TermState(Terms::new())
    }
}

fn terms_of(app: &tauri::AppHandle) -> Arc<Terms> {
    use tauri::Manager;
    app.state::<TermState>().0.clone()
}

/// Every window hears `term-changed` (the list) when it changes.
pub fn setup(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let handle = app.clone();
    terms_of(app).listen(Arc::new(move |list: &[TermInfo]| {
        let _ = handle.emit("term-changed", list);
    }));
}

/// Island is quitting: every terminal ends.
pub fn quit(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<TermState>() {
        state.0.kill_all();
    }
}

#[derive(Serialize)]
pub struct Opened {
    pub id: String,
    pub pid: u32,
}

/// Opens a terminal: a shell (`shell`: powershell, cmd or bash), or `program` with `args` run
/// directly (no shell, so nothing in them is read as a command). `claude`: for a Claude chat.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn term_open(
    app: tauri::AppHandle,
    cwd: Option<String>,
    shell: Option<String>,
    program: Option<String>,
    args: Option<Vec<String>>,
    cols: Option<u16>,
    rows: Option<u16>,
    title: Option<String>,
    claude: Option<bool>,
) -> Result<Opened, String> {
    let terms = terms_of(&app);
    let open = Open { cwd, shell, program, args: args.unwrap_or_default(), cols, rows, title, claude: claude.unwrap_or(false) };
    let info = tauri::async_runtime::spawn_blocking(move || terms.open(open)).await.map_err(|e| e.to_string())??;
    Ok(Opened { id: info.id, pid: info.pid })
}

/// Types `text` into a running terminal (a Claude chat's message ends in "\r").
#[tauri::command]
pub fn term_write(state: tauri::State<'_, TermState>, id: String, text: String) -> bool {
    state.0.write(&id, text.as_bytes())
}

#[tauri::command]
pub fn term_list(state: tauri::State<'_, TermState>) -> Vec<TermInfo> {
    state.0.list()
}

/// Ends a terminal and everything started in it, and takes it off the list.
#[tauri::command]
pub fn term_kill(state: tauri::State<'_, TermState>, id: String) -> bool {
    state.0.kill(&id)
}

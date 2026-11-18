// Chats with friends: the last few notes each way, kept so the island can show a conversation.
//
// Small on purpose (Moss, 2026-11-17): text only (pictures and files go the normal Land way and
// land in Downloads, nothing here stores or previews them), the last `KEEP` messages per friend,
// and kept on disk only when the user turns "Remember chats" on. With it off, a chat lives in
// memory until Island closes. Only friends get a chat, and removing a friend wipes theirs.

use super::*;

/// Messages kept per friend; older ones drop off.
pub const KEEP: usize = 20;
/// A kept message is cut to this many characters (a note can be longer to send; history is a glance).
const KEEP_CHARS: usize = 4000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Msg {
    /// "in" (they sent it) or "out" (you did).
    pub dir: String,
    pub text: String,
    /// When it was sent or taken (ms).
    pub at: u64,
    /// Files that went with the note (they are in Downloads, not here).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub files: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Serialize, Deserialize, Default)]
struct Disk {
    #[serde(default)]
    remember: bool,
    /// Friend key -> messages, oldest first. Empty unless `remember`.
    #[serde(default)]
    chats: HashMap<String, Vec<Msg>>,
}

pub struct History {
    file: Option<PathBuf>,
    inner: Mutex<Disk>,
}

impl History {
    /// No file: chats stay in memory (Land anywhere off, tests).
    pub fn memory() -> Self {
        Self { file: None, inner: Mutex::new(Disk::default()) }
    }

    /// Reads `file` (missing or damaged: starts empty). Chats on disk are only trusted while
    /// "Remember chats" is on.
    pub fn open(file: PathBuf) -> Self {
        let mut disk: Disk = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if !disk.remember {
            disk.chats.clear();
        }
        for list in disk.chats.values_mut() {
            let extra = list.len().saturating_sub(KEEP);
            list.drain(..extra);
        }
        Self { file: Some(file), inner: Mutex::new(disk) }
    }

    pub fn remember(&self) -> bool {
        self.inner.lock().unwrap().remember
    }

    pub fn list(&self, friend: &str) -> Vec<Msg> {
        self.inner.lock().unwrap().chats.get(friend).cloned().unwrap_or_default()
    }

    /// Adds a message (the oldest beyond `KEEP` goes) and saves when remembering.
    pub fn push(&self, friend: &str, mut msg: Msg) {
        if msg.text.chars().count() > KEEP_CHARS {
            msg.text = msg.text.chars().take(KEEP_CHARS).collect::<String>() + "\u{2026}";
        }
        let mut d = self.inner.lock().unwrap();
        let list = d.chats.entry(friend.to_string()).or_default();
        list.push(msg);
        let extra = list.len().saturating_sub(KEEP);
        list.drain(..extra);
        self.save(&d);
    }

    /// Forgets one friend's chat.
    pub fn clear(&self, friend: &str) {
        let mut d = self.inner.lock().unwrap();
        if d.chats.remove(friend).is_some() {
            self.save(&d);
        }
    }

    /// Turning it off wipes what was on disk (the chats stay in memory until Island closes).
    pub fn set_remember(&self, on: bool) {
        let mut d = self.inner.lock().unwrap();
        d.remember = on;
        self.save(&d);
    }

    fn save(&self, d: &Disk) {
        let Some(file) = &self.file else { return };
        let out = if d.remember { serde_json::to_vec(d) } else { serde_json::to_vec(&Disk { remember: false, chats: HashMap::new() }) };
        let Ok(bytes) = out else { return };
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, file)).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// The remember switch while Land is off: straight from the file.
pub fn remember_in(file: &Path) -> bool {
    History::open(file.to_path_buf()).remember()
}

/// Sets it while Land is off (turning it off wipes the file's chats).
pub fn set_remember_in(file: &Path, on: bool) {
    let h = History::open(file.to_path_buf());
    h.set_remember(on);
}

impl Running {
    /// A finished text transfer with a friend becomes a line in their chat. `t` is any state; only
    /// "done" counts (a declined or failed note was never read, or never arrived).
    pub(super) fn record_chat(&self, t: &Transfer) {
        if t.state != "done" {
            return;
        }
        let Some(text) = t.text.as_ref() else { return };
        let Some(far) = &self.far else { return };
        // A friend nearby is the computer nearby, with its friend key beside its Land key.
        let key = t.peer.anywhere.clone().unwrap_or_else(|| t.peer.id.clone());
        if far.friend(&key).is_none() {
            return;
        }
        // The same transfer can publish "done" twice (a late progress event): once only.
        {
            let mut seen = self.chatted.lock().unwrap();
            if !seen.insert(t.id.clone()) {
                return;
            }
            if seen.len() > 200 {
                seen.clear();
                seen.insert(t.id.clone());
            }
        }
        self.chats.push(&key, Msg { dir: t.dir.to_string(), text: text.clone(), at: now_ms(), files: t.count });
    }
}

// ------------------------------------------------------------------ commands

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub remember: bool,
    pub messages: Vec<Msg>,
}

/// A friend's chat (the last `KEEP` notes) and whether chats are remembered across restarts.
#[tauri::command]
pub async fn land_chat(state: tauri::State<'_, LandState>, friend: String) -> Result<Chat, String> {
    let run = running(&state).await?;
    Ok(Chat { remember: run.chats.remember(), messages: run.chats.list(&friend) })
}

/// Wipes one friend's chat.
#[tauri::command]
pub async fn land_chat_clear(state: tauri::State<'_, LandState>, friend: String) -> Result<(), String> {
    running(&state).await?.chats.clear(&friend);
    Ok(())
}

/// Whether chats are remembered across restarts (works with Land off).
#[tauri::command]
pub async fn land_chat_remember(state: tauri::State<'_, LandState>) -> Result<bool, String> {
    match state.run.lock().await.clone() {
        Some(run) => Ok(run.chats.remember()),
        None => Ok(remember_in(&chats_file())),
    }
}

/// Turns remembering chats on or off. Off wipes what was saved on disk.
#[tauri::command]
pub async fn land_chat_set_remember(state: tauri::State<'_, LandState>, on: bool) -> Result<(), String> {
    match state.run.lock().await.clone() {
        Some(run) => run.chats.set_remember(on),
        None => set_remember_in(&chats_file(), on),
    }
    Ok(())
}

pub fn chats_file() -> PathBuf {
    crate::anywhere::book_file().with_file_name("land-chats.json")
}

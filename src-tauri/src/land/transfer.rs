// What a transfer is: the offer, its dropped items, its state as the island sees it, how it
// ends early, and what is kept while it waits to resume or to reach a friend who is away.

use super::*;

// ------------------------------------------------------------------ offers and transfers

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct OfferFile {
    pub name: String,
    pub size: u64,
    /// When the sender's file last changed (ms; 0 unknown).
    #[serde(default)]
    pub mtime: u64,
}

pub struct Offer {
    pub from: String,
    pub os: String,
    pub files: Vec<OfferFile>,
    pub total: u64,
    /// The sender's id for this transfer: the same when it comes back after a dropped connection.
    pub tid: Option<String>,
    /// Text or a link instead of files (an Island before 0.3.0 declines it as "bad").
    pub text: Option<String>,
}

/// The longest text one send carries.
pub const MAX_TEXT: usize = 20_000;

/// Text worth sending: not blank, not too long, no control characters but line breaks and tabs.
pub fn clean_text(text: &str) -> Option<String> {
    let t: String = text.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect::<String>().trim().to_string();
    (!t.is_empty() && t.chars().count() <= MAX_TEXT).then_some(t)
}

impl Offer {
    /// An offer as it arrived, checked: 1 to MAX_FILES files with names and sizes, or text and no
    /// files. The total is counted here.
    pub fn parse(v: &Value) -> Option<Offer> {
        if v.get("t")?.as_str()? != "offer" {
            return None;
        }
        let text = match v.get("text") {
            Some(t) => Some(clean_text(t.as_str()?)?),
            None => None,
        };
        let list = v.get("files")?.as_array()?;
        if (list.is_empty() && text.is_none()) || list.len() > MAX_FILES {
            return None;
        }
        let mut files = Vec::with_capacity(list.len());
        let mut total: u64 = 0;
        for f in list {
            let name = f.get("name")?.as_str()?;
            let size = f.get("size")?.as_u64()?;
            if name.is_empty() || name.len() > 4096 {
                return None;
            }
            total = total.checked_add(size)?;
            let mtime = f.get("mtime").and_then(Value::as_u64).unwrap_or(0);
            files.push(OfferFile { name: name.to_string(), size, mtime });
        }
        let from = clean_name(v.get("from").and_then(Value::as_str).unwrap_or(""));
        let os = clean_os(v.get("os").and_then(Value::as_str).unwrap_or(""));
        let tid = v.get("tid").and_then(Value::as_str).filter(|t| !t.is_empty() && t.len() <= 80).map(String::from);
        Some(Offer { from, os, files, total, tid, text })
    }
}

/// One dropped item of a transfer: a file, or a folder with the files in it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Top {
    pub name: String,
    pub size: u64,
    pub files: usize,
    pub dir: bool,
}

/// The dropped items behind a list of files, in order ("Trip/a.jpg" and "Trip/b.jpg" are one folder).
pub fn tops(files: &[OfferFile]) -> Vec<Top> {
    let mut out: Vec<Top> = Vec::new();
    let mut at: HashMap<(bool, String), usize> = HashMap::new();
    for f in files {
        let parts = clean_rel(&f.name);
        let dir = parts.len() > 1;
        match at.get(&(dir, parts[0].to_lowercase())) {
            Some(&i) => {
                out[i].size += f.size;
                out[i].files += 1;
            }
            None => {
                at.insert((dir, parts[0].to_lowercase()), out.len());
                out.push(Top { name: parts[0].clone(), size: f.size, files: 1, dir });
            }
        }
    }
    out
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    pub os: String,
    /// A computer nearby's key for friends on other networks, when it announced one (signed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anywhere: Option<String>,
}

/// What the island hears about a transfer, on every change and as bytes move.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    /// "out" (sending) or "in" (receiving).
    pub dir: &'static str,
    pub peer: PeerInfo,
    /// waiting (out: connecting, then asking) | asking (in: waiting for this user) | sending | receiving | done | declined | failed | cancelled
    pub state: &'static str,
    pub done: u64,
    pub total: u64,
    pub count: usize,
    /// The dropped files and folders, the first LISTED of them, named as the receiver saves them.
    pub items: Vec<Top>,
    pub error: Option<String>,
    /// What arrived, as saved (a file, or the folder a dropped folder became).
    pub saved: Vec<String>,
    pub folder: Option<String>,
    /// When an ask runs out (epoch ms).
    pub expires: Option<u64>,
    /// How it goes: "lan" (a computer nearby), or for a friend "direct" or "relay" (it can change midway).
    pub via: Option<&'static str>,
    /// What a text send carries, instead of files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl Transfer {
    pub(super) fn new(id: &str, dir: &'static str, peer: PeerInfo, files: &[OfferFile]) -> Self {
        Self {
            id: id.into(),
            dir,
            peer,
            state: "waiting",
            done: 0,
            total: files.iter().map(|f| f.size).sum(),
            count: files.len(),
            items: tops(files).into_iter().take(LISTED).collect(),
            error: None,
            saved: Vec::new(),
            folder: None,
            expires: None,
            via: None,
            text: None,
        }
    }
}

/// How a transfer ended early.
pub(super) struct Fail {
    pub(super) state: &'static str,
    pub(super) error: String,
}

impl Fail {
    pub(super) fn failed(error: impl Into<String>) -> Self {
        Self { state: "failed", error: error.into() }
    }
    pub(super) fn declined(error: impl Into<String>) -> Self {
        Self { state: "declined", error: error.into() }
    }
    pub(super) fn cancelled(error: impl Into<String>) -> Self {
        Self { state: "cancelled", error: error.into() }
    }
    /// The connection dropped after the files were accepted: worth trying again.
    pub(super) fn lost(error: impl Into<String>) -> Self {
        Self { state: "lost", error: error.into() }
    }
    /// A friend's Island couldn't be reached at all: the send waits for it.
    pub(super) fn away(error: impl Into<String>) -> Self {
        Self { state: "away", error: error.into() }
    }
}

/// A send waiting for a friend who is away, kept in `<data dir>/land-queue.json` until it goes.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub(super) struct Waiting {
    pub(super) tid: String,
    pub(super) friend: String,
    /// What was dropped, sent again from the disk when it goes.
    pub(super) paths: Vec<String>,
    /// Or the text to send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) text: Option<String>,
    /// When the send began (ms).
    pub(super) since: u64,
}

/// A friend as a transfer names them.
pub(super) fn friend_info(f: &crate::anywhere::Friend) -> PeerInfo {
    PeerInfo { id: f.id.clone(), name: f.name.clone(), os: String::new(), anywhere: Some(f.id.clone()) }
}

/// How long a receiver turns away the comeback of a transfer its user cancelled while paused.
pub(super) const RESUME_REFUSED: Duration = Duration::from_secs(3600);

/// A sender's transfer, as its comeback is recognised: who sends, and its id for the transfer.
pub(super) fn resume_key(sender: &str, tid: &str) -> String {
    format!("{sender}/{tid}")
}

/// The files of an accepted transfer as they arrive: where each goes, and its temp file once begun.
pub(super) struct Landing {
    pub(super) targets: Vec<Target>,
    pub(super) temps: Vec<PathBuf>,
    pub(super) litter: Litter,
}

impl Landing {
    pub(super) fn new(downloads: &Path, files: &[OfferFile]) -> io::Result<Landing> {
        let mut litter = Litter::default();
        let targets = prepare(downloads, files, &mut litter)?;
        Ok(Landing { targets, temps: Vec::new(), litter })
    }

    /// The bytes of each file already on disk (0 for one not begun).
    pub(super) fn have(&self) -> Vec<u64> {
        self.targets.iter().enumerate().map(|(i, t)| self.temps.get(i).and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len().min(t.size)).unwrap_or(0)).collect()
    }
}

/// An accepted transfer whose connection dropped: its pieces wait for the sender to come back.
pub(super) struct Paused {
    pub(super) files: Vec<OfferFile>,
    pub(super) transfer: Transfer,
    pub(super) landing: Landing,
    /// Which pause this is (a transfer can drop more than once).
    pub(super) epoch: u64,
}

pub(super) fn why_declined(why: &str, name: &str) -> String {
    match why {
        "busy" => format!("{name} is busy with other files. Try again in a moment."),
        "space" => format!("{name} doesn't have enough space for these files."),
        "timeout" => format!("{name} didn't answer."),
        // An Island before 0.3.0 turns away what it doesn't know, like text.
        "bad" => format!("{name}'s Island can't take that yet. They need to update Island."),
        _ => format!("{name} declined."),
    }
}

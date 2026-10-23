// The phones paired with this Island, kept in `<data dir>/phones.json`: a JSON array of
// `{id, name, pairedAt, lastSeen, push}`, `push` being the phone's Web Push subscription or null.

use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PushKeys {
    pub p256dh: String,
    pub auth: String,
}

/// A Web Push subscription, as the phone's `PushSubscription.toJSON()` gives it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PushSub {
    pub endpoint: String,
    pub keys: PushKeys,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Phone {
    /// The phone's iroh key (its EndpointId, Display form): proven by the TLS handshake.
    pub id: String,
    pub name: String,
    /// When it paired, and when it was last connected (ms since 1970).
    pub paired_at: u64,
    pub last_seen: u64,
    #[serde(default)]
    pub push: Option<PushSub>,
}

/// A phone's name as shown: no control characters, at most 40 characters, "Phone" when blank.
pub fn clean_phone_name(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(40).collect();
    let t = t.trim_end().to_string();
    if t.is_empty() {
        "Phone".into()
    } else {
        t
    }
}

/// Base64url as browsers write it (no padding), also taking padding and the standard alphabet.
pub fn b64url(text: &str) -> Option<Vec<u8>> {
    let t: String = text.trim().trim_end_matches('=').chars().map(|c| match c {
        '+' => '-',
        '/' => '_',
        c => c,
    }).collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(t.as_bytes()).ok()
}

/// A push subscription from a phone's `push-sub` line, if it is one a push can go to: an https
/// endpoint, a P-256 public key (65 bytes, uncompressed) and a 16-byte auth secret.
pub fn read_push_sub(v: &Value) -> Option<PushSub> {
    let sub: PushSub = serde_json::from_value(v.clone()).ok()?;
    let ok = sub.endpoint.len() <= 2000
        && super::push::push_host_ok(&sub.endpoint)
        && sub.keys.p256dh.len() <= 200
        && sub.keys.auth.len() <= 100
        && b64url(&sub.keys.p256dh).is_some_and(|k| k.len() == 65 && k[0] == 4)
        && b64url(&sub.keys.auth).is_some_and(|a| a.len() == 16);
    ok.then_some(sub)
}

#[derive(Debug)]
pub struct Store {
    file: PathBuf,
    phones: Vec<Phone>,
}

impl Store {
    /// A missing file is no phones. A file that can't be read is kept as `phones.json.bad` and
    /// Island starts with no phones (they pair again).
    pub fn load(file: PathBuf) -> Store {
        let phones = match std::fs::read(&file) {
            Err(_) => Vec::new(),
            Ok(bytes) => match serde_json::from_slice::<Vec<Phone>>(&bytes) {
                Ok(list) => {
                    let mut kept: Vec<Phone> = Vec::with_capacity(list.len());
                    for p in list {
                        if p.id.parse::<iroh::EndpointId>().is_ok() && !kept.iter().any(|k| k.id == p.id) {
                            kept.push(Phone { name: clean_phone_name(&p.name), ..p });
                        }
                    }
                    kept
                }
                Err(e) => {
                    let bad = file.with_extension("json.bad");
                    let _ = std::fs::rename(&file, &bad);
                    crate::log::line(format!("remote: phones.json was unreadable ({e}); kept as {}", bad.display()));
                    Vec::new()
                }
            },
        };
        Store { file, phones }
    }

    /// Written to a temporary file first, so a crash never leaves half a list.
    pub fn save(&self) -> std::io::Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let temp = self.file.with_extension("json.tmp");
        std::fs::write(&temp, serde_json::to_vec_pretty(&self.phones).map_err(std::io::Error::other)?)?;
        std::fs::rename(&temp, &self.file)
    }

    pub fn phones(&self) -> &[Phone] {
        &self.phones
    }

    pub fn is_empty(&self) -> bool {
        self.phones.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&Phone> {
        self.phones.iter().find(|p| p.id == id)
    }

    /// A phone that just paired (again: its name is updated, its push subscription kept).
    pub fn pair(&mut self, id: &str, name: &str, now: u64) {
        match self.phones.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.name = name.to_string();
                p.paired_at = now;
                p.last_seen = now;
            }
            None => self.phones.push(Phone { id: id.to_string(), name: name.to_string(), paired_at: now, last_seen: now, push: None }),
        }
    }

    pub fn rename(&mut self, id: &str, name: &str) -> bool {
        match self.phones.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.name = clean_phone_name(name);
                true
            }
            None => false,
        }
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.phones.len();
        self.phones.retain(|p| p.id != id);
        self.phones.len() != before
    }

    pub fn seen(&mut self, id: &str, now: u64) -> bool {
        match self.phones.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.last_seen = now;
                true
            }
            None => false,
        }
    }

    /// True when it changed.
    pub fn set_push(&mut self, id: &str, sub: Option<PushSub>) -> bool {
        match self.phones.iter_mut().find(|p| p.id == id) {
            Some(p) if p.push != sub => {
                p.push = sub;
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_file(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("island-remote-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("phones.json")
    }

    fn id() -> String {
        iroh::SecretKey::generate().public().to_string()
    }

    fn sub() -> PushSub {
        let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4u8; 65]);
        let auth = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 16]);
        PushSub { endpoint: "https://web.push.apple.com/abc".into(), keys: PushKeys { p256dh: key, auth } }
    }

    #[test]
    fn phones_are_kept_across_restarts_in_camel_case() {
        let file = temp_file("keep");
        let (a, b) = (id(), id());
        let mut s = Store::load(file.clone());
        assert!(s.is_empty());
        s.pair(&a, "iPhone", 1000);
        s.pair(&b, "iPad", 2000);
        assert!(s.rename(&a, "  Moss\u{7}'s iPhone  "));
        assert!(s.seen(&b, 3000));
        assert!(s.set_push(&b, Some(sub())));
        assert!(!s.set_push(&b, Some(sub())), "the same subscription is no change");
        s.save().unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(raw[0]["pairedAt"], 1000);
        assert_eq!(raw[0]["lastSeen"], 1000);
        assert_eq!(raw[0]["push"], Value::Null);
        assert_eq!(raw[1]["push"]["keys"]["auth"], sub().keys.auth);
        let s = Store::load(file.clone());
        assert_eq!(s.phones().len(), 2);
        assert_eq!(s.get(&a).unwrap().name, "Moss's iPhone");
        assert_eq!(s.get(&b).unwrap().last_seen, 3000);
        assert_eq!(s.get(&b).unwrap().push, Some(sub()));
        assert!(!file.with_extension("json.tmp").exists());
    }

    #[test]
    fn pairing_again_keeps_the_push_subscription() {
        let mut s = Store::load(temp_file("again"));
        let a = id();
        s.pair(&a, "iPhone", 1);
        s.set_push(&a, Some(sub()));
        s.pair(&a, "Moss's iPhone", 5);
        assert_eq!(s.phones().len(), 1);
        let p = s.get(&a).unwrap();
        assert_eq!((p.name.as_str(), p.paired_at, p.push.is_some()), ("Moss's iPhone", 5, true));
        assert!(s.remove(&a) && !s.remove(&a));
        assert!(!s.rename(&a, "x") && !s.seen(&a, 9) && !s.set_push(&a, None));
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_and_island_starts_empty() {
        let file = temp_file("bad");
        std::fs::write(&file, b"{ not json").unwrap();
        let s = Store::load(file.clone());
        assert!(s.is_empty());
        assert!(!file.exists());
        assert_eq!(std::fs::read(file.with_extension("json.bad")).unwrap(), b"{ not json");
        // Records that are not phones (a bad key, a repeat) are dropped.
        let a = id();
        let list = json!([{ "id": a, "name": "A", "pairedAt": 1, "lastSeen": 2 }, { "id": "nope", "name": "B", "pairedAt": 1, "lastSeen": 2 }, { "id": a, "name": "C", "pairedAt": 1, "lastSeen": 2 }]);
        std::fs::write(&file, list.to_string()).unwrap();
        let s = Store::load(file);
        assert_eq!(s.phones().len(), 1);
        assert_eq!(s.phones()[0].name, "A");
        assert_eq!(s.phones()[0].push, None);
    }

    #[test]
    fn names_are_short_and_never_blank() {
        assert_eq!(clean_phone_name(""), "Phone");
        assert_eq!(clean_phone_name(" \n\t "), "Phone");
        assert_eq!(clean_phone_name(&"é".repeat(60)).chars().count(), 40);
        assert_eq!(clean_phone_name(" Moss\u{0}’s iPhone "), "Moss’s iPhone");
    }

    #[test]
    fn only_push_subscriptions_a_push_can_go_to_are_kept() {
        let good = serde_json::to_value(sub()).unwrap();
        assert_eq!(read_push_sub(&good), Some(sub()));
        let mut plain = good.clone();
        plain["endpoint"] = json!("http://web.push.apple.com/abc");
        assert_eq!(read_push_sub(&plain), None);
        let mut short_key = good.clone();
        short_key["keys"]["p256dh"] = json!("BAAA");
        assert_eq!(read_push_sub(&short_key), None);
        let mut padded = good.clone();
        padded["keys"]["auth"] = json!(format!("{}==", sub().keys.auth));
        assert!(read_push_sub(&padded).is_some(), "padding is fine");
        assert_eq!(read_push_sub(&json!({ "endpoint": "https://x/" })), None);
        assert_eq!(read_push_sub(&json!("sub")), None);
    }
}

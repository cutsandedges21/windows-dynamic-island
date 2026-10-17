//! Phone pushes: the island's "needs you" notifications also go to the free ntfy app
//! on a phone, through the public ntfy.sh server. The topic is the only secret:
//! anyone who knows it can read the pushes, so Settings makes a long random one.
//!
//! Answering from the phone (Settings › Notifications › Answer Claude from my phone): a
//! push can carry buttons (ntfy's "http" actions, which the iPhone app does too). A tap
//! posts the button's text, a word and a one-time code, to a second random topic, and
//! `phone_listen` hands what arrives there to the island while a request waits.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

/// ntfy topics: 1–64 letters, digits, '-' or '_'.
fn topic_ok(topic: &str) -> bool {
    !topic.is_empty() && topic.len() <= 64 && topic.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// ntfy emoji shortcodes ("white_check_mark", "+1"): short, lowercase, no spaces.
fn tag_ok(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= 32 && tag.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'+' || b == b'-')
}

/// A button on a push: tapping it posts `reply` to the reply topic.
#[derive(Deserialize, Clone, Debug)]
pub struct PushButton {
    label: String,
    reply: String,
}

/// ntfy shows three buttons at most.
const MAX_BUTTONS: usize = 3;

/// A button's text and what it posts: short, one line, plain ASCII words and digits.
fn button_ok(b: &PushButton) -> bool {
    let plain = |s: &str, max: usize| !s.trim().is_empty() && s.len() <= max && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b' ');
    plain(&b.label, 24) && plain(&b.reply, 80)
}

/// The push as ntfy's JSON. Buttons only go with a good reply topic, each one ntfy's "http"
/// action posting its reply there.
fn payload(topic: &str, title: &str, body: &str, tag: Option<String>, priority: Option<u8>, reply_topic: Option<&str>, buttons: &[PushButton]) -> serde_json::Value {
    let message = if body.trim().is_empty() { title } else { body };
    let tag = tag.filter(|t| tag_ok(t)).unwrap_or_else(|| "desktop_computer".into());
    let priority = priority.unwrap_or(3).clamp(1, 5);
    let mut v = serde_json::json!({ "topic": topic, "title": title, "message": message, "tags": [tag], "priority": priority });
    if let Some(reply) = reply_topic.filter(|t| topic_ok(t) && *t != topic) {
        let actions: Vec<serde_json::Value> = buttons
            .iter()
            .filter(|b| button_ok(b))
            .take(MAX_BUTTONS)
            .map(|b| serde_json::json!({ "action": "http", "label": b.label, "url": format!("https://ntfy.sh/{reply}"), "method": "POST", "body": b.reply, "clear": true }))
            .collect();
        if !actions.is_empty() {
            v["actions"] = serde_json::Value::Array(actions);
        }
    }
    v
}

/// Sends one push; true when ntfy.sh accepted it. `tag` is the emoji before the title,
/// `priority` ntfy's 1–5 (3 default); `buttons` post to `reply_topic` when tapped. JSON keeps
/// accents and emoji intact (ntfy's header form only takes ASCII).
#[tauri::command]
pub async fn phone_push(topic: String, title: String, body: String, tag: Option<String>, priority: Option<u8>, reply_topic: Option<String>, buttons: Option<Vec<PushButton>>) -> bool {
    if !topic_ok(&topic) {
        return false;
    }
    let payload = payload(&topic, &title, &body, tag, priority, reply_topic.as_deref(), &buttons.unwrap_or_default());
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("Island/", env!("CARGO_PKG_VERSION")))
        .build()
    else {
        return false;
    };
    match client.post("https://ntfy.sh/").json(&payload).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(e) => {
            crate::log::line(format!("phone: push failed: {e}"));
            false
        }
    }
}

// ------------------------------------------------------------------ answers from the phone

/// The reply topic being listened to, and until when.
static LISTEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);
/// Never longer than this per call; each push with buttons asks again.
const LISTEN_MAX: Duration = Duration::from_secs(600);

fn listening_until(topic: &str) -> Option<Instant> {
    LISTEN.lock().unwrap().as_ref().filter(|(t, _)| t == topic).map(|(_, u)| *u)
}

/// Listens on `topic` for `seconds` more (a running listener just waits longer): each message
/// posted there reaches the island as `phone-reply` `{message}`.
#[tauri::command]
pub fn phone_listen(app: AppHandle, topic: String, seconds: u64) -> bool {
    if !topic_ok(&topic) {
        return false;
    }
    let until = Instant::now() + Duration::from_secs(seconds).min(LISTEN_MAX);
    let start = {
        let mut slot = LISTEN.lock().unwrap();
        let running = slot.as_ref().is_some_and(|(t, u)| *t == topic && *u > Instant::now());
        let keep = slot.as_ref().filter(|(t, _)| *t == topic).map_or(until, |(_, u)| (*u).max(until));
        *slot = Some((topic.clone(), keep));
        !running
    };
    if start {
        tauri::async_runtime::spawn(listen(app, topic));
    }
    true
}

/// Streams the reply topic's messages (ntfy's JSON stream), from a little before now, until
/// nobody waits any more; it reconnects when the stream drops.
async fn listen(app: AppHandle, topic: String) {
    let client = match reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).user_agent(concat!("Island/", env!("CARGO_PKG_VERSION"))).build() {
        Ok(c) => c,
        Err(_) => return,
    };
    // A tap that came while this was starting is still picked up.
    let mut since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs().saturating_sub(30)).unwrap_or(0).to_string();
    crate::log::line("phone: listening for answers");
    while let Some(until) = listening_until(&topic).filter(|u| *u > Instant::now()) {
        let resp = tokio::time::timeout(until - Instant::now(), client.get(format!("https://ntfy.sh/{topic}/json?since={since}")).send()).await;
        let Ok(Ok(mut resp)) = resp else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        let mut buf: Vec<u8> = Vec::new();
        while let Some(until) = listening_until(&topic).filter(|u| *u > Instant::now()) {
            match tokio::time::timeout(until - Instant::now(), resp.chunk()).await {
                Ok(Ok(Some(bytes))) => {
                    buf.extend_from_slice(&bytes);
                    while let Some(at) = buf.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=at).collect();
                        if let Some((id, message)) = reply_in(&line) {
                            since = id;
                            let _ = app.emit_to(crate::overlay::LABEL, "phone-reply", serde_json::json!({ "message": message }));
                        }
                    }
                    if buf.len() > 64 * 1024 {
                        buf.clear();
                    }
                }
                // The stream dropped: connect again from the last message.
                Ok(_) => break,
                // Nobody waits any more.
                Err(_) => break,
            }
        }
    }
    let mut slot = LISTEN.lock().unwrap();
    if slot.as_ref().is_some_and(|(t, u)| *t == topic && *u <= Instant::now()) {
        *slot = None;
    }
    crate::log::line("phone: stopped listening");
}

/// One line of ntfy's JSON stream: a message's id and text (keepalives and opens are not messages).
fn reply_in(line: &[u8]) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_slice(line).ok()?;
    if v["event"] != "message" {
        return None;
    }
    Some((v["id"].as_str()?.to_string(), v["message"].as_str()?.trim().to_string()))
}

#[cfg(test)]
mod tests {
    use super::{payload, reply_in, tag_ok, topic_ok, PushButton};

    #[test]
    fn buttons_post_their_reply_to_the_reply_topic() {
        let b = |label: &str, reply: &str| PushButton { label: label.into(), reply: reply.into() };
        let v = payload("island-aa", "Needs permission · app", "Running command: npm test", Some("lock".into()), Some(4), Some("island-bb"), &[b("Allow", "allow 0f3c"), b("Deny", "deny 0f3c")]);
        assert_eq!(v["actions"][0], serde_json::json!({ "action": "http", "label": "Allow", "url": "https://ntfy.sh/island-bb", "method": "POST", "body": "allow 0f3c", "clear": true }));
        assert_eq!(v["actions"][1]["body"], "deny 0f3c");
        // No good reply topic (or the push topic itself): no buttons.
        assert!(payload("island-aa", "t", "b", None, None, Some("island-aa"), &[b("Allow", "allow 1")]).get("actions").is_none());
        assert!(payload("island-aa", "t", "b", None, None, Some("../x"), &[b("Allow", "allow 1")]).get("actions").is_none());
        // Odd buttons are left out; three at most.
        let odd = payload("island-aa", "t", "b", None, None, Some("island-bb"), &[b("Al\nlow", "allow 1"), b("Ok", "ok\"x"), b("A", "a"), b("B", "b"), b("C", "c"), b("D", "d")]);
        assert_eq!(odd["actions"].as_array().unwrap().len(), 3);
        assert_eq!(odd["actions"][0]["label"], "A");
    }

    #[test]
    fn only_messages_are_replies() {
        assert_eq!(reply_in(br#"{"id":"abc","time":1,"event":"message","topic":"t","message":" allow 0f3c "}"#), Some(("abc".into(), "allow 0f3c".into())));
        assert_eq!(reply_in(br#"{"id":"k","event":"keepalive"}"#), None);
        assert_eq!(reply_in(b"not json"), None);
    }

    #[test]
    fn only_emoji_shortcodes_pass_as_tags() {
        assert!(tag_ok("white_check_mark"));
        assert!(tag_ok("+1"));
        assert!(!tag_ok(""));
        assert!(!tag_ok("Has Caps"));
        assert!(!tag_ok("a,b"));
        assert!(!tag_ok(&"a".repeat(33)));
    }

    #[test]
    fn only_plain_topics_pass() {
        assert!(topic_ok("island-3f9a0c1d2e4b5a6978c0d1e2"));
        assert!(topic_ok("a_b-C9"));
        assert!(!topic_ok(""));
        assert!(!topic_ok("has space"));
        assert!(!topic_ok("../other"));
        assert!(!topic_ok("x?y=1"));
        assert!(!topic_ok(&"a".repeat(65)));
    }
}

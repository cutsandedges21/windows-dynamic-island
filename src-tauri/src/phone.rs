//! Phone pushes: the island's "needs you" notifications also go to the free ntfy app
//! on a phone, through the public ntfy.sh server. The topic is the only secret:
//! anyone who knows it can read the pushes, so Settings makes a long random one.

/// ntfy topics: 1–64 letters, digits, '-' or '_'.
fn topic_ok(topic: &str) -> bool {
    !topic.is_empty() && topic.len() <= 64 && topic.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// ntfy emoji shortcodes ("white_check_mark", "+1"): short, lowercase, no spaces.
fn tag_ok(tag: &str) -> bool {
    !tag.is_empty() && tag.len() <= 32 && tag.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'+' || b == b'-')
}

/// Sends one push; true when ntfy.sh accepted it. `tag` is the emoji before the title,
/// `priority` ntfy's 1–5 (3 default). JSON keeps accents and emoji intact (ntfy's header
/// form only takes ASCII).
#[tauri::command]
pub async fn phone_push(topic: String, title: String, body: String, tag: Option<String>, priority: Option<u8>) -> bool {
    if !topic_ok(&topic) {
        return false;
    }
    let message = if body.trim().is_empty() { title.clone() } else { body };
    let tag = tag.filter(|t| tag_ok(t)).unwrap_or_else(|| "desktop_computer".into());
    let priority = priority.unwrap_or(3).clamp(1, 5);
    let payload = serde_json::json!({ "topic": topic, "title": title, "message": message, "tags": [tag], "priority": priority });
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

#[cfg(test)]
mod tests {
    use super::{tag_ok, topic_ok};

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

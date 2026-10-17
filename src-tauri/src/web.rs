// Small HTTPS reads (calendar feeds, weather) shared by Windows and the Mac: one client, and
// a body read that stops at its cap, so a huge or endless answer never sits in memory whole.

use std::sync::OnceLock;
use std::time::Duration;

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("Island/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

/// GET `url` (https only): its status and at most `cap` bytes of its body.
pub async fn get_capped(url: &str, cap: usize) -> Option<(u16, Vec<u8>)> {
    if !url.to_ascii_lowercase().starts_with("https://") {
        return None;
    }
    let mut resp = client().get(url).send().await.ok()?;
    let status = resp.status().as_u16();
    let mut body = Vec::with_capacity(cap.min(64 * 1024));
    while body.len() < cap {
        match resp.chunk().await.ok()? {
            Some(chunk) => body.extend_from_slice(&chunk[..chunk.len().min(cap - body.len())]),
            None => break,
        }
    }
    Some((status, body))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn only_https_is_fetched() {
        assert!(super::get_capped("http://example.com", 10).await.is_none());
        assert!(super::get_capped("file:///C:/Windows/win.ini", 10).await.is_none());
    }
}

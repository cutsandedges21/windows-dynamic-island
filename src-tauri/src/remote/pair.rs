// Pairing: one code at a time, shown as a QR code of `<site>/#pair=<payload>`. The payload is
// base64url (no padding) of `{"v":1,"id","relays","code","name"}`, byte for byte what
// src/remote/protocol.ts `encodePair` writes. The code is 16 random bytes in hex, works for 10
// minutes, once, and 5 wrong tries end it.

use std::time::{Duration, Instant};

use base64::Engine;
use ring::rand::SecureRandom;
use serde::Serialize;

/// Wrong codes a pairing takes before it ends.
pub const MAX_TRIES: u8 = 5;

/// `n` random bytes from the system's secure source.
pub fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut b = [0u8; N];
    ring::rand::SystemRandom::new().fill(&mut b).map_err(|_| "This computer gave Island no random numbers.".to_string())?;
    Ok(b)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A new one-time code: 32 lowercase hex characters.
pub fn new_code() -> Result<String, String> {
    Ok(hex(&random::<16>()?))
}

/// The code waiting for a phone.
#[derive(Debug)]
pub struct Pairing {
    code: String,
    until: Instant,
    wrong: u8,
    /// Which pairing this is (its timer ends only its own).
    pub seq: u64,
}

impl Pairing {
    pub fn new(code: String, now: Instant, valid: Duration, seq: u64) -> Pairing {
        Pairing { code, until: now + valid, wrong: 0, seq }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Check {
    Ok,
    /// Not the code (the fifth wrong one ends the pairing).
    Wrong,
    /// No code is waiting: it ran out, was used, stopped or tried too often.
    Expired,
}

/// Checks `code` against the pairing in `slot`, which ends once used, out of time or tried
/// `MAX_TRIES` times wrongly.
pub fn check(slot: &mut Option<Pairing>, code: &str, now: Instant) -> Check {
    let Some(p) = slot.as_mut() else { return Check::Expired };
    if now >= p.until {
        *slot = None;
        return Check::Expired;
    }
    if same(code.as_bytes(), p.code.as_bytes()) {
        *slot = None;
        return Check::Ok;
    }
    p.wrong += 1;
    if p.wrong >= MAX_TRIES {
        *slot = None;
    }
    Check::Wrong
}

/// Equal, in time that doesn't depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// The fields in the order protocol.ts writes them (serde keeps declaration order).
#[derive(Serialize)]
struct Payload<'a> {
    v: u8,
    id: &'a str,
    relays: &'a [String],
    code: &'a str,
    name: &'a str,
}

fn payload_json(id: &str, relays: &[String], code: &str, name: &str) -> Vec<u8> {
    serde_json::to_vec(&Payload { v: 1, id, relays, code, name }).unwrap_or_default()
}

/// What goes after `#pair=`.
pub fn payload(id: &str, relays: &[String], code: &str, name: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload_json(id, relays, code, name))
}

/// The address the QR code shows: the site (its trailing slashes dropped), then the payload.
pub fn url(site: &str, payload: &str) -> String {
    let site = site.trim().trim_end_matches('/');
    let site = if site.is_empty() { super::PHONE_SITE } else { site };
    format!("{site}/#pair={payload}")
}

/// The computer's name as the phone takes it (protocol.ts refuses more than 80 UTF-16 units).
pub fn payload_name(name: &str) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in name.chars() {
        units += c.len_utf16();
        if units > 80 {
            break;
        }
        out.push(c);
    }
    out
}

/// A relay as a browser dials it: https only, without the trailing dot n0's relay names carry
/// ("…iroh.link."), which can hang a browser's WebSocket (iroh issue 4550). Written the way
/// protocol.ts `relayUrl` writes it: `https://host[:port]/path`.
pub fn browser_relay(url: &iroh::RelayUrl) -> Option<String> {
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.');
    if host.is_empty() {
        return None;
    }
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("https://{host}{port}{}", url.path()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payload_matches_protocol_ts_byte_for_byte() {
        let relays = vec!["https://use1-1.relay.n0.iroh.iroh.link/".to_string()];
        let (id, code, name) = ("k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0", "0123456789abcdef0123456789abcdef", "Moss\u{2019}s Laptop");
        let json = String::from_utf8(payload_json(id, &relays, code, name)).unwrap();
        assert_eq!(json, r#"{"v":1,"id":"k3m9xq7d1w5yhz8c4b2n6p0rtfa3e7gj9sv5ou1lqxw2y4z6c8d0","relays":["https://use1-1.relay.n0.iroh.iroh.link/"],"code":"0123456789abcdef0123456789abcdef","name":"Moss’s Laptop"}"#);
        assert_eq!(
            payload(id, &relays, code, name),
            "eyJ2IjoxLCJpZCI6ImszbTl4cTdkMXc1eWh6OGM0YjJuNnAwcnRmYTNlN2dqOXN2NW91MWxxeHcyeTR6NmM4ZDAiLCJyZWxheXMiOlsiaHR0cHM6Ly91c2UxLTEucmVsYXkubjAuaXJvaC5pcm9oLmxpbmsvIl0sImNvZGUiOiIwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiIsIm5hbWUiOiJNb3Nz4oCZcyBMYXB0b3AifQ"
        );
    }

    #[test]
    fn the_url_is_the_site_then_the_payload() {
        assert_eq!(url("https://islandphone.vercel.app//", "abc"), "https://islandphone.vercel.app/#pair=abc");
        assert_eq!(url("https://islandphone.vercel.app", "abc"), "https://islandphone.vercel.app/#pair=abc");
        assert_eq!(url("  ", "abc"), "https://islandphone.vercel.app/#pair=abc");
    }

    #[test]
    fn relays_lose_their_trailing_dot() {
        let r = |s: &str| browser_relay(&s.parse().unwrap());
        assert_eq!(r("https://use1-1.relay.n0.iroh.link./"), Some("https://use1-1.relay.n0.iroh.link/".into()));
        assert_eq!(r("https://euc1-1.relay.n0.iroh.link."), Some("https://euc1-1.relay.n0.iroh.link/".into()));
        assert_eq!(r("https://127.0.0.1:4433"), Some("https://127.0.0.1:4433/".into()));
        assert_eq!(r("https://relay.example:443/"), Some("https://relay.example/".into()));
        assert_eq!(r("http://plain.example/"), None);
    }

    #[test]
    fn names_fit_what_the_phone_takes() {
        assert_eq!(payload_name("MossLaptop"), "MossLaptop");
        assert_eq!(payload_name(&"a".repeat(100)).len(), 80);
        // An emoji is two UTF-16 units.
        assert_eq!(payload_name(&"😀".repeat(50)).chars().count(), 40);
    }

    #[test]
    fn codes_are_32_hex_characters_and_differ() {
        let (a, b) = (new_code().unwrap(), new_code().unwrap());
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)), "{a}");
        assert_ne!(a, b);
    }

    #[test]
    fn a_code_works_once() {
        let now = Instant::now();
        let mut slot = Some(Pairing::new("c0de".repeat(8), now, Duration::from_secs(600), 1));
        assert_eq!(check(&mut slot, &"c0de".repeat(8), now), Check::Ok);
        assert!(slot.is_none());
        assert_eq!(check(&mut slot, &"c0de".repeat(8), now), Check::Expired);
    }

    #[test]
    fn a_code_runs_out_after_ten_minutes() {
        let now = Instant::now();
        let mut slot = Some(Pairing::new("c0de".repeat(8), now, Duration::from_secs(600), 1));
        assert_eq!(check(&mut slot, &"c0de".repeat(8), now + Duration::from_secs(600)), Check::Expired);
        assert!(slot.is_none());
    }

    #[test]
    fn five_wrong_tries_end_a_code() {
        let now = Instant::now();
        let code = "c0de".repeat(8);
        let mut slot = Some(Pairing::new(code.clone(), now, Duration::from_secs(600), 1));
        for i in 0..4 {
            assert_eq!(check(&mut slot, &"0".repeat(32), now), Check::Wrong, "try {i}");
            assert!(slot.is_some());
        }
        // A wrong length is just as wrong.
        assert_eq!(check(&mut slot, "c0de", now), Check::Wrong);
        assert!(slot.is_none(), "the fifth wrong try ends it");
        assert_eq!(check(&mut slot, &code, now), Check::Expired, "even the right code is too late now");
    }

    #[test]
    fn codes_compare_whole() {
        assert!(same(b"abcd", b"abcd"));
        assert!(!same(b"abcd", b"abce"));
        assert!(!same(b"abcd", b"abc"));
        assert!(!same(b"", b"a"));
    }
}

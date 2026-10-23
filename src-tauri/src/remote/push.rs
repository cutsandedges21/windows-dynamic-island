// Web Push straight from Island to the phone's Home Screen app: no ntfy, no server of ours.
// Each push is encrypted for the phone (RFC 8291, aes128gcm) and signed for the push service
// with Island's VAPID key (RFC 8292), a P-256 key made once and kept in
// `<data dir>/phone-push.key` (PKCS#8). The phone subscribes with its public half (`remote_vapid`).

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use ring::{aead, agreement, hmac};

use super::store::{b64url, PushSub};
use super::*;

/// Who sends the pushes, as the push services ask (an https URL or a mailto).
const VAPID_SUB: &str = "https://islandphone.vercel.app";
/// A VAPID token is good this long (Apple takes at most a day).
const TOKEN_FOR: u64 = 12 * 3600;
/// How long a push service may keep a push for a phone that is off.
const TTL: &str = "3600";
/// The record size in the header: one record holds the whole push.
const RECORD: u32 = 4096;

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The VAPID key: made once and kept.
pub(super) fn load_or_create_key(file: &Path) -> Result<EcdsaKeyPair, String> {
    let rng = SystemRandom::new();
    if let Ok(bytes) = std::fs::read(file) {
        if let Ok(kp) = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &bytes, &rng) {
            return Ok(kp);
        }
    }
    let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).map_err(|_| "Island couldn't make its push key.".to_string())?;
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(file, doc.as_ref()).map_err(|e| format!("Island can't save its push key: {e}"))?;
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, doc.as_ref(), &rng).map_err(|_| "Island's push key is damaged.".to_string())
}

/// The public half as `pushManager.subscribe({applicationServerKey})` takes it: the uncompressed
/// point, base64url.
pub(super) fn public_key(kp: &EcdsaKeyPair) -> String {
    b64(kp.public_key().as_ref())
}

/// A VAPID token (ES256 JWT) for a push service's origin.
pub(super) fn jwt(kp: &EcdsaKeyPair, aud: &str, exp: u64) -> Result<String, String> {
    let header = b64(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = b64(json!({ "aud": aud, "exp": exp, "sub": VAPID_SUB }).to_string().as_bytes());
    let input = format!("{header}.{claims}");
    let sig = kp.sign(&SystemRandom::new(), input.as_bytes()).map_err(|_| "Island couldn't sign a push.".to_string())?;
    Ok(format!("{input}.{}", b64(sig.as_ref())))
}

fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut ctx = hmac::Context::with_key(&hmac::Key::new(hmac::HMAC_SHA256, key));
    for p in parts {
        ctx.update(p);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(ctx.sign().as_ref());
    out
}

/// HKDF-SHA-256 (RFC 5869) for outputs of one block: extract with `salt`, expand with `info`.
fn hkdf(salt: &[u8], ikm: &[u8], info: &[&[u8]]) -> [u8; 32] {
    let prk = hmac_sha256(salt, &[ikm]);
    let mut parts: Vec<&[u8]> = info.to_vec();
    parts.push(&[1]);
    hmac_sha256(&prk, &parts)
}

/// RFC 8291: `plaintext` encrypted for the phone whose subscription keys are `ua_public` (65
/// bytes) and `auth` (16), with the one-time key `eph` and `salt`. The whole request body.
pub(super) fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8], eph: agreement::EphemeralPrivateKey, salt: &[u8; 16]) -> Result<Vec<u8>, String> {
    let bad = || "That phone's push keys don't work.".to_string();
    let as_public = eph.compute_public_key().map_err(|_| bad())?;
    let as_public = as_public.as_ref().to_vec();
    let ecdh = agreement::agree_ephemeral(eph, &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, ua_public), |s| s.to_vec()).map_err(|_| bad())?;
    let ikm = hkdf(auth, &ecdh, &[b"WebPush: info\0", ua_public, &as_public]);
    let cek = hkdf(salt, &ikm, &[b"Content-Encoding: aes128gcm\0"]);
    let nonce = hkdf(salt, &ikm, &[b"Content-Encoding: nonce\0"]);
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek[..16]).map_err(|_| bad())?);
    let mut record = plaintext.to_vec();
    // The padding delimiter of the last (only) record.
    record.push(2);
    let nonce = aead::Nonce::try_assume_unique_for_key(&nonce[..12]).map_err(|_| bad())?;
    key.seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut record).map_err(|_| bad())?;
    let mut body = Vec::with_capacity(16 + 4 + 1 + as_public.len() + record.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&record);
    Ok(body)
}

/// Push services phones use (Apple's for an iPhone; Google's, Mozilla's and Microsoft's for
/// browsers): a subscription pointing anywhere else is not posted to.
pub(super) fn push_host_ok(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else { return false };
    let Some(host) = url.host_str() else { return false };
    url.scheme() == "https"
        && (host.ends_with(".push.apple.com")
            || host == "fcm.googleapis.com"
            || host == "push.services.mozilla.com"
            || host.ends_with(".push.services.mozilla.com")
            || host.ends_with(".notify.windows.com"))
}

/// `scheme://host[:port]` of a push endpoint: the token's audience.
fn origin(endpoint: &str) -> Option<String> {
    let url = reqwest::Url::parse(endpoint).ok()?;
    Some(url.origin().ascii_serialization())
}

/// What a push carries to the phone's service worker (`tag` and `open` only when given). The
/// island's `tag` is ntfy's emoji code, so `Remote::push` leaves it out: same-kind pushes would
/// replace each other on the phone.
pub(super) fn message(title: &str, body: &str, tag: Option<&str>, open: Option<&str>) -> Vec<u8> {
    let clip = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    let mut m = json!({ "title": clip(title, 200), "body": clip(body, 1000) });
    if let Some(t) = tag.filter(|t| !t.is_empty()) {
        m["tag"] = json!(clip(t, 64));
    }
    if let Some(o) = open.filter(|o| !o.is_empty()) {
        m["open"] = json!(clip(o, 64));
    }
    m.to_string().into_bytes()
}

/// A push ready to post: the endpoint, its headers and body.
pub(super) struct Request {
    pub endpoint: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

pub(super) fn request(kp: &EcdsaKeyPair, sub: &PushSub, message: &[u8], urgent: bool, now_s: u64) -> Result<Request, String> {
    let bad = || "That phone's push subscription is damaged.".to_string();
    let ua_public = b64url(&sub.keys.p256dh).ok_or_else(bad)?;
    let auth = b64url(&sub.keys.auth).ok_or_else(bad)?;
    let aud = origin(&sub.endpoint).ok_or_else(bad)?;
    let rng = SystemRandom::new();
    let eph = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).map_err(|_| bad())?;
    let body = encrypt(&ua_public, &auth, message, eph, &pair::random::<16>()?)?;
    let token = jwt(kp, &aud, now_s + TOKEN_FOR)?;
    let headers = vec![
        ("Authorization", format!("vapid t={token}, k={}", public_key(kp))),
        ("Content-Encoding", "aes128gcm".into()),
        ("Content-Type", "application/octet-stream".into()),
        ("TTL", TTL.into()),
        ("Urgency", if urgent { "high" } else { "normal" }.into()),
    ];
    Ok(Request { endpoint: sub.endpoint.clone(), headers, body })
}

impl Remote {
    fn vapid_key(&self) -> Result<Arc<EcdsaKeyPair>, String> {
        let mut slot = self.vapid.lock().unwrap();
        if let Some(kp) = slot.as_ref() {
            return Ok(kp.clone());
        }
        let kp = Arc::new(load_or_create_key(&self.cfg.dir.join("phone-push.key"))?);
        *slot = Some(kp.clone());
        Ok(kp)
    }

    /// The VAPID public key phones subscribe with.
    pub fn vapid(&self) -> Result<String, String> {
        Ok(public_key(self.vapid_key()?.as_ref()))
    }

    /// A notification to every phone with a push subscription: how many push services took it.
    /// A subscription its service says is gone (404, 410) is dropped.
    pub async fn push(self: &Arc<Self>, title: &str, body: &str, tag: Option<&str>, open: Option<&str>, urgent: bool) -> usize {
        let subs: Vec<(String, PushSub)> = self.store.lock().unwrap().phones().iter().filter_map(|p| p.push.clone().map(|s| (p.id.clone(), s))).collect();
        if subs.is_empty() {
            return 0;
        }
        let kp = match self.vapid_key() {
            Ok(kp) => kp,
            Err(e) => {
                crate::log::line(format!("remote: {e}"));
                return 0;
            }
        };
        let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent(concat!("Island/", env!("CARGO_PKG_VERSION"))).build() else { return 0 };
        // `tag` is ntfy's emoji code: not a notification tag (see `message`).
        let _ = tag;
        let msg = message(title, body, None, open);
        let now_s = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let mut posts = tokio::task::JoinSet::new();
        for (id, sub) in subs {
            if !push_host_ok(&sub.endpoint) {
                continue;
            }
            let req = match request(&kp, &sub, &msg, urgent, now_s) {
                Ok(r) => r,
                Err(e) => {
                    crate::log::line(format!("remote: push not sent: {e}"));
                    continue;
                }
            };
            let client = client.clone();
            posts.spawn(async move {
                let mut post = client.post(&req.endpoint).body(req.body);
                for (k, v) in req.headers {
                    post = post.header(k, v);
                }
                (id, sub.endpoint, post.send().await.map(|r| r.status().as_u16()))
            });
        }
        let mut taken = 0;
        let mut gone = Vec::new();
        while let Some(Ok((id, endpoint, status))) = posts.join_next().await {
            match status {
                Ok(s) if (200..300).contains(&s) => taken += 1,
                Ok(404 | 410) => gone.push((id, endpoint)),
                Ok(s) => crate::log::line(format!("remote: a push service said {s}")),
                Err(e) => crate::log::line(format!("remote: push failed: {e}")),
            }
        }
        if !gone.is_empty() {
            {
                let mut store = self.store.lock().unwrap();
                for (id, endpoint) in &gone {
                    // Only if the phone hasn't subscribed anew meanwhile.
                    if store.get(id).and_then(|p| p.push.as_ref()).is_some_and(|s| &s.endpoint == endpoint) {
                        store.set_push(id, None);
                    }
                }
                self.save(&store);
            }
            crate::log::line(format!("remote: {} push subscriptions ended", gone.len()));
            self.emit_phones();
        }
        taken
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};

    fn d(s: &str) -> Vec<u8> {
        b64url(&s.replace([' ', '\n'], "")).unwrap()
    }

    /// An ephemeral key from fixed bytes (ring makes them only from its random source).
    #[allow(deprecated)]
    fn fixed_key(private: &[u8]) -> agreement::EphemeralPrivateKey {
        agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &ring::test::rand::FixedSliceRandom { bytes: private }).unwrap()
    }

    #[test]
    fn rfc_8291_section_5_example() {
        let as_private = d("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
        let ua_public = d("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = d("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = d("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt(&ua_public, &auth, b"When I grow up, I want to be a watermelon", fixed_key(&as_private), &salt).unwrap();
        let expected = d("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
        assert_eq!(body, expected);
    }

    fn key() -> EcdsaKeyPair {
        let rng = SystemRandom::new();
        let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, doc.as_ref(), &rng).unwrap()
    }

    #[test]
    fn a_vapid_token_verifies_with_the_public_key() {
        let kp = key();
        let token = jwt(&kp, "https://web.push.apple.com", 1_800_000_000).unwrap();
        let (input, sig) = token.rsplit_once('.').unwrap();
        let public = b64url(&public_key(&kp)).unwrap();
        assert_eq!((public.len(), public[0]), (65, 4), "uncompressed point");
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public).verify(input.as_bytes(), &b64url(sig).unwrap()).unwrap();
        let (header, claims) = input.split_once('.').unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&b64url(header).unwrap()).unwrap(), json!({ "typ": "JWT", "alg": "ES256" }));
        assert_eq!(serde_json::from_slice::<Value>(&b64url(claims).unwrap()).unwrap(), json!({ "aud": "https://web.push.apple.com", "exp": 1_800_000_000u64, "sub": "https://islandphone.vercel.app" }));
    }

    #[test]
    fn the_vapid_key_is_made_once_and_kept() {
        let dir = std::env::temp_dir().join(format!("island-remote-vapid-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("phone-push.key");
        let a = public_key(&load_or_create_key(&file).unwrap());
        let b = public_key(&load_or_create_key(&file).unwrap());
        assert_eq!(a, b);
        assert_eq!(a.len(), 87);
    }

    /// The phone's side of RFC 8291, for a round trip.
    fn decrypt(ua: agreement::EphemeralPrivateKey, ua_public: &[u8], auth: &[u8], body: &[u8]) -> Vec<u8> {
        let (salt, rest) = body.split_at(16);
        assert_eq!(u32::from_be_bytes(rest[..4].try_into().unwrap()), RECORD);
        let n = rest[4] as usize;
        let (as_public, record) = rest[5..].split_at(n);
        let ecdh = agreement::agree_ephemeral(ua, &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, as_public), |s| s.to_vec()).unwrap();
        let ikm = hkdf(auth, &ecdh, &[b"WebPush: info\0", ua_public, as_public]);
        let cek = hkdf(salt, &ikm, &[b"Content-Encoding: aes128gcm\0"]);
        let nonce = hkdf(salt, &ikm, &[b"Content-Encoding: nonce\0"]);
        let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek[..16]).unwrap());
        let mut data = record.to_vec();
        let plain = key.open_in_place(aead::Nonce::try_assume_unique_for_key(&nonce[..12]).unwrap(), aead::Aad::empty(), &mut data).unwrap();
        assert_eq!(plain.last(), Some(&2));
        plain[..plain.len() - 1].to_vec()
    }

    #[test]
    fn a_push_request_carries_what_the_phone_and_its_push_service_need() {
        let kp = key();
        let rng = SystemRandom::new();
        let ua = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let ua_public = ua.compute_public_key().unwrap().as_ref().to_vec();
        let auth = pair::random::<16>().unwrap();
        let sub = PushSub { endpoint: "https://web.push.apple.com/QGv2/abc".into(), keys: store::PushKeys { p256dh: b64(&ua_public), auth: b64(&auth) } };
        let msg = message("Claude needs you", "Allow npm test?", Some("claude"), None);
        let req = request(&kp, &sub, &msg, true, 1_000).unwrap();
        assert_eq!(req.endpoint, sub.endpoint);
        let h = |k: &str| req.headers.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()).unwrap();
        assert_eq!((h("Content-Encoding"), h("TTL"), h("Urgency")), ("aes128gcm".into(), "3600".into(), "high".into()));
        let auth_header = h("Authorization");
        assert!(auth_header.starts_with("vapid t=") && auth_header.ends_with(&format!(", k={}", public_key(&kp))), "{auth_header}");
        let token = auth_header.trim_start_matches("vapid t=").split(',').next().unwrap();
        let claims: Value = serde_json::from_slice(&b64url(token.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!((claims["aud"].as_str(), claims["exp"].as_u64()), (Some("https://web.push.apple.com"), Some(1_000 + 12 * 3600)));
        let plain = decrypt(ua, &ua_public, &auth, &req.body);
        assert_eq!(serde_json::from_slice::<Value>(&plain).unwrap(), json!({ "title": "Claude needs you", "body": "Allow npm test?", "tag": "claude" }));
        assert!(req.body.len() <= RECORD as usize + 86);
    }

    #[test]
    fn pushes_go_only_to_push_services() {
        assert!(push_host_ok("https://web.push.apple.com/QGv2/abc"));
        assert!(push_host_ok("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(push_host_ok("https://updates.push.services.mozilla.com/wpush/v2/abc"));
        assert!(push_host_ok("https://wns2-bl2p.notify.windows.com/w/?token=abc"));
        assert!(!push_host_ok("https://192.168.1.1/admin"));
        assert!(!push_host_ok("https://evil.example/web.push.apple.com"));
        assert!(!push_host_ok("http://web.push.apple.com/abc"));
        assert!(!push_host_ok("https://push.apple.com.evil.example/"));
    }

    #[test]
    fn long_pushes_are_cut_to_fit_one_record() {
        let m = message(&"t".repeat(500), &"é".repeat(5000), Some(""), Some("claude"));
        let v: Value = serde_json::from_slice(&m).unwrap();
        assert_eq!(v["title"].as_str().unwrap().len(), 200);
        assert!(v.get("tag").is_none());
        assert_eq!(v["open"], "claude");
        // Plaintext + delimiter + tag + header within the 4096-byte record.
        assert!(m.len() + 1 + 16 <= RECORD as usize);
    }
}

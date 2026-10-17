// Land to any phone: what was dropped (or a note or a link) is served on this network at a
// random address the island shows as a QR code. The phone's camera opens it in the browser:
// no app, any phone. Only devices on this computer's own networks get an answer, the address
// is unguessable and works for 15 minutes (or until Stop), and it serves only what was shared.
// Plain HTTP, as the phone's browser has no way to trust a certificate made here: anyone on the
// same Wi-Fi who watches the traffic could see what goes to the phone.

use std::sync::atomic::AtomicUsize;

use tauri::Emitter;

use super::*;

/// How long a share works.
pub const SHARE_FOR: Duration = Duration::from_secs(15 * 60);
/// A request's line and headers; more is not a phone asking for a file.
const MAX_HEAD: usize = 8 * 1024;
/// How long a phone gets to say what it wants.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const COPY_CHUNK: usize = 64 * 1024;

/// What is shared, and the address it is at.
pub(crate) struct Sharing {
    token: String,
    items: Vec<Item>,
    text: Option<String>,
    from: String,
    nets: Vec<Net>,
    stop: watch::Sender<bool>,
    /// Files a phone opened from the start (a video's later pieces are not counted again).
    opened: AtomicUsize,
    emit: Emit,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub url: String,
    /// The QR code for `url`: `size` modules a side, row by row, '1' for dark.
    pub qr: String,
    pub size: usize,
    /// When it stops working (ms since 1970).
    pub expires: u64,
    pub count: usize,
    pub bytes: u64,
}

/// 128 random bits, from the system's secure source (a Noise key is exactly that).
fn token() -> Result<String, String> {
    let kp = snow::Builder::new(noise_params()).generate_keypair().map_err(|e| e.to_string())?;
    Ok(kp.private[..16].iter().map(|b| format!("{b:02x}")).collect())
}

/// The address a phone on the same Wi-Fi reaches this computer at: the one the computer uses
/// for the internet when it is a private one, else the first private one.
fn share_ip(nets: &[Net]) -> Option<Ipv4Addr> {
    let ok = |n: &&Net| (8..=30).contains(&n.prefix) && n.ip.is_private();
    let candidates: Vec<Ipv4Addr> = nets.iter().filter(ok).map(|n| n.ip).collect();
    // Connecting a UDP socket sends nothing; it only picks the way out.
    let routed = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|s| s.connect((Ipv4Addr::new(1, 1, 1, 1), 80)).map(|_| s))
        .and_then(|s| s.local_addr())
        .ok()
        .and_then(|a| match a.ip() {
            IpAddr::V4(v4) => Some(v4),
            IpAddr::V6(_) => None,
        });
    routed.filter(|ip| candidates.contains(ip)).or_else(|| candidates.first().copied())
}

/// The QR code of `text`: its side, and its modules row by row ('1' dark).
pub(super) fn qr(text: &str) -> Result<(usize, String), String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    let cells = code.to_colors().into_iter().map(|c| if c == qrcode::Color::Dark { '1' } else { '0' }).collect();
    Ok((code.width(), cells))
}

/// `name` for a URL path: letters, digits and -._~ as they are, the rest %XX.
pub(super) fn pct(name: &str) -> String {
    name.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub(super) fn html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// What the phone's browser is told a file is. Anything that could run in the page (HTML,
/// SVG, scripts) only ever downloads.
fn mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" | "log" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// A `Range: bytes=a-b` header for a file of `len` bytes: the first and last byte asked for.
pub(super) fn byte_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (a, "") => (a.parse().ok()?, len - 1),
        (a, b) => (a.parse().ok()?, b.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

impl Sharing {
    /// The page the phone opens: what was shared, a tap away.
    fn page(&self) -> String {
        let total: u64 = self.items.iter().map(|i| i.size).sum();
        let mut list = String::new();
        for (i, item) in self.items.iter().enumerate() {
            let href = format!("/{}/f/{i}/{}", self.token, pct(item.name.rsplit('/').next().unwrap_or("file")));
            list.push_str(&format!(
                "<li><a class=\"name\" href=\"{href}\">{}</a><span class=\"size\">{}</span><a class=\"save\" href=\"{href}?dl=1\" download>Save</a></li>",
                html(&item.name),
                human(item.size)
            ));
        }
        let mut body = String::new();
        if let Some(text) = &self.text {
            let link = text.trim();
            let open = if (link.starts_with("https://") || link.starts_with("http://")) && !link.contains(char::is_whitespace) {
                format!("<a class=\"open\" href=\"{}\">Open link</a>", html(link))
            } else {
                String::new()
            };
            body.push_str(&format!("<pre>{}</pre>{open}<p class=\"hint\">Press and hold the text to copy it.</p>", html(text)));
        }
        if !self.items.is_empty() {
            body.push_str(&format!("<ul>{list}</ul>"));
        }
        let what = if self.items.is_empty() {
            "A note".to_string()
        } else if self.items.len() == 1 {
            human(total)
        } else {
            format!("{} files · {}", self.items.len(), human(total))
        };
        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>From {from}</title><style>{CSS}</style></head><body><h1>From {from}</h1><p class=\"sub\">{what} · sent with Island</p>{body}<p class=\"foot\">This page works for 15 minutes, on this Wi-Fi only.</p></body></html>",
            from = html(&self.from)
        )
    }

    async fn answer(self: Arc<Self>, mut sock: TcpStream) {
        let _ = sock.set_nodelay(true);
        let Ok(Ok(Some((method, path, range)))) = timeout(HEAD_TIMEOUT, read_head(&mut sock)).await else { return };
        let head = method == "HEAD";
        if method != "GET" && !head {
            let _ = respond(&mut sock, "405 Method Not Allowed", "text/plain", b"", head).await;
            return;
        }
        let (path, query) = path.split_once('?').unwrap_or((&path, ""));
        let mut parts = path.trim_start_matches('/').splitn(4, '/');
        if parts.next() != Some(self.token.as_str()) {
            let _ = respond(&mut sock, "404 Not Found", "text/plain", b"Not here.", head).await;
            return;
        }
        match (parts.next(), parts.next()) {
            (None, _) | (Some(""), _) => {
                let _ = respond(&mut sock, "200 OK", "text/html; charset=utf-8", self.page().as_bytes(), head).await;
            }
            (Some("f"), Some(i)) => match i.parse::<usize>().ok().and_then(|i| self.items.get(i)) {
                Some(item) => self.file(&mut sock, item, range.as_deref(), query.split('&').any(|q| q == "dl=1"), head).await,
                None => {
                    let _ = respond(&mut sock, "404 Not Found", "text/plain", b"Not here.", head).await;
                }
            },
            _ => {
                let _ = respond(&mut sock, "404 Not Found", "text/plain", b"Not here.", head).await;
            }
        }
    }

    /// One shared file, whole or the piece asked for (a phone playing a video asks in pieces).
    async fn file(&self, sock: &mut TcpStream, item: &Item, range: Option<&str>, download: bool, head: bool) {
        let Ok(mut file) = tokio::fs::File::open(&item.path).await else {
            let _ = respond(sock, "410 Gone", "text/plain", b"That file is gone from the computer.", head).await;
            return;
        };
        let len = file.metadata().await.map(|m| m.len()).unwrap_or(0);
        let part = range.and_then(|r| byte_range(r, len));
        let (start, end) = part.unwrap_or((0, len.saturating_sub(1)));
        let count = if len == 0 { 0 } else { end - start + 1 };
        let name = item.name.rsplit('/').next().unwrap_or("file");
        let ascii: String = name.chars().map(|c| if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' { c } else { '_' }).collect();
        let kind = mime(name);
        let disposition = if download || kind == "application/octet-stream" { "attachment" } else { "inline" };
        let mut headers = format!(
            "HTTP/1.1 {}\r\nContent-Type: {kind}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nContent-Disposition: {disposition}; filename=\"{ascii}\"; filename*=UTF-8''{}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n",
            if part.is_some() { "206 Partial Content" } else { "200 OK" },
            pct(name)
        );
        if part.is_some() {
            headers.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
        }
        headers.push_str("\r\n");
        if timeout(IO_TIMEOUT, sock.write_all(headers.as_bytes())).await.map_or(true, |r| r.is_err()) || head {
            return;
        }
        if start == 0 && !head {
            let n = self.opened.fetch_add(1, Ordering::Relaxed) + 1;
            (self.emit)("land-share", json!({ "state": "opened", "name": name, "opened": n }));
        }
        if start > 0 && file.seek(io::SeekFrom::Start(start)).await.is_err() {
            return;
        }
        let mut left = count;
        let mut buf = vec![0u8; COPY_CHUNK];
        while left > 0 {
            let want = (left as usize).min(COPY_CHUNK);
            let Ok(n) = file.read(&mut buf[..want]).await else { return };
            if n == 0 {
                return;
            }
            if timeout(IO_TIMEOUT, sock.write_all(&buf[..n])).await.map_or(true, |r| r.is_err()) {
                return;
            }
            left -= n as u64;
        }
        let _ = sock.flush().await;
    }
}

/// "2.1 MB": sizes on the phone's page.
fn human(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1000 {
        return format!("{bytes} bytes");
    }
    let mut v = bytes as f64 / 1000.0;
    let mut u = 0;
    while v >= 1000.0 && u < UNITS.len() - 1 {
        v /= 1000.0;
        u += 1;
    }
    format!("{} {}", if v < 10.0 { format!("{v:.1}") } else { format!("{v:.0}") }, UNITS[u])
}

/// The request line and the Range header, read up to the blank line.
async fn read_head(sock: &mut TcpStream) -> io::Result<Option<(String, String, Option<String>)>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = sock.read(&mut chunk).await?;
        if n == 0 || buf.len() + n > MAX_HEAD {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (Some(method), Some(path)) = (first.next(), first.next()) else { return Ok(None) };
    let range = lines.find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("range")).map(|(_, v)| v.trim().to_string()));
    Ok(Some((method.to_string(), path.to_string(), range)))
}

async fn respond(sock: &mut TcpStream, status: &str, kind: &str, body: &[u8], head: bool) -> io::Result<()> {
    let headers = format!("HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
    timeout(IO_TIMEOUT, async {
        sock.write_all(headers.as_bytes()).await?;
        if !head {
            sock.write_all(body).await?;
        }
        sock.flush().await
    })
    .await
    .map_err(|_| io::Error::other("timed out"))?
}

/// Answers phones on this network until the share runs out or is stopped.
async fn serve(sharing: Arc<Sharing>, listener: TcpListener, until: Duration) {
    let mut stop = sharing.stop.subscribe();
    let end = tokio::time::sleep(until);
    tokio::pin!(end);
    loop {
        tokio::select! {
            _ = &mut end => break,
            _ = cancelled(&mut stop) => break,
            r = listener.accept() => {
                let Ok((sock, from)) = r else { continue };
                // Only this computer's own networks: nothing from beyond a router.
                if !is_local(from.ip(), &sharing.nets) {
                    continue;
                }
                tokio::spawn(sharing.clone().answer(sock));
            }
        }
    }
    (sharing.emit)("land-share", json!({ "state": "ended" }));
    crate::log::line("land: phone share ended");
}

/// Starts sharing `paths` (or `text`) at a new address: the old share, if any, stops. `ip` is
/// where phones reach this computer (tests use 127.0.0.1).
pub(super) async fn start_share(paths: &[PathBuf], text: Option<String>, from: &str, ip: Option<Ipv4Addr>, emit: Emit, until: Duration) -> Result<(Arc<Sharing>, ShareInfo), String> {
    let text = match text {
        Some(t) => Some(clean_text(&t).ok_or_else(|| format!("Nothing to share, or more than {MAX_TEXT} characters."))?),
        None => None,
    };
    let owned = paths.to_vec();
    let items = tokio::task::spawn_blocking(move || collect(&owned)).await.map_err(|e| e.to_string())??;
    if items.is_empty() && text.is_none() {
        return Err("Nothing to share: the folders are empty.".into());
    }
    let nets = networks();
    let ip = ip.or_else(|| share_ip(&nets)).ok_or_else(|| "This computer isn't on a network a phone can reach (no Wi-Fi or Ethernet address).".to_string())?;
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).await.map_err(|e| format!("Couldn't open a port for the phone: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = token()?;
    let url = format!("http://{ip}:{port}/{token}/");
    let (size, cells) = qr(&url)?;
    let (stop, _) = watch::channel(false);
    let bytes = items.iter().map(|i| i.size).sum();
    let count = items.len();
    let sharing = Arc::new(Sharing { token, items, text, from: from.to_string(), nets, stop, opened: AtomicUsize::new(0), emit });
    tokio::spawn(serve(sharing.clone(), listener, until));
    crate::log::line(format!("land: sharing {count} files with a phone on {ip}:{port}"));
    let expires = now_ms() + until.as_millis() as u64;
    Ok((sharing, ShareInfo { url, qr: cells, size, expires, count, bytes }))
}

impl Sharing {
    pub(crate) fn stop(&self) {
        self.stop.send_replace(true);
    }
}

// ------------------------------------------------------------------ commands

#[derive(Default)]
pub struct ShareState {
    now: tokio::sync::Mutex<Option<Arc<Sharing>>>,
}

/// Shares dropped files (or text) with a phone on this network: the address and its QR code.
#[tauri::command]
pub async fn land_share_start(app: tauri::AppHandle, state: tauri::State<'_, ShareState>, paths: Vec<String>, text: Option<String>) -> Result<ShareInfo, String> {
    let emit: Emit = Arc::new(move |event: &str, payload: Value| {
        let _ = app.emit_to(crate::overlay::LABEL, event, payload);
    });
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let mut slot = state.now.lock().await;
    if let Some(old) = slot.take() {
        old.stop();
    }
    let (sharing, info) = start_share(&paths, text, &computer_name(), None, emit, SHARE_FOR).await?;
    *slot = Some(sharing);
    Ok(info)
}

#[tauri::command]
pub async fn land_share_stop(state: tauri::State<'_, ShareState>) -> Result<(), String> {
    if let Some(old) = state.now.lock().await.take() {
        old.stop();
    }
    Ok(())
}

/// The phone page's look: dark, big tap targets.
const CSS: &str = "body{font:16px/1.45 -apple-system,system-ui,sans-serif;margin:0;padding:24px 18px 40px;background:#0f1115;color:#f2f3f5}h1{font-size:22px;margin:0 0 4px}.sub,.foot,.hint{color:#9aa0aa;font-size:14px;margin:0 0 18px}.foot{margin-top:28px}ul{list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #23262d}.name{flex:1;color:#f2f3f5;text-decoration:none;word-break:break-word}.size{color:#9aa0aa;font-size:13px;white-space:nowrap}.save,.open{background:#3b82f6;color:#fff;text-decoration:none;border-radius:10px;padding:8px 14px;font-weight:600;white-space:nowrap}.open{display:inline-block;margin:4px 0 8px}pre{white-space:pre-wrap;word-break:break-word;background:#181b21;border-radius:12px;padding:14px;font:15px/1.45 -apple-system,system-ui,sans-serif;margin:0 0 12px;-webkit-user-select:text;user-select:text}";

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_read_the_way_browsers_send_them() {
        assert_eq!(byte_range("bytes=0-1", 100), Some((0, 1)));
        assert_eq!(byte_range("bytes=10-", 100), Some((10, 99)));
        assert_eq!(byte_range("bytes=-30", 100), Some((70, 99)));
        assert_eq!(byte_range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(byte_range("bytes=100-", 100), None, "past the end");
        assert_eq!(byte_range("bytes=0-1,5-6", 100), None, "several pieces: the whole file instead");
        assert_eq!(byte_range("items=0-1", 100), None);
    }

    #[test]
    fn names_are_safe_in_links_and_pages() {
        assert_eq!(pct("a b/é.jpg"), "a%20b%2F%C3%A9.jpg");
        assert_eq!(html("<b>\"Tom's\" & co</b>"), "&lt;b&gt;&quot;Tom&#39;s&quot; &amp; co&lt;/b&gt;");
        assert_eq!(mime("Photo.JPG"), "image/jpeg");
        assert_eq!(mime("page.html"), "application/octet-stream", "nothing that runs in the page opens in it");
        assert_eq!(human(2_100_000), "2.1 MB");
    }

    #[test]
    fn the_qr_code_is_square_and_has_its_finder_corners() {
        let (size, cells) = qr("http://192.168.1.20:51234/0123456789abcdef0123456789abcdef/").unwrap();
        assert_eq!(cells.len(), size * size);
        assert!(size >= 21);
        // The top-left finder pattern's top row: seven dark modules.
        assert_eq!(&cells[..7], "1111111");
    }

    async fn get(addr: SocketAddr, path: &str, extra: &str) -> (String, Vec<u8>) {
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n{extra}\r\n").as_bytes()).await.unwrap();
        let mut all = Vec::new();
        s.read_to_end(&mut all).await.unwrap();
        let at = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&all[..at]).to_string(), all[at + 4..].to_vec())
    }

    #[tokio::test]
    async fn a_phone_on_the_network_gets_the_page_and_the_files_and_nobody_else_does() {
        let dir = std::env::temp_dir().join(format!("island-share-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let data: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("clip & 'one'.mp4"), &data).unwrap();
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = events.clone();
        let emit: Emit = Arc::new(move |_e: &str, v: Value| sink.lock().unwrap().push(v));
        let (sharing, info) = start_share(&[dir.join("clip & 'one'.mp4")], Some("https://example.com".into()), "Moss <PC>", Some(Ipv4Addr::LOCALHOST), emit, Duration::from_secs(30)).await.unwrap();
        assert!(info.url.starts_with("http://127.0.0.1:") && info.url.ends_with('/'));
        assert_eq!((info.count, info.bytes), (1, 200_000));
        let url = info.url.trim_start_matches("http://");
        let (host, path) = url.split_once('/').unwrap();
        let addr: SocketAddr = host.parse().unwrap();
        let token = path.trim_end_matches('/');

        let (head, page) = get(addr, &format!("/{token}/"), "").await;
        assert!(head.starts_with("HTTP/1.1 200"));
        let page = String::from_utf8(page).unwrap();
        assert!(page.contains("From Moss &lt;PC&gt;"));
        assert!(page.contains("clip &amp; &#39;one&#39;.mp4"));
        assert!(page.contains(&format!("/{token}/f/0/clip%20%26%20%27one%27.mp4")));
        assert!(page.contains("Open link"));

        let (head, body) = get(addr, &format!("/{token}/f/0/clip.mp4"), "").await;
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(head.contains("Content-Type: video/mp4"));
        assert_eq!(body, data);
        let (head, body) = get(addr, &format!("/{token}/f/0/clip.mp4?dl=1"), "Range: bytes=1000-1999\r\n").await;
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 1000-1999/200000"));
        assert!(head.contains("attachment"));
        assert_eq!(body, data[1000..2000]);
        // The first read counts as opened; the piece does not.
        assert_eq!(events.lock().unwrap().iter().filter(|v| v["state"] == "opened").count(), 1);

        // A wrong token, another file, anything else: nothing.
        assert!(get(addr, "/0123456789abcdef0123456789abcdef/", "").await.0.starts_with("HTTP/1.1 404"));
        assert!(get(addr, &format!("/{token}/f/1/x"), "").await.0.starts_with("HTTP/1.1 404"));
        assert!(get(addr, "/", "").await.0.starts_with("HTTP/1.1 404"));

        sharing.stop();
        for _ in 0..100 {
            if events.lock().unwrap().iter().any(|v| v["state"] == "ended") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(events.lock().unwrap().iter().any(|v| v["state"] == "ended"));
        assert!(TcpStream::connect(addr).await.is_err(), "the port is closed once it stops");
        let _ = std::fs::remove_dir_all(dir);
    }
}

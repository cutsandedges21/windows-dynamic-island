// Files between a phone and the PC, each on a bidirectional stream of its own: a header line
// `{"t":"file","id","name","size","mime"}`, exactly `size` bytes, then the sender finishes its
// side, and the receiver answers one line: `{"t":"file-ok","id","name"}` (the name it was saved
// under) or `{"t":"file-error","id","error"}`. Files from a phone go to Downloads under Land's
// rules: a safe name, never over a file that is there ("name (1).jpg"), the "from another
// computer" mark.

use std::path::{Path, PathBuf};

use iroh::endpoint::{Connection, RecvStream, SendStream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::lines::LineReader;
use super::*;
use crate::land::share::{clean_component, create_temp, free_space, mark_from_network, mime, place};

/// Largest file a phone sends to the PC.
pub const MAX_UPLOAD: u64 = 2 * 1024 * 1024 * 1024;
/// Largest file the PC sends to a phone (the phone holds it in memory).
pub const MAX_DOWNLOAD: u64 = 200 * 1024 * 1024;
/// A header, or an answer, is one short line.
const MAX_HEADER: usize = 64 * 1024;
const HEADER_WITHIN: Duration = Duration::from_secs(10);
/// A file stream that goes quiet this long has stalled.
const IDLE: Duration = Duration::from_secs(30);
/// After the last byte, the sender finishing its side is waited for this long.
const FINISH_WITHIN: Duration = Duration::from_secs(2);
/// How long a phone gets to answer once all of a file is sent (it may ask its user first).
const ANSWER_WITHIN: Duration = Duration::from_secs(120);
/// Room left on the disk after a file from a phone.
const SPARE: u64 = 64 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Header {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

pub(super) fn read_header(line: &[u8]) -> Option<Header> {
    let v: Value = serde_json::from_slice(line).ok()?;
    if v["t"] != "file" {
        return None;
    }
    let id = v["id"].as_str().filter(|id| !id.is_empty() && id.len() <= 100)?;
    let name = v["name"].as_str().filter(|n| n.len() <= 1000)?;
    let size = v["size"].as_u64()?;
    let mime: String = v["mime"].as_str().unwrap_or("application/octet-stream").chars().filter(|c| !c.is_control()).take(200).collect();
    Some(Header { id: id.into(), name: name.into(), size, mime })
}

/// A temp file removed unless it was kept.
struct Temp(Option<PathBuf>);

impl Drop for Temp {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

fn dropped() -> String {
    "The connection to the phone dropped.".into()
}

/// `size` bytes from `first` and then `recv` into `file`, and the sender's end after them.
async fn copy_in(first: &[u8], recv: &mut RecvStream, file: &mut tokio::fs::File, size: u64) -> Result<(), String> {
    let disk = |_| "Island couldn't write the file to Downloads.".to_string();
    let more = || "The phone sent more than it said it would.".to_string();
    if first.len() as u64 > size {
        return Err(more());
    }
    file.write_all(first).await.map_err(disk)?;
    let mut got = first.len() as u64;
    while got < size {
        match timeout(IDLE, recv.read_chunk(CHUNK)).await {
            Ok(Ok(Some(chunk))) => {
                if got + chunk.len() as u64 > size {
                    return Err(more());
                }
                file.write_all(&chunk).await.map_err(disk)?;
                got += chunk.len() as u64;
            }
            Ok(Ok(None)) => return Err("The phone stopped sending before the end of the file.".into()),
            _ => return Err(dropped()),
        }
    }
    file.flush().await.map_err(disk)?;
    // The phone finishes its side now (a phone that doesn't is not held to it).
    if let Ok(Ok(Some(_))) = timeout(FINISH_WITHIN, recv.read_chunk(1)).await {
        return Err(more());
    }
    Ok(())
}

impl Remote {
    fn downloads(&self) -> PathBuf {
        self.cfg.downloads.clone().unwrap_or_else(crate::land::share::downloads_dir)
    }

    /// Every stream a phone opens after its control stream is a file or a terminal (terms.rs).
    /// Ends with the connection.
    pub(super) async fn file_streams(self: Arc<Self>, phone: String, conn: Connection) {
        while let Ok((send, recv)) = conn.accept_bi().await {
            tokio::spawn(self.clone().receive(phone.clone(), send, recv));
        }
    }

    async fn receive(self: Arc<Self>, phone: String, mut send: SendStream, recv: RecvStream) {
        let mut reader = LineReader::new(recv, MAX_HEADER);
        let Ok(Ok(Some(head))) = timeout(HEADER_WITHIN, reader.next_line()).await else { return };
        if super::terms::is_term(&head) {
            return self.term_stream(phone, send, reader, head).await;
        }
        let Some(h) = read_header(&head) else { return };
        let saved = self.save_file(&h, reader).await;
        let reply = match &saved {
            Ok((name, _)) => json!({ "t": "file-ok", "id": h.id, "name": name }),
            Err(e) => json!({ "t": "file-error", "id": h.id, "error": e }),
        };
        if send.write_all(&line(&reply)).await.is_ok() {
            let _ = send.finish();
            let _ = timeout(FINISH_WITHIN, send.stopped()).await;
        }
        match saved {
            Ok((name, path)) => {
                crate::log::line(format!("remote: a file from a phone ({} bytes) is in Downloads", h.size));
                (self.emit)("remote-file", json!({ "phone": phone, "id": h.id, "name": name, "path": path.to_string_lossy(), "size": h.size, "mime": h.mime }));
            }
            Err(e) => crate::log::line(format!("remote: a file from a phone failed: {e}")),
        }
    }

    /// Saves a file's bytes in Downloads: its name there, and where it is.
    async fn save_file(&self, h: &Header, reader: LineReader) -> Result<(String, PathBuf), String> {
        if h.size > MAX_UPLOAD {
            return Err("That file is bigger than 2 GB, too big to send to the PC.".into());
        }
        let dir = self.downloads();
        tokio::fs::create_dir_all(&dir).await.map_err(|_| "Island can't write to Downloads.".to_string())?;
        if free_space(&dir).is_some_and(|free| free < h.size.saturating_add(SPARE)) {
            return Err("There isn't room for that file on the PC.".into());
        }
        let name = clean_component(&h.name).unwrap_or_else(|| "file".into());
        let (temp, mut file) = create_temp(&dir, &name).await.map_err(|_| "Island can't write to Downloads.".to_string())?;
        let mut guard = Temp(Some(temp.clone()));
        let (mut recv, first) = reader.into_parts();
        let copied = copy_in(&first, &mut recv, &mut file, h.size).await;
        // Closed before it is named (or removed).
        drop(file);
        copied?;
        let path = place(&temp, &dir, &name).map_err(|e| format!("Couldn't save {name}: {e}"))?;
        guard.0 = None;
        mark_from_network(&path);
        let saved = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
        Ok((saved, path))
    }

    /// Sends a file to a connected phone: the name the phone kept it under.
    pub async fn send_file(self: &Arc<Self>, phone: &str, path: &Path) -> Result<String, String> {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "file".into());
        let sent = self.send_file_to(phone, path, &name).await;
        let event = match &sent {
            Ok(_) => json!({ "phone": phone, "name": name, "ok": true }),
            Err(e) => json!({ "phone": phone, "name": name, "ok": false, "error": e }),
        };
        (self.emit)("remote-file-sent", event);
        sent
    }

    async fn send_file_to(&self, phone: &str, path: &Path, name: &str) -> Result<String, String> {
        let session = self.sessions.lock().unwrap().get(phone).cloned().ok_or_else(|| "That phone isn't connected right now. Open Island on it first.".to_string())?;
        let meta = tokio::fs::metadata(path).await.map_err(|_| format!("{name} is gone."))?;
        if !meta.is_file() {
            return Err("Only files go to a phone, not folders.".into());
        }
        let size = meta.len();
        if size > MAX_DOWNLOAD {
            return Err(format!("{name} is bigger than 200 MB, too big for a phone."));
        }
        let mut file = tokio::fs::File::open(path).await.map_err(|_| format!("Island can't open {name}."))?;
        let id = pair::hex(&pair::random::<8>()?);
        let (mut send, recv) = session.conn.open_bi().await.map_err(|_| dropped())?;
        let header = line(&json!({ "t": "file", "id": id, "name": name, "size": size, "mime": mime(name) }));
        send.write_all(&header).await.map_err(|_| dropped())?;
        let mut buf = vec![0u8; CHUNK];
        let mut left = size;
        while left > 0 {
            let want = (left as usize).min(CHUNK);
            let n = file.read(&mut buf[..want]).await.map_err(|_| format!("Island can't read {name}."))?;
            if n == 0 {
                return Err(format!("{name} got shorter while it was sent."));
            }
            match timeout(IDLE, send.write_all(&buf[..n])).await {
                Ok(Ok(())) => {}
                _ => return Err(dropped()),
            }
            left -= n as u64;
        }
        send.finish().map_err(|_| dropped())?;
        let mut answer = LineReader::new(recv, MAX_HEADER);
        let reply = match timeout(ANSWER_WITHIN, answer.next_line()).await {
            Ok(Ok(Some(l))) => serde_json::from_slice::<Value>(&l).unwrap_or(Value::Null),
            Ok(_) => return Err(dropped()),
            Err(_) => return Err("The phone didn't answer.".into()),
        };
        match reply["t"].as_str() {
            Some("file-ok") => Ok(reply["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(name).to_string()),
            Some("file-error") => Err(reply["error"].as_str().filter(|e| !e.is_empty()).unwrap_or("The phone couldn't take the file.").to_string()),
            _ => Err("The phone answered something Island doesn't understand.".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_are_checked() {
        let h = read_header(br#"{"t":"file","id":"a1","name":"IMG_0001.JPG","size":5,"mime":"image/jpeg"}"#).unwrap();
        assert_eq!(h, Header { id: "a1".into(), name: "IMG_0001.JPG".into(), size: 5, mime: "image/jpeg".into() });
        assert_eq!(read_header(br#"{"t":"file","id":"a1","name":"x","size":5}"#).unwrap().mime, "application/octet-stream");
        assert!(read_header(br#"{"t":"file","id":"","name":"x","size":5}"#).is_none());
        assert!(read_header(br#"{"t":"file","id":"a","name":"x","size":-1}"#).is_none());
        assert!(read_header(br#"{"t":"file","id":"a","size":1}"#).is_none());
        assert!(read_header(br#"{"t":"text","id":"a","name":"x","size":1}"#).is_none());
        assert!(read_header(b"not json").is_none());
    }
}

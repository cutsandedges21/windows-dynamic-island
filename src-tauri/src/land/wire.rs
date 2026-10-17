// Land's identity and its secure channel: the key pair, frames on the wire, the Noise XX
// handshake, and the messages both sides exchange.

use super::*;

// ------------------------------------------------------------------ identity

/// This computer's Land key pair. The id other devices see is derived from the public key.
#[derive(Clone)]
pub struct Identity {
    pub(super) private: Vec<u8>,
    pub public: Vec<u8>,
    pub id: String,
}

/// First 8 bytes of SHA-256 of a public key, in hex: short, and impossible to claim without the key.
pub fn device_id(public: &[u8]) -> String {
    Sha256::digest(public)[..8].iter().map(|b| format!("{b:02x}")).collect()
}

impl Identity {
    pub fn generate() -> Result<Self, String> {
        let kp = snow::Builder::new(noise_params()).generate_keypair().map_err(|e| e.to_string())?;
        Ok(Self::from_parts(kp.private, kp.public))
    }

    pub(super) fn from_parts(private: Vec<u8>, public: Vec<u8>) -> Self {
        let id = device_id(&public);
        Self { private, public, id }
    }

    /// Made on first use and kept in Island's data folder (private key, then public key).
    pub fn load_or_create(file: &Path) -> Result<Self, String> {
        if let Ok(bytes) = std::fs::read(file) {
            if bytes.len() == 64 {
                return Ok(Self::from_parts(bytes[..32].to_vec(), bytes[32..].to_vec()));
            }
        }
        let me = Self::generate()?;
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let mut both = me.private.clone();
        both.extend_from_slice(&me.public);
        std::fs::write(file, both).map_err(|e| format!("cannot save the Land key: {e}"))?;
        Ok(me)
    }
}

// ------------------------------------------------------------------ the secure channel

/// Frames on the wire: a big-endian u16 length, then that many bytes.
pub(super) async fn write_frame(w: &mut (impl AsyncWriteExt + Unpin), bytes: &[u8]) -> io::Result<()> {
    let len = u16::try_from(bytes.len()).map_err(|_| io::Error::other("frame too big"))?;
    let mut buf = Vec::with_capacity(bytes.len() + 2);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(bytes);
    w.write_all(&buf).await
}

pub(super) async fn read_frame(r: &mut (impl AsyncReadExt + Unpin), buf: &mut Vec<u8>) -> io::Result<()> {
    let mut len = [0u8; 2];
    r.read_exact(&mut len).await?;
    buf.resize(u16::from_be_bytes(len) as usize, 0);
    r.read_exact(buf).await?;
    Ok(())
}

/// Noise XX: -> e; <- e, ee, s, es; -> s, se. Both sides end up knowing each other's key.
pub(super) async fn handshake(stream: &mut TcpStream, me: &Identity, initiator: bool) -> Result<snow::TransportState, String> {
    let e = |e: snow::Error| e.to_string();
    let b = snow::Builder::new(noise_params()).local_private_key(&me.private).map_err(e)?.prologue(PROLOGUE).map_err(e)?;
    let mut hs = if initiator { b.build_initiator() } else { b.build_responder() }.map_err(e)?;
    let mut buf = vec![0u8; NOISE_MAX];
    let mut msg = Vec::new();
    let steps = if initiator { [true, false, true] } else { [false, true, false] };
    for write in steps {
        if write {
            let n = hs.write_message(&[], &mut buf).map_err(e)?;
            write_frame(stream, &buf[..n]).await.map_err(|e| e.to_string())?;
        } else {
            read_frame(stream, &mut msg).await.map_err(|e| e.to_string())?;
            hs.read_message(&msg, &mut buf).map_err(e)?;
        }
    }
    hs.into_transport_mode().map_err(e)
}

/// How frames are protected, shared by the reading and the writing half: a Noise session over
/// TCP (computers nearby), or nothing more over QUIC (friends on other networks), which already
/// encrypts and proves the other side's key.
pub(super) enum Wire {
    Noise(Mutex<snow::TransportState>),
    Plain,
}

impl Wire {
    pub(super) fn new(state: snow::TransportState) -> Self {
        Wire::Noise(Mutex::new(state))
    }

    /// `plain` (a frame type, then its bytes), encrypted when it is Noise, and framed.
    pub(super) fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        match self {
            Wire::Noise(state) => {
                let mut out = vec![0u8; plain.len() + NOISE_TAG + 2];
                let n = state.lock().unwrap().write_message(plain, &mut out[2..]).map_err(|e| e.to_string())?;
                out[..2].copy_from_slice(&(n as u16).to_be_bytes());
                out.truncate(n + 2);
                Ok(out)
            }
            Wire::Plain => {
                let len = u16::try_from(plain.len()).map_err(|_| "frame too big".to_string())?;
                let mut out = Vec::with_capacity(plain.len() + 2);
                out.extend_from_slice(&len.to_be_bytes());
                out.extend_from_slice(plain);
                Ok(out)
            }
        }
    }

    pub(super) fn open(&self, msg: &[u8]) -> Result<(u8, Vec<u8>), String> {
        let mut out = match self {
            Wire::Noise(state) => {
                let mut out = vec![0u8; msg.len()];
                let n = state.lock().unwrap().read_message(msg, &mut out).map_err(|_| "a frame failed its check".to_string())?;
                out.truncate(n);
                out
            }
            Wire::Plain => msg.to_vec(),
        };
        if out.is_empty() {
            return Err("an empty frame".into());
        }
        let kind = out.remove(0);
        Ok((kind, out))
    }
}

pub(super) enum Msg {
    Json(Value),
    Data(Vec<u8>),
}

/// One JSON message, split over frames when it is long (a long list of files).
pub(super) async fn send_json(w: &mut (impl AsyncWrite + Unpin), wire: &Wire, v: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    let parts: Vec<&[u8]> = bytes.chunks(CHUNK).collect();
    for (i, part) in parts.iter().enumerate() {
        let mut plain = Vec::with_capacity(part.len() + 1);
        plain.push(if i + 1 == parts.len() { F_JSON } else { F_JSON_PART });
        plain.extend_from_slice(part);
        let frame = wire.seal(&plain)?;
        timeout(IO_TIMEOUT, w.write_all(&frame)).await.map_err(|_| "timed out".to_string())?.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The next message: file bytes, or a whole JSON message.
pub(super) async fn recv(r: &mut (impl AsyncRead + Unpin), wire: &Wire) -> Result<Msg, String> {
    let mut frame = Vec::new();
    let mut json = Vec::new();
    loop {
        read_frame(r, &mut frame).await.map_err(|e| e.to_string())?;
        let (kind, body) = wire.open(&frame)?;
        match kind {
            F_DATA => return Ok(Msg::Data(body)),
            F_JSON_PART | F_JSON => {
                json.extend_from_slice(&body);
                if json.len() > MAX_JSON {
                    return Err("a message too long".into());
                }
                if kind == F_JSON {
                    return serde_json::from_slice(&json).map(Msg::Json).map_err(|e| e.to_string());
                }
            }
            _ => return Err("an unknown frame".into()),
        }
    }
}

pub(super) async fn recv_for(r: &mut (impl AsyncRead + Unpin), wire: &Wire, limit: Duration) -> Result<Msg, String> {
    timeout(limit, recv(r, wire)).await.map_err(|_| "timed out".to_string())?
}

/// Resolves once `cancel` says stop (never, if its sender is gone).
pub(super) async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    while !*cancel.borrow() {
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

pub(super) struct AbortOnDrop(pub(super) tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}


/// Reads until `buf` is full or the file ends; the count read.
pub(super) async fn read_up_to(r: &mut (impl AsyncReadExt + Unpin), buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        let n = r.read(&mut buf[got..]).await?;
        if n == 0 {
            break;
        }
        got += n;
    }
    Ok(got)
}

// Receiving: connections from computers nearby and friends, the offer, this user's answer, and the
// files arriving (or pausing for the sender to come back).

use super::*;

impl Running {
    pub(super) async fn accept_loop(self: Arc<Self>, listener: TcpListener) {
        let mut stop = self.stop.subscribe();
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                r = listener.accept() => {
                    let Ok((sock, from)) = r else { continue };
                    let local = {
                        let nets = self.nets.lock().unwrap();
                        is_local(from.ip(), &nets)
                    };
                    if !local {
                        crate::log::line(format!("land: refused a connection from outside the local network ({})", from.ip()));
                        continue;
                    }
                    tokio::spawn(self.clone().receive(sock));
                }
            }
        }
    }

    // -------------------------------------------------------------- receiving

    pub(super) async fn receive(self: Arc<Self>, mut stream: TcpStream) {
        let _ = stream.set_nodelay(true);
        let Ok(Ok(ts)) = timeout(HANDSHAKE_TIMEOUT, handshake(&mut stream, &self.me, false)).await else { return };
        let sender = device_id(ts.get_remote_static().unwrap_or_default());
        let wire = Arc::new(Wire::new(ts));
        let (mut rd, mut wr) = stream.into_split();
        // The name it announced, if it did; else the one in its offer.
        let known = self.peers.lock().unwrap().get(&sender).map(|p| p.info.clone());
        self.receive_on(&mut rd, &mut wr, &wire, sender, known, None).await;
    }

    /// A friend's Island sends from another network: one QUIC stream, the same exchange as nearby.
    /// A connection that never opens a stream was only checking that this Island is online.
    pub(super) async fn receive_far(self: Arc<Self>, conn: Connection) {
        let from = conn.remote_id().to_string();
        // Heard from: sends waiting for this friend go now.
        self.kick(&from);
        let Ok(Ok((mut send, mut recv))) = timeout(HANDSHAKE_TIMEOUT, conn.accept_bi()).await else { return };
        let known = self.far.as_ref().and_then(|f| f.friend(&from)).map(|f| PeerInfo { id: from.clone(), name: f.name, os: String::new(), anywhere: Some(from.clone()) });
        self.receive_on(&mut recv, &mut send, &Arc::new(Wire::Plain), from, known, Some(&conn)).await;
        // Let the last message ("saved", or a decline) arrive: the sender closes the connection.
        let _ = send.finish();
        let _ = timeout(Duration::from_secs(10), conn.closed()).await;
    }

    /// An offer arrives: carry on with one accepted before its connection dropped, or ask this
    /// user, then take the files. `known` is who the sender is when that is known (a computer
    /// that announced itself, a friend); else its offer names it.
    pub(super) async fn receive_on<R, W>(self: &Arc<Self>, rd: &mut R, wr: &mut W, wire: &Arc<Wire>, sender: String, known: Option<PeerInfo>, conn: Option<&Connection>)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let Ok(Msg::Json(v)) = recv_for(rd, wire, Duration::from_secs(15)).await else { return };
        let Some(offer) = Offer::parse(&v) else {
            let _ = send_json(wr, wire, &json!({ "t": "decline", "why": "bad" })).await;
            return;
        };
        let peer = match known {
            Some(mut p) => {
                if p.os.is_empty() {
                    p.os = offer.os.clone();
                }
                p
            }
            None => PeerInfo { id: sender.clone(), name: offer.from.clone(), os: offer.os.clone(), anywhere: None },
        };
        let via = conn.map(crate::anywhere::via).unwrap_or("lan");
        let key = offer.tid.as_ref().map(|tid| resume_key(&sender, tid));

        // The same transfer, back after its connection dropped: no asking again.
        if let Some(key) = &key {
            if self.refused_resume.lock().unwrap().get(key).is_some_and(|at| at.elapsed() < RESUME_REFUSED) {
                let _ = send_json(wr, wire, &json!({ "t": "decline", "why": "cancelled" })).await;
                return;
            }
            let back = self.paused.lock().unwrap().remove(key);
            if let Some(p) = back {
                if p.files == offer.files {
                    let have = p.landing.have();
                    let mut t = p.transfer;
                    if send_json(wr, wire, &json!({ "t": "accept", "have": have })).await.is_err() {
                        self.pause(key.clone(), p.files, t, p.landing);
                        return;
                    }
                    t.done = have.iter().sum();
                    t.via = Some(via);
                    crate::log::line(format!("land: {} is back, {} of {} bytes already here", short(&peer.id), t.done, t.total));
                    self.receive_files(rd, wr, wire, &offer, Some(key.clone()), t, p.landing, conn).await;
                    return;
                }
                // The files changed meanwhile: the old pieces go, and this is a new offer.
                let mut old = p.transfer;
                old.state = "failed";
                old.error = Some(format!("{} changed the files, so they come again as a new offer.", peer.name));
                self.publish(&old);
            }
        }

        let id = self.next_id("in");
        let mut t = Transfer::new(&id, "in", peer.clone(), &offer.files);
        t.text = offer.text.clone();
        t.via = Some(via);

        let quiet = self.declined.lock().unwrap().get(&sender).is_some_and(|t| t.elapsed() < DECLINE_QUIET);
        let busy = quiet || {
            let asks = self.asks.lock().unwrap();
            asks.len() >= MAX_ASKING || asks.values().any(|(from, _)| *from == sender)
        };
        if busy {
            let _ = send_json(wr, wire, &json!({ "t": "decline", "why": "busy" })).await;
            return;
        }
        if free_space(&self.downloads).is_some_and(|free| free < offer.total.saturating_add(SPARE_BYTES)) {
            let _ = send_json(wr, wire, &json!({ "t": "decline", "why": "space" })).await;
            t.state = "failed";
            t.error = Some(format!("{} tried to send you files, but Downloads doesn't have room for them.", peer.name));
            self.publish(&t);
            return;
        }

        let (tx, rx) = oneshot::channel();
        self.asks.lock().unwrap().insert(id.clone(), (sender.clone(), tx));
        t.state = "asking";
        t.expires = Some(now_ms() + ASK_FOR.as_millis() as u64);
        self.publish(&t);
        match &t.text {
            Some(text) => crate::log::line(format!("land: {} offers text ({} characters)", short(&peer.id), text.chars().count())),
            None => crate::log::line(format!("land: {} offers {} files ({} bytes)", short(&peer.id), t.count, t.total)),
        }
        enum Said {
            Yes,
            No,
            Late,
            Gone,
        }
        let said = tokio::select! {
            a = rx => if a.unwrap_or(false) { Said::Yes } else { Said::No },
            _ = tokio::time::sleep(ASK_FOR) => Said::Late,
            // The sender cancelled, or went away.
            _ = recv(rd, wire) => Said::Gone,
        };
        self.asks.lock().unwrap().remove(&id);
        t.expires = None;
        match said {
            Said::Yes => {}
            Said::No | Said::Late => {
                let why = if matches!(said, Said::Late) { "timeout" } else { "declined" };
                if why == "declined" {
                    let mut declined = self.declined.lock().unwrap();
                    declined.retain(|_, t| t.elapsed() < DECLINE_QUIET);
                    declined.insert(sender.clone(), Instant::now());
                }
                let _ = send_json(wr, wire, &json!({ "t": "decline", "why": why })).await;
                t.state = "declined";
                t.error = Some(if why == "timeout" { "Not answered in time.".into() } else { "Declined.".into() });
                self.publish(&t);
                crate::log::line(format!("land: offer from {} {why}", short(&peer.id)));
                return;
            }
            Said::Gone => {
                t.state = "cancelled";
                t.error = Some(format!("{} cancelled.", peer.name));
                self.publish(&t);
                return;
            }
        }
        if send_json(wr, wire, &json!({ "t": "accept" })).await.is_err() {
            t.state = "failed";
            t.error = Some(format!("The connection to {} dropped.", peer.name));
            self.publish(&t);
            return;
        }
        let landing = match Landing::new(&self.downloads, &offer.files) {
            Ok(l) => l,
            Err(e) => {
                let _ = send_json(wr, wire, &json!({ "t": "error" })).await;
                t.state = "failed";
                t.error = Some(format!("Couldn't write to Downloads: {e}"));
                self.publish(&t);
                return;
            }
        };
        self.receive_files(rd, wr, wire, &offer, key, t, landing, conn).await;
    }

    /// Takes the files of an accepted transfer. A dropped connection keeps the pieces for the
    /// sender to come back (when its offer can be matched again: `key`); anything else ends it.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn receive_files<R, W>(self: &Arc<Self>, rd: &mut R, wr: &mut W, wire: &Arc<Wire>, offer: &Offer, key: Option<String>, mut t: Transfer, mut landing: Landing, conn: Option<&Connection>)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let id = t.id.clone();
        let who = short(&t.peer.id).to_string();
        let (ctx, crx) = watch::channel(false);
        self.cancels.lock().unwrap().insert(id.clone(), ctx);
        t.state = "receiving";
        t.error = None;
        self.publish(&t);
        let result = self.take_files(rd, wr, wire, &mut landing, &mut t, crx, conn).await;
        self.cancels.lock().unwrap().remove(&id);
        match (result, key) {
            (Ok(saved), _) => {
                t.state = "done";
                t.saved = saved.iter().map(|p| p.to_string_lossy().to_string()).collect();
                t.folder = Some(self.downloads.to_string_lossy().to_string());
                crate::log::line(format!("land: received {} files from {who} ({})", t.count, t.via.unwrap_or("?")));
            }
            (Err(f), Some(key)) if f.state == "lost" => {
                t.state = "paused";
                t.error = Some(format!("Connection lost. Continues when {} is back.", t.peer.name));
                crate::log::line(format!("land: receive from {who} paused at {} of {} bytes", t.done, t.total));
                self.publish(&t);
                self.pause(key, offer.files.clone(), t, landing);
                return;
            }
            (Err(f), _) => {
                t.state = if f.state == "lost" { "failed" } else { f.state };
                crate::log::line(format!("land: receive from {who} {}: {}", t.state, f.error));
                t.error = Some(f.error);
            }
        }
        self.publish(&t);
    }

    /// Keeps a dropped transfer's pieces for its sender to come back; after `pause_keep` they go.
    pub(super) fn pause(self: &Arc<Self>, key: String, files: Vec<OfferFile>, transfer: Transfer, landing: Landing) {
        let epoch = self.seq.fetch_add(1, Ordering::Relaxed);
        let keep = self.timing.lock().unwrap().pause_keep;
        self.paused.lock().unwrap().insert(key.clone(), Paused { files, transfer, landing, epoch });
        let run = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(keep).await;
            let Some(run) = run.upgrade() else { return };
            let expired = {
                let mut paused = run.paused.lock().unwrap();
                if paused.get(&key).is_some_and(|p| p.epoch == epoch) {
                    paused.remove(&key)
                } else {
                    None
                }
            };
            if let Some(p) = expired {
                let mut t = p.transfer;
                t.state = "failed";
                t.error = Some(format!("{} didn't come back to finish, so the pieces were removed.", t.peer.name));
                crate::log::line(format!("land: dropped receive from {} expired", short(&t.peer.id)));
                run.publish(&t);
                // `p.landing` goes here, and its pieces with it.
            }
        });
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn take_files<R, W>(&self, rd: &mut R, wr: &mut W, wire: &Wire, landing: &mut Landing, t: &mut Transfer, mut cancel: watch::Receiver<bool>, conn: Option<&Connection>) -> Result<Vec<PathBuf>, Fail>
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let name = t.peer.name.clone();
        // The connection dropped: what arrived stays, for the sender to come back.
        let gone = || Fail::lost(format!("The connection to {name} dropped."));
        let broken = || Fail::failed(format!("{name} sent something Land doesn't expect."));
        let disk = |e: io::Error| Fail::failed(format!("Couldn't write to Downloads: {e}"));
        let mut last = Instant::now();
        for i in 0..landing.targets.len() {
            let target = landing.targets[i].clone();
            let (file, mut left) = if let Some(temp) = landing.temps.get(i) {
                // Begun before the connection dropped: carry on from what is on disk.
                let had = std::fs::metadata(temp).map(|m| m.len()).unwrap_or(0).min(target.size);
                let mut f = tokio::fs::OpenOptions::new().write(true).open(temp).await.map_err(disk)?;
                f.set_len(had).await.map_err(disk)?;
                f.seek(io::SeekFrom::Start(had)).await.map_err(disk)?;
                (f, target.size - had)
            } else {
                let (temp, f) = match create_temp(&target.dir, &target.name).await {
                    Ok(x) => x,
                    Err(e) => {
                        let _ = send_json(wr, wire, &json!({ "t": "error" })).await;
                        return Err(disk(e));
                    }
                };
                landing.litter.temps.push(temp.clone());
                landing.temps.push(temp);
                (f, target.size)
            };
            let mut out = tokio::io::BufWriter::with_capacity(1 << 20, file);
            while left > 0 {
                let m = tokio::select! {
                    _ = cancelled(&mut cancel) => {
                        let _ = send_json(wr, wire, &json!({ "t": "cancel" })).await;
                        return Err(Fail::cancelled("Cancelled."));
                    }
                    m = recv_for(rd, wire, IO_TIMEOUT) => m,
                };
                match m {
                    Ok(Msg::Data(d)) if (d.len() as u64) <= left => {
                        if let Err(e) = out.write_all(&d).await {
                            let _ = send_json(wr, wire, &json!({ "t": "error" })).await;
                            return Err(disk(e));
                        }
                        left -= d.len() as u64;
                        t.done += d.len() as u64;
                        if last.elapsed() >= PROGRESS_EVERY {
                            last = Instant::now();
                            if let Some(c) = conn {
                                t.via = Some(crate::anywhere::via(c));
                            }
                            self.publish(t);
                        }
                    }
                    Ok(Msg::Json(v)) if v["t"] == "cancel" => return Err(Fail::cancelled(format!("{name} cancelled."))),
                    Ok(Msg::Json(v)) if v["t"] == "error" => return Err(Fail::failed(format!("{name} couldn't read one of the files."))),
                    Err(_) => {
                        // Every byte that arrived stays on disk for the resume.
                        let _ = out.flush().await;
                        return Err(gone());
                    }
                    _ => return Err(broken()),
                }
            }
            out.flush().await.map_err(disk)?;
        }
        match recv_for(rd, wire, IO_TIMEOUT).await {
            Ok(Msg::Json(v)) if v["t"] == "done" => {}
            Ok(Msg::Json(v)) if v["t"] == "cancel" => return Err(Fail::cancelled(format!("{name} cancelled."))),
            Err(_) => return Err(gone()),
            _ => return Err(broken()),
        }
        // Every byte is in: the files get their names, never over a file that is there.
        let mut saved: Vec<PathBuf> = Vec::new();
        for (target, temp) in landing.targets.iter().zip(&landing.temps) {
            let at = place(temp, &target.dir, &target.name).map_err(|e| Fail::failed(format!("Couldn't save {}: {e}", target.name)))?;
            mark_from_network(&at);
            let shown = target.root.clone().unwrap_or(at);
            if !saved.contains(&shown) {
                saved.push(shown);
            }
        }
        landing.litter.keep = true;
        let _ = send_json(wr, wire, &json!({ "t": "saved" })).await;
        Ok(saved)
    }
}

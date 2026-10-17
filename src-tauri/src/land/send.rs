// Sending: to a computer nearby over TCP + Noise, or to a friend over QUIC, with retries after a
// drop and sends that wait for a friend who is away.

use super::*;

impl Running {
    // -------------------------------------------------------------- sending

    /// Starts sending `paths` to a computer nearby or to a friend on another network (by id);
    /// progress arrives as land-transfer events.
    pub async fn send(self: &Arc<Self>, peer_id: &str, paths: Vec<PathBuf>) -> Result<String, String> {
        // A computer nearby by its id, or by its friend key: a friend who is nearby goes the fast way.
        let peer = {
            let peers = self.peers.lock().unwrap();
            peers.get(peer_id).or_else(|| peers.values().find(|p| p.info.anywhere.as_deref() == Some(peer_id))).cloned()
        };
        let friend = if peer.is_none() { self.far.as_ref().and_then(|f| f.friend(peer_id)) } else { None };
        let info = match (&peer, &friend) {
            (Some(p), _) => p.info.clone(),
            (None, Some(f)) => friend_info(f),
            (None, None) => return Err("That device is gone. Try again when it shows up.".to_string()),
        };
        let shown: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
        let items = tokio::task::spawn_blocking(move || collect(&paths)).await.map_err(|e| e.to_string())??;
        if items.is_empty() {
            return Err("Nothing to send: the folders are empty.".into());
        }
        let id = self.next_id("out");
        self.start_send(id.clone(), info, peer, friend, items, shown, now_ms(), None);
        Ok(id)
    }

    /// Sends text (a link, a note) the way files go, and with the same consent: the other
    /// island shows it, with Copy and, for a link, Open.
    pub async fn send_text(self: &Arc<Self>, peer_id: &str, text: &str) -> Result<String, String> {
        let text = clean_text(text).ok_or_else(|| format!("Nothing to send, or more than {MAX_TEXT} characters."))?;
        let peer = {
            let peers = self.peers.lock().unwrap();
            peers.get(peer_id).or_else(|| peers.values().find(|p| p.info.anywhere.as_deref() == Some(peer_id))).cloned()
        };
        let friend = if peer.is_none() { self.far.as_ref().and_then(|f| f.friend(peer_id)) } else { None };
        let info = match (&peer, &friend) {
            (Some(p), _) => p.info.clone(),
            (None, Some(f)) => friend_info(f),
            (None, None) => return Err("That device is gone. Try again when it shows up.".to_string()),
        };
        let id = self.next_id("out");
        self.start_send(id.clone(), info, peer, friend, Vec::new(), Vec::new(), now_ms(), Some(text));
        Ok(id)
    }

    /// Runs a send in the background: `tid` is its id, `paths` what was dropped (kept for a send
    /// that waits), `since` when it began (a waiting send gives up `queue_for` after that).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn start_send(self: &Arc<Self>, tid: String, info: PeerInfo, peer: Option<Peer>, friend: Option<crate::anywhere::Friend>, items: Vec<Item>, paths: Vec<String>, since: u64, text: Option<String>) {
        let (tx, rx) = watch::channel(false);
        self.cancels.lock().unwrap().insert(tid.clone(), tx);
        let run = self.clone();
        tokio::spawn(async move { run.run_send(tid, info, peer, friend, items, paths, since, text, rx).await });
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_send(self: Arc<Self>, tid: String, info: PeerInfo, peer: Option<Peer>, friend: Option<crate::anywhere::Friend>, items: Vec<Item>, paths: Vec<String>, since: u64, text: Option<String>, rx: watch::Receiver<bool>) {
        let offered: Vec<OfferFile> = items.iter().map(|i| OfferFile { name: i.name.clone(), size: i.size, mtime: i.mtime }).collect();
        let mut t = Transfer::new(&tid, "out", info.clone(), &offered);
        t.text = text.clone();
        self.publish(&t);
        let who = short(&info.id).to_string();
        crate::log::line(format!("land: sending {} files ({} bytes) to {who}", t.count, t.total));
        // A connection that drops after the files were accepted: pause, and try again (2 s,
        // 4 s, ... up to `retry_max`) until `retry_for` has gone by. The receiver keeps what arrived.
        // A friend who can't be reached: the send waits (kept on disk) until they come online,
        // which their hello tells at once, or a try every `queue_retry` finds.
        let mut paused: Option<Instant> = None;
        let mut tries = 0u32;
        let result = loop {
            let attempt = match (&peer, &friend) {
                (Some(p), _) => {
                    // A computer nearby may be at a new address by now.
                    let p = self.peers.lock().unwrap().get(&p.info.id).cloned().unwrap_or_else(|| p.clone());
                    self.send_to(&p, &items, &offered, &mut t, rx.clone()).await
                }
                (_, Some(f)) => self.send_far(f, &items, &offered, &mut t, rx.clone()).await,
                (None, None) => Err(Fail::failed("That device is gone.")),
            };
            let timing = *self.timing.lock().unwrap();
            let mut stop = rx.clone();
            match attempt {
                Err(f) if f.state == "away" => {
                    let Some(fr) = &friend else { break Err(Fail::failed(f.error)) };
                    if now_ms().saturating_sub(since) >= timing.queue_for.as_millis() as u64 {
                        break Err(Fail::failed(format!("{} didn't come online, so Land stopped trying to send.", info.name)));
                    }
                    if t.state != "queued" {
                        t.state = "queued";
                        t.error = None;
                        crate::log::line(format!("land: {who} is away; the send waits"));
                        self.publish(&t);
                        self.keep_waiting(Waiting { tid: tid.clone(), friend: fr.id.clone(), paths: paths.clone(), since, text: text.clone() });
                    }
                    let hello = self.kick_for(&fr.id);
                    tokio::select! {
                        _ = cancelled(&mut stop) => break Err(Fail::cancelled("Cancelled.")),
                        _ = hello.notified() => {}
                        _ = tokio::time::sleep(timing.queue_retry) => {}
                    }
                }
                Err(f) if f.state == "lost" => {
                    let since = *paused.get_or_insert_with(Instant::now);
                    if since.elapsed() >= timing.retry_for {
                        break Err(Fail::failed(format!("{} didn't come back to finish, so Land stopped trying.", info.name)));
                    }
                    t.state = "paused";
                    t.error = Some(format!("Connection to {} lost. Trying again\u{2026}", info.name));
                    crate::log::line(format!("land: send to {who} paused at {} of {} bytes: {}", t.done, t.total, f.error));
                    self.publish(&t);
                    let wait = timing.retry_first.saturating_mul(2u32.saturating_pow(tries)).min(timing.retry_max);
                    tries += 1;
                    tokio::select! {
                        _ = cancelled(&mut stop) => break Err(Fail::cancelled("Cancelled.")),
                        _ = tokio::time::sleep(wait) => {}
                    }
                }
                other => break other,
            }
        };
        self.cancels.lock().unwrap().remove(&tid);
        // Land turning off: a waiting send stays on disk for next time, and nothing is said.
        if *self.stop.borrow() && t.state == "queued" {
            return;
        }
        self.done_waiting(&tid);
        match result {
            Ok(()) => {
                t.state = "done";
                crate::log::line(format!("land: sent to {who} ({})", t.via.unwrap_or("?")));
            }
            Err(f) => {
                t.state = f.state;
                crate::log::line(format!("land: send to {who} {}: {}", f.state, f.error));
                t.error = Some(f.error);
            }
        }
        self.publish(&t);
    }

    /// Keeps a send that waits for a friend on disk, so it outlives Land turning off.
    pub(super) fn keep_waiting(&self, w: Waiting) {
        let mut list = self.waiting.lock().unwrap();
        if !list.iter().any(|x| x.tid == w.tid) {
            list.push(w);
            self.save_waiting(&list);
        }
    }

    pub(super) fn done_waiting(&self, tid: &str) {
        let mut list = self.waiting.lock().unwrap();
        let before = list.len();
        list.retain(|x| x.tid != tid);
        if list.len() != before {
            self.save_waiting(&list);
        }
    }

    pub(super) fn save_waiting(&self, list: &[Waiting]) {
        let Some(file) = &self.queue_file else { return };
        let temp = file.with_extension("json.tmp");
        let saved = serde_json::to_vec_pretty(list).map_err(io::Error::other).and_then(|bytes| std::fs::write(&temp, bytes)).and_then(|_| std::fs::rename(&temp, file));
        if let Err(e) = saved {
            crate::log::line(format!("land: cannot save the waiting sends: {e}"));
        }
    }

    /// What wakes the sends waiting for a friend.
    pub(super) fn kick_for(&self, friend: &str) -> Arc<tokio::sync::Notify> {
        self.kicks.lock().unwrap().entry(friend.to_string()).or_default().clone()
    }

    /// A friend's Island was heard from: sends waiting for it go now.
    pub(super) fn kick(&self, friend: &str) {
        if let Some(n) = self.kicks.lock().unwrap().get(friend) {
            n.notify_waiters();
        }
    }

    /// The sends that waited for friends when Land last stopped: they wait again (or go).
    pub(super) fn restore_waiting(self: &Arc<Self>) {
        let list = self.waiting.lock().unwrap().clone();
        let Some(far) = self.far.clone() else { return };
        for w in list {
            let Some(friend) = far.friend(&w.friend) else {
                // No longer a friend: nothing to send to.
                self.done_waiting(&w.tid);
                continue;
            };
            let run = self.clone();
            tokio::spawn(async move {
                let paths: Vec<PathBuf> = w.paths.iter().map(PathBuf::from).collect();
                // Text waits as it is; files are read from the disk again.
                let items = if w.text.is_some() { Some(Vec::new()) } else { tokio::task::spawn_blocking(move || collect(&paths)).await.ok().and_then(|r| r.ok()).filter(|i| !i.is_empty()) };
                let info = friend_info(&friend);
                match items {
                    Some(items) => run.start_send(w.tid, info, None, Some(friend), items, w.paths, w.since, w.text),
                    None => {
                        run.done_waiting(&w.tid);
                        let mut t = Transfer::new(&w.tid, "out", info, &[]);
                        t.state = "failed";
                        t.error = Some("The files waiting to be sent are gone.".into());
                        run.publish(&t);
                    }
                }
            });
        }
    }

    pub(super) async fn send_to(&self, peer: &Peer, items: &[Item], offered: &[OfferFile], t: &mut Transfer, mut cancel: watch::Receiver<bool>) -> Result<(), Fail> {
        let name = peer.info.name.clone();
        let unreachable = || Fail::failed(format!("Couldn't reach {name}. Check that it's awake, on the same network, and that its firewall lets Island in."));
        let mut stream = tokio::select! {
            _ = cancelled(&mut cancel) => return Err(Fail::cancelled("Cancelled.")),
            r = timeout(CONNECT_TIMEOUT, TcpStream::connect(peer.addr)) => match r {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => {
                    // Nothing listens there any more (Island quit, Land turned off): it is gone.
                    if e.kind() == io::ErrorKind::ConnectionRefused && self.peers.lock().unwrap().remove(&peer.info.id).is_some() {
                        self.emit_peers();
                    }
                    return Err(unreachable());
                }
                Err(_) => return Err(unreachable()),
            },
        };
        let _ = stream.set_nodelay(true);
        let ts = timeout(HANDSHAKE_TIMEOUT, handshake(&mut stream, &self.me, true))
            .await
            .map_err(|_| Fail::failed(format!("{name} didn't finish the secure connection.")))?
            .map_err(|_| Fail::failed(format!("Couldn't set up a secure connection with {name}.")))?;
        if ts.get_remote_static() != Some(&peer.key[..]) {
            return Err(Fail::failed(format!("{name} answered with a different key than it announced, so nothing was sent.")));
        }
        let wire = Arc::new(Wire::new(ts));
        let (rd, wr) = stream.into_split();
        t.via = Some("lan");
        self.exchange(rd, wr, wire, &name, items, offered, t, cancel, None).await
    }

    /// Sends to a friend on another network: dials their Island by key (direct when it can,
    /// through a relay when it can't), then the same exchange as nearby, over one QUIC stream.
    pub(super) async fn send_far(&self, friend: &crate::anywhere::Friend, items: &[Item], offered: &[OfferFile], t: &mut Transfer, mut cancel: watch::Receiver<bool>) -> Result<(), Fail> {
        let name = friend.name.clone();
        let far = self.far.clone().ok_or_else(|| Fail::failed("Turn on Friends on other networks first (Activities \u{203a} Land)."))?;
        let id: iroh::EndpointId = friend.id.parse().map_err(|_| Fail::failed(format!("{name}'s key is damaged. Remove them and add them again.")))?;
        let refused = || Fail::failed(format!("{name} isn't taking files from you. Ask them to add you again with your Land code."));
        let unreachable = || Fail::away(format!("Couldn't reach {name}. Their computer needs Island open, with Friends on other networks on."));
        let limit = self.timing.lock().unwrap().far_connect;
        let conn = tokio::select! {
            _ = cancelled(&mut cancel) => return Err(Fail::cancelled("Cancelled.")),
            r = timeout(limit, far.dial(id, crate::anywhere::ALPN_LAND)) => match r {
                Ok(Ok(c)) => c,
                // Turned away before the handshake was over on this side.
                Ok(Err(e)) if e.contains(&crate::anywhere::NOT_A_FRIEND.to_string()) => return Err(refused()),
                _ => return Err(unreachable()),
            },
        };
        t.via = Some(crate::anywhere::via(&conn));
        let result = match conn.open_bi().await {
            Ok((send, recv)) => self.exchange(recv, send, Arc::new(Wire::Plain), &name, items, offered, t, cancel, Some(&conn)).await,
            Err(_) => Err(Fail::failed(format!("The connection to {name} dropped."))),
        };
        let was_refused = crate::anywhere::refused(&conn);
        conn.close(VarInt::from_u32(0), b"done");
        match result {
            Err(_) if was_refused => Err(refused()),
            r => r,
        }
    }

    /// Offers the files, waits for the answer, sends them, and waits for "saved": the same over
    /// TCP + Noise (computers nearby) and over QUIC (friends; `conn` reports the path as it changes).
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn exchange<R, W>(&self, mut rd: R, mut wr: W, wire: Arc<Wire>, name: &str, items: &[Item], offered: &[OfferFile], t: &mut Transfer, mut cancel: watch::Receiver<bool>, conn: Option<&Connection>) -> Result<(), Fail>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin,
    {
        let name = name.to_string();
        let lost = || Fail::failed(format!("The connection to {name} dropped."));
        // Trying again after a drop, or a friend back after waiting: waiting for the receiver once more.
        if t.state == "paused" || t.state == "queued" {
            t.state = "waiting";
            t.error = None;
            self.publish(t);
        }
        // `tid` stays the same on every try, so the receiver knows the transfer when it comes back.
        let mut offer = json!({ "t": "offer", "from": self.name(), "os": std::env::consts::OS, "files": offered, "tid": t.id });
        if let Some(text) = &t.text {
            offer["text"] = json!(text);
        }
        send_json(&mut wr, &wire, &offer).await.map_err(|_| lost())?;

        // The receiving user decides; the receiver gives up after ASK_FOR.
        let answer = tokio::select! {
            _ = cancelled(&mut cancel) => {
                let _ = send_json(&mut wr, &wire, &json!({ "t": "cancel" })).await;
                return Err(Fail::cancelled("Cancelled."));
            }
            r = recv_for(&mut rd, &wire, ASK_FOR + Duration::from_secs(15)) => r,
        };
        // "have": what the receiver already holds of each file, when this is a transfer coming back.
        let have: Vec<u64> = match answer {
            Ok(Msg::Json(v)) if v["t"] == "accept" => v["have"].as_array().map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0)).collect()).unwrap_or_default(),
            Ok(Msg::Json(v)) if v["t"] == "decline" && v["why"] == "cancelled" => return Err(Fail::cancelled(format!("{name} cancelled."))),
            Ok(Msg::Json(v)) if v["t"] == "decline" => return Err(Fail::declined(why_declined(v["why"].as_str().unwrap_or(""), &name))),
            Err(e) if e == "timed out" => return Err(Fail::declined(why_declined("timeout", &name))),
            _ => return Err(lost()),
        };
        let have: Vec<u64> = items.iter().enumerate().map(|(i, it)| have.get(i).copied().unwrap_or(0).min(it.size)).collect();
        // From here a dropped connection is worth trying again: the receiver keeps what arrived.
        let gone = || Fail::lost(format!("The connection to {name} dropped."));
        t.done = have.iter().sum();
        t.state = "sending";
        self.publish(t);

        // While the files go, a reader listens for the receiver (a cancel, or "saved" at the end).
        let (ctl_tx, mut ctl_rx) = mpsc::channel::<Result<Value, String>>(4);
        let reader_wire = wire.clone();
        let reader = tokio::spawn(async move {
            loop {
                let m = recv(&mut rd, &reader_wire).await;
                let end = !matches!(m, Ok(Msg::Json(_)));
                let msg = match m {
                    Ok(Msg::Json(v)) => Ok(v),
                    Ok(Msg::Data(_)) => Err("unexpected data".to_string()),
                    Err(e) => Err(e),
                };
                if ctl_tx.send(msg).await.is_err() || end {
                    break;
                }
            }
        });
        let _reader = AbortOnDrop(reader.abort_handle());
        let mut plain = vec![0u8; CHUNK + 1];
        plain[0] = F_DATA;
        let mut last = Instant::now();
        for (item, &skip) in items.iter().zip(&have) {
            let mut file = tokio::fs::File::open(&item.path).await.map_err(|_| Fail::failed(format!("Couldn't open {}.", item.name)))?;
            if skip > 0 {
                file.seek(io::SeekFrom::Start(skip)).await.map_err(|_| Fail::failed(format!("Couldn't read {}.", item.name)))?;
            }
            let mut file = tokio::io::BufReader::with_capacity(1 << 20, file);
            let mut left = item.size - skip;
            while left > 0 {
                if *cancel.borrow() {
                    let _ = send_json(&mut wr, &wire, &json!({ "t": "cancel" })).await;
                    return Err(Fail::cancelled("Cancelled."));
                }
                if let Ok(m) = ctl_rx.try_recv() {
                    return Err(match m {
                        Ok(v) if v["t"] == "cancel" => Fail::cancelled(format!("{name} cancelled.")),
                        Ok(v) if v["t"] == "error" => Fail::failed(format!("{name} couldn't save the files.")),
                        _ => gone(),
                    });
                }
                let want = (left as usize).min(CHUNK);
                let got = read_up_to(&mut file, &mut plain[1..1 + want]).await.map_err(|_| Fail::failed(format!("Couldn't read {}.", item.name)))?;
                if got < want {
                    let _ = send_json(&mut wr, &wire, &json!({ "t": "error" })).await;
                    return Err(Fail::failed(format!("{} changed while it was being sent.", item.name)));
                }
                let frame = wire.seal(&plain[..1 + want]).map_err(Fail::failed)?;
                timeout(IO_TIMEOUT, wr.write_all(&frame)).await.map_err(|_| gone())?.map_err(|_| gone())?;
                left -= want as u64;
                t.done += want as u64;
                #[cfg(test)]
                {
                    let cut = self.cut.load(Ordering::Relaxed);
                    if cut > 0 && t.done >= cut {
                        // As if the network dropped: the connection goes with this return.
                        self.cut.store(0, Ordering::Relaxed);
                        return Err(gone());
                    }
                }
                if last.elapsed() >= PROGRESS_EVERY {
                    last = Instant::now();
                    if let Some(c) = conn {
                        t.via = Some(crate::anywhere::via(c));
                    }
                    self.publish(t);
                }
            }
        }
        send_json(&mut wr, &wire, &json!({ "t": "done" })).await.map_err(|_| gone())?;
        self.publish(t);
        // Done when the receiver says every file has its name.
        match timeout(Duration::from_secs(60), ctl_rx.recv()).await {
            Ok(Some(Ok(v))) if v["t"] == "saved" => Ok(()),
            Ok(Some(Ok(v))) if v["t"] == "cancel" => Err(Fail::cancelled(format!("{name} cancelled."))),
            Ok(Some(Ok(v))) if v["t"] == "error" => Err(Fail::failed(format!("{name} couldn't save the files."))),
            _ => Err(Fail::failed(format!("{name} didn't confirm the files arrived."))),
        }
    }

}

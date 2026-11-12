// Auto model, part 2 (installed by Island: Activities > Claude Sessions > Auto model).
// Model check: at the end of a stretch of work (a compact, or the context
// passing 500k tokens) Sonnet reviews every prompt of that stretch and says
// whether it ran on the right model. Too big: how much usage a cheaper model
// would have saved. Too small: how much more often a stronger one would have
// got it right the first time (an estimate).
//
// Hooks (settings.json): PreCompact starts a review, Stop starts one when the
// context passes 500k and shows a finished review at the end of the reply,
// SessionEnd (/clear, exit) starts one for what is left of the chat, which
// shows at the end of the next reply in the same folder (after /clear: the
// same terminal).
// Part of Auto model: the router's switch (./off, also the Island's "Auto
// model" button) turns both off. Reviews are kept in ./reviews.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const DIR = path.join(HERE, "reviews");
const LIMIT = Number(process.env.MODEL_CHECK_LIMIT) || 500_000; // context tokens that count as "end of a conversation"
const END_MIN = Number(process.env.MODEL_CHECK_END_MIN) || 100_000; // tokens a chat must have spent before /clear or exit gets a check
const TIERS = ["haiku", "sonnet", "opus", "fable"];
const NAMES = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus", fable: "Fable" };
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// $ per million tokens, Claude API list prices (Oct 2026). cw5 / cw1 = cache writes kept 5 min / 1 h.
const PRICE = {
  haiku: { in: 0.1, out: 0.5, cr: 0.01, cw5: 0.125, cw1: 0.2 },
  haikuLong: { in: 0.5, out: 2.5, cr: 0.05, cw5: 0.625, cw1: 1 }, // Haiku prompts over 100k tokens
  sonnet: { in: 2, out: 10, cr: 0.2, cw5: 2.5, cw1: 4 },
  opus: { in: 4, out: 20, cr: 0.2, cw5: 5, cw1: 8 },
  fable: { in: 10, out: 50, cr: 0.25, cw5: 12.5, cw1: 20 },
};
// A prompt that says the last answer was wrong.
const CORRECTION = /^(no|nope|wrong)\b|\b(still (not|broken|doesn'?t|wrong|the same|there)|(doesn'?t|didn'?t|does not|did not|isn'?t) work|not working|try again|that'?s not|not what i|you (forgot|missed|broke)|it broke|undo that|revert)\b/i;

const fmt = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tierOf = (id = "") => TIERS.find((t) => id.toLowerCase().includes(t));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const log = (msg) => {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(path.join(DIR, "review.log"), `${new Date().toISOString()} ${msg}\n`); } catch {}
};

/** "claude-opus-5-5" -> "Opus 5.5" */
function modelName(id = "") {
  const m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i);
  const t = tierOf(id);
  if (!m || !t) return id;
  return `${NAMES[t]} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

const tokens = (u) => (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

/** What one reply would cost at `tier`'s prices. */
function cost(u, tier) {
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const p = tier === "haiku" && prompt > 100_000 ? PRICE.haikuLong : PRICE[tier];
  const cw1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cw5 = Math.max(0, (u.cache_creation_input_tokens || 0) - cw1);
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + cw5 * p.cw5 + cw1 * p.cw1) / 1e6;
}

// ---- state: reviews/<session>.state.json = { offset: transcript byte where the next review starts, over: 500k review done } ----
const stateFile = (sid) => path.join(DIR, `${sid}.state.json`);
const pendingFile = (sid) => path.join(DIR, `${sid}.pending.txt`);
/** A chat that ended has no next reply: its check waits for the next one in the same folder. */
const folderPendingFile = (cwd) => path.join(DIR, `folder-${createHash("md5").update(String(cwd).toLowerCase()).digest("hex").slice(0, 12)}.pending.txt`);
function loadState(sid) {
  try { return JSON.parse(fs.readFileSync(stateFile(sid), "utf8")); } catch { return { offset: 0, over: false }; }
}
function saveState(sid, patch) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(stateFile(sid), JSON.stringify({ ...loadState(sid), ...patch }));
}

/** Context size of the last main-chat reply (reads only the end of the transcript). */
function contextTokens(file) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 400_000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      if (!line.includes('"type":"assistant"') || line.includes('"isSidechain":true')) continue;
      try {
        const m = JSON.parse(line).message;
        if (m?.usage && tierOf(m.model)) return tokens(m.usage);
      } catch {}
    }
  } catch {}
  return null;
}

/** Prompts typed by the user from `offset` on, each with the replies (deduped by message id) and tool calls it caused. */
function readStretch(file, offset) {
  const size = fs.statSync(file).size;
  if (offset > size) offset = 0; // transcript was rewritten
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const end = buf.lastIndexOf(10) + 1;
  let title = "";
  try { // the session's title is usually written before the stretch starts
    const all = fs.readFileSync(file, "utf8");
    const i = all.lastIndexOf('"type":"ai-title"');
    if (i >= 0) title = JSON.parse(all.slice(all.lastIndexOf("\n", i) + 1, all.indexOf("\n", i))).aiTitle || "";
  } catch {}

  const prompts = [];
  let cur = null;
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.isSidechain) continue;
    // A prompt the user typed: not a tool result, a reminder, a compact summary or a background-task notice
    // (older transcripts and -p runs have no origin at all).
    const c = j.message?.content;
    const typed = j.type === "user" && !j.isMeta && !j.isCompactSummary && (!j.origin || j.origin.kind === "human") &&
      (typeof c === "string" || (Array.isArray(c) && c.some((b) => b.type === "text") && !c.some((b) => b.type === "tool_result")));
    if (typed) {
      let text = typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join(" ");
      if (/^\s*<(local-command|task-notification|system-reminder)/.test(text)) continue;
      const cmd = text.match(/<command-name>([^<]*)<\/command-name>/); // a slash command: "/lesson-video calc2 6.4"
      if (cmd) text = `${cmd[1]} ${text.match(/<command-args>([^<]*)<\/command-args>/)?.[1] || ""}`;
      text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      cur = { n: prompts.length + 1, text: text || "(empty)", msgs: new Map(), tools: {} };
      prompts.push(cur);
      continue;
    }
    if (j.type !== "assistant") continue;
    const m = j.message;
    if (!m?.id || !m.usage || !tierOf(m.model)) continue;
    if (!cur) { // the stretch starts in the middle of a reply
      cur = { n: 1, text: "(the end of a prompt sent before this check)", msgs: new Map(), tools: {} };
      prompts.push(cur);
    }
    const e = cur.msgs.get(m.id) || { model: m.model, effort: j.effort, usage: m.usage };
    e.usage = m.usage;
    cur.msgs.set(m.id, e);
    for (const b of m.content || []) if (b.type === "tool_use") cur.tools[b.name] = (cur.tools[b.name] || 0) + 1;
  }
  for (const p of prompts) {
    const out = {};
    const eff = {};
    for (const e of p.msgs.values()) {
      out[e.model] = (out[e.model] || 0) + (e.usage.output_tokens || 0) + 1;
      if (e.effort) eff[e.effort] = (eff[e.effort] || 0) + 1;
    }
    p.model = Object.entries(out).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    p.tier = tierOf(p.model);
    p.effort = Object.entries(eff).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    p.written = [...p.msgs.values()].reduce((a, e) => a + (e.usage.output_tokens || 0), 0);
  }
  return { prompts: prompts.filter((p) => p.msgs.size), end: offset + end, title };
}

function digest(prompts, title) {
  const shown = prompts.slice(-150); // a huge stretch: judge the last 150 prompts
  const lines = shown.map((p, i) => {
    const tools = Object.entries(p.tools).map(([k, v]) => `${k}×${v}`).join(", ") || "none";
    const fix = i > 0 && CORRECTION.test(p.text) ? " | CORRECTION of the previous prompt" : "";
    return `#${p.n} [${modelName(p.model)} ${p.effort || ""} | tools: ${tools} | wrote ${fmt(p.written)} tokens${fix}] ${clip(p.text, 400)}`;
  });
  return `Session: ${title || "untitled"}\n${plural(prompts.length, "prompt")} in this stretch${shown.length < prompts.length ? `, the last ${shown.length} shown` : ""}.\n\n${lines.join("\n")}`;
}

/** Sonnet's verdict as { picks, effort, accuracy_gain_pct, note }, or null. One retry if the reply isn't valid JSON. */
function grade(text) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync("claude", [
      "-p", "--model", "sonnet", "--effort", "low",
      "--setting-sources", "", "--strict-mcp-config", "--tools", "", "--no-session-persistence",
      "--system-prompt-file", path.join(HERE, "review-rubric.md"),
    ], { input: text, encoding: "utf8", timeout: 150_000, windowsHide: true, env: { ...process.env, CLAUDE_ROUTER_CHILD: "1" } });
    const out = r.stdout || "";
    const start = out.indexOf("{");
    // The object ends at one of the "}" — try from the last one back.
    for (let end = out.lastIndexOf("}"); start >= 0 && end > start; end = out.lastIndexOf("}", end - 1)) {
      try {
        const v = JSON.parse(out.slice(start, end + 1));
        if (Array.isArray(v.picks)) return v;
      } catch {}
    }
    log(`grade failed (try ${attempt}): ${clip(out || r.stderr || String(r.error || ""), 3000)}`);
  }
  return null;
}

/** Turns the per-prompt picks into numbers: usage saved on prompts that ran too big, prompts that ran too small. */
function score(prompts, v) {
  const byN = new Map(prompts.map((p) => [p.n, p]));
  let total = 0, totalTok = 0, saved = 0;
  for (const p of prompts) for (const e of p.msgs.values()) { total += cost(e.usage, tierOf(e.model)); totalTok += tokens(e.usage); }
  const picks = new Map();
  for (const pick of v.picks) {
    const p = byN.get(Number(pick.n));
    const to = String(pick.model || "").toLowerCase();
    if (p && TIERS.includes(to) && to !== "fable" && to !== p.tier) picks.set(p.n, { n: p.n, text: p.text, from: p.tier, to, why: String(pick.why || "") });
  }
  // Prompts in a row that fit the same cheaper model form a run. Switching model
  // mid-chat re-writes the whole context into the new model's cache, so a run
  // only counts as "too big" when what it saves beats that one switch.
  const down = [], up = [], runs = [];
  let run = null;
  prompts.forEach((p, i) => {
    const item = picks.get(p.n);
    if (item && TIERS.indexOf(item.to) > TIERS.indexOf(p.tier)) up.push(item);
    if (!item || TIERS.indexOf(item.to) > TIERS.indexOf(p.tier)) return (run = null);
    if (!run || run.to !== item.to || run.last !== i - 1) {
      const u = p.msgs.values().next().value.usage;
      const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const p1 = item.to === "haiku" && context > 100_000 ? PRICE.haikuLong : PRICE[item.to];
      run = { to: item.to, items: [], gain: i === 0 && context < 50_000 ? 0 : -(context * p1.cw1) / 1e6 };
      runs.push(run);
    }
    run.last = i;
    run.items.push(item);
    for (const e of p.msgs.values()) run.gain += Math.max(0, cost(e.usage, tierOf(e.model)) - cost(e.usage, item.to));
  });
  let notWorth = 0;
  for (const r of runs) {
    if (r.gain > 0) { saved += r.gain; down.push(...r.items); }
    else notWorth += r.items.length;
  }
  const savedTok = total ? totalTok * (saved / total) : 0; // the same share of the tokens spent
  // The model most of the stretch ran on.
  const spend = {};
  for (const p of prompts) spend[p.model] = (spend[p.model] || 0) + p.written + 1;
  const main = Object.entries(spend).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const effs = {};
  for (const p of prompts) if (p.effort) effs[p.effort] = (effs[p.effort] || 0) + 1;
  const effort = Object.entries(effs).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  const acc = up.length ? Math.max(5, Math.min(60, Math.round(Number(v.accuracy_gain_pct) || 0))) : 0;
  return { total, totalTok, saved, savedTok, pct: total ? Math.round((saved / total) * 100) : 0, down, up, notWorth, main, effort, acc };
}

/** "6 on Sonnet, 2 on Haiku" */
function groups(items) {
  const c = {};
  for (const i of items) c[i.to] = (c[i.to] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} → ${NAMES[t]}`).join(", ");
}

function render(sid, trigger, prompts, s, v, title) {
  const why = { compact: "before compact", "500k": "context passed 500k", end: "end of chat" }[trigger] || trigger;
  const named = trigger === "end" && title ? ` · ${clip(title, 50)}` : ""; // shown in the next chat: say which one
  const head = `Model check (${why}${named}) · ${plural(prompts.length, "prompt")} · ${fmt(s.totalTok)} tokens · mostly ${modelName(s.main)}${s.effort ? ` ${s.effort}` : ""}`;
  const lines = [head];
  const ok = prompts.length - s.down.length - s.up.length;
  const small = s.notWorth ? ` (${plural(s.notWorth, "small prompt")} fit a cheaper model, but switching would have cost more than it saved)` : "";
  if (!s.down.length && !s.up.length) lines.push(`✓ Right model for every prompt${small}.`);
  else lines.push(`✓ Right model for ${ok} of ${prompts.length}${small}.`);
  const eg = (items) => items.slice(0, 2).map((i) => `    #${i.n} "${clip(i.text, 50)}" → ${NAMES[i.to]}${i.why ? ` (${i.why})` : ""}`);
  if (s.down.length) {
    lines.push(`↓ Too big for ${s.down.length} (${groups(s.down)}): ~${s.pct}% less usage, ≈${fmt(s.savedTok)} of ${fmt(s.totalTok)} tokens (~$${s.saved.toFixed(2)} at API prices).`);
    lines.push(...eg(s.down));
  }
  if (s.up.length) {
    lines.push(`↑ Too small for ${s.up.length} (${groups(s.up)}): ~${s.acc}% more likely right the first time (estimate).`);
    lines.push(...eg(s.up));
  }
  const rec = String(v.effort || "").toLowerCase();
  if (EFFORTS.includes(rec) && s.effort && rec !== s.effort) lines.push(`Effort: ${rec} would have fit (you ran ${s.effort}).`);
  if (v.note) lines.push(`Work: ${clip(String(v.note), 140)}`);
  return lines.join("\n");
}

/** Runs one review (detached from the hook, so compaction and replies never wait for it). */
function worker(sid, file, trigger, cwd, dry) {
  const lock = path.join(DIR, `${sid}.lock`);
  fs.mkdirSync(DIR, { recursive: true });
  // One review per session at a time: wait for a running one (max 3 min), then review what it left.
  for (let i = 0; i < 90 && !dry; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); break; } catch {}
    try { if (Date.now() - fs.statSync(lock).mtimeMs > 5 * 60_000) fs.unlinkSync(lock); } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  try {
    const st = dry ? { offset: 0 } : loadState(sid);
    const { prompts, end, title } = readStretch(file, st.offset || 0);
    if (!prompts.length) return log(`${sid.slice(0, 8)} ${trigger}: nothing new since the last check`);
    // A chat that ends after a quick question or two isn't worth a check.
    const spent = prompts.reduce((a, p) => a + [...p.msgs.values()].reduce((b, e) => b + tokens(e.usage), 0), 0);
    if (trigger === "end" && spent < END_MIN) return log(`${sid.slice(0, 8)} end: only ${fmt(spent)} tokens, skipped`);
    const v = grade(digest(prompts, title));
    if (!v) return;
    const s = score(prompts, v);
    const text = render(sid, trigger, prompts, s, v, title);
    if (dry) return console.log(text);
    saveState(sid, { offset: end });
    // The terminal shows it at the end of the next reply (of the next chat in this folder, once this one ended).
    if (trigger !== "end") fs.writeFileSync(pendingFile(sid), text);
    else if (cwd) fs.writeFileSync(folderPendingFile(cwd), text);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(DIR, `${sid}-${stamp}.json`), JSON.stringify({ session: sid, trigger, title, at: new Date().toISOString(), cwd, prompts: prompts.length, ...s, verdict: v, text }, null, 1));
    log(`${sid.slice(0, 8)} ${trigger}: ${prompts.length} prompts, ${s.down.length} too big, ${s.up.length} too small`);
  } catch (e) {
    log(`worker error: ${e.stack || e}`);
  } finally {
    if (!dry) try { fs.unlinkSync(lock); } catch {}
  }
}

function startWorker(s, trigger) {
  spawn(process.execPath, [SELF, "--worker", s.session_id, s.transcript_path, trigger, s.cwd || ""], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

try {
  if (process.env.CLAUDE_ROUTER_CHILD || fs.existsSync(path.join(HERE, "off"))) process.exit(0); // Auto model is off
  const [mode, sid, file, trigger, ...rest] = process.argv.slice(2);
  // Manual run: node review.mjs --worker <session id> <transcript> <label> [folder] [--dry]
  if (mode === "--worker") { worker(sid, file, trigger, rest.find((x) => x !== "--dry") || "", rest.includes("--dry")); process.exit(0); }

  const s = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  if (!s.session_id || !s.transcript_path) process.exit(0);
  if (s.hook_event_name === "PreCompact") startWorker(s, "compact");
  // /clear, exit, /resume to another chat: check what's left. A check still waiting for this chat's
  // next reply would never show; the end-of-chat check carries on from where it stopped.
  if (s.hook_event_name === "SessionEnd") {
    try { fs.unlinkSync(pendingFile(s.session_id)); } catch {}
    startWorker(s, "end");
  }
  if (s.hook_event_name === "Stop") {
    const ctx = contextTokens(s.transcript_path);
    const st = loadState(s.session_id);
    if (ctx !== null && ctx >= LIMIT && !st.over) { saveState(s.session_id, { over: true }); startWorker(s, "500k"); }
    else if (ctx !== null && ctx < LIMIT && st.over) saveState(s.session_id, { over: false }); // compacted: the next 500k counts again
    // A finished review shows at the end of the reply: this chat's own, and one from a chat that
    // ended in this folder within the hour (after /clear, the chat before in this terminal).
    const texts = [];
    for (const [pend, maxAge] of [[pendingFile(s.session_id), Infinity], [s.cwd ? folderPendingFile(s.cwd) : "", 3600_000]]) {
      if (!pend || !fs.existsSync(pend)) continue;
      if (Date.now() - fs.statSync(pend).mtimeMs < maxAge) texts.push(fs.readFileSync(pend, "utf8"));
      fs.unlinkSync(pend);
    }
    if (texts.length) process.stdout.write(JSON.stringify({ systemMessage: texts.join("\n\n") }));
  }
} catch (e) {
  log(`hook error: ${e.stack || e}`); // never break a session because the check broke
}
process.exit(0);

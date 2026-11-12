// Auto model, part 1 (installed by Island: Activities > Claude Sessions > Auto model).
// UserPromptSubmit hook: asks Haiku which model + effort fits the prompt.
// Mismatch -> the prompt is held and blocked with a "switch to X" message.
// After switching (/model, /effort), typing "go" runs the held prompt.
// SessionStart / PostModelSwitch hooks: remember the session's model.
// Pause switch: create ~/.claude/model-router/off (the Island's "Auto model" button).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(os.tmpdir(), "claude-router");
const MODELS = ["haiku", "sonnet", "opus"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const NAMES = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

const allow = () => process.exit(0);
const reply = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };

const tierOf = (id = "") => MODELS.find((m) => id.toLowerCase().includes(m));

const stateFile = (sid) => path.join(STATE, `${sid}.json`);
const effortOf = (e) => (typeof e === "string" ? e : e?.level);

/** The default model in Claude Code's settings (next to this folder), e.g. "opus". */
function defaultModel() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, "..", "settings.json"), "utf8")).model; } catch { return undefined; }
}

// Current model: what SessionStart / PostModelSwitch (or a status line) last saved, else the
// model of the last reply, else the default one (first prompt). Effort: the hook's own input,
// else the saved one, else the session's environment.
function currentState(s) {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile(s.session_id), "utf8")); } catch {}
  if (!st.model) st.model = lastAssistant(s)?.model || process.env.ANTHROPIC_MODEL || defaultModel();
  st.effort = effortOf(s.effort) || st.effort || process.env.CLAUDE_EFFORT;
  return st;
}

/** SessionStart / PostModelSwitch: save the session's model for the next prompt. */
function rememberModel(s) {
  const model = s.to_model || (typeof s.model === "string" ? s.model : s.model?.id);
  if (!s.session_id || !model) return;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile(s.session_id), "utf8")); } catch {}
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(stateFile(s.session_id), JSON.stringify({ ...st, model, effort: effortOf(s.effort) || st.effort }));
}

// Last assistant message in the transcript (reads only the tail of the file).
function lastAssistant(s) {
  if (!s.transcript_path) return null;
  try {
    const size = fs.statSync(s.transcript_path).size;
    const len = Math.min(size, 400_000);
    const fd = fs.openSync(s.transcript_path, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"type":"assistant"')) continue;
      try {
        const m = JSON.parse(line).message;
        const text = (m?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        if (text) return { model: m.model, text };
      } catch {}
    }
  } catch {}
  return null;
}

function classify(s, cur) {
  const prev = lastAssistant(s)?.text?.slice(-1500);
  const input = [
    `Current model: ${cur.model || "unknown"}, effort: ${cur.effort || "unknown"}`,
    prev ? `Previous assistant reply (end):\n${prev}` : "",
    `User request:\n${s.prompt}`,
  ].filter(Boolean).join("\n\n");
  const r = spawnSync("claude", [
    "-p", "--model", "haiku", "--effort", "low",
    "--setting-sources", "", "--strict-mcp-config", "--tools", "",
    "--system-prompt-file", path.join(HERE, "rubric.md"),
  ], {
    input, encoding: "utf8", timeout: 20_000, windowsHide: true,
    env: { ...process.env, CLAUDE_ROUTER_CHILD: "1" },
  });
  const json = (r.stdout || "").match(/\{[^{}]*\}/)?.[0];
  if (!json) return null;
  const pick = JSON.parse(json);
  return MODELS.includes(pick.model) ? pick : null;
}

try {
  if (process.env.CLAUDE_ROUTER_CHILD) allow();
  if (fs.existsSync(path.join(HERE, "off"))) allow();

  const s = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  // Silent: SessionStart's output would go to Claude.
  if (s.hook_event_name === "SessionStart" || s.hook_event_name === "PostModelSwitch") { rememberModel(s); allow(); }
  const prompt = (s.prompt || "").trim();
  const holdFile = path.join(STATE, `${s.session_id}.hold`);

  // "go" -> release the held prompt.
  if (/^go[.!]?$/i.test(prompt) && fs.existsSync(holdFile)) {
    const held = fs.readFileSync(holdFile, "utf8");
    fs.unlinkSync(holdFile);
    reply({
      systemMessage: `Router: running your held prompt.`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `"go" means: carry out the user's real request below now. It was held while they switched model.\n\n<held_request>\n${held}\n</held_request>`,
      },
    });
  }

  // Resending the blocked prompt (no "go") = keep the current model.
  if (fs.existsSync(holdFile)) {
    const held = fs.readFileSync(holdFile, "utf8").trim();
    fs.unlinkSync(holdFile);
    if (held === prompt) allow();
  }

  if (prompt.startsWith("/") && !/^\/[\w:-]+\s+\S/.test(prompt)) allow(); // bare slash command
  if (prompt.split(/\s+/).length <= 3) allow(); // "yes", "continue", ...
  // A short question is cheap on any model; skipping it saves the Haiku check too.
  if (prompt.split(/\s+/).length <= 15 && /^(what|who|when|where|which|why|how (much|many|do|does|is|are)|is|are|does|do|can|define|convert|translate)\b|\?$/i.test(prompt)) allow();

  const cur = currentState(s);
  const curTier = tierOf(cur.model);
  if (!curTier) allow(); // unknown model (e.g. Fable): don't guess

  const pick = classify(s, cur);
  if (!pick) allow();
  if (process.env.ROUTER_DEBUG) console.error(JSON.stringify(pick));

  const curLabel = `${NAMES[curTier]}${cur.effort ? ` · ${cur.effort}` : ""}`;

  // Only block when the mismatch is exaggerated: haiku <-> opus, or very clear sonnet <-> opus.
  const gap = MODELS.indexOf(pick.model) - MODELS.indexOf(curTier);
  // Sonnet <-> Opus also counts, but only when Haiku is very sure (>= 0.9).
  const involvesSonnetOpus = gap !== 0 && curTier !== "haiku" && pick.model !== "haiku";
  // Only big/important work is worth interrupting: on a tiny prompt the switch costs more than it saves.
  const big = pick.size === "large";
  if (big && ((Math.abs(gap) >= 2 && pick.confidence >= 0.7) || (involvesSonnetOpus && pick.confidence >= 0.9))) {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(holdFile, s.prompt);
    const dir = gap < 0 ? "overkill" : "too weak";
    const effort = pick.effort === cur.effort ? "" : ` + /effort ${pick.effort}`;
    reply({
      decision: "block",
      reason: `Router: ${curLabel} is ${dir}, use ${NAMES[pick.model]} (/model ${pick.model}${effort}) then type go, or resend to keep ${NAMES[curTier]}.`,
    });
  }
  allow();
} catch {
  allow(); // never block work because the router broke
}

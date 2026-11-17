# Codex in Island Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This plan is executed inline by the session that wrote it (Moss: no subagents, lean tokens), so it pins files, interfaces, tests and commands and leaves out full code listings.

**Goal:** Codex chats behave in Island the way Claude Code chats do: pill, permission cards, reply window, limits, pushes, open/continue, phone chat.

**Architecture:** `island-hook <agent> <Event>` tags hook events with the agent; the pipe routes them; a shared `AgentActivity` engine (split out of the Claude activity) drives the UI; `ClaudeActivity` and `CodexActivity` supply sessions, limits and open/continue. Codex's hooks live in `~/.codex/hooks.json` and are trusted through `codex app-server`.

**Tech Stack:** Rust (Tauri 2, tokio, serde_json, windows-rs), TypeScript (Vite, Vitest), Codex CLI 0.158 hooks + app-server JSON-RPC.

Spec: `docs/superpowers/specs/2026-10-30-codex-in-island-design.md`. Probe harness: `C:\tmp\codex-probe` (`fake.mjs` fake OpenAI server on :18080, `drive.mjs` app-server driver, `dump.mjs` hook recorder, `home\` throwaway CODEX_HOME).

## Ground rules

- Commands run from `windows-dynamic-island\`. Cargo: `CARGO_TARGET_DIR` stays `%LOCALAPPDATA%\windows-dynamic-island\target` (scripts/tauri.mjs sets it); never a bare `cargo` without it (OneDrive).
- Checks: `npx tsc --noEmit`, `npx vitest run <file>`, `cargo test --manifest-path hook/Cargo.toml`, `cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>` (with `CARGO_TARGET_DIR` set).
- Other sessions may edit this repo: `git status --short` before touching shared files (`app.ts`, `island.css`, `catalog.ts`, `lib.rs`); commit nothing until Moss says (his rule), so "Commit" steps are replaced by a green check run.
- Claude's behaviour must not change: `test/claude-island.test.ts`, `test/claude-chat.test.ts`, `test/claude-logic.test.ts`, `test/claude-pushes.test.ts` stay green with at most import-path edits.

## File map

| File | Change |
|---|---|
| `hook/src/main.rs` | `island-hook <agent> <Event>`, `agent` field, per-agent `waits_for` / `output_json` |
| `src-tauri/src/pipe.rs` | per-agent waiting rules, `agent` in logs |
| `src-tauri/src/hooks.rs` | make `unified_diff`, `fingerprint`, `stamp` `pub(crate)` |
| `src-tauri/src/codex.rs` (new) | `codex_env`, find codex.exe, Codex hooks.json install/remove/status/preview, trust via app-server, `codex_resume`, CLI flags |
| `src-tauri/src/fsx.rs` | `codex_rollout_scan(path, offset)` |
| `src-tauri/src/lib.rs` | register commands, `--install-codex-hooks` / `--remove-codex-hooks` |
| `src/core/native.ts` | bindings for the new commands |
| `src/activities/claude/hooks.ts` | `agent?: string` on `HookEvent` |
| `src/activities/agent/engine.ts` (new) | `AgentActivity`: everything agent-neutral from `claude/index.ts` |
| `src/activities/agent/brand.ts` (new) | `AgentBrand` (id, name, product, icon, tone, moments) |
| `src/activities/claude/index.ts` | `ClaudeActivity extends AgentActivity` (Claude-only parts) |
| `src/activities/codex/rollout.ts` (new) | pure rollout folding |
| `src/activities/codex/limits.ts` (new) | pure `rate_limits` → `UsageData` |
| `src/activities/codex/tracker.ts` (new) | Codex sessions from hooks + rollouts + processes |
| `src/activities/codex/index.ts` (new) | `CodexActivity extends AgentActivity` |
| `src/activities/catalog.ts`, `registry.ts` | `codex` entry |
| `src/core/segments.ts`, `src/activities/external.ts`, `src/core/icons.ts`, `src/styles/island.css`, `src/styles/app.css`, `phone/web/src/phone.css` | `codex` tone + icon |
| `src/app.ts` | Codex panel (shared with Claude's by agent id) + "Answer Claude and Codex from my phone" |
| `src/core/onboarding.ts` | offer Codex when `~/.codex` exists |
| `test/codex-*.test.ts` (new) | rollout, limits, tracker, activity |
| `docs/ARCHITECTURE.md`, `docs/STATUS.md` | Codex section, status entry |

---

### Task 1: The relay knows which AI is calling

**Files:** Modify `hook/src/main.rs` (tests in the same file).

- [ ] **Step 1: Failing tests** in `mod tests`:
  - `parse_agent(&["island-hook","codex","Stop"])` → `("codex","Stop")`; `["island-hook","Stop"]` → `("claude","Stop")`; `["island-hook","PermissionRequest"]` → `("claude","PermissionRequest")`.
  - `waits_for("codex","PermissionRequest","Bash") == Some(DECISION_BUDGET)`, `waits_for("codex","Stop","") == Some(REPLY_BUDGET)`, `waits_for("codex","PreToolUse","AskUserQuestion") == None`, Claude's existing cases unchanged (`waits_for("claude", …)`).
  - `output_json("codex","PermissionRequest","allow")` equals Claude's allow JSON; `output_json("codex","Stop",r#"{"kind":"reply","text":"go"}"#)` has `decision == "block"`; `output_json("codex","PreToolUse",<answer>)` is `None`.
- [ ] **Step 2:** `cargo test --manifest-path hook/Cargo.toml` → the new tests fail to compile.
- [ ] **Step 3: Implement.** `const AGENTS: &[&str] = &["codex"];` `fn parse_agent(args) -> (String, String)`: if `args[1]` is in `AGENTS`, agent = it and the event arg = `args[2]`, else agent `claude` and the event arg = `args[1]`. `main()` routes `Some(a) if AGENTS.contains(a)` to `hook_mode()` too. `read_event()` takes the event arg from `parse_agent` and inserts `"agent"`. `waits_for(agent, event, tool)`: the `("PreToolUse","AskUserQuestion")` arm only for `claude`. `output_json(agent, event, answer)`: `PreToolUse` arm only for `claude`; PermissionRequest/Stop arms shared. Update the module doc comment (forms list).
- [ ] **Step 4:** `cargo test --manifest-path hook/Cargo.toml` → all pass.

### Task 2: The pipe routes by agent

**Files:** Modify `src-tauri/src/pipe.rs`.

- [ ] **Step 1: Failing test** `waits_by_agent`: `fn limits_for(agent, event, tool) -> Option<(Duration, Duration)>`; `("codex","PreToolUse","AskUserQuestion")` → `None`; `("codex","PermissionRequest","Bash")` → decision; `("codex","Stop","")` → reply; `("claude","PreToolUse","AskUserQuestion")` → decision.
- [ ] **Step 2:** run `cargo test … --lib pipe::` → fails.
- [ ] **Step 3:** extract the `match (event, tool)` in `handle()` into `limits_for(agent, …)`; read `agent` (default `"claude"`); log lines say `hook <agent> <event>`.
- [ ] **Step 4:** `cargo test … --lib pipe::` → pass.

### Task 3: Hook events carry the agent; Claude ignores others

**Files:** Modify `src/activities/claude/hooks.ts` (`agent?: string` on `HookEvent`), `src/activities/claude/index.ts` (`onHook`: `if ((ev.agent ?? 'claude') !== 'claude') return;`). Test: `test/claude-island.test.ts`.

- [ ] **Step 1: Failing test** (new `it` in "permission and question cards"): emitting `hook` with `{hook_event_name:'PermissionRequest', agent:'codex', session_id:'S1', request_id:'r9', tool_name:'Bash'}` leaves `act` with no cards and `hookReply` uncalled.
- [ ] **Step 2:** `npx vitest run test/claude-island.test.ts` → the new test fails.
- [ ] **Step 3:** implement the guard.
- [ ] **Step 4:** run again → all pass.

### Task 4: Split the engine out of the Claude activity

**Files:** Create `src/activities/agent/brand.ts`, `src/activities/agent/engine.ts`; modify `src/activities/claude/index.ts`.

`brand.ts`:
```ts
import type { MomentId } from '../../core/pet';
import type { Tone } from '../../core/segments';
export interface AgentBrand {
  id: 'claude' | 'codex';
  /** "Claude" / "Codex": the short name in sentences ("Claude finished"). */
  name: string;
  /** "Claude Code" / "Codex": the product, in fallbacks and the tile. */
  product: string;
  icon: string;
  tone: Tone;
  moments: { asks: MomentId; done: MomentId; error: MomentId };
}
```

`engine.ts`: `export abstract class AgentActivity extends BaseActivity` holding, moved verbatim from `ClaudeActivity` with `'Claude'`/`'Claude Code'`/`'claude'` tone/icon/moment literals replaced by `this.brand.*`: the fields `hooks`, `sessions`, `closed`, `usageState`, `tokenTotals`, `selected`, `inputFor`, `finished`, `pushes`, `phoneCodes`, `notice`, `pollTimer`, `looking`, `picks`, `tracker` (typed `AgentTracker`); and the methods from "the reply window" through "views", "the card under the pill" (except Claude-only blocks), `action()` cases that are not phone-chat or desktop, `dismiss`, `status`, `chip`, `pet`, `tile`, `limitsNow`, `checkResets`. Hook handling starts with the agent guard (`(ev.agent ?? 'claude') !== this.brand.id`).

```ts
export interface AgentTracker {
  readonly probe: { table: Map<number, unknown>; ancestors(pid: number): Array<{ pid: number; name: string }>; load(rows: unknown): void; runningEditor?(): string | null };
  get(id: string): SessionView | null;
  getClosed(id: string): ClosedView | null;
  poll(): Promise<{ sessions: SessionView[]; closed: ClosedView[]; events: TrackerEvent[] }>;
}
```

Abstract / overridable (protected):
- `abstract readonly brand: AgentBrand`
- `abstract switchTo(id: string, source?: string): Promise<boolean>`
- `abstract reopen(id: string): Promise<boolean>`
- `protected abstract continueSession(id: string, text: string): Promise<void>`
- `protected openText(s): string`, `protected lateHint(s): string`, `protected hoverExtras(now): Block[]` (default `[]`), `protected phoneSheet(now): SheetView | null` (default `null`), `protected agentAction(verb, ref, id, arg): Promise<boolean>` (default `false`; Claude handles chat/say/open-desktop there), `protected options(): AgentOptions` (shared option parsing; Claude adds `sessionHotkeys`, `showDesktop`).

`ClaudeActivity extends AgentActivity`: `brand = { id:'claude', name:'Claude', product:'Claude Code', icon:'claude', tone:'claude', moments:{asks:'claude-asks',done:'claude-done',error:'claude-error'} }`, `init()` (unchanged), polling, usage, desktop chats, `switchTo`, `reopen`, `openInEditor`, `moveToEditor`, `continueSession`, the phone chat card, hotkeys, tray, `command()`, demo.

- [ ] **Step 1:** create `brand.ts`; move code into `engine.ts` as above; keep `ClaudeActivity`'s public surface (`sessions`, `closed`, `chats`, `usageState`, `tokenTotals`, `forks`, `recentFolders`, `messageChat`, `switchTo`, `reopen`, `dismiss`, `action`, `command`, `hotkeys`, `hotkey`, `tray`, `sheet`, `tile`, `render`, `status`, `chip`, `pet`).
- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3:** `npx vitest run test/claude-island.test.ts test/claude-chat.test.ts test/claude-logic.test.ts test/claude-pushes.test.ts test/claude-estimate.test.ts` → all pass, no test edits beyond imports.
- [ ] **Step 4:** `npx vitest run` (whole suite) → same count passing as before the split (record the count first).

### Task 5: Codex tone, icon, catalog entry

**Files:** `src/core/segments.ts` (`Tone` += `'codex'`), `src/activities/external.ts` (TONES += `'codex'`), `src/core/icons.ts` (`codex` glyph: a rounded cloud outline with a `>_` inside, stroke style like the others), `src/styles/island.css` (`--codex: #8b93ff` dark, `#4f5bd5` in the light-pill block, `.tone-codex`, `.seg-meter.tone-codex`), `src/styles/app.css` (`--codex`, `.tone-codex`), `phone/web/src/phone.css` (`--codex`, `.tone-codex`), `src/activities/catalog.ts` (entry after `claude`: id `codex`, name `Codex`, `mac: 'soon'`, category developer, enabled true, priority high, `B(true,false,true,true)`, options: resetAlerts, notifications, phone, showLimits, finishedSeconds, onlyOtherChats, replyWindowSeconds, requireHello with Codex wording), `src/activities/registry.ts` (`['codex', () => new CodexActivity()]`, added in Task 10).

- [ ] **Step 1:** add tone + icon + CSS; `npx tsc --noEmit` clean.
- [ ] **Step 2:** catalog entry; `npx vitest run test/catalog*.test.ts test/settings*.test.ts` (whatever covers the catalog; `ls test | grep -i catalog`) → pass.

### Task 6: Rust: find Codex, scan rollouts, resume

**Files:** Create `src-tauri/src/codex.rs`; modify `src-tauri/src/fsx.rs`, `src-tauri/src/lib.rs`, `src/core/native.ts`.

- `codex_home() -> PathBuf`: `CODEX_HOME` env if set, else `%USERPROFILE%\.codex`.
- `find_codex_exe() -> Option<PathBuf>`: `where codex.exe` on PATH; else npm's vendored exe under `%APPDATA%\npm\node_modules\@openai\codex\vendor\**\codex.exe` (newest); else newest `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` by modified time.
- `#[tauri::command] codex_env() -> Option<CodexEnv { home, sessionsDir, archivedDir, indexPath, codexExe: Option<String>, hookExe, hookReady }>`: `None` when `codex_home()` doesn't exist.
- `#[tauri::command] codex_resume(session_id, cwd, prompt: Option<String>, minimized: bool) -> bool`: `is_uuid` check, `spawn_console(codex_exe, ["resume", id, prompt?], cwd, minimized)` (reuse `claude::spawn_console`, `claude::quote_arg`, `claude::clean_prompt`, made `pub(crate)`).
- `fsx::codex_rollout_scan(path, offset: f64) -> Option<RolloutScan { size, lines: Vec<Value> }>`: reads from `offset` to the last full line (max 8 MiB per call), keeps only `session_meta` (payload minus `base_instructions`/`instructions`/`dynamic_tools`), `event_msg` of type `task_started|task_complete|turn_aborted|token_count|user_message|agent_message|error`, `response_item` `message` (role user/assistant only, text parts only), `response_item` `function_call` (name + arguments cut to 300), each string cut to 4000 chars; plus `timestamp`.
- [ ] **Step 1: Failing cargo tests** in `fsx.rs`: a temp file with the probe's lines (copy 8 lines from `C:\tmp\codex-probe\home\archived_sessions\*.jsonl` into `src-tauri/src/testdata/codex-rollout.jsonl`); scan from 0 keeps `session_meta`, two `token_count`, `task_complete`, the user and assistant messages, drops `developer` messages and `world_state`; scanning from the returned `size` returns no lines; a half-written last line is not returned.
- [ ] **Step 2:** run `cargo test … --lib fsx::` → fail. **Step 3:** implement. **Step 4:** pass.
- [ ] **Step 5:** register `codex::codex_env`, `codex::codex_resume`, `fsx::codex_rollout_scan` in `lib.rs`; bindings in `native.ts`: `codexEnv()`, `codexResume(sessionId, cwd, prompt, minimized)`, `codexRolloutScan(path, offset)`; `npx tsc --noEmit` clean.

### Task 7: Install and trust Codex hooks

**Files:** `src-tauri/src/codex.rs`, `src-tauri/src/hooks.rs` (helpers `pub(crate)`), `src-tauri/src/lib.rs`, `src/core/native.ts`.

- `CODEX_EVENTS: &[(&str, u64)] = [("SessionStart",10),("SessionEnd",3),("UserPromptSubmit",10),("PreToolUse",10),("PostToolUse",10),("PermissionRequest",120),("Stop",300),("Interrupt",3),("SubagentStop",10)]`.
- `codex_hook_command(exe: &Path, event) -> String` = `& '<exe with ' doubled>' codex <event>` (backslashes kept: PowerShell paths).
- `merged`/`without_ours`/`entry_is_ours` like hooks.rs but on `hooks.json` (`{"hooks": {...}}`, keep any other top-level keys), marker `island-hook`.
- `codex_hooks_status() -> CodexHookStatus { installed, upToDate, trusted: Option<bool>, codexFound, hooksPath, hookPath, hookReady, error: Option<String> }` (trust unknown here: `None`; the panel asks `codex_hooks_trust_check` separately because it starts codex.exe).
- `codex_hooks_preview(install) -> { diff, backup, hooksPath, fingerprint, trust: Vec<String> }` (`trust` = the `hooks.state.'<hooks.json path>:<event_snake>:<group>:0'` lines the click will write, computed from the merged file: group index = position of Island's entry in that event's list).
- `codex_hooks_write(install, fingerprint) -> { ok, backup?, error?, trust? }`: backup + write like hooks.rs; when installing, then `trust_island_hooks()`.
- `trust_island_hooks() -> Result<Vec<(String, String)>, String>` (event, status): spawns `codex.exe app-server` (`NoWindow`, stdin/stdout piped, env `CODEX_HOME` passed through), JSON-RPC lines: `initialize {clientInfo:{name:"island",title:"Island",version}, capabilities:{experimentalApi:true, requestAttestation:false}}` → `initialized` → `hooks/list {cwds:[home]}` → for entries whose `command` contains `island-hook` and `trustStatus` is `untrusted|modified`: one `config/batchWrite {edits:[{keyPath:"hooks.state.\"<key>\".trusted_hash", value:currentHash, mergeStrategy:"upsert"}], reloadUserConfig:true}` → `hooks/list` again → kill. 20 s overall budget; a JSON-RPC `error` or early exit returns `Err(<message + last stderr line>)`.
- `codex_hooks_trust_check() -> { trusted: bool, error? }`: the same session without the write.
- Pure helpers tested without codex.exe: `trust_edits(list_reply: &Value) -> Vec<Value>` and `trust_summary(list_reply) -> Vec<(event, status)>`.
- `cli(install)` for `--install-codex-hooks` / `--remove-codex-hooks` in `lib.rs` next to the Claude flags.
- [ ] **Step 1: Failing cargo tests** in `codex.rs`: command quoting (`C:\Users\O'Neil\AppData\Local\Island\bin\island-hook.exe` → `& 'C:\Users\O''Neil\…\island-hook.exe' codex Stop`); merge keeps someone else's `Stop` hook and `description`, adds ours with timeout 300, installing twice is idempotent, removing restores the original; `trust_edits` on a recorded `hooks/list` reply (save the probe's reply as `src-tauri/src/testdata/codex-hooks-list.json`, with commands rewritten to `island-hook`) returns one edit per untrusted Island hook and none for a trusted one or someone else's.
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** pass.
- [ ] **Step 5: Real check** against the probe home: `CODEX_HOME=C:\tmp\codex-probe\home` + a debug build's `--install-codex-hooks` writes `home\hooks.json` with Island's entries next to the dump ones and `hooks/list` (via `drive.mjs`) reports them `trusted`.
- [ ] **Step 6:** register commands, `native.ts` bindings `codexHooksStatus()`, `codexHooksPreview(install)`, `codexHooksWrite(install, fingerprint)`, `codexHooksTrustCheck()`; `npx tsc --noEmit` clean.

### Task 8: Read rollouts and limits (pure)

**Files:** Create `src/activities/codex/rollout.ts`, `src/activities/codex/limits.ts`, `test/codex-rollout.test.ts`, `test/fixtures/codex-rollout.json` (the scanned lines from Task 6's fixture, as `RolloutLine[]`).

`rollout.ts`:
```ts
export interface RolloutLine { timestamp?: string; type: string; payload?: Record<string, unknown> }
export interface RolloutSummary {
  id: string | null; cwd: string | null; originator: string | null; source: string | null; version: string | null; model: string | null;
  firstPrompt: string | null; lastPromptAt: number | null; lastAssistant: string | null; lastActivityMs: number;
  turnOpen: boolean; aborted: boolean; turnStartMs: number | null; turns: number[];
  context: { used: number; window: number } | null;
  limits: { at: number; raw: unknown } | null;
  tokens: Array<{ at: number; input: number; cached: number; output: number }>;
}
export function emptySummary(): RolloutSummary;
export function foldRollout(s: RolloutSummary, lines: RolloutLine[]): RolloutSummary;
export function isContextText(text: string): boolean; // starts with "<" + tag-ish, or "# AGENTS.md"
export function chatMessages(lines: RolloutLine[], max: number): ChatMessage[]; // ChatMessage from claude/transcript.ts
```
`limits.ts`: `export function codexLimits(raw: unknown, now: number): UsageData | null` (windows by `window_minutes`: 300 → fiveHour, 10080 → sevenDay; otherwise primary → fiveHour, secondary → sevenDay; `pct = used_percent`, `resetsAt = resets_at * 1000`; `models: []`).

- [ ] **Step 1: Failing tests**: folding the fixture gives `id` `01a18eb4-…`, `cwd` `C:\tmp\codex-probe\work`, `firstPrompt` "please PROBE-TOOL now", `lastAssistant` "All done. Wrote probe.txt.", `turnOpen` false, two `turns` durations (3545, 873), `context` `{used: 1240, window: 258400}` from the last `last_token_usage.total_tokens`; a `task_started` without `task_complete` → `turnOpen` true; `turn_aborted` → `aborted`; `<environment_context>` messages never become `firstPrompt`; `codexLimits` on the fixture's last `rate_limits` → `fiveHour {pct:42, resetsAt:1793406329000}`, `sevenDay {pct:17, …}`; `null` and `{primary:null}` → `null`; swapped windows (primary = 10080) still map by length.
- [ ] **Step 2:** `npx vitest run test/codex-rollout.test.ts` → fail. **Step 3:** implement. **Step 4:** pass.

### Task 9: Codex sessions tracker

**Files:** Create `src/activities/codex/tracker.ts`, `test/codex-tracker.test.ts`.

`CodexTracker implements AgentTracker`: `constructor(env: CodexEnv)`; `probe = new ProcessProbe()`; `noteHook(ev: HookEvent, now)` (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd/Interrupt update live state: `pid` = parent of `hook_ppid` when that parent is `codex.exe`, else `hook_ppid`'s nearest `codex.exe` ancestor; `transcript_path`; `turnOpen`; ended); `poll()`: lists rollouts via `native.listFiles(sessionsDir, true, '.jsonl', 2 days)`, scans changed ones incrementally (`codexRolloutScan(path, offset)`, keep `{offset, summary}` per path), reads `session_index.jsonl` names when its size changes, loads `procSnapshot()` into the probe; builds `SessionView`s (fields as in `claude/tracker.ts`; `entrypoint` = `codex-app` | `codex-editor` | `codex-cli` from host/originator; `host` = app / editor name / terminal name via `classifyAncestry`; `status` = `awaiting_permission` (engine sets it from cards) | `working` (turn open) | `interrupted` | `awaiting_input`; `needsYou` false (the engine's cards do that)). Live = hook-live and process alive, or (no hooks seen in 10 min) rollout touched in the last 10 min. Closed = not live, touched in the last 24 h. Events: `finished` when a live session's turn closes between polls.
`limits()`: the newest `summary.limits` across files → `codexLimits(raw)` plus `asOf`. `weekTokens(windowStart)`: sums `tokens` entries at/after `windowStart`.

- [ ] **Step 1: Failing tests** (native mocked like `claude-island.test.ts`): hooks only (SessionStart + UserPromptSubmit) → one live `working` session titled from the prompt; then Stop → `awaiting_input` with `lastAssistantText`; SessionEnd → moves to `closed`; rollouts only (a fixture file returned by `listFiles` + `codexRolloutScan`) → closed entry with the thread name from `session_index.jsonl`; process gone (procSnapshot without the pid) → closed; limits come from the newest file.
- [ ] **Step 2:** run → fail. **Step 3:** implement. **Step 4:** pass.

### Task 10: The Codex activity

**Files:** Create `src/activities/codex/index.ts`, `test/codex-island.test.ts`; modify `src/activities/registry.ts`.

`CodexActivity extends AgentActivity`: `brand = { id:'codex', name:'Codex', product:'Codex', icon:'codex', tone:'codex', moments:{asks:'claude-asks',done:'claude-done',error:'claude-error'} }`; `init()`: listens like Claude (hook, phone-reply, hook-expired, foreground), `codexEnv()`; null → idle (no tile, quiet); else tracker, `every(3000, poll)`, `watch('codex-sessions', sessionsDir, true)`, `every(10000, tokens)`; usage = `{data: tracker.limits(), source: 'rollout', fetchedAt: asOf}`, and when `asOf` is over 5 minutes old the limit blocks get a muted "As of 12 min ago (Codex updates these after each turn)" line (`hoverExtras`); `onHook` also calls `tracker.noteHook(ev)` before the engine's handling. `switchTo`/`reopen`/`continueSession` per Task 12 (stubs that flash "Open it in Codex" until then).

- [ ] **Step 1: Failing tests** (copy the boot/stub helpers from `claude-island.test.ts` with `CodexActivity`): a Codex `PermissionRequest` hook makes a card whose head says "Run this command?" with the command, Allow answers `allow` through `hookReply`; a Codex `Stop` while not looking holds a reply window and a typed reply sends `{"kind":"reply",…}`; a Claude-tagged hook is ignored by Codex; the hover sheet shows the limit meters from a stubbed `limits()`; `status().summary` is `Codex · Your turn`.
- [ ] **Step 2:** run → fail. **Step 3:** implement + registry entry. **Step 4:** pass; full `npx vitest run` green; `npx tsc --noEmit` clean.

### Task 11: Activities panel and setup

**Files:** `src/app.ts`, `src/core/onboarding.ts`.

- [ ] **Step 1:** make `claudePanel()`/`fillClaude()` take `agent: 'claude' | 'codex'` (title strings, the hooks block calls `codex-hooks-*` commands for Codex); `if (meta.id === 'codex') body.append(agentPanel('codex'))`. Codex's hooks block: status line ("Installed and trusted" / "Installed, not trusted yet: <error>" / "Not installed" / "Codex not found on this PC"), Install/Update/Remove with the diff + trust lines dialog, "Check trust" button (runs the trust check).
- [ ] **Step 2:** `CodexActivity.command()`: `snapshot`, `hooks-preview`, `hooks-write`, `trust-check`, `switch`, `reopen`, `refresh`.
- [ ] **Step 3:** the phone-answer row label "Answer Claude and Codex from my phone".
- [ ] **Step 4:** `onboarding.ts`: `facts.codex` (from `codexEnv()`), `coding: ['claude','codex','servers']`, drop `codex` when absent.
- [ ] **Step 5:** `npx tsc --noEmit`; `npx vitest run test/onboarding*.test.ts`; browser preview check: `npx vite --port 1430`, open `/app.html#activities` (or the Activities route), Codex row and panel render.

### Task 12: Open, continue, reopen

**Files:** `src/activities/codex/open.ts` (new, pure routing), `src/activities/codex/index.ts`, `test/codex-open.test.ts`.

`routeFor(s: SessionView | ClosedView, live: boolean): 'app' | 'editor' | 'terminal' | 'resume'`; `CodexActivity.switchTo`: app → `openUrl('codex://threads/<id>')`; editor → `selectWindow` editor pids by project + `activate`; terminal → `focusSession` (the Claude helper, pid = codex pid); closed → `codexResume(id, cwd, null, false)`. `continueSession`: app/editor → clipboard + open + "press Enter there"; terminal → `claudeInject(pid, text)` (falls back to clipboard + focus); closed → `codexResume(id, cwd, text, true)`.

- [ ] **Step 1: Failing tests** for `routeFor` and for each `continueSession` branch's native calls.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5: Real check:** start `codex` (the CLI, `CODEX_HOME=C:\tmp\codex-probe\home`, fake server) in Windows Terminal, then from a debug Island: Open brings the tab forward, Continue types into it, and a closed chat reopens with `codex resume`.

### Task 13: Codex in the phone app's chat card

**Files:** `src/activities/agent/engine.ts` (generic chat card frame moved from Claude), `src/activities/codex/index.ts`, `test/codex-chat.test.ts`.

- Codex's `phoneSheet` lists chats (live first, then closed), opens one with its last 12 messages (`chatMessages()` over a fresh `codexRolloutScan` of its transcript), and a "Message Codex…" box. `messageChat`: a chat in an Island terminal → typed; live terminal → inject; else → an Island terminal running `codex resume <id> <text>` (new chat: `codex <text>` in the folder).
- [ ] **Step 1: Failing tests** mirroring `claude-chat.test.ts`'s route cases with Codex args.
- [ ] **Step 2–4:** fail → implement → pass.

### Task 14: End to end, docs

- [ ] **Step 1:** build the relay + debug app: `node scripts/tauri.mjs hook` then `node scripts/tauri.mjs dev` (or the debug exe), with `CODEX_HOME=C:\tmp\codex-probe\home` for Codex runs only (Island itself reads the real `~/.codex` unless `CODEX_HOME` is set in its environment: start the debug Island with it set).
- [ ] **Step 2:** Install + trust from the panel; run `node C:\tmp\codex-probe\drive.mjs "please PROBE-TOOL now"` with `answer.json` removed: the permission card shows on the pill; Allow → the turn finishes; repeat with Deny + reason → the probe's hook log shows the deny feedback; a reply typed in the reply window → the fake server's log shows a second turn whose input contains the reply.
- [ ] **Step 3:** limits show 42% / 17% on hover.
- [ ] **Step 4:** `docs/ARCHITECTURE.md`: a "Codex" section (relay form, PowerShell quoting, trust, rollouts, open routes); `docs/STATUS.md`: entry with what was verified and what waits for Moss (a real Codex chat with a ChatGPT login; Moss's config line).
- [ ] **Step 5:** full checks: `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path hook/Cargo.toml`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `cargo clippy` as the repo does it (check `package.json` scripts).

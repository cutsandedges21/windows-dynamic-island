# Codex in Island (and the AIs after it): design

Date: 2026-10-30. Status: approved by Moss in chat; plan next.

Moss asked: "integrate Codex just like Claude currently is", then "add one or two more major AIs that function the same way as Claude". This spec covers sub-project 1: a shared engine split out of the Claude activity, and Codex on it. Cursor and Gemini CLI follow as sub-projects 2 and 3, each with its own spec and plan.

## Decisions (Moss, 2026-10-30)

- Codex is its own activity, like Claude: own switch in Activities, own mark and colour on the pill, own options.
- Code shape: one shared engine plus a "kit" per AI (approach A). The Claude activity's behaviour does not change.
- On Install, Island also marks its own Codex hooks as trusted (Codex skips untrusted hooks). The preview shows the hooks and the trust entries.
- After Codex: Cursor and Gemini CLI.

## What was verified on this PC (C:\tmp\codex-probe, 2026-10-30)

A scripted fake of the OpenAI Responses API drove Codex 0.158.0-alpha.2.1 (the copy the Codex app installed in `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`) through `codex app-server`, with a throwaway `CODEX_HOME`. Moss's `~/.codex` was not touched.

1. Hooks are stable and on by default (`codex features list`: `hooks stable true`). Config: `~/.codex/hooks.json`, the same shape as Claude Code's `hooks` object: `{"hooks": {"<Event>": [{"matcher"?, "hooks": [{"type": "command", "command", "timeout"}]}]}}`. Timeouts are in seconds.
2. Events seen firing: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SessionEnd` (on archive). Also documented: `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Interrupt` (Interrupt and SessionEnd allow at most 3 s).
3. Payload (stdin JSON): `session_id` (= thread id, a UUID v7), `turn_id`, `transcript_path` (the rollout `.jsonl`), `cwd`, `hook_event_name`, `model`, `permission_mode`; plus `prompt` (UserPromptSubmit), `source` (SessionStart: startup/resume/clear/compact/fork), `tool_name`, `tool_input`, `tool_use_id` (tools), `stop_hook_active`, `last_assistant_message` (Stop), `reason` (SessionEnd). Codex's shell tool arrives as `tool_name: "Bash"` with `tool_input.command`, the same as Claude Code's.
4. Answers use Claude Code's formats, unchanged:
   - PermissionRequest: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message"?}}}`. A deny replaced Codex's own approval prompt (no approval request reached the client).
   - Stop: `{"decision":"block","reason":"…"}` continues the chat with `reason` as the next message. The next Stop carries `stop_hook_active: true`.
   - A hook that fails or prints nothing is ignored and Codex carries on.
5. Codex on Windows runs hook commands through `powershell.exe -NoProfile -Command "<command>"`. A quoted path followed by arguments is a PowerShell syntax error, so the command must use the call operator: `& 'C:\…\island-hook.exe' codex Stop`. Process chain: `island-hook` → `powershell.exe` → `codex.exe` (TUI, `exec`, or `app-server`) → its host.
6. Non-ASCII text survives both ways (prompt `héllo café 🚀 ü` arrived intact; a Stop reason with an emoji arrived intact).
7. Trust: `hooks/list` (app-server JSON-RPC over stdio) returns, per hook, `key` (`<source path>:<event_snake>:<group>:<handler>`, e.g. `C:\Users\x\.codex\hooks.json:permission_request:0:0`), `currentHash` (`sha256:…`) and `trustStatus` (`untrusted` | `trusted` | `modified` | `managed`). `config/batchWrite` with `{keyPath: "hooks.state.\"<key>\".trusted_hash", value: currentHash, mergeStrategy: "upsert"}` makes Codex write `[hooks.state.'<key>'] trusted_hash = "sha256:…"` into `config.toml`; `hooks/list` then reports `trusted`, and the hooks run.
8. Session files: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` (archived chats move to `~/.codex/archived_sessions/`). Lines are `{timestamp, type, payload}`:
   - `session_meta`: `id`, `cwd`, `originator` (e.g. `Codex Desktop`, `codex_cli_rs`, `codex_vscode`), `source` (`cli`, `vscode`, `exec`…), `cli_version`, `model_provider`.
   - `event_msg` `task_started` (`turn_id`), `task_complete` (`turn_id`, `last_agent_message`, `duration_ms`), `turn_aborted`, `token_count`.
   - `token_count`: `info.total_token_usage` / `info.last_token_usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`), `info.model_context_window`, and `rate_limits`: `{limit_id, primary: {used_percent, window_minutes, resets_at (unix s)}, secondary: {…}, plan_type, …}` (null for API-key or local-model use).
   - `response_item` `message` with `role` `user` / `assistant` / `developer` and `content[].text`. Context blocks the model gets as user messages start with `<` (`<environment_context>`, …) and are not the user's words. Older files also have `event_msg` `user_message` / `agent_message`.
   - Thread names: `~/.codex/session_index.jsonl` lines `{id, thread_name, updated_at}`.
9. Opening chats: the Codex desktop app (it ships inside the ChatGPT desktop app now) opens a local chat with `codex://threads/<thread id>` (OpenAI's documented link). The Codex editor extension (`openai.chatgpt`) has no public link to a chat. The CLI has `codex resume <id> [prompt]` and `codex queue --thread <id> --message <text>`.

Found on Moss's PC, not part of this work: `~/.codex/config.toml` line 3 `profile = "ollama-launch-codex-app"` makes Codex 0.158 refuse to start ("legacy `profile` config is no longer supported"). Island shows Codex's own error text when that happens; it never edits that file except through Codex's trust call.

## What Moss sees

1. **Activities › Codex** (Developer, like Claude Code): the switch, options (the Claude ones that apply: Windows notification, Send to my phone, Limits in the island, Show "finished" for, Only pop up for other chats, Reply window, Windows Hello to Allow, Limit reset alerts), and a panel: hooks status, Install / Update / Remove with the diff, sessions, Closed recently with Reopen.
2. **The pill**: Codex's mark and colour while a Codex chat works or needs you; "Codex ×2, 1 needs you" with several; the bot codes at its laptop while Codex works and reacts when Codex asks, finishes or errors.
3. **Permission card**: "Run this command?" with the full command, Allow, Deny, a "tell Codex what to do instead" box, the countdown, Windows Hello if set. Unanswered or dismissed, it goes back to Codex's own prompt at once.
4. **Finished card + reply window**: the chat's last message and a reply box; the reply becomes the chat's next message (Stop hook). After the window, a reply goes the "next best way" (see Open and continue).
5. **Limits**: 5-hour and weekly bars with pace on hover and in the expanded pill, reset alerts. They are as fresh as Codex's last turn; the hover card says "as of 12 min ago" when older than 5 minutes.
6. **Phone**: pushes for finished, error, permission (with Allow/Deny when Settings › Notifications › Answer Claude from my phone is on; that row becomes "Answer Claude and Codex from my phone", same setting), needs you. Codex in the phone app's chat card comes last in the build order.
7. **Open and continue**. Where a chat lives comes from its `codex.exe`'s process chain while it is live (Codex app, an editor, or a terminal), else from `originator` in its rollout (`Codex Desktop` = the app; one containing `vscode` = the editor extension; anything else = the CLI). The editor and CLI originator strings and the desktop app's exe name are checked on a real install during the build.
   - Codex app chat: Open = `codex://threads/<id>`; a late reply = open it + text on the clipboard.
   - Editor-extension chat: Open = bring the editor window for that folder forward; a late reply = the same + clipboard ("press Enter there").
   - Live terminal chat: Open = bring its terminal forward; a late reply = `island-hook inject <codex pid>` types it and presses Enter (as for Claude), clipboard fallback.
   - Closed terminal chat: `codex resume <id> "<reply>"` in a new console window in the chat's folder.

Not carried over: Codex's questions (its `request_user_input` tool, Plan mode only) can't be answered by a hook, so the island doesn't show them; Alt+Shift+1–9 session hotkeys stay Claude's; there is no "Codex app chats" list (Codex app chats are ordinary sessions here).

## Architecture

### 1. Relay: `hook/src/main.rs`

- New form `island-hook <agent> <Event>` with agent `codex` (later `cursor`, `gemini`). The old form `island-hook <Event>` stays Claude's, so existing Claude installs keep working.
- Adds `"agent": "<agent>"` to the payload (Claude: `"claude"`, added by the relay too, so routing never guesses).
- `waits_for(agent, event, tool)`: Codex waits on `PermissionRequest` (110 s) and `Stop` (290 s); its `PreToolUse` never waits.
- `output_json(agent, event, answer)`: Codex uses Claude's shapes for PermissionRequest and Stop. Kept per agent so Cursor's `{"permission": …}` / `{"followup_message": …}` fit later.
- Everything else (300 ms connect, budgets, dropped fields, `hook_pid`/`hook_ppid`) is shared.

### 2. Pipe: `src-tauri/src/pipe.rs`

Reads `agent` (default `claude`), logs it, keeps the same waiting rules per agent: `("codex", "PreToolUse")` passes through. The `hook` event carries `agent`; nothing else changes.

### 3. Installer: `src-tauri/src/codex.rs` (new) next to `src-tauri/src/hooks.rs`

- `hooks.rs`: Claude's installer, unchanged in behaviour (settings.json, Git Bash quoting); its diff, fingerprint and timestamp helpers become `pub(crate)`.
- `codex.rs`: `~/.codex/hooks.json` (honours `CODEX_HOME`), with the same merge / remove / backup (`hooks.json.bak-<stamp>`) / diff / fingerprint steps. Events and timeouts: SessionStart 10, SessionEnd 3, UserPromptSubmit 10, PreToolUse 10, PostToolUse 10, PermissionRequest 120, Stop 300, Interrupt 3, SubagentStop 10. Command: `& '<path>' codex <Event>` (single quotes doubled inside the path).
- Trust (also in `codex.rs`): finds `codex.exe` (PATH `codex.exe`/`codex.cmd`'s vendored exe, then the newest `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`), runs `codex app-server` with stdio pipes (no window), `initialize` → `initialized` → `hooks/list {cwds:[home]}` → `config/batchWrite` for Island's entries (command contains `island-hook`) that are not `trusted` → `hooks/list` again, 20 s budget, then kills the process. Returns per-event trust status or Codex's error text.
- Status for the panel: `installed`, `upToDate`, `trusted` (null = unknown until checked), `codexFound`, `error`. The preview lists the hooks.json diff and the trust lines (`hooks.state.'<key>'.trusted_hash`) that the click will write. Install = write hooks.json, then trust; Remove = remove Island's entries from hooks.json (stale trust entries are harmless and left alone).
- CLI: `Island.exe --install-codex-hooks` / `--remove-codex-hooks`, like the Claude ones.

### 4. Shared engine (TypeScript)

`src/activities/agent/` takes the agent-neutral parts of `src/activities/claude/index.ts`:

- `engine.ts`: `AgentActivity extends BaseActivity`: hook handling, permission answers (Allow/Deny/Deny with reason, Hello, phone codes), the reply window (onStop, holds, release on foreground, hold longer, sendReply), finished / needs-you moments, notices, pushes (`PushGate`), status/chip/pet, pill views, the urgent and hover sheets, the tile, generic actions, and the phone chat card frame.
- `hooks.ts`, `pushes.ts`, `phonechat.ts`, `focus.ts`, `procinfo.ts` move to `agent/` with re-exports left in `claude/` so existing imports and tests keep working.
- A kit supplies what differs: `id`, `name` ("Claude" / "Codex"), `mark` icon, `tone`, moment ids, option defaults, `start()` (watchers, polling), `poll()` → sessions / closed / events (same `SessionView` / `ClosedView` shapes), `limits()` → `UsageState`, `tokens()`, `open(id)`, `reopen(id)`, `continue(id, text)`, `lateHint(s)`, `openText(s)`, `messageChat()` routes for the phone, extra hover blocks (Claude app chats), hotkeys, tray items, panel snapshot.
- `ClaudeActivity` = engine + Claude kit (today's tracker, usage API, desktop chats, `claude --resume`, hotkeys). `claude-island.test.ts` (96 tests) and `claude-chat.test.ts` (24) must pass unchanged, apart from import paths.
- Hooks are routed by `agent`: each activity ignores events whose `agent` isn't its own (a missing `agent` means Claude).

### 5. Codex kit: `src/activities/codex/`

- `rollout.ts` (pure, tested): folds rollout lines into a session summary: id, cwd, originator, source, title (thread name, else the first real user message), status (turn open = working; `task_complete` = your turn; `turn_aborted` = interrupted), last assistant message, last activity time, model context fill, last `rate_limits` with its timestamp, token totals.
- `tracker.ts`: live sessions from hooks first (SessionStart / UserPromptSubmit make a chat live; SessionEnd or its `codex.exe` exiting closes it; the codex pid comes from `hook_ppid`'s parent, checked against the process table), filled in from rollouts. Without hooks: rollouts touched in the last 10 minutes show as live, and a turn still open counts as Working. Rollouts from the last 24 hours that are not live make "Closed recently". Names from `session_index.jsonl`.
- `limits.ts` (pure, tested): the newest `rate_limits` across recent rollouts → `UsageData` (`fiveHour` = the window with `window_minutes` 300, `sevenDay` = 10080; else primary/secondary by size), `resets_at` × 1000, plus `asOf`. Past reset times show 0% (the engine's `limitsNow`).
- `open.ts`: the open/continue/reopen rules from "What Moss sees" 7.
- Rust: `codex_env` (codex home, codex.exe path or null, hook exe), `codex_rollout_scan(path, offset)` in `fsx.rs` (incremental, returns only the line kinds above, long strings cut, like `claude_transcript_meta`), `codex_resume(id, cwd, prompt)` (new console; reuses `spawn_console`), the hook commands above. Inject reuses `claude_inject` (it is agent-neutral: it types into a pid's console).

### 6. Look

- Mark: a Codex glyph, `codex` in `src/core/icons.ts` (next to `claude`).
- Colour: a new `codex` tone, `#8b93ff` (indigo) in dark and `#4f5bd5` in light pills, set in `src/styles/island.css`, `src/styles/app.css` and `phone/web/src/phone.css`, and added to the `Tone` type and `external.ts`'s tone list. Orange stays Claude's. Moss may swap the colour after seeing it.
- The bot: same moments as Claude (`claude-asks` / `claude-done` / `claude-error` are reaction kinds, keyed per chat), plus thinking while any Codex chat works.

### 7. Activities window and setup

- `app.ts`: a Codex panel (the Claude panel's shape: status line, Install / Update / Remove with the diff dialog, sessions, closed, Refresh). The panel shows "Codex not found on this PC" when there is no codex.exe.
- Setup (`welcome.ts` / `onboarding.ts`): when `~/.codex` exists, the coding step offers Codex next to Claude Code.

## Errors

- Island closed, slow or hidden: the relay prints nothing; Codex asks in its own window (verified: failed and empty hooks are ignored).
- Codex not installed: the activity stays quiet, its tile is hidden, the panel says so.
- Codex can't load its config (Moss's case today): the trust step fails with Codex's own message; hooks.json is still written; the panel shows "Installed, not trusted yet: <Codex's message>" and a Try again button.
- A hook changed by someone else: `hooks/list` says `modified`; the panel shows Update.
- Rollout format drift: unknown lines are skipped; a file that can't be read is skipped for that poll.

## Testing

- Vitest: `rollout.ts` and `limits.ts` against fixture lines copied from the probe's files; the Codex tracker (hooks only, rollouts only, both); hook routing by `agent`; the engine with a fake kit; all existing Claude tests unchanged.
- cargo: relay `island-hook codex <Event>` parsing, `waits_for`, `output_json` for Codex; hooks.json merge/remove/idempotent install; the PowerShell command quoting (spaces, apostrophes); trust edits built from a recorded `hooks/list` reply; `codex_rollout_scan` on fixtures.
- On this PC, end to end: the probe's fake OpenAI server + the real `island-hook.exe` + a debug Island: permission card → Allow and Deny reach Codex, a reply typed in the island becomes the next turn, limits show 42% / 17%. Then Moss tries a real Codex chat.

## Build order (for the plan)

1. Relay + pipe `agent` routing (Claude unchanged).
2. Engine split (Claude kit), all Claude tests green.
3. Codex installer + trust + panel.
4. Codex kit: rollout parser, tracker, limits; pill, cards, reply window, pushes, bot.
5. Open / continue / reopen.
6. Codex in the phone app's chat card.
7. Release build (Moss decides when).

## Later sub-projects (own specs)

- Cursor: `~/.cursor/hooks.json` (`version: 1`), PowerShell on Windows. `beforeSubmitPrompt`, `afterAgentResponse`, `stop` → `followup_message` (the reply box), `beforeShellExecution` (allow/deny/ask; fires for every command, so Allow/Deny from the island needs its own design).
- Gemini CLI: `~/.gemini/settings.json` `hooks`; `AfterAgent` deny → the reason becomes a new prompt (the reply box); `Notification` `ToolPermission` is observe-only (a "needs you" card with Open, no Allow).

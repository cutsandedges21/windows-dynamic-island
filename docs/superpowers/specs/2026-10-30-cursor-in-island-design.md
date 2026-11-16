# Cursor in Island (sub-project 2)

Moss, 2026-10-30: "build the cursor one (0.4.4 once it's confirmed working)". Sub-project 1 (Codex) built the shared engine (`src/activities/agent/engine.ts`); Cursor is a second kit on it. Built inline, no separate plan file: the tasks are the file list below.

## What Cursor 3.27 gives (read from its docs, its shipped bundle and its own hook logs)

- **Hooks** in `~/.cursor/hooks.json`: `{"version": 1, "hooks": {"<event>": [{"command", "timeout", "loop_limit", "matcher"}]}}`. Flat entries, no trust step for user hooks, reloaded on save. Commands run through **PowerShell** with the JSON on stdin, from `~/.cursor`, so Island's command is `& '<island-hook.exe>' cursor <event>` (as for Codex).
- **Every input** carries `conversation_id` (also sent as `session_id`), `generation_id`, `model`, `hook_event_name` (camelCase: `stop`, `beforeSubmitPrompt`…), `cursor_version`, `workspace_roots` (URI paths, `/c:/code/app`), `user_email`, `transcript_path`.
- **stop** gets `status` (`completed` | `aborted` | `error`), `loop_count` and token counts; its output `followup_message` is sent as the chat's next user message: **the reply window**. Follow-ups are capped by `loop_limit` (default 5): Island writes `null`.
- **beforeShellExecution / beforeMCPExecution** can answer `allow` | `deny` | `ask`. In the bundle (`cursor-agent-exec`), `deny` blocks, `ask` forces Cursor's own prompt (FORCE_PROMPT), and **`allow` changes nothing**: Cursor still asks unless its Auto-run is on. A hook cannot approve a command.
- **afterAgentResponse** gives the answer's `text` (the stop input has no last message).
- **sessionStart** fires only when a chat is created; **workspaceOpen** fires when a window opens a folder and **sessionEnd** when a window closes (seen in Cursor's own log, `%APPDATA%\Cursor\logs\<date>\window*\output_*\cursor.hooks.*.log`, which records each hook's INPUT, OUTPUT and STDERR).
- Empty stdout means "no opinion"; invalid JSON from a permission hook **blocks** the action.
- **Transcripts**: `~/.cursor/projects/<folder slug>/agent-transcripts/<id>/<id>.jsonl`: `{role, message: {content: [text | tool_use]}}` lines and `{type: "turn_ended", status}`; user text wrapped in `<user_query>`; hidden thinking as `[REDACTED]`; no timestamps.
- **Cursor also runs Claude Code's hooks** from `~/.claude/settings.json` (its "third-party" setting, on in Moss's Cursor: "Loaded Claude user hooks"), mapped to Cursor events and with Cursor's input. Island's Claude commands (`"<path>" Stop`) don't even parse in PowerShell, but island-hook now drops any Claude-form call that carries `cursor_version`, so a Cursor chat never shows up as a Claude chat.
- No plan limits on disk; no way to type into a Cursor chat from outside; no deep link to one chat.

## Design

| Island feature | Cursor |
|---|---|
| Live chats, Working / Your turn / Stopped | hooks (`beforeSubmitPrompt`, `afterAgentResponse`, `stop`, `sessionEnd`) + transcripts |
| Finished card with the last answer | `afterAgentResponse` text, else the transcript |
| Reply window | `stop` waits; a reply → `{"followup_message": …}` |
| Permission card | only with the option **Ask me here before Cursor runs a command** (off by default; its two hooks are installed only then). Allow → `{"permission":"allow"}` (lets it through), Deny → `deny` (+ the user's note as `agent_message`), dismissed / not answered / Island busy → `ask` (Cursor asks in its window). Island not running, or the option off → nothing. |
| Open / reopen | bring up Cursor's window for the folder, else `Cursor.exe <folder>` |
| Continue (late reply) | clipboard + Cursor up ("paste it in its chat") |
| Phone | chat view from the transcript; a message goes in only while the chat's stop waits; no new Cursor chats from the phone |
| Limits | none |

Wire changes shared with Claude/Codex: the pipe now tells island-hook `pass` (not the island's to answer) from `decline` (hand it back), and an empty answer after the card was up; Claude and Codex print nothing for all three, as before.

## Files

- `hook/src/main.rs`: agent `cursor`, its waits, `cursor_output`, the Claude-form guard.
- `src-tauri/src/pipe.rs`: `Reply::Pass`, `Outcome`, Cursor's limits.
- `src-tauri/src/cursor.rs`: env, `cursor_transcripts` (with the slug → folder walk), `cursor_open`, hooks.json install/remove with the `gate`.
- `src/activities/cursor/{transcript,tracker,index}.ts`, catalog entry (`askBeforeCommands`), registry, tone `cursor` (teal), icon, setup facts, phone guard, Activities › Cursor panel.
- `test/cursor.test.ts`.

## Checks

Unit: relay (Cursor waits and outputs, the guard), pipe, cursor.rs (merge/remove/gate, slug walk), transcript/tracker/activity (20). Live: Cursor itself running Island's command (a throwaway Cursor window on a test folder with project hooks: `workspaceOpen`, `sessionEnd`), and Cursor's exact hook calls (PowerShell, real payload shapes) through the real relay into the real island: reply card → reply → `followup_message`; command card → Allow / dismiss. A real agent turn needs a signed-in Cursor account (Moss's Cursor shows `user_email: null`).

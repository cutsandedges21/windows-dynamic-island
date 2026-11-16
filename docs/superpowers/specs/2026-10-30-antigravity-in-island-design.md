# Antigravity in Island (sub-project 3, "the Gemini one")

Moss, 2026-10-30: "then build the gemini one (0.4.5 once it's confirmed working)". Planned as Gemini CLI, but Google retired Gemini CLI for individual accounts on 2026-06-18 and moved it into **Antigravity**: one agent behind the Antigravity app, the Antigravity IDE and the Antigravity CLI (`agy`), all on Gemini models. Moss has the app and the IDE installed. So "the Gemini one" is Antigravity: a third kit on the shared engine (`src/activities/agent/engine.ts`).

## What Antigravity gives (its docs, https://antigravity.google/docs/hooks, and the docs built into its agent, language_server.exe of 2026-10-08)

- **Hooks** for the app, IDE and CLI at once in `~/.gemini/config/hooks.json` (workspace: `.agents/hooks.json`, behind folder trust). Shape: `{"<hook name>": {"enabled": true, "<Event>": [...]}}`. Tool events (`PreToolUse`, `PostToolUse`) take `[{matcher, hooks: [handler]}]`; the others take handlers directly. Handler: `{type: "command", command, timeout}` (seconds, default 30).
- Commands run through **`cmd /c`** on Windows, from the folder that holds hooks.json, JSON on stdin, JSON expected on stdout. Hooks run synchronously in the agent loop.
- **Input**, camelCase: `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`; `PreToolUse`/`PostToolUse`: `toolCall {name, args}` (shell: `run_command`, `args.CommandLine`), `stepIdx`, `error`; `PreInvocation`/`PostInvocation`: `invocationNum`, `initialNumSteps`; `Stop`: `executionNum`, `terminationReason` (`model_stop`, `max_steps_exceeded`, `error`), `error`, `fullyIdle`. No prompt, answer or folder fields.
- **Output**: `PreToolUse` `decision` is required (`allow`, `auto_approve` = approve where Antigravity would ask, `deny`, `ask`, `force_ask`); a missing or unknown decision blocks the tool. `Stop`: `{"decision": "continue", "reason"}` keeps the agent going with `reason` as a system message; any other decision lets it stop. `PostToolUse` must answer `{}`; the others take `{}`.
- **Transcripts**: `~/.gemini/<antigravity | antigravity-cli | antigravity-ide>/brain/<conversation id>/.system_generated/logs/transcript.jsonl`, one step per line: `step_index`, `source` (`USER_EXPLICIT`, `MODEL`, `SYSTEM`), `type` (`USER_INPUT`, `PLANNER_RESPONSE`, …), `status` (`DONE`, `ERROR`), `created_at`, `content`, `thinking`, `tool_calls`, `truncated_fields`.
- No plan limits on disk; no documented link to one conversation.

## Design

| Island feature | Antigravity |
|---|---|
| Live chats, Working / Your turn | `SessionStart`, `PreInvocation` (call 0 = a turn starts), `Stop`; titles and answers from the transcript |
| Finished card with the last answer | the transcript's last `PLANNER_RESPONSE`, read when Stop arrives |
| Reply window | `Stop` waits; a reply → `{"decision": "continue", "reason": "The user replied from Island: …"}` |
| Permission card | with **Ask me here before Antigravity runs a command** (off by default; a `PreToolUse` hook on `run_command` only then). Allow → `auto_approve` (it really runs), Deny → `deny` + note, anything else → `ask` (Antigravity asks in its window) |
| Island closed | the relay still answers: `PreToolUse` → `ask`, `Stop` → `stop`, the rest `{}` (never block, never approve) |
| Open / continue | bring the Antigravity window (app, IDE, or the CLI's terminal) up; a late reply goes on the clipboard, or is typed into a running CLI |
| Limits | none |

The command uses a path without spaces (the 8.3 short path when the profile folder has a space), so it runs the same whether `cmd /c` gets it raw or escaped.

# Local AI

An assistant that runs on this PC: questions never leave the computer, and it works offline. Built in slices, each one shippable on its own. Slice 1 is done.

```
Local AI activity (src/activities/local.ts)
   │ local_ask(id, model, turns) ── "local-delta" {id, text so far} ──► pill + card
   ▼
src-tauri/src/local.rs ── POST /v1/chat/completions (stream) ──► Ollama on 127.0.0.1:11434
                                                                 (later: a bundled llama-server, same API)
```

## Measured on Moss's PC

Intel UHD graphics only, so inference runs on the CPU (i7-12650H, 32 GB).

| Model | Speed | Answer time |
| --- | --- | --- |
| llama3.1:8b (Q4, 4.9 GB) | 7.8 tok/s | 1.8 s warm, 15.7 s when the model has to load first |
| llama3.2:3b (2.0 GB) | 17 tok/s | 4.2 s warm for 64 tokens, 7.5 s with a 3.2 s load first |

Ollama unloads a model after 5 idle minutes, so the first question after a break pays the load time. Slice 2 hides it.

## Slices

1. **Typed question, local model, streaming.** Done 2026-10-06.
   - `src-tauri/src/local.rs`: `local_status`, `local_ask`, `local_cancel`. Stop drops the connection, so Ollama stops generating and the CPU goes quiet. 21 tests against a fake server, plus `real_ollama_streams_an_answer` (`cargo test --lib local:: -- --ignored`) against the real one.
   - `src/activities/local.ts`: compose, thinking, streaming, answer, error. The answer only ever shows on the card; the pill says Thinking…, Writing… or Answered (Moss's call). Stop keeps what was written. Hidden while Ollama is not running. Thinking from reasoning models (`<think>`) is never shown. 18 tests in `test/local.test.ts`.
   - **Questions about the PC**: every question carries a list of what Island can see right now (`deviceFacts`): time and date, PC name, Windows version, uptime, processor, free disk space, CPU/GPU/memory load, battery, network, volume and mic, what is playing, the window in front, Do Not Disturb, the next calendar events. Read in parallel, 1.5 s at most, slow parts left out. Rust adds `local_device_info` (registry, uptime, fixed drives only). Checked on llama3.2:3b: time, free space and battery answered right; the weather (not in the list) is declined.
   - Option `model`: empty uses the smallest chat model installed.
2. **No wait after a break.** Done 2026-10-06. Opening the input calls `local_warm` (Ollama `/api/generate` with only `model` and `keep_alive`, at most once a minute), and every request asks Ollama to keep the model 30 minutes instead of 5. Checked on the real Ollama: warm-up 3.1 s while typing, then the first answer in 0.8 s (7.7 s cold before).
3. **Every PC, best model it can run, Claude when that is not enough** (Moss, 2026-10-06: "almost as good as ChatGPT", on virtually all laptops). In steps:
   - **3a. Pick by hardware** (done, `src-tauri/src/llama.rs` `plan()`): total RAM and each GPU's own memory (registry, not WMI, which stops at 4 GB). Integrated graphics are ignored: on this PC the Intel UHD made Llama 3.2 3B slower (12.6 tok/s against 18.4 on the CPU).

     | Tier | Model (Apache-2.0, pinned SHA-256) | Size | Picked when |
     | --- | --- | --- | --- |
     | large | Qwen3-30B-A3B-Instruct-2507 Q4_K_M (MoE, 3B active) | 18.6 GB | 48 GB RAM, or a GPU with 19+ GB |
     | medium | gpt-oss-20b MXFP4 (MoE) | 12.1 GB | 32 GB RAM, or a GPU with 13+ GB |
     | small | Qwen3-4B-Instruct-2507 Q4_K_M (no thinking step) | 2.5 GB | 8–16 GB RAM; 9.9 tok/s on this CPU |
     | tiny | Qwen3-1.7B Q4_K_M, `enable_thinking:false` | 1.1 GB | 4 GB RAM. Measured here: 2.1 s load, "The capital of Canada is Ottawa." in 0.5 s (~17 tok/s), no thinking text |
     | none | | | under 4 GB |

     A model may take at most 40% of the RAM (`RAM_SHARE`): with the 30B on Moss's 32 GB PC, their apps (about 10 GB) plus the model reached 31 GB used. The server stops after 5 idle minutes (was 15). llama-server runs with `--no-repack`: repacking kept a second copy of the weights (gpt-oss-20b: 20.5 GB in RAM, free RAM down to 0.8 GB; with the flag 10.1 GB, of which 0.5 GB private, the rest file pages Windows can reclaim; 11.0 tok/s instead of 13.9).
   - **3f. The user picks the model** (2026-10-06 evening, with the first-run setup in `docs/ONBOARDING.md`). The tier `plan()` picks is now only the **Recommended** one. `llama.rs`: `placement()` per tier (same 40% rule), `models()` (this PC's processor, RAM, graphics cards, free disk, and every tier: fits, downloaded, partial bytes, recommended), `setup(tier, slot)` with one download at a time (`claim()` / `Slot`) and a free-space check, `remove(Some(id))` for one model, `ensure(id)` restarting llama-server when another model is asked for (after the old one has exited, so two models never share RAM). `local.rs`: `local_models`, `local_setup(model)` returns once the download has begun and every window follows it through `local-setup` and one `local-setup-end`, `local_setup_cancel` (the `.part` stays and resumes), `local_remove(model)`. The activity's `model` option holds `island:<id>` for an Island model, an Ollama name, or empty for "let Island choose" (`chooseBackend` in `src/core/models.ts`). While a picked model downloads, the best downloaded one answers.
   - Measured on this PC (i7-12650H, CPU only): small 9.9 tok/s; medium (gpt-oss-20b, low reasoning) 13.9 tok/s, real answers in 5–9 s with its reasoning included, correct on a time-arithmetic question. MoE beats the dense 4B. Large (Qwen3-30B): 9.4 tok/s but no reasoning step, so real answers came faster than gpt-oss (2.6–5.6 s against 5.4–8.9 s); first load from disk 45 s.
   - **Bug found and fixed**: the Vulkan build still put its working memory on the Intel UHD even with `-ngl 0`, and the 30B failed to start (`ErrorOutOfDeviceMemory`). When the plan says CPU, llama-server now gets `-dev none` (tested).
   - **3b–3d done** (`llama.rs`: `download` resumable + SHA-256, `extract`, `Job`, `ensure`/`setup`/`remove`; `local.rs`: `local_setup`, `local_remove`, `backend` on ask/warm; `local.ts`: setup tile with size, progress in the pill, "Local AI is ready", `chooseBackend`). Real check: the runtime downloaded from GitHub, started with the small model in 2.9 s and answered "The capital of Canada is Ottawa." in 1.4 s. Not yet clicked through on the overlay.
   - **3b. Download and check**: llama.cpp b11450 Vulkan build (33 MB; also carries CPU builds from SSE4.2 to Zen 4, so one zip runs on every x64 PC) and the tier's model, resumable, SHA-256 checked, unzipped with Windows' own `tar.exe`.
   - **3c. Run it**: llama-server on a free localhost port, `-ngl 99` only when the plan picked a GPU, inside a kill-on-close Job Object, stopped when idle.
   - **3d. Setup in the island**: "Set up Local AI" with size and progress; Ollama still wins when present.
   - ~~3e. Claude fallback~~: dropped by Moss (2026-10-06).

   Original note: **No Ollama needed.** Ship llama.cpp's `llama-server.exe` (CPU build; downloaded on first use, not bundled, because it is large) and one small GGUF. Rust starts it on demand on a free port and checks `/health`. It must die with Island: nothing kills child processes today (`lib.rs` has no `RunEvent::Exit` handler), so put it in a Job Object with kill-on-close. `local.rs` keeps the same request and only changes the base URL. 4–6 hours.
4. **Voice in (dictation).** Copy utter's speech pipeline (Moonshine Base, q8, 63 MB) into `src/stt/`: `resample.ts`, `silence.ts`, `segmenter.ts`, `filter.ts`, `liveTranscriber.ts`, `engine/types.ts`, `protocol.ts`, `workerEngine.ts`, `public/mic-processor.js` and their five test files verbatim. Rewrite `useLiveTranscriber.ts` (React) as an activity, and do not port its `visibilitychange` stop (the overlay is "hidden" often). Needs:
   - `'wasm-unsafe-eval'` in `script-src` (both CSPs). Without it ONNX Runtime fails as "no available backend found", with no network request, which looks like a download bug.
   - the model as a bundled resource, `allowRemoteModels = false` (the CSP blocks huggingface.co, and offline must work);
   - a spike first: does WebView2 grant the mic to the island window? That decides this slice, not the model.
   - `calls.ts` must ignore Island's own process, or Island lights its own red mic chip.
   4–6 hours after the spike.
5. **Voice turn.** Push-to-talk hotkey, transcript, `local_ask`, reply spoken by Windows' own speech synthesis. 3–4 hours.
6. **Brain.** Tasks and notes as Markdown in `%LOCALAPPDATA%\Island\brain\`, and a fixed set of actions (add task, list today, append note) the model picks with JSON output, not free tool calling: 1–4B models are unreliable at that. 6+ hours, split before starting.

## Decisions

| Question | Pick | Why |
| --- | --- | --- |
| Runtime first | Ollama, detected | Already installed here. llama-server speaks the same API, so slice 3 swaps a URL. |
| Who talks HTTP | Rust | The island CSP blocks localhost, and prompts stay out of the webview and the log, as in `chat.rs`. |
| New activity or Ask Claude backend | New activity | Streaming, Stop and model choice differ, and orange is Claude's. Local AI is violet. |
| Stop | Drop the connection | Ignoring the reply would keep the CPU busy for up to 512 tokens. |
| Default model | Smallest installed; suggest `llama3.2:3b` | Measured here at 2.2× the 8B's speed, with no thinking step. Provisional: the model research step was stopped before it finished. |

## Open questions

Not verified yet:

- the best small instruct model today;
- whether Parakeet TDT 0.6B v3 really runs as GGUF;
- whether "Keel" and "Taby" exist as described.

The model research agent was stopped at Moss's limit before it answered. Check these before slice 3 picks a model to ship.

## Cut from the brief

- WhisperKit and macparakeet: Mac only.
- A Pomodoro timer: Island has the timer activity.
- Choosing Electron, Python or .NET: Island is Tauri and TypeScript.
- Forking Keel: Island's activities already are the app shell.

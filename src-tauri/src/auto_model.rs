// Auto model for Claude Code: a router that warns before a prompt runs on a far
// too strong or too weak model, and a model check that reviews a chat when it
// compacts, passes 500k tokens or ends. Both are Node scripts shipped inside
// Island (src-tauri/model-router). Turning Auto model on (Activities › Claude
// Status) writes them to ~/.claude/model-router and adds their hooks to
// Claude Code's settings.json, after a dated backup; off removes the hooks and
// leaves everybody else's alone. The card's "Auto model" button only pauses
// it: an `off` file next to the scripts, which both of them check.
//
// Island's own Claude Code hooks (hooks.rs, island-hook.exe) live in the same
// settings.json. Auto model only adds hook commands naming its scripts and
// only removes those; Island's update and removal do the same for theirs, so
// either can be turned on or off, in any order, without moving the other.
//
// The hooks need Node.js. A PC without it gets Island's own copy on request:
// the official portable build, pinned and checked like Local AI's runtime,
// unpacked into Island's folder (no admin, nothing added to PATH).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::claude::config_dir;
use crate::hooks::{read_settings, read_settings_at, save_settings_at};
use crate::nowindow::NoWindow;

const NODE_VERSION: &str = "v24.22.2";
#[cfg(target_arch = "aarch64")]
const NODE_BUILD: (&str, &str, u64) = ("win-arm64", "f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468", 33_789_289);
#[cfg(not(target_arch = "aarch64"))]
const NODE_BUILD: (&str, &str, u64) = ("win-x64", "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2", 37_754_834);

/// What turning on says when there is no Node.js; the Activities row then asks to download it.
const NEEDS_NODE: &str = "Auto model needs Node.js, which isn't on this PC.";

const FILES: &[(&str, &str)] = &[
    ("router.mjs", include_str!("../model-router/router.mjs")),
    ("rubric.md", include_str!("../model-router/rubric.md")),
    ("review.mjs", include_str!("../model-router/review.mjs")),
    ("review-rubric.md", include_str!("../model-router/review-rubric.md")),
];

/// Event, script, timeout (s), the spinner text Claude Code shows while it runs.
const HOOKS: &[(&str, &str, u64, Option<&str>)] = &[
    ("UserPromptSubmit", "router.mjs", 30, Some("Picking model...")),
    ("SessionStart", "router.mjs", 5, None),
    ("PostModelSwitch", "router.mjs", 5, None),
    ("PreCompact", "review.mjs", 10, None),
    ("Stop", "review.mjs", 10, None),
    ("SessionEnd", "review.mjs", 5, None),
];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AutoModel {
    /// Its hooks are in Claude Code's settings.
    pub installed: bool,
    /// Not paused (no `off` file).
    pub on: bool,
    /// Why turning it on or off didn't work.
    pub error: Option<String>,
    /// It didn't turn on for want of Node.js: Island can install its own (`claude_auto_model_node`).
    pub needs_node: bool,
    /// How big that download is, to say before starting it.
    pub node_download_bytes: u64,
}

fn dir() -> PathBuf {
    config_dir().join("model-router")
}

/// Where Island keeps its own Node.js.
fn node_dir() -> PathBuf {
    crate::log::data_dir().join("node")
}

fn island_node() -> PathBuf {
    node_dir().join(format!("node-{NODE_VERSION}-{}", NODE_BUILD.0)).join("node.exe")
}

/// How the hooks start Node: the PC's own on PATH, else Island's copy (quoted path). None: neither.
fn node_program() -> Option<String> {
    let found = std::process::Command::new("node").arg("--version").no_window().output().is_ok_and(|o| o.status.success());
    if found {
        return Some("node".into());
    }
    let own = island_node();
    own.exists().then(|| format!("\"{}\"", own.to_string_lossy().replace('\\', "/")))
}

/// Which of our scripts a hook runs, if any: a command naming model-router/router.mjs or review.mjs
/// (also one the user added by hand, so it is never added twice).
fn script_of(hook: &Value) -> Option<&'static str> {
    let cmd = hook.get("command").and_then(Value::as_str)?.replace('\\', "/");
    ["router.mjs", "review.mjs"].into_iter().find(|s| cmd.contains(&format!("model-router/{s}")))
}

/// `dir`: where the scripts are (model-router in Claude Code's folder).
fn command(dir: &Path, node: &str, script: &str) -> String {
    format!("{node} \"{}\"", dir.join(script).to_string_lossy().replace('\\', "/"))
}

/// The settings with every Auto model hook present, run by `node` from `dir`; ones already there
/// stay as they are, and new ones go last, after everybody else's (Island's own included).
fn merged(existing: &Value, node: &str, dir: &Path) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut hooks = root.get("hooks").and_then(Value::as_object).cloned().unwrap_or_else(Map::new);
    for (event, script, timeout, message) in HOOKS {
        let mut list = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        let present = list.iter().any(|entry| {
            entry.get("hooks").and_then(Value::as_array).is_some_and(|hs| hs.iter().any(|h| script_of(h) == Some(*script)))
        });
        if present {
            continue;
        }
        let mut hook = json!({ "type": "command", "command": command(dir, node, script), "timeout": timeout });
        if let Some(m) = message {
            hook["statusMessage"] = json!(m);
        }
        list.push(json!({ "hooks": [hook] }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
    root.insert("hooks".into(), Value::Object(hooks));
    Value::Object(root)
}

/// The settings without any Auto model hook; a group or event left empty goes too.
fn without_ours(existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let Some(hooks) = root.get("hooks").and_then(Value::as_object).cloned() else {
        return Value::Object(root);
    };
    let mut out = Map::new();
    for (event, value) in hooks {
        let Some(list) = value.as_array() else {
            out.insert(event, value);
            continue;
        };
        let mut kept = Vec::new();
        for entry in list {
            let Some(hs) = entry.get("hooks").and_then(Value::as_array) else {
                kept.push(entry.clone());
                continue;
            };
            let left: Vec<Value> = hs.iter().filter(|h| script_of(h).is_none()).cloned().collect();
            if left.len() == hs.len() {
                kept.push(entry.clone());
            } else if !left.is_empty() {
                let mut e = entry.clone();
                e["hooks"] = Value::Array(left);
                kept.push(e);
            }
        }
        if !kept.is_empty() {
            out.insert(event, Value::Array(kept));
        }
    }
    if out.is_empty() {
        root.remove("hooks");
    } else {
        root.insert("hooks".into(), Value::Object(out));
    }
    Value::Object(root)
}

/// Installed means the router runs on prompts.
fn installed_in(settings: &Value) -> bool {
    settings
        .get("hooks")
        .and_then(|h| h.get("UserPromptSubmit"))
        .and_then(Value::as_array)
        .is_some_and(|list| {
            list.iter().any(|e| e.get("hooks").and_then(Value::as_array).is_some_and(|hs| hs.iter().any(|h| script_of(h) == Some("router.mjs"))))
        })
}

fn state(error: Option<String>) -> AutoModel {
    AutoModel {
        installed: read_settings().map(|s| installed_in(&s)).unwrap_or(false),
        on: !dir().join("off").exists(),
        needs_node: error.as_deref() == Some(NEEDS_NODE),
        node_download_bytes: NODE_BUILD.2,
        error,
    }
}

/// The hooks run the scripts with Node, and the scripts ask Claude through the `claude` command.
fn turn_on() -> Result<(), String> {
    if !config_dir().exists() {
        return Err("Claude Code isn't set up on this computer yet: run `claude` once, then try again.".into());
    }
    let node = node_program().ok_or_else(|| NEEDS_NODE.to_string())?;
    turn_on_in(&config_dir(), &node)
}

/// Writes the scripts into `config`/model-router, un-pauses them and adds their hooks to
/// `config`/settings.json (after a backup, only if something changes).
fn turn_on_in(config: &Path, node: &str) -> Result<(), String> {
    let d = config.join("model-router");
    std::fs::create_dir_all(&d).map_err(|e| format!("Can't create {}: {e}", d.display()))?;
    for (name, text) in FILES {
        let path = d.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(*text) {
            std::fs::write(&path, text).map_err(|e| format!("Can't write {}: {e}", path.display()))?;
        }
    }
    let _ = std::fs::remove_file(d.join("off"));
    let path = config.join("settings.json");
    let current = read_settings_at(&path)?;
    let next = merged(&current, node, &d);
    if next != current {
        save_settings_at(&path, &next, "auto model hooks installed")?;
    }
    Ok(())
}

/// Island's own Node.js: downloads the pinned portable build (checksum checked) and unpacks it.
/// `progress(done, total)` gets the bytes about once a megabyte.
#[cfg(windows)]
async fn install_node(mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    if island_node().exists() {
        return Ok(());
    }
    let (build, sha256, _) = NODE_BUILD;
    let url = format!("https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-{build}.zip");
    let zip = node_dir().join(format!("node-{NODE_VERSION}-{build}.zip"));
    let mut last = 0u64;
    crate::llama::download(&url, sha256, &zip, |done, total| {
        if done.saturating_sub(last) >= 1 << 20 || done == total {
            last = done;
            progress(done, total);
        }
    })
    .await?;
    let unpacked = crate::llama::extract(&zip, &node_dir());
    let _ = std::fs::remove_file(&zip);
    unpacked?;
    if island_node().exists() {
        crate::log::line(format!("auto model: Node.js {NODE_VERSION} installed in {}", node_dir().display()));
        Ok(())
    } else {
        Err("Node.js was downloaded but node.exe isn't where it should be. Try again.".into())
    }
}

#[cfg(not(windows))]
async fn install_node(_progress: impl FnMut(u64, u64)) -> Result<(), String> {
    Err("Install Node.js from nodejs.org, then turn Auto model on again.".into())
}

fn turn_off() -> Result<(), String> {
    turn_off_in(&config_dir())
}

fn turn_off_in(config: &Path) -> Result<(), String> {
    let path = config.join("settings.json");
    let current = read_settings_at(&path)?;
    let next = without_ours(&current);
    if next != current {
        save_settings_at(&path, &next, "auto model hooks removed")?;
    }
    Ok(())
}

#[tauri::command]
pub fn claude_auto_model_get() -> AutoModel {
    state(None)
}

/// Installs (on) or removes (off) Auto model's hooks; returns the new state.
#[tauri::command]
pub async fn claude_auto_model_set(on: bool) -> AutoModel {
    let result = tauri::async_runtime::spawn_blocking(move || if on { turn_on() } else { turn_off() }).await;
    let error = match result {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e),
        Err(e) => Some(e.to_string()),
    };
    if let Some(e) = &error {
        crate::log::line(format!("auto model {}: {e}", if on { "on" } else { "off" }));
    }
    state(error)
}

/// For a PC without Node.js: installs Island's own copy (progress as `auto-model-node`
/// events, {done, total} bytes), then turns Auto model on.
#[tauri::command]
pub async fn claude_auto_model_node(app: tauri::AppHandle) -> AutoModel {
    use tauri::Emitter;
    if let Err(e) = install_node(|done, total| drop(app.emit("auto-model-node", json!({ "done": done, "total": total })))).await {
        crate::log::line(format!("auto model node: {e}"));
        return state(Some(e));
    }
    claude_auto_model_set(true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_settings() -> Value {
        json!({
            "model": "opus",
            "hooks": {
                "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "py \"C:/x/guard.py\"" }] }],
                "Stop": [{ "hooks": [
                    { "type": "command", "command": "py \"C:/x/hook.py\"" },
                    { "type": "command", "command": "node \"C:/Users/a/.claude/model-router/review.mjs\"" }
                ] }]
            },
            "statusLine": { "type": "command", "command": "node x.mjs" }
        })
    }

    fn router_dir() -> PathBuf {
        PathBuf::from("C:/Users/a/.claude/model-router")
    }

    fn scripts(v: &Value, event: &str) -> Vec<&'static str> {
        v["hooks"][event].as_array().into_iter().flatten().flat_map(|e| e["hooks"].as_array().into_iter().flatten()).filter_map(script_of).collect()
    }

    #[test]
    fn turning_on_adds_every_hook_once_and_keeps_the_rest() {
        let on = merged(&user_settings(), "node", &router_dir());
        assert!(installed_in(&on));
        for (event, script, _, _) in HOOKS {
            assert_eq!(scripts(&on, event), vec![*script], "{event}");
        }
        // The user's own hooks and settings stay, in order.
        assert_eq!(on["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"], "py \"C:/x/guard.py\"");
        assert_eq!(on["hooks"]["Stop"][0]["hooks"][0]["command"], "py \"C:/x/hook.py\"");
        assert_eq!(on["model"], "opus");
        let keys: Vec<&String> = on.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "hooks", "statusLine"]);
        // The router asks for a spinner text; turning on twice changes nothing.
        let router = on["hooks"]["UserPromptSubmit"].as_array().unwrap().last().unwrap();
        assert_eq!(router["hooks"][0]["statusMessage"], "Picking model...");
        assert_eq!(merged(&on, "node", &router_dir()), on);
    }

    #[test]
    fn turning_off_removes_only_auto_model() {
        let off = without_ours(&merged(&user_settings(), "node", &router_dir()));
        assert!(!installed_in(&off));
        assert_eq!(off["hooks"]["UserPromptSubmit"], json!([{ "hooks": [{ "type": "command", "command": "py \"C:/x/guard.py\"" }] }]));
        // A group shared with the user's hook keeps the user's; events left empty go.
        assert_eq!(off["hooks"]["Stop"], json!([{ "hooks": [{ "type": "command", "command": "py \"C:/x/hook.py\"" }] }]));
        for event in ["SessionStart", "PostModelSwitch", "PreCompact", "SessionEnd"] {
            assert!(off["hooks"].get(event).is_none(), "{event}");
        }
        assert_eq!(off["statusLine"], user_settings()["statusLine"]);
    }

    /// A throwaway Claude folder, never the real one (each test its own).
    fn temp_claude(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("island-auto-model-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn settings_in(root: &Path) -> Value {
        read_settings_at(&root.join("settings.json")).unwrap()
    }

    fn backups_in(root: &Path) -> usize {
        std::fs::read_dir(root).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with("settings.json.bak-")).count()
    }

    /// The real thing in a throwaway Claude folder: scripts written, hooks added after a backup,
    /// paused and resumed, then removed.
    #[test]
    fn turns_on_and_off_in_a_claude_folder() {
        let root = temp_claude("on-off");
        std::fs::write(root.join("settings.json"), serde_json::to_string_pretty(&user_settings()).unwrap()).unwrap();

        turn_on_in(&root, "node").unwrap();
        for (name, text) in FILES {
            assert_eq!(std::fs::read_to_string(root.join("model-router").join(name)).unwrap(), *text);
        }
        assert_eq!(backups_in(&root), 1);
        let on = settings_in(&root);
        assert!(installed_in(&on));
        let router = &on["hooks"]["UserPromptSubmit"].as_array().unwrap().last().unwrap()["hooks"][0]["command"];
        assert_eq!(router.as_str().unwrap(), format!("node \"{}/model-router/router.mjs\"", root.to_string_lossy().replace('\\', "/")));

        // Paused from the island's button: still installed, and turning on again un-pauses it
        // without writing settings.json again.
        std::fs::write(root.join("model-router").join("off"), "").unwrap();
        turn_on_in(&root, "node").unwrap();
        assert!(!root.join("model-router").join("off").exists());
        assert_eq!(backups_in(&root), 1);

        turn_off_in(&root).unwrap();
        let off = settings_in(&root);
        assert!(!installed_in(&off));
        assert_eq!(off["hooks"]["Stop"], json!([{ "hooks": [{ "type": "command", "command": "py \"C:/x/hook.py\"" }] }]));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Island's own hooks (hooks.rs), the way its Activities button writes them.
    fn island_hooks(root: &Path, install: bool) {
        let path = root.join("settings.json");
        crate::hooks::write_at(&path, install, &crate::hooks::fingerprint_at(&path)).unwrap();
    }

    fn island_in(v: &Value) -> bool {
        crate::hooks::installed_in(v).0
    }

    /// Every hook command of `event`, in order, as "island", "router", "review" or the command.
    fn commands(v: &Value, event: &str) -> Vec<String> {
        v["hooks"][event]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|e| e["hooks"].as_array().into_iter().flatten())
            .map(|h| {
                let c = h["command"].as_str().unwrap_or("");
                if c.contains("island-hook") {
                    "island".to_string()
                } else if let Some(s) = script_of(h) {
                    s.trim_end_matches(".mjs").to_string()
                } else {
                    c.to_string()
                }
            })
            .collect()
    }

    #[test]
    fn island_hooks_then_auto_model_and_back_leave_each_other_alone() {
        let root = temp_claude("island-first");
        std::fs::write(root.join("settings.json"), serde_json::to_string_pretty(&user_settings()).unwrap()).unwrap();

        island_hooks(&root, true);
        turn_on_in(&root, "node").unwrap();
        let both = settings_in(&root);
        assert!(island_in(&both) && installed_in(&both));
        // Auto model's hooks go last, after the user's and Island's.
        assert_eq!(commands(&both, "UserPromptSubmit"), ["py \"C:/x/guard.py\"", "island", "router"]);
        assert_eq!(commands(&both, "Stop"), ["py \"C:/x/hook.py\"", "review", "island"]);
        // Island still counts its hooks as up to date: updating them would change nothing.
        assert_eq!(crate::hooks::installed_in(&both), (true, true));

        // Island updating its own hooks (an update, a reinstall) moves nobody: same file.
        island_hooks(&root, true);
        assert_eq!(settings_in(&root), both);
        // Auto model turned on again changes nothing either.
        turn_on_in(&root, "node").unwrap();
        assert_eq!(settings_in(&root), both);

        // Island's hooks removed: Auto model's stay, in place.
        island_hooks(&root, false);
        let auto_only = settings_in(&root);
        assert!(!island_in(&auto_only) && installed_in(&auto_only));
        assert_eq!(commands(&auto_only, "UserPromptSubmit"), ["py \"C:/x/guard.py\"", "router"]);
        assert_eq!(commands(&auto_only, "Stop"), ["py \"C:/x/hook.py\"", "review"]);
        assert_eq!(commands(&auto_only, "PreCompact"), ["review"]);
        assert!(auto_only["hooks"].get("PermissionRequest").is_none());

        // And back: Island's go in again, Auto model's don't move.
        island_hooks(&root, true);
        let again = settings_in(&root);
        assert_eq!(commands(&again, "UserPromptSubmit"), ["py \"C:/x/guard.py\"", "router", "island"]);
        turn_off_in(&root).unwrap();
        let island_only = settings_in(&root);
        assert!(island_in(&island_only) && !installed_in(&island_only));
        assert_eq!(commands(&island_only, "UserPromptSubmit"), ["py \"C:/x/guard.py\"", "island"]);
        assert_eq!(commands(&island_only, "Stop"), ["py \"C:/x/hook.py\"", "island"]);
        assert!(island_only["hooks"].get("PreCompact").is_none());
        assert_eq!(crate::hooks::installed_in(&island_only), (true, true));

        // Both off: the user's file as it was.
        island_hooks(&root, false);
        let mut expected = user_settings();
        // The user's own Stop group shared a line with a hand-added model-router review, which is Auto model's.
        expected["hooks"]["Stop"] = json!([{ "hooks": [{ "type": "command", "command": "py \"C:/x/hook.py\"" }] }]);
        assert_eq!(settings_in(&root), expected);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn auto_model_then_island_hooks_and_back_leave_each_other_alone() {
        let root = temp_claude("auto-first");
        turn_on_in(&root, "node").unwrap();
        island_hooks(&root, true);
        let both = settings_in(&root);
        assert!(island_in(&both) && installed_in(&both));
        assert_eq!(commands(&both, "UserPromptSubmit"), ["router", "island"]);
        assert_eq!(commands(&both, "SessionEnd"), ["review", "island"]);
        assert_eq!(crate::hooks::installed_in(&both), (true, true));

        // Re-running either install is a no-op.
        island_hooks(&root, true);
        turn_on_in(&root, "node").unwrap();
        assert_eq!(settings_in(&root), both);

        turn_off_in(&root).unwrap();
        let island_only = settings_in(&root);
        assert!(island_in(&island_only) && !installed_in(&island_only));
        assert_eq!(commands(&island_only, "UserPromptSubmit"), ["island"]);
        assert!(island_only["hooks"].get("PostModelSwitch").is_none());

        turn_on_in(&root, "node").unwrap();
        island_hooks(&root, false);
        let auto_only = settings_in(&root);
        assert!(!island_in(&auto_only) && installed_in(&auto_only));
        assert_eq!(commands(&auto_only, "UserPromptSubmit"), ["router"]);
        assert_eq!(commands(&auto_only, "Stop"), ["review"]);

        turn_off_in(&root).unwrap();
        assert_eq!(settings_in(&root), json!({}));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_group_shared_by_both_loses_only_the_one_removed() {
        // Someone put Island's relay and the router in one group by hand.
        let root = temp_claude("shared");
        island_hooks(&root, true);
        let mut v = settings_in(&root);
        let relay = v["hooks"]["UserPromptSubmit"][0]["hooks"][0].clone();
        v["hooks"]["UserPromptSubmit"] = json!([{ "hooks": [relay, { "type": "command", "command": "node \"C:/Users/a/.claude/model-router/router.mjs\"" }] }]);
        std::fs::write(root.join("settings.json"), serde_json::to_string_pretty(&v).unwrap()).unwrap();

        // Island's update keeps the router where it was and gives its own line a group of its own.
        island_hooks(&root, true);
        assert_eq!(commands(&settings_in(&root), "UserPromptSubmit"), ["router", "island"]);
        island_hooks(&root, false);
        assert_eq!(commands(&settings_in(&root), "UserPromptSubmit"), ["router"]);
        // Auto model's removal takes the router and nothing else.
        island_hooks(&root, true);
        turn_off_in(&root).unwrap();
        assert_eq!(commands(&settings_in(&root), "UserPromptSubmit"), ["island"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A PC without Node.js: Island downloads its own (the real 38 MB build) and the hooks use it.
    /// Sets LOCALAPPDATA, CLAUDE_CONFIG_DIR and PATH, so it runs alone:
    /// `AUTO_MODEL_TEST_DIR=<empty dir> cargo test --lib auto_model::tests::without_node -- --ignored`
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn without_node_island_installs_its_own() {
        let root = PathBuf::from(std::env::var("AUTO_MODEL_TEST_DIR").expect("AUTO_MODEL_TEST_DIR"));
        std::fs::create_dir_all(root.join("claude")).unwrap();
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        unsafe {
            std::env::set_var("LOCALAPPDATA", root.join("local"));
            std::env::set_var("CLAUDE_CONFIG_DIR", root.join("claude"));
            std::env::set_var("PATH", format!(r"{system}\System32"));
        }
        assert!(node_program().is_none());
        let s = state(turn_on().err());
        assert!(s.needs_node && !s.installed, "{s:?}");

        let mut seen = 0;
        tauri::async_runtime::block_on(install_node(|_, _| seen += 1)).unwrap();
        assert!(seen > 10, "progress {seen}");
        assert!(island_node().exists());
        let out = std::process::Command::new(island_node()).arg("--version").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), NODE_VERSION);

        turn_on().unwrap();
        let on = read_settings().unwrap();
        let cmd = on["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"].as_str().unwrap().to_string();
        assert!(cmd.starts_with(&format!("\"{}\"", island_node().to_string_lossy().replace('\\', "/"))), "{cmd}");
        std::fs::write(root.join("hook-command.txt"), cmd).unwrap();
    }

    #[test]
    fn islands_own_node_is_quoted_and_still_ours() {
        let on = merged(&json!({}), "\"C:/Users/a/AppData/Local/Island/node/node-v24/node.exe\"", &router_dir());
        let cmd = on["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.starts_with("\"C:/Users/a/AppData/Local/Island/node/node-v24/node.exe\" \""), "{cmd}");
        assert!(cmd.ends_with("/model-router/review.mjs\""), "{cmd}");
        assert!(installed_in(&on));
        assert_eq!(without_ours(&on), json!({}));
    }

    #[test]
    fn nothing_else_counts_as_ours() {
        assert_eq!(script_of(&json!({ "command": "node \"C:\\Users\\a\\.claude\\model-router\\router.mjs\"" })), Some("router.mjs"));
        assert_eq!(script_of(&json!({ "command": "node router.mjs" })), None);
        assert_eq!(script_of(&json!({ "command": "node \"C:/other/review.mjs\"" })), None);
        assert_eq!(without_ours(&json!({ "model": "opus" })), json!({ "model": "opus" }));
    }
}

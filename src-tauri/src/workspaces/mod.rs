// Workspaces: the file of saved workspaces (workspaces.json beside settings.json) and the
// native pieces the Workspaces page needs. The schema belongs to TypeScript
// (src/workspaces/model.ts). Rust keeps the document, applies the windows' small edits one
// at a time under a lock (so the island and the Activities window never overwrite each
// other's), writes it atomically and tells every window. See docs/WORKSPACES.md.

pub mod launch;
pub mod layout;
pub mod paths;
pub mod pick;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

const FILE: &str = "workspaces.json";
/// Far more than any real set of workspaces; stops a runaway write from filling the disk.
const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct WsStore {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    /// Null until something is saved (or after an unreadable file was set aside).
    doc: Value,
    rev: u64,
    /// Where an unreadable file was moved, for the page to say so.
    recovered: Option<String>,
    /// Why nothing may be written (an unreadable file that could not be moved out of the way).
    blocked: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    doc: Value,
    rev: u64,
    recovered: Option<String>,
    blocked: Option<String>,
}

fn file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| crate::log::data_dir())
        .join(FILE)
}

fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

/// What was saved, plus where an unreadable file went and whether writing is safe. A file that
/// is there but isn't a JSON object is moved aside (copied, if it can't be moved), never
/// overwritten; if neither works, writing stays blocked so it can't be lost.
fn load_from(path: &Path) -> (Value, Option<String>, Option<String>) {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Value::Null, None, None),
        Err(e) => {
            crate::log::line(format!("workspaces: cannot read {}: {e}", path.display()));
            return (Value::Null, None, Some(format!("Island can't read {} ({e}), so nothing is saved until it can.", path.display())));
        }
    };
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    if let Ok(v) = serde_json::from_slice::<Value>(text) {
        if v.is_object() {
            return (v, None, None);
        }
    }
    let aside = path.with_file_name(format!("workspaces.unreadable-{}.json", stamp()));
    let moved = std::fs::rename(path, &aside).is_ok() || std::fs::copy(path, &aside).is_ok();
    crate::log::line(format!("workspaces: {} is not valid JSON; set aside as {} (ok={moved})", path.display(), aside.display()));
    if moved {
        (Value::Null, Some(aside.display().to_string()), None)
    } else {
        (Value::Null, None, Some(format!("{} can't be read and can't be moved aside. Fix or remove it, then restart Island.", path.display())))
    }
}

/// Write beside the target and rename over it, so a crash never leaves half a file.
fn save_to(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    if text.len() > MAX_BYTES {
        return Err("Too much to save: remove some workspaces or items.".into());
    }
    let temp = path.with_extension(format!("json.{}", std::process::id()));
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

fn version_of(doc: &Value) -> Option<u64> {
    doc.get("version").and_then(Value::as_u64)
}

// ------------------------------------------------------------------ the three operations (TypeScript applies the same: applyOp)

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn list_mut(doc: &mut Value) -> Result<&mut Vec<Value>, String> {
    let obj = doc.as_object_mut().ok_or("Workspaces aren't set up yet.")?;
    obj.entry("workspaces")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| "The workspaces file has no list of workspaces.".to_string())
}

fn id_of(w: &Value) -> Option<&str> {
    w.get("id").and_then(Value::as_str)
}

/// Merges the given top-level fields into the workspace with this id, or adds it first.
fn upsert(doc: &mut Value, id: &str, fields: Map<String, Value>) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Bad workspace id.".into());
    }
    let list = list_mut(doc)?;
    let target = match list.iter().position(|w| id_of(w) == Some(id)) {
        Some(at) => &mut list[at],
        None => {
            let mut obj = Map::new();
            obj.insert("id".into(), Value::String(id.into()));
            list.insert(0, Value::Object(obj));
            &mut list[0]
        }
    };
    let obj = target.as_object_mut().ok_or("A saved workspace is damaged.")?;
    for (k, v) in fields {
        if k != "id" {
            obj.insert(k, v);
        }
    }
    Ok(())
}

fn remove(doc: &mut Value, id: &str) -> Result<(), String> {
    list_mut(doc)?.retain(|w| id_of(w) != Some(id));
    Ok(())
}

/// The listed ids first, in that order, then the rest as they were.
fn reorder(doc: &mut Value, ids: &[String]) -> Result<(), String> {
    let list = list_mut(doc)?;
    let mut rest: Vec<Value> = std::mem::take(list);
    let mut out = Vec::with_capacity(rest.len());
    for id in ids {
        if let Some(at) = rest.iter().position(|w| id_of(w) == Some(id.as_str())) {
            out.push(rest.remove(at));
        }
    }
    out.append(&mut rest);
    *list = out;
    Ok(())
}

// ------------------------------------------------------------------ the store

impl WsStore {
    fn ensure_loaded(inner: &mut Inner, path: &Path) {
        if inner.loaded {
            return;
        }
        let (doc, recovered, blocked) = load_from(path);
        inner.doc = doc;
        inner.recovered = recovered;
        inner.blocked = blocked;
        inner.loaded = true;
    }

    fn snapshot(inner: &Inner) -> Loaded {
        Loaded { doc: inner.doc.clone(), rev: inner.rev, recovered: inner.recovered.clone(), blocked: inner.blocked.clone() }
    }

    fn load(&self, path: &Path) -> Loaded {
        let mut inner = self.inner.lock().unwrap();
        Self::ensure_loaded(&mut inner, path);
        Self::snapshot(&inner)
    }

    /// Applies one change to a copy, saves it, and only then makes it count. `notify` hears the
    /// new document and revision under the lock, so windows get the changes in order. `change`
    /// is told the current revision and may refuse.
    fn mutate(
        &self,
        path: &Path,
        change: impl FnOnce(&mut Value, u64) -> Result<(), String>,
        notify: impl FnOnce(&Value, u64),
    ) -> Result<u64, String> {
        let mut inner = self.inner.lock().unwrap();
        Self::ensure_loaded(&mut inner, path);
        if let Some(why) = &inner.blocked {
            return Err(why.clone());
        }
        let mut next = inner.doc.clone();
        change(&mut next, inner.rev)?;
        save_to(path, &next)?;
        inner.doc = next;
        inner.rev += 1;
        notify(&inner.doc, inner.rev);
        Ok(inner.rev)
    }

    /// The first document, written only when nothing is saved yet; what is there either way.
    fn init(&self, path: &Path, doc: Value, notify: impl FnOnce(&Value, u64)) -> Result<Loaded, String> {
        if !doc.is_object() {
            return Err("Not a workspaces document.".into());
        }
        let mut inner = self.inner.lock().unwrap();
        Self::ensure_loaded(&mut inner, path);
        if inner.doc.is_null() {
            if let Some(why) = &inner.blocked {
                return Err(why.clone());
            }
            save_to(path, &doc)?;
            inner.doc = doc;
            inner.rev += 1;
            notify(&inner.doc, inner.rev);
        }
        Ok(Self::snapshot(&inner))
    }

    /// The whole document (an upgraded file), only if nothing changed since revision `rev`.
    /// When the version changes, the old file is copied to workspaces.v<old>.json first.
    fn replace(&self, path: &Path, doc: Value, rev: u64, notify: impl FnOnce(&Value, u64)) -> Result<u64, String> {
        if !doc.is_object() {
            return Err("Not a workspaces document.".into());
        }
        self.mutate(
            path,
            |current, now| {
                if now != rev {
                    return Err("changed".into());
                }
                let (old, new) = (version_of(current), version_of(&doc));
                if let Some(old) = old.filter(|o| Some(*o) != new) {
                    let backup = path.with_file_name(format!("workspaces.v{old}.json"));
                    std::fs::copy(path, &backup).map_err(|e| format!("Couldn't keep a copy of the old file before upgrading it: {e}"))?;
                    crate::log::line(format!("workspaces: upgrading v{old} -> v{}, old file kept as {}", new.unwrap_or(0), backup.display()));
                }
                *current = doc;
                Ok(())
            },
            notify,
        )
    }
}

fn announce(app: &AppHandle, origin: &str) -> impl FnOnce(&Value, u64) {
    let (app, origin) = (app.clone(), origin.to_string());
    move |doc, rev| {
        let _ = app.emit("workspaces", serde_json::json!({ "doc": doc, "rev": rev, "origin": origin }));
    }
}

#[tauri::command]
pub fn workspaces_load(app: AppHandle, state: tauri::State<'_, WsStore>) -> Loaded {
    state.load(&file(&app))
}

#[tauri::command]
pub fn workspaces_init(app: AppHandle, state: tauri::State<'_, WsStore>, doc: Value) -> Result<Loaded, String> {
    state.init(&file(&app), doc, announce(&app, "init"))
}

#[tauri::command]
pub fn workspaces_replace(app: AppHandle, state: tauri::State<'_, WsStore>, doc: Value, rev: u64, origin: String) -> Result<u64, String> {
    state.replace(&file(&app), doc, rev, announce(&app, &origin))
}

#[tauri::command]
pub fn workspaces_upsert(app: AppHandle, state: tauri::State<'_, WsStore>, id: String, fields: Map<String, Value>, origin: String) -> Result<u64, String> {
    state.mutate(&file(&app), |d, _| upsert(d, &id, fields), announce(&app, &origin))
}

#[tauri::command]
pub fn workspaces_remove(app: AppHandle, state: tauri::State<'_, WsStore>, id: String, origin: String) -> Result<u64, String> {
    state.mutate(&file(&app), |d, _| remove(d, &id), announce(&app, &origin))
}

#[tauri::command]
pub fn workspaces_reorder(app: AppHandle, state: tauri::State<'_, WsStore>, ids: Vec<String>, origin: String) -> Result<u64, String> {
    state.mutate(&file(&app), |d, _| reorder(d, &ids), announce(&app, &origin))
}

#[cfg(test)]
mod tests;

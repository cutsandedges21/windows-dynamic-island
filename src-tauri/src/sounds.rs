// Your own chimes (Settings › Notifications › Sound: Your own). The file picked for "done" or
// "attention" is copied to `<data dir>/sounds/<kind>.<ext>`, so it still plays after the
// original moves or goes; the island reads it back as bytes and plays it (src/core/sounds.ts).

use std::path::{Path, PathBuf};

/// The two moments that chime: something finished, something needs you.
const KINDS: &[&str] = &["done", "attention"];
/// What WebView2 and WKWebView both decode.
const EXTS: &[&str] = &["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"];
/// A chime is a few seconds; this keeps a whole song out.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

fn dir() -> PathBuf {
    crate::log::data_dir().join("sounds")
}

fn kind_ok(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) {
        Ok(())
    } else {
        Err("Unknown sound.".into())
    }
}

/// The file's audio extension, lowercase; None for anything else.
fn audio_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    EXTS.contains(&ext.as_str()).then_some(ext)
}

/// The stored file for `kind` in `dir`, whatever its extension.
fn stored(dir: &Path, kind: &str) -> Option<PathBuf> {
    EXTS.iter().map(|e| dir.join(format!("{kind}.{e}"))).find(|p| p.is_file())
}

/// Copies `src` in as `kind`'s sound, replacing the one before it.
fn store(dir: &Path, kind: &str, src: &Path) -> Result<(), String> {
    let ext = audio_ext(src).ok_or("Island plays MP3, WAV, OGG, M4A, AAC, FLAC and Opus files.")?;
    let len = std::fs::metadata(src).map_err(|_| "Island can't open that file.")?.len();
    if len > MAX_BYTES {
        return Err("That file is over 5 MB. A short sound works best.".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Island can't save the sound: {e}"))?;
    remove(dir, kind);
    std::fs::copy(src, dir.join(format!("{kind}.{ext}"))).map_err(|e| format!("Island can't save the sound: {e}"))?;
    Ok(())
}

fn remove(dir: &Path, kind: &str) {
    for e in EXTS {
        let _ = std::fs::remove_file(dir.join(format!("{kind}.{e}")));
    }
}

/// Opens the Open dialog for an audio file and keeps a copy as `kind`'s sound. The picked
/// file's name, for Settings to show; None when cancelled.
#[tauri::command]
pub async fn sound_pick(window: tauri::WebviewWindow, kind: String) -> Result<Option<String>, String> {
    kind_ok(&kind)?;
    let picked = crate::workspaces::pick::ws_pick(window, "sound".into(), false, None).await;
    let Some(src) = picked.into_iter().next().map(PathBuf::from) else { return Ok(None) };
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || store(&dir(), &kind, &src)).await.map_err(|e| e.to_string())??;
    Ok(Some(name))
}

/// `kind`'s stored sound, as bytes.
#[tauri::command]
pub async fn sound_read(kind: String) -> Result<tauri::ipc::Response, String> {
    kind_ok(&kind)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = stored(&dir(), &kind).ok_or("No sound saved.")?;
        std::fs::read(file).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Forgets `kind`'s sound; the built-in chime plays again.
#[tauri::command]
pub fn sound_clear(kind: String) -> Result<(), String> {
    kind_ok(&kind)?;
    remove(&dir(), &kind);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("island-sounds-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_audio_files_are_taken() {
        assert_eq!(audio_ext(Path::new("C:/a/Ding.MP3")), Some("mp3".into()));
        assert_eq!(audio_ext(Path::new("/a/b.opus")), Some("opus".into()));
        assert_eq!(audio_ext(Path::new("/a/b.exe")), None);
        assert_eq!(audio_ext(Path::new("/a/noext")), None);
    }

    #[test]
    fn only_the_two_kinds_exist() {
        assert!(kind_ok("done").is_ok());
        assert!(kind_ok("attention").is_ok());
        assert!(kind_ok("../done").is_err());
        assert!(kind_ok("").is_err());
    }

    #[test]
    fn a_new_sound_replaces_the_old_one_whatever_its_type() {
        let root = temp("replace");
        let store_dir = root.join("sounds");
        let wav = root.join("first.wav");
        let mp3 = root.join("second.mp3");
        std::fs::write(&wav, b"RIFF").unwrap();
        std::fs::write(&mp3, b"ID3").unwrap();

        store(&store_dir, "done", &wav).unwrap();
        assert_eq!(stored(&store_dir, "done"), Some(store_dir.join("done.wav")));
        store(&store_dir, "done", &mp3).unwrap();
        assert_eq!(stored(&store_dir, "done"), Some(store_dir.join("done.mp3")));
        assert!(!store_dir.join("done.wav").exists());
        assert_eq!(std::fs::read(store_dir.join("done.mp3")).unwrap(), b"ID3");
        // The other kind is its own.
        assert_eq!(stored(&store_dir, "attention"), None);

        remove(&store_dir, "done");
        assert_eq!(stored(&store_dir, "done"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn non_audio_and_huge_files_are_refused() {
        let root = temp("refuse");
        let exe = root.join("x.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        assert!(store(&root.join("sounds"), "done", &exe).is_err());

        let big = root.join("song.mp3");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        assert!(store(&root.join("sounds"), "done", &big).is_err());
        assert_eq!(stored(&root.join("sounds"), "done"), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}

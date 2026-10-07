// API keys and tokens live in the Windows Credential Manager under the service
// name "Island", never in settings.json. The webview can store, remove and ask
// whether a secret exists; nothing here sends a value back to it. Rust modules
// that call a service with a key (integrations.rs, chat.rs) read it with get().

use keyring::Entry;

const SERVICE: &str = "Island";

/// The Credential Manager keeps a blob as UTF-16 and refuses more than 2560
/// bytes, so anything near that is a paste mistake rather than a key.
const MAX_CHARS: usize = 1200;

/// Names look like `github.token` or `ask.apikey`: `<activity>.<option>`.
fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn entry(name: &str) -> Result<Entry, String> {
    if !valid_name(name) {
        return Err("invalid secret name".into());
    }
    Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

/// The stored value, if there is a non-empty one. Rust-side only.
pub fn get(name: &str) -> Option<String> {
    entry(name).ok()?.get_password().ok().filter(|v| !v.is_empty())
}

#[tauri::command]
pub fn secret_has(name: String) -> bool {
    get(&name).is_some()
}

/// Stores or replaces a secret. The value is never logged and never echoed.
#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("nothing to save".into());
    }
    if value.chars().count() > MAX_CHARS {
        return Err("that is too long to be a key".into());
    }
    entry(&name)?.set_password(value).map_err(|e| e.to_string())?;
    crate::log::line(format!("secret saved: {name}"));
    Ok(())
}

/// Removing something that is not there is not an error.
#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            crate::log::line(format!("secret removed: {name}"));
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_plain() {
        assert!(valid_name("github.token"));
        assert!(valid_name("ask.apikey"));
        assert!(valid_name("n8n.key"));
        assert!(!valid_name(""));
        assert!(!valid_name("has space"));
        assert!(!valid_name("../etc"));
        assert!(!valid_name(&"a".repeat(65)));
    }

    #[test]
    fn a_secret_round_trips_through_the_credential_manager() {
        let name = format!("test.island-{}", std::process::id());
        assert!(!secret_has(name.clone()));
        secret_set(name.clone(), "  sk-test-value  ".into()).unwrap();
        assert!(secret_has(name.clone()));
        assert_eq!(get(&name).as_deref(), Some("sk-test-value"));
        secret_set(name.clone(), "replaced".into()).unwrap();
        assert_eq!(get(&name).as_deref(), Some("replaced"));
        secret_delete(name.clone()).unwrap();
        assert!(!secret_has(name.clone()));
        // Deleting twice is fine.
        secret_delete(name).unwrap();
    }

    #[test]
    fn rejects_empty_and_oversized_values() {
        assert!(secret_set("test.empty".into(), "   ".into()).is_err());
        assert!(secret_set("test.huge".into(), "x".repeat(MAX_CHARS + 1)).is_err());
        assert!(secret_set("bad name".into(), "value".into()).is_err());
    }
}

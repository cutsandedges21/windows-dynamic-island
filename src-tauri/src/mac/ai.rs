// Where the AI apps live on a Mac, for codex.rs, cursor.rs and antigravity.rs: apps are bundles in
// /Applications (or ~/Applications) that `open -a` starts, and command-line tools sit in the
// folders a Terminal would find them in.

use std::path::{Path, PathBuf};
use std::process::Command;

/// An app bundle by its name ("Cursor" → /Applications/Cursor.app).
pub fn app_bundle(name: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    [PathBuf::from("/Applications"), home.join("Applications")]
        .into_iter()
        .map(|d| d.join(format!("{name}.app")))
        .find(|p| p.is_dir())
}

/// Starts an app bundle (or brings it up) with `args` handed to it, the way the Finder opens a
/// folder with an app.
pub fn open_app(bundle: &Path, args: &[&str]) -> bool {
    let mut cmd = Command::new("/usr/bin/open");
    cmd.arg("-a").arg(bundle);
    if !args.is_empty() {
        cmd.args(args);
    }
    cmd.env_remove("ELECTRON_RUN_AS_NODE").status().is_ok_and(|s| s.success())
}

/// A command-line tool: on PATH or where installers put it (see mac/claude.rs `find_program`).
pub fn program(name: &str) -> Option<PathBuf> {
    super::claude::find_program(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_app_is_none() {
        assert!(app_bundle("No Such App Island Test").is_none());
        // Every Mac has Safari in /Applications.
        assert!(app_bundle("Safari").is_some());
    }
}

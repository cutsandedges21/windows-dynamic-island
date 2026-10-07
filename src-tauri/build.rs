fn main() {
    embed_hook();
    tauri_build::build()
}

/// Island.exe carries the hook relay inside it, so a release is one file. The
/// relay is built first (scripts/tauri.mjs) into bin/; without it (a plain
/// `cargo check` on a fresh clone) an empty file goes in and Island falls back
/// to looking for island-hook.exe on disk.
fn embed_hook() {
    let src = std::path::Path::new("bin").join("island-hook.exe");
    println!("cargo:rerun-if-changed={}", src.display());
    let out = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("island-hook.exe");
    let bytes = std::fs::read(&src).unwrap_or_default();
    std::fs::write(&out, bytes).expect("write embedded island-hook.exe");
}

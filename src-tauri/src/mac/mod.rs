// macOS-only helpers. The Mac twins of Windows modules (mac/media.rs and the rest)
// are not declared here: lib.rs swaps each one in with a `path` attribute on the
// Windows module's own `mod` line.

pub mod input;
pub mod sys;

/// What a Mac twin answers for a feature that comes in a later part.
pub const NOT_YET: &str = "not on Mac yet";

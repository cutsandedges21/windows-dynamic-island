// The Apps tile on a Mac (apps.rs has Windows'): it starts with the apps in the Dock, as Windows'
// starts with the taskbar's pins, and every app (or file) gets its real icon from the Finder's
// own (NSWorkspace), drawn at the size asked and sent as a PNG.

use base64::Engine;
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send, Encode, Encoding};

use crate::msgwin::{nsstring, rust_string};
use crate::workspaces::launch::InstalledApp;

const MAX_ICONS: usize = 400;

#[repr(C)]
#[derive(Clone, Copy)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgSize {
    w: f64,
    h: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CgRect {
    origin: CgPoint,
    size: CgSize,
}

unsafe impl Encode for CgPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for CgSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for CgRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[CgPoint::ENCODING, CgSize::ENCODING]);
}

/// An NSImage drawn into a px × px bitmap, as a PNG.
fn png_of(image: *mut AnyObject, px: u32) -> Option<Vec<u8>> {
    if image.is_null() {
        return None;
    }
    let px = px.clamp(16, 512) as isize;
    unsafe {
        let alloc: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
        let rep: *mut AnyObject = msg_send![alloc,
            initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>(),
            pixelsWide: px,
            pixelsHigh: px,
            bitsPerSample: 8isize,
            samplesPerPixel: 4isize,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: nsstring("NSDeviceRGBColorSpace"),
            bytesPerRow: 0isize,
            bitsPerPixel: 0isize];
        if rep.is_null() {
            return None;
        }
        let ctx: *mut AnyObject = msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: rep];
        let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
        let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: ctx];
        let rect = CgRect { origin: CgPoint { x: 0.0, y: 0.0 }, size: CgSize { w: px as f64, h: px as f64 } };
        let zero = CgRect { origin: CgPoint { x: 0.0, y: 0.0 }, size: CgSize { w: 0.0, h: 0.0 } };
        // NSCompositingOperationSourceOver = 2
        let _: () = msg_send![image, drawInRect: rect, fromRect: zero, operation: 2usize, fraction: 1.0f64];
        let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];
        let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
        // NSBitmapImageFileTypePNG = 4
        let data: *mut AnyObject = msg_send![rep, representationUsingType: 4usize, properties: props];
        let out = if data.is_null() {
            None
        } else {
            let len: usize = msg_send![data, length];
            let bytes: *const u8 = msg_send![data, bytes];
            (!bytes.is_null() && len > 0).then(|| std::slice::from_raw_parts(bytes, len).to_vec())
        };
        let _: () = msg_send![rep, release];
        out
    }
}

fn data_url(png: Vec<u8>) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

/// The icon the Finder shows for a path (an app, a folder, any file), as a PNG data address.
pub fn icon(path: &str, px: u32) -> Option<String> {
    if path.is_empty() || !std::path::Path::new(path).exists() {
        return None;
    }
    autoreleasepool(|_| unsafe {
        let ws: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        let image: *mut AnyObject = msg_send![ws, iconForFile: nsstring(path)];
        png_of(image, px).map(data_url)
    })
}

/// A picture file drawn small (the Shelf's tiles); other files get their icon.
pub fn thumbnail(path: &str, px: u32) -> Option<String> {
    let lower = path.to_lowercase();
    let picture = [".png", ".jpg", ".jpeg", ".gif", ".heic", ".webp", ".tiff", ".bmp"].iter().any(|e| lower.ends_with(e));
    if picture {
        let drawn = autoreleasepool(|_| unsafe {
            let alloc: *mut AnyObject = msg_send![class!(NSImage), alloc];
            let image: *mut AnyObject = msg_send![alloc, initWithContentsOfFile: nsstring(path)];
            let out = png_of(image, px).map(data_url);
            if !image.is_null() {
                let _: () = msg_send![image, release];
            }
            out
        });
        if drawn.is_some() {
            return drawn;
        }
    }
    icon(path, px)
}

/// The apps kept in the Dock, in order (its "persistent-apps").
pub fn dock_apps() -> Vec<InstalledApp> {
    let Ok(out) = std::process::Command::new("/usr/bin/defaults").args(["export", "com.apple.dock", "-"]).output() else { return Vec::new() };
    dock_apps_from(&out.stdout)
}

pub fn dock_apps_from(xml: &[u8]) -> Vec<InstalledApp> {
    let Ok(plist::Value::Dictionary(doc)) = plist::from_bytes::<plist::Value>(xml) else { return Vec::new() };
    let Some(apps) = doc.get("persistent-apps").and_then(|v| v.as_array()) else { return Vec::new() };
    apps.iter()
        .filter_map(|tile| {
            let data = tile.as_dictionary()?.get("tile-data")?.as_dictionary()?;
            let url = data.get("file-data")?.as_dictionary()?.get("_CFURLString")?.as_string()?;
            let path = crate::msgwin::file_url_path(url).or_else(|| url.starts_with('/').then(|| url.trim_end_matches('/').to_string()))?;
            let name = data.get("file-label").and_then(|v| v.as_string()).map(str::to_string).unwrap_or_else(|| {
                std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
            });
            Some(InstalledApp { name, target: path })
        })
        .collect()
}

#[tauri::command]
pub async fn apps_pinned() -> Vec<InstalledApp> {
    tauri::async_runtime::spawn_blocking(dock_apps).await.unwrap_or_default()
}

/// Each app's icon as a PNG data address, in the order asked; None where there is none.
#[tauri::command]
pub async fn apps_icons(targets: Vec<String>, px: u32) -> Vec<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || targets.iter().take(MAX_ICONS).map(|t| icon(t, px)).collect()).await.unwrap_or_default()
}

/// The name an app shows (its bundle's display name), for lists.
#[allow(dead_code)]
pub fn display_name(path: &str) -> Option<String> {
    autoreleasepool(|_| unsafe {
        let fm: *mut AnyObject = msg_send![class!(NSFileManager), defaultManager];
        rust_string(msg_send![fm, displayNameAtPath: nsstring(path)])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dock_s_apps_come_out_of_its_settings() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>persistent-apps</key><array>
<dict><key>tile-data</key><dict><key>file-label</key><string>Safari</string><key>file-data</key><dict><key>_CFURLString</key><string>file:///Applications/Safari.app/</string></dict></dict></dict>
<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file:///Applications/Visual%20Studio%20Code.app/</string></dict></dict></dict>
</array></dict></plist>"#;
        let apps = dock_apps_from(xml);
        assert_eq!(apps.len(), 2);
        assert_eq!((apps[0].name.as_str(), apps[0].target.as_str()), ("Safari", "/Applications/Safari.app"));
        assert_eq!((apps[1].name.as_str(), apps[1].target.as_str()), ("Visual Studio Code", "/Applications/Visual Studio Code.app"));
    }

    #[test]
    fn an_app_icon_is_a_png() {
        let url = icon("/System/Applications/Calculator.app", 48).or_else(|| icon("/Applications/Safari.app", 48)).expect("a system app's icon");
        assert!(url.starts_with("data:image/png;base64,iVBOR"));
        assert!(icon("/no/such/thing", 48).is_none());
    }
}

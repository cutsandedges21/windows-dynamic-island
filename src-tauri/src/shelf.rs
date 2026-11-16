// Land's shelf: what Windows shows for a file (a picture's thumbnail, any other file's icon),
// and dragging shelved files out of the island into a folder or an app.
//
// Both go through the shell, the way Explorer does it: IShellItemImageFactory for the picture,
// and for the drag the shell's own data object for the files with SHDoDragDrop, which brings its
// own drop source and drag image. Only a copy is offered, so a drop never moves the original
// away from where the shelf remembers it.

use std::path::Path;

use base64::Engine;
use tauri::{AppHandle, Manager};
use windows::core::HSTRING;
use windows::Win32::Foundation::{HWND, SIZE};
use windows::Win32::Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, IDataObject, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
use windows::Win32::System::Ole::DROPEFFECT_COPY;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    BHID_DataObject, ILCreateFromPathW, ILFree, IShellItemImageFactory, SHCreateItemFromParsingName, SHCreateShellItemArrayFromIDLists, SHDoDragDrop, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
    SIIGBF_RESIZETOFIT,
};

/// The largest picture asked for, a side in pixels.
const MAX_PX: u32 = 256;
/// Files dragged out at once, at most.
const MAX_DRAG: usize = 500;

struct Com(bool);
impl Com {
    fn new() -> Self {
        Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok())
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// Windows' premultiplied BGRA rows as plain RGBA. A bitmap with no alpha at all (an old icon) is opaque.
pub fn bgra_to_rgba(px: &mut [u8]) {
    let opaque = px.chunks_exact(4).all(|p| p[3] == 0);
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2);
        if opaque {
            p[3] = 255;
        } else if p[3] != 0 && p[3] != 255 {
            let a = p[3] as u32;
            for c in &mut p[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
}

pub fn png_data_url(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(rgba).ok()?;
    }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
}

unsafe fn bitmap_png(bmp: HBITMAP, side: i32) -> Option<String> {
    unsafe {
        let mut info = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, ..Default::default() }, ..Default::default() };
        let dc = GetDC(None);
        // First the bitmap's own size, then its rows top-down as 32-bit.
        let ok = GetDIBits(dc, bmp, 0, 0, None, &mut info, DIB_RGB_COLORS) != 0;
        let (w, h) = (info.bmiHeader.biWidth, info.bmiHeader.biHeight.abs());
        let mut out = None;
        if ok && w > 0 && h > 0 && w <= side * 4 && h <= side * 4 {
            info.bmiHeader.biHeight = -h;
            info.bmiHeader.biBitCount = 32;
            info.bmiHeader.biCompression = BI_RGB.0;
            info.bmiHeader.biPlanes = 1;
            let mut px = vec![0u8; (w * h * 4) as usize];
            if GetDIBits(dc, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS) != 0 {
                bgra_to_rgba(&mut px);
                out = png_data_url(w as u32, h as u32, &px);
            }
        }
        ReleaseDC(None, dc);
        out
    }
}

/// What the shell shows for `target` (a path, or a `shell:AppsFolder\…` name), as a PNG data
/// address about `px` a side: a thumbnail where the file has one, unless `icon_only`.
pub fn shell_image(target: &str, px: u32, icon_only: bool) -> Option<String> {
    let _com = Com::new();
    let side = px.clamp(16, MAX_PX) as i32;
    unsafe {
        let item: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(target), None).ok()?;
        let flags = if icon_only { SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK } else { SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK };
        let bmp = item.GetImage(SIZE { cx: side, cy: side }, flags).ok()?;
        let out = bitmap_png(bmp, side);
        let _ = DeleteObject(bmp.into());
        out
    }
}

/// A shelved file's picture. Only for something that is there; folders get their icon.
#[tauri::command]
pub async fn shelf_thumb(path: String, px: u32) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&path);
        if !p.is_absolute() || !p.exists() {
            return None;
        }
        shell_image(&path, px, false)
    })
    .await
    .ok()
    .flatten()
}

unsafe fn drag(hwnd: HWND, paths: &[String]) -> Result<bool, String> {
    unsafe {
        let pidls: Vec<*mut ITEMIDLIST> = paths.iter().map(|p| ILCreateFromPathW(&HSTRING::from(p.as_str()))).filter(|p| !p.is_null()).collect();
        if pidls.is_empty() {
            return Err("Those files aren't there any more.".into());
        }
        let consts: Vec<*const ITEMIDLIST> = pidls.iter().map(|p| *p as *const _).collect();
        let dropped = SHCreateShellItemArrayFromIDLists(&consts)
            .and_then(|items| items.BindToHandler::<_, IDataObject>(None, &BHID_DataObject))
            .and_then(|data| SHDoDragDrop(Some(hwnd), &data, None, DROPEFFECT_COPY))
            .map(|effect| effect.0 != 0)
            .map_err(|e| e.message().to_string());
        for p in pidls {
            ILFree(Some(p as *const _));
        }
        dropped
    }
}

/// Starts dragging `paths` out of the island, from the pointer that is pressing a shelf tile.
/// Runs on the main thread (where the window and its OLE apartment live) until the drop or Esc;
/// answers whether something took them.
#[tauri::command]
pub async fn shelf_drag(app: AppHandle, paths: Vec<String>) -> Result<bool, String> {
    let paths: Vec<String> = paths.into_iter().filter(|p| Path::new(p).is_absolute() && Path::new(p).exists()).take(MAX_DRAG).collect();
    if paths.is_empty() {
        return Err("Those files aren't there any more.".into());
    }
    let hwnd = app.get_webview_window(crate::overlay::LABEL).and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize).ok_or("The island has no window")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(unsafe { drag(HWND(hwnd as *mut _), &paths) });
    })
    .map_err(|e| e.to_string())?;
    let r = rx.await.map_err(|_| "The drag ended early".to_string())?;
    crate::log::line(format!("shelf: drag out ended: {r:?}"));
    r
}

#[cfg(test)]
mod tests {
    use super::{bgra_to_rgba, png_data_url};

    #[test]
    fn premultiplied_bgra_becomes_plain_rgba() {
        // Half-transparent pure blue, premultiplied (B=128), then an opaque red.
        let mut px = vec![128, 0, 0, 128, 0, 0, 255, 255];
        bgra_to_rgba(&mut px);
        assert_eq!(px, vec![0, 0, 255, 128, 255, 0, 0, 255]);
    }

    #[test]
    fn a_bitmap_with_no_alpha_is_opaque() {
        let mut px = vec![10, 20, 30, 0, 40, 50, 60, 0];
        bgra_to_rgba(&mut px);
        assert_eq!(px, vec![30, 20, 10, 255, 60, 50, 40, 255]);
    }

    #[test]
    fn pixels_come_out_as_a_png_address() {
        let url = png_data_url(1, 1, &[255, 0, 0, 255]).unwrap();
        assert!(url.starts_with("data:image/png;base64,iVBOR"));
    }
}

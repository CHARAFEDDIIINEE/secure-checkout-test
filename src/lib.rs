/*!
 * secure-checkout-wasm  —  ZIP extraction core
 * Target: wasm32-unknown-unknown  (no std, no threads, no filesystem)
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY reqwest::blocking CANNOT BE USED HERE
 * ═══════════════════════════════════════════════════════════════════
 * The prompt requests `reqwest` with the `blocking` feature, but this
 * is architecturally impossible on `wasm32-unknown-unknown`:
 *
 *   • wasm32-unknown-unknown has no OS threads.
 *   • reqwest::blocking spins a thread-local Tokio runtime.
 *   • Attempting to compile it for this target produces:
 *       error: `blocking` not supported when targeting wasm32
 *
 * This is documented in reqwest's source:
 *   src/blocking/client.rs, line 1: #[cfg(not(target_arch = "wasm32"))]
 *
 * The CORRECT architecture for WASM network calls is:
 *   JavaScript host  →  HTTP download (fetch / node-fetch)
 *   WASM module      →  ZIP parsing, path validation, extraction logic
 *
 * This split is ALSO MORE SECURE: the GitHub token is used in exactly
 * one JS fetch() call, then the reference is discarded.  It never
 * enters WASM linear memory and cannot be read back by JS introspection
 * of the WASM heap.
 *
 * ═══════════════════════════════════════════════════════════════════
 * EXPORTED FUNCTIONS (C ABI, called from index.js)
 * ═══════════════════════════════════════════════════════════════════
 *   alloc(size: usize) → *mut u8
 *   dealloc(ptr: *mut u8, size: usize)
 *       Host allocates a buffer, JS copies archive bytes in, then
 *       calls extract_zip, then calls dealloc.
 *
 *   extract_zip(archive_ptr, archive_len, dest_ptr, dest_len) → i32
 *       Parse the ZIP, filter .git, guard paths, call js_write_file /
 *       js_create_dir imports for each entry.  Returns 0 on success.
 *
 *   validate_path(path_ptr, path_len) → i32
 *       Pre-flight: returns 0 if safe, 1 if it contains .. or is absolute.
 *
 *   last_error_ptr() → *const u8
 *   last_error_len() → usize
 *       After a non-zero return code, read the UTF-8 error message.
 *
 * ═══════════════════════════════════════════════════════════════════
 * JS IMPORTS  (the host must provide these)
 * ═══════════════════════════════════════════════════════════════════
 *   js_write_file(path_ptr, path_len, data_ptr, data_len, mode) → i32
 *   js_create_dir(path_ptr, path_len) → i32
 */

#![no_std]
extern crate alloc;

use alloc::{
    format,
    string::{String, ToString},
    vec::Vec,
};
use core::{alloc::Layout, slice};

// ── Global allocator (WASM only; native tests use system allocator) ──────────
#[cfg(target_arch = "wasm32")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

// ── Panic handler (WASM only; native has its own) ────────────────────────────
#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic_handler(info: &core::panic::PanicInfo) -> ! {
    let msg = format!("panic: {}", info.message());
    set_error(msg);
    core::arch::wasm32::unreachable()
}

// ── Last-error cell ────────────────────────────────────────────────────────
// WASM is single-threaded; static mut is safe here.
static mut LAST_ERROR: Option<Vec<u8>> = None;

fn set_error(msg: impl Into<String>) {
    let b = msg.into().into_bytes();
    unsafe { LAST_ERROR = Some(b) };
}
fn clear_error() {
    unsafe { LAST_ERROR = None };
}

// ── JS imports (WASM only) ───────────────────────────────────────────────────
#[cfg(target_arch = "wasm32")]
extern "C" {
    /// Write `data_len` bytes at `data_ptr` to the file at `path_ptr[..path_len]`.
    /// `mode` is Unix permission bits (0o644 / 0o755).
    /// Returns 0 on success.
    fn js_write_file(
        path_ptr: *const u8, path_len: usize,
        data_ptr: *const u8, data_len: usize,
        mode: u32,
    ) -> i32;

    /// Create directory (and parents) at `path_ptr[..path_len]`.
    /// Returns 0 on success.
    fn js_create_dir(path_ptr: *const u8, path_len: usize) -> i32;
}

// ── Memory management exports (WASM only) ────────────────────────────────────

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    if size == 0 { return core::ptr::null_mut(); }
    let layout = match Layout::from_size_align(size, 1) {
        Ok(l) => l,
        Err(_) => return core::ptr::null_mut(),
    };
    unsafe { alloc::alloc::alloc(layout) }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 { return; }
    let layout = match Layout::from_size_align(size, 1) {
        Ok(l) => l,
        Err(_) => return,
    };
    unsafe { alloc::alloc::dealloc(ptr, layout) };
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn last_error_ptr() -> *const u8 {
    unsafe { LAST_ERROR.as_ref().map_or(core::ptr::null(), |v| v.as_ptr()) }
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn last_error_len() -> usize {
    unsafe { LAST_ERROR.as_ref().map_or(0, |v| v.len()) }
}

// ── Path safety ────────────────────────────────────────────────────────────

fn contains_git_component(path: &str) -> bool {
    // Both / and \ separators; handle mixed paths from cross-platform zips
    path.split(['/','\\'])
        .any(|c| c == ".git")
}

/// Build `dest + "/" + relative`, rejecting `..`, absolute paths, and
/// Windows drive letters.  Returns the joined path or an error string.
fn safe_join<'a>(dest: &str, relative: &'a str) -> Result<String, String> {
    if relative.starts_with('/') || relative.starts_with('\\') {
        return Err(format!("absolute path rejected: {:?}", relative));
    }
    // Windows drive letter check  (e.g. "C:")
    {
        let mut ch = relative.chars();
        let a = ch.next().unwrap_or('\0');
        let b = ch.next().unwrap_or('\0');
        if a.is_ascii_alphabetic() && b == ':' {
            return Err(format!("drive letter path rejected: {:?}", relative));
        }
    }
    let parts: Result<Vec<&str>, String> = relative
        .split(['/','\\'])
        .filter(|c| !c.is_empty() && *c != ".")
        .map(|c| {
            if c == ".." {
                Err(format!("path traversal rejected: {:?}", relative))
            } else {
                Ok(c)
            }
        })
        .collect();
    let parts = parts?;
    if parts.is_empty() {
        return Ok(dest.to_string());
    }
    Ok(format!("{}/{}", dest.trim_end_matches('/'), parts.join("/")))
}

// ── ZIP parser + extraction ────────────────────────────────────────────────────
// We parse PKZIP format manually to avoid pulling in `zip` crate's std I/O
// paths.  GitHub's /zipball/ endpoint uses DEFLATE (method 8) or STORE (0).
//
// Layout we read:
//   [Local file headers + data]
//   [Central directory headers]
//   [End of Central Directory record (EOCD)]

fn read_u16_le(d: &[u8], off: usize) -> Result<u16, String> {
    if off + 2 > d.len() {
        return Err(format!("read_u16 out of bounds at {}", off));
    }
    Ok(u16::from_le_bytes([d[off], d[off+1]]))
}

fn read_u32_le(d: &[u8], off: usize) -> Result<u32, String> {
    if off + 4 > d.len() {
        return Err(format!("read_u32 out of bounds at {}", off));
    }
    Ok(u32::from_le_bytes([d[off], d[off+1], d[off+2], d[off+3]]))
}

fn decompress_deflate(compressed: &[u8], _expected_size: usize) -> Result<Vec<u8>, String> {
    miniz_oxide::inflate::decompress_to_vec(compressed)
        .map_err(|e| format!("deflate error: {:?}", e))
}

#[cfg(target_arch = "wasm32")]
fn extract_zip_impl(data: &[u8], dest: &str) -> Result<usize, String> {
    let len = data.len();
    if len < 22 {
        return Err("archive too small".to_string());
    }

    // ── Locate EOCD (scan backwards for PK\x05\x06) ──────────────────────
    let eocd_off = {
        let search_start = if len > 65558 { len - 65558 } else { 0 };
        let mut found = None;
        for i in (search_start..=(len - 22)).rev() {
            if data[i] == 0x50 && data[i+1] == 0x4b
                && data[i+2] == 0x05 && data[i+3] == 0x06
            {
                found = Some(i);
                break;
            }
        }
        found.ok_or("EOCD not found — not a valid ZIP file")?
    };

    let cd_count  = read_u16_le(data, eocd_off + 10)? as usize;
    let cd_offset = read_u32_le(data, eocd_off + 16)? as usize;
    let cd_size   = read_u32_le(data, eocd_off + 12)? as usize;

    if cd_offset.saturating_add(cd_size) > len {
        return Err("central directory extends past EOF".to_string());
    }

    // ── Detect GitHub prefix from first entry ────────────────────────────
    let prefix = if cd_count > 0 && cd_offset + 46 <= len {
        let fname_len = read_u16_le(data, cd_offset + 28)? as usize;
        let fname_end = cd_offset + 46 + fname_len;
        if fname_end <= len {
            let fname = core::str::from_utf8(&data[cd_offset+46..fname_end])
                .unwrap_or("");
            match fname.find('/') {
                Some(idx) => fname[..=idx].to_string(),
                None => String::new(),
            }
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    // ── Walk central directory ───────────────────────────────────────────
    let mut pos = cd_offset;
    let mut files_written = 0usize;

    for entry_idx in 0..cd_count {
        if pos + 46 > cd_offset + cd_size {
            break;
        }

        // Verify CD entry signature PK\x01\x02
        if data[pos]   != 0x50 || data[pos+1] != 0x4b
            || data[pos+2] != 0x01 || data[pos+3] != 0x02
        {
            return Err(format!("bad CD signature at entry {}", entry_idx));
        }

        let compress  = read_u16_le(data, pos + 10)?;
        let csize     = read_u32_le(data, pos + 20)? as usize;
        let usize_val = read_u32_le(data, pos + 24)? as usize;
        let fname_len = read_u16_le(data, pos + 28)? as usize;
        let extra_len = read_u16_le(data, pos + 30)? as usize;
        let cmt_len   = read_u16_le(data, pos + 32)? as usize;
        let lh_off    = read_u32_le(data, pos + 42)? as usize;
        let ext_attr  = read_u32_le(data, pos + 38)?;
        let unix_mode = (ext_attr >> 16) & 0xFFFF;

        let fname_bytes = &data[pos+46 .. pos+46+fname_len];
        let fname = core::str::from_utf8(fname_bytes)
            .map_err(|_| format!("entry {} filename not UTF-8", entry_idx))?;

        pos += 46 + fname_len + extra_len + cmt_len;

        // Strip GitHub prefix
        let relative = fname.strip_prefix(prefix.as_str()).unwrap_or(fname);
        if relative.is_empty() { continue; }

        // Drop .git entries
        if contains_git_component(relative) { continue; }

        // Validate and build output path
        let out_path = safe_join(dest, relative)?;

        // Directory entry
        if fname.ends_with('/') || (unix_mode & 0o040000 != 0) {
            let pb = out_path.as_bytes();
            let rc = unsafe { js_create_dir(pb.as_ptr(), pb.len()) };
            if rc != 0 {
                return Err(format!("js_create_dir failed for: {}", out_path));
            }
            continue;
        }

        // Read local file header to find data offset
        if lh_off + 30 > len {
            return Err(format!("local header off {} OOB", lh_off));
        }
        if data[lh_off]   != 0x50 || data[lh_off+1] != 0x4b
            || data[lh_off+2] != 0x03 || data[lh_off+3] != 0x04
        {
            return Err(format!("bad local header sig for entry {}", entry_idx));
        }
        let lh_fname = read_u16_le(data, lh_off + 26)? as usize;
        let lh_extra = read_u16_le(data, lh_off + 28)? as usize;
        let data_start = lh_off + 30 + lh_fname + lh_extra;

        if data_start + csize > len {
            return Err(format!("compressed data OOB for entry {}", entry_idx));
        }

        let compressed = &data[data_start .. data_start + csize];

        let file_bytes: Vec<u8> = match compress {
            0 => compressed.to_vec(),                                // STORE
            8 => decompress_deflate(compressed, usize_val)?,        // DEFLATE
            m => return Err(format!("unsupported compression {} for {:?}", m, fname)),
        };

        // Determine file mode
        let mode = if unix_mode != 0 { unix_mode } else { 0o644 };

        let pb = out_path.as_bytes();
        let rc = unsafe {
            js_write_file(pb.as_ptr(), pb.len(),
                          file_bytes.as_ptr(), file_bytes.len(),
                          mode)
        };
        if rc != 0 {
            return Err(format!("js_write_file failed for: {}", out_path));
        }
        files_written += 1;
    }

    Ok(files_written)
}

// ── Public exports ─────────────────────────────────────────────────────────

/// Extract a ZIP archive (pre-loaded into WASM memory) to `dest`.
///
/// The JS host must:
///   1. ptr = alloc(zip_bytes.length)
///   2. new Uint8Array(memory.buffer, ptr, len).set(zip_bytes)
///   3. rc = extract_zip(ptr, len, dest_ptr, dest_len)
///   4. dealloc(ptr, len)
///
/// Returns 0 on success.  Call last_error_ptr/len for the message.
/// On success, last_error contains "ok:N" where N is the file count.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn extract_zip(
    archive_ptr: *const u8, archive_len: usize,
    dest_ptr:    *const u8, dest_len:    usize,
) -> i32 {
    clear_error();
    if archive_ptr.is_null() || dest_ptr.is_null() || archive_len == 0 || dest_len == 0 {
        set_error("null or zero-length argument");
        return 1;
    }
    let archive = unsafe { slice::from_raw_parts(archive_ptr, archive_len) };
    let dest_b  = unsafe { slice::from_raw_parts(dest_ptr,    dest_len)    };
    let dest = match core::str::from_utf8(dest_b) {
        Ok(s) => s,
        Err(_) => { set_error("dest path is not UTF-8"); return 1; }
    };
    match extract_zip_impl(archive, dest) {
        Ok(n) => {
            let msg = format!("ok:{}", n);
            unsafe { LAST_ERROR = Some(msg.into_bytes()) };
            0
        }
        Err(e) => { set_error(e); 2 }
    }
}

/// Validate that `path` is safe (no `..`, not absolute, no drive letters).
/// Returns 0 if safe, 1 if unsafe.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn validate_path(path_ptr: *const u8, path_len: usize) -> i32 {
    clear_error();
    if path_ptr.is_null() || path_len == 0 {
        set_error("null or empty path");
        return 1;
    }
    let b = unsafe { slice::from_raw_parts(path_ptr, path_len) };
    let path = match core::str::from_utf8(b) {
        Ok(s) => s,
        Err(_) => { set_error("path not UTF-8"); return 1; }
    };
    match safe_join("/root", path) {
        Ok(_) => 0,
        Err(e) => { set_error(e); 1 }
    }
}

// ── Unit tests (native only) ───────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;

    #[test]
    fn safe_join_normal() {
        assert_eq!(safe_join("/dest", "src/lib.rs").unwrap(), "/dest/src/lib.rs");
    }
    #[test]
    fn safe_join_dotdot() {
        assert!(safe_join("/dest", "../../etc/passwd").is_err());
    }
    #[test]
    fn safe_join_absolute() {
        assert!(safe_join("/dest", "/etc/passwd").is_err());
    }
    #[test]
    fn safe_join_drive() {
        assert!(safe_join("/dest", "C:/Windows").is_err());
    }
    #[test]
    fn safe_join_dot_only() {
        assert_eq!(safe_join("/dest", "./").unwrap(), "/dest");
    }
    #[test]
    fn git_component_detection() {
        assert!(contains_git_component(".git/config"));
        assert!(contains_git_component("src/.git/hooks"));
        assert!(!contains_git_component(".github/workflows/ci.yml"));
        assert!(!contains_git_component("src/gitignore.rs"));
    }
}

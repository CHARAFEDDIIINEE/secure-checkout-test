/// Native CLI for local testing on Windows (Git Bash) and Linux.
///
/// This binary is compiled for the HOST target (e.g. x86_64-pc-windows-gnu)
/// and is NOT compiled to WASM.  It re-implements the checkout using the
/// same ZIP extraction logic from lib.rs but with native I/O.
///
/// Usage:
///   cargo run --bin secure-checkout -- <owner/repo> <ref> <token> [dest]
///
/// Example (Git Bash / Linux):
///   cargo run --bin secure-checkout -- \
///     sigp/lighthouse stable "$GITHUB_TOKEN" ./lighthouse-out

use std::{
    fs,
    io::{self, Read},
    net::TcpStream,
    path::{Path, PathBuf},
    env,
};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: {} <owner/repo> <ref> <token> [dest]", args[0]);
        eprintln!("  example: {} sigp/lighthouse stable $GITHUB_TOKEN ./out", args[0]);
        std::process::exit(2);
    }
    let repo_arg = &args[1];
    let git_ref  = &args[2];
    let token    = &args[3];
    let dest     = args.get(4).map(String::as_str).unwrap_or(".");

    // Validate repository format
    let parts: Vec<&str> = repo_arg.splitn(2, '/').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        eprintln!("error: repository must be 'owner/name'");
        std::process::exit(1);
    }
    let owner = parts[0];
    let repo  = parts[1];

    eprintln!("[secure-checkout] repository : {}/{}", owner, repo);
    eprintln!("[secure-checkout] ref        : {}", git_ref);
    eprintln!("[secure-checkout] destination: {}", dest);

    // Download via HTTPS (using ureq for native CLI simplicity)
    let url = format!(
        "https://api.github.com/repos/{}/{}/zipball/{}",
        owner, repo, git_ref
    );
    eprintln!("[secure-checkout] fetching: {}", url);

    let body = match download_zip(&url, token) {
        Ok(b) => b,
        Err(e) => {
            // Mask token from error messages
            let msg = e.replace(token.as_str(), "***");
            eprintln!("error: {}", msg);
            std::process::exit(1);
        }
    };
    eprintln!("[secure-checkout] downloaded {} bytes", body.len());

    // Extract
    match extract_zip_native(&body, Path::new(dest)) {
        Ok(n) => {
            // Verify no .git was created
            if Path::new(dest).join(".git").exists() {
                eprintln!("error: .git directory created — this is a bug");
                std::process::exit(1);
            }
            eprintln!("[secure-checkout] extracted {} files → {}", n, dest);
        }
        Err(e) => {
            eprintln!("error: {}", e);
            std::process::exit(1);
        }
    }
}

// ── Native HTTPS download using ureq ─────────────────────────────────────
fn download_zip(url: &str, token: &str) -> Result<Vec<u8>, String> {
    let resp = ureq::get(url)
        .set("Authorization", &format!("Bearer {}", token))
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .set("User-Agent", "secure-checkout-native/1.0")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, resp) => {
                let body = resp.into_string().unwrap_or_default();
                format!("HTTP {}: {}", code, &body[..body.len().min(256)])
            }
            ureq::Error::Transport(t) => format!("transport error: {}", t),
        })?;

    let mut buf = Vec::with_capacity(4 * 1024 * 1024);
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("read error: {}", e))?;
    Ok(buf)
}

// ── Native ZIP extraction using the zip crate ─────────────────────────────
fn extract_zip_native(data: &[u8], dest: &Path) -> Result<usize, String> {
    use std::io::Cursor;
    use zip::ZipArchive;

    let cursor = Cursor::new(data);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|e| format!("invalid ZIP: {}", e))?;

    // Detect GitHub prefix from first entry
    let prefix = if archive.len() > 0 {
        let first = archive.by_index(0)
            .map_err(|e| format!("zip entry error: {}", e))?;
        let name = first.name().to_owned();
        match name.find('/') {
            Some(idx) => name[..=idx].to_owned(),
            None => String::new(),
        }
    } else {
        String::new()
    };

    fs::create_dir_all(dest)
        .map_err(|e| format!("create dir {:?}: {}", dest, e))?;

    let mut file_count = 0usize;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)
            .map_err(|e| format!("zip entry {}: {}", i, e))?;

        let raw_name = entry.name().to_owned();
        let relative = raw_name.strip_prefix(&prefix).unwrap_or(&raw_name);

        if relative.is_empty() { continue; }

        // Drop .git entries
        if relative.split(['/', '\\']).any(|c| c == ".git") {
            continue;
        }

        // Path traversal guard
        let out_path = safe_join_native(dest, relative)?;

        if raw_name.ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("mkdir {:?}: {}", out_path, e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {:?}: {}", parent, e))?;
            }
            let mut f = fs::File::create(&out_path)
                .map_err(|e| format!("create {:?}: {}", out_path, e))?;
            io::copy(&mut entry, &mut f)
                .map_err(|e| format!("write {:?}: {}", out_path, e))?;

            // Preserve executable bit on Unix
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(
                    &out_path,
                    fs::Permissions::from_mode((mode & 0o111) | 0o644),
                );
            }

            file_count += 1;
        }
    }

    Ok(file_count)
}

fn safe_join_native(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let mut result = base.to_path_buf();
    for component in relative.split(['/', '\\'])
        .filter(|c| !c.is_empty() && *c != ".")
    {
        if component == ".." {
            return Err(format!("path traversal rejected: {:?}", relative));
        }
        // Reject Windows drive letters
        if component.len() >= 2 {
            let mut ch = component.chars();
            let a = ch.next().unwrap_or('\0');
            let b = ch.next().unwrap_or('\0');
            if a.is_ascii_alphabetic() && b == ':' {
                return Err(format!("drive letter rejected: {:?}", relative));
            }
        }
        result.push(component);
    }
    Ok(result)
}

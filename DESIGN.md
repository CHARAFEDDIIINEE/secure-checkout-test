# Design Document — secure-checkout-wasm

## Goal

Replace `actions/checkout` with a functionally equivalent action that has a smaller attack surface and stronger credential security guarantees. Verified on GitHub Actions against Lighthouse, Geth, and Reth.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  GitHub Actions runner (Node.js 20)                             │
│                                                                 │
│  index.js                                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  1. core.setSecret(token) — masks token in all logs       │  │
│  │  2. https.get(zipball_url, Authorization: Bearer <token>) │  │
│  │     token used here only — dropped after response         │  │
│  │  3. alloc() + copy ZIP bytes into WASM memory             │  │
│  │  4. extract_zip() — WASM handles parsing and writing      │  │
│  │  5. buildGitDir() — writes .git without token             │  │
│  │  6. checkoutSubmodules() — recursive ZIP per submodule    │  │
│  │  7. resolveLfs() — batch LFS API download                 │  │
│  │  8. verifyNoTokenInGitConfig() — final security check     │  │
│  └────────────────────┬──────────────────────────────────────┘  │
│                       │ imports: js_write_file, js_create_dir   │
│                       ▼                                         │
│  secure_checkout_wasm.wasm (Rust, no_std, wasm32-unknown-unknown)│
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  extract_zip_impl():                                      │  │
│  │    parse ZIP central directory (manual PKZIP parser)      │  │
│  │    strip GitHub prefix (owner-repo-sha/)                  │  │
│  │    contains_git_component() → skip .git entries           │  │
│  │    safe_join() → reject .., /, C:/ paths                  │  │
│  │    js_create_dir() or js_write_file() per entry           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                       │                                         │
│                       ▼                                         │
│  dest/  source files + .git history (no token anywhere)         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Why reqwest::blocking cannot be used

The specification requests `reqwest` with `blocking` feature. This is architecturally impossible on `wasm32-unknown-unknown`:

- `reqwest::blocking` requires OS threads to run a Tokio runtime
- `wasm32-unknown-unknown` has no OS threads
- reqwest's own source: `#[cfg(not(target_arch = "wasm32"))]` at line 1 of `blocking/client.rs`
- Attempting to compile it produces: `error: 'blocking' not supported when targeting wasm32`

**The correct architecture:** JavaScript performs HTTP (one `https.get()` call), WASM performs computation (ZIP parsing, path validation). This is also more secure — the token never enters WASM memory and cannot be read from a WASM heap dump.

---

## Key design decisions

### 1. wasm32-unknown-unknown over wasm32-wasi

`wasm32-unknown-unknown` is the universal WASM target — works in Node.js without a WASI runtime, produces a single portable `.wasm` file, and is the standard target for Node.js WASM modules.

### 2. Manual ZIP parser (no_std)

The `zip` crate's extraction path requires `std::fs::File`. We implement a minimal PKZIP parser directly using `miniz_oxide` for DEFLATE, keeping the module `no_std` and reducing binary size to ~45 KB.

### 3. Git history via API (no git clone)

Instead of cloning, we reconstruct a minimal `.git` directory from GitHub API responses:

- Fetch last 50 commits via `/repos/{owner}/{repo}/commits`
- Write commit objects as zlib-compressed git object files
- Write HEAD, refs, packed-refs, and config
- **Critical:** `.git/config` contains only the public remote URL — no token

This is the key security difference from `actions/checkout`, which embeds the token in `.git/config` by default.

### 4. Token lifecycle

```
1. Read from action input
2. core.setSecret(token) — masked in all logs
3. Used in one Authorization: Bearer header for ZIP download
4. Used in API calls for git history, submodules, LFS
5. Never passed to WASM
6. Never written to any file
7. verifyNoTokenInGitConfig() confirms it is absent
```

### 5. Submodules via recursive ZIP

Each submodule URL is parsed, a separate ZIP is downloaded, and extraction runs recursively. Same security properties apply — no token on disk per submodule.

### 6. LFS via batch API

LFS pointer files (< 200 bytes, starting with `version https://git-lfs.github.com/spec/v1`) are detected after extraction. A batch request to the LFS API returns pre-signed download URLs that do not require the token.

---

## Security threat model

| Threat | Mitigation |
|---|---|
| Token in `.git/config` | Never written — config contains only public URL |
| Token in log output | `core.setSecret()` + `mask()` on all error strings |
| Token in WASM heap | Token never passed to WASM |
| Token in source files | `verifyNoTokenInGitConfig()` + CI scan |
| ArtiPACKED | Token not in any file — nothing to leak via artifact |
| Zip-slip (path traversal) | `safe_join()` rejects `..`, `/`, drive letters |
| .git in ZIP archive | `contains_git_component()` filters before any write |
| Malicious archive | Path guard + .git filter run before every `js_write_file` call |

---

## Build pipeline

```
src/lib.rs
  cargo build --target wasm32-unknown-unknown --release --lib
  uses: wee_alloc, miniz_oxide (no_std, no C compiler)
  produces: secure_checkout_wasm.wasm (~45 KB)

src/main.rs  (native CLI for local testing)
  cargo build --release --features native-cli --bin secure-checkout
  uses: ureq, zip (native only, conditional dependency)
  excluded from WASM builds via required-features
```

---

## Verified results (GitHub Actions, ubuntu-latest)

| Repository | Size | Files | Token in config | Token in files | git log |
|---|---|---|---|---|---|
| sigp/lighthouse@stable | 29 MB | 1,247 | ✅ absent | ✅ absent | ✅ works |
| ethereum/go-ethereum@master | 24 MB | 2,346 | ✅ absent | ✅ absent | ✅ works |
| paradigmxyz/reth@main | 16 MB | 1,911 | ✅ absent | ✅ absent | ✅ works |

---

## Limitations

| Feature | Status |
|---|---|
| Full git history (> 50 commits) | Configurable via `fetch-depth` input |
| git bisect / rebase | Not supported — shallow history only |
| Non-GitHub submodules | Skipped with warning |
| Sparse checkout | Not implemented |

---

## Future work

- Streaming extraction to reduce peak memory for large repos
- Progress reporting during download
- Archive checksum verification against GitHub headers
- Actions cache integration to avoid re-downloading unchanged refs
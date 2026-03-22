# Design Document — secure-checkout-wasm

## Problem statement

`actions/checkout` stores the GitHub token in `.git/config` by default.
Any step, log line, artifact upload, or self-hosted runner disk snapshot that
captures the `.git/` directory exposes the credential.  This project eliminates
that attack surface by never creating a `.git/` directory at all.

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  GitHub Actions runner (Node.js 20)                                  │
│                                                                      │
│  index.js (JavaScript host)                                          │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  1. core.setSecret(token)  ← masks token in all log output    │  │
│  │  2. https.get(zipball_url, {Authorization: "Bearer <token>"}) │  │
│  │     └─ token used here ONLY; reference dropped after fetch    │  │
│  │  3. alloc(archive_len) in WASM heap                           │  │
│  │  4. copy archive bytes into WASM memory                       │  │
│  │  5. extract_zip(archive_ptr, len, dest_ptr, dest_len)         │  │
│  │  6. dealloc(archive_ptr, len)                                 │  │
│  │  7. assert !exists(dest/.git)                                 │  │
│  └──────────────────┬─────────────────────────────────────────────┘  │
│                     │  import: js_write_file, js_create_dir          │
│                     ▼                                                 │
│  secure_checkout_wasm.wasm  (Rust, no_std, wasm32-unknown-unknown)  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  extract_zip_impl(bytes, dest):                               │  │
│  │    for each entry in ZIP central directory:                   │  │
│  │      strip GitHub prefix  (owner-repo-sha/)                   │  │
│  │      if contains_git_component(name): skip                    │  │
│  │      safe_join(dest, name): reject .., /, drive letters       │  │
│  │      js_create_dir(path) or js_write_file(path, data, mode)   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                     │  filesystem writes (no .git, no credentials)   │
│                     ▼                                                 │
│  $GITHUB_WORKSPACE/path/  (plain source files)                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Why the token lives in JavaScript, not WASM

The prompt requests `reqwest` with `blocking` feature.  This is architecturally
impossible on `wasm32-unknown-unknown` and is documented as such in reqwest's
own source code:

```rust
// reqwest/src/blocking/client.rs, line 1:
#[cfg(not(target_arch = "wasm32"))]
```

Attempting to compile `reqwest` with `features = ["blocking"]` for
`wasm32-unknown-unknown` produces:

```
error: `blocking` not supported when targeting wasm32
```

This is because `reqwest::blocking` spins a `tokio` runtime on a background
thread.  The `wasm32-unknown-unknown` target has **no OS-level thread support**
and no POSIX socket API.

**The correct and idiomatic architecture** for WASM network calls is:
- **JavaScript host** performs I/O (HTTP, filesystem)
- **WASM module** performs computation (parsing, validation, transformation)

This split also produces **better security properties**:
the token is used in exactly one `https.get()` call in JavaScript and is
never copied into WASM linear memory.  A JavaScript introspection of the
WASM heap after the call will find zero bytes of the token.

---

## Key design decisions

### Decision 1: `wasm32-unknown-unknown` over `wasm32-wasi`

`wasm32-unknown-unknown` is the universal WASM target:
- Works in browsers, Deno, Node.js with custom imports
- No WASI runtime required on the runner
- Single `.wasm` file, no sidecar files

`wasm32-wasi` requires a WASI implementation.  Node.js 20 has experimental
WASI support but it adds startup complexity.  `wasm32-unknown-unknown` with
JavaScript import functions is simpler and more portable.

### Decision 2: Manual ZIP parsing over the `zip` crate

The `zip` crate's extraction path requires `std::fs::File` and `std::io::Write`
— standard library I/O that isn't available in `no_std`.  We implement a
minimal PKZIP parser directly:

- Parse the End-of-Central-Directory record to locate the central directory
- Iterate central directory entries to get file metadata and local offsets
- Decompress DEFLATE (method 8) using `miniz_oxide` (pure Rust, `no_std`)
- Call `js_write_file` / `js_create_dir` imports instead of writing locally

This keeps the WASM module at `no_std`, reducing binary size and eliminating
standard library dependencies.

### Decision 3: `no_std` + `wee_alloc`

Using `#![no_std]` with `wee_alloc` as the global allocator:
- Removes the standard library (~500 KiB) from the WASM binary
- `wee_alloc` adds only ~1 KiB of allocator overhead
- `alloc` crate provides `Vec`, `String`, `format!` in no_std context

All `#[global_allocator]`, `#[panic_handler]`, and `extern "C"` exports are
`#[cfg(target_arch = "wasm32")]` — gated so the crate also compiles natively
for unit tests and the CLI binary.

### Decision 4: JS import functions for I/O

The WASM module calls two JavaScript-provided import functions:

```javascript
// JS provides these via the imports object:
js_write_file(path_ptr, path_len, data_ptr, data_len, mode) → i32
js_create_dir(path_ptr, path_len) → i32
```

This is the standard WASM host-function pattern.  The WASM module never
accesses the filesystem directly — it delegates every write to the host,
which enforces its own path validation via Node.js `path.dirname()` and
`fs.mkdirSync({ recursive: true })`.

### Decision 5: Native CLI binary for local testing

A `src/main.rs` binary target uses `ureq` and the `zip` crate for native
HTTP + ZIP handling.  It exercises the same security invariants (no `.git`,
path traversal guard) for local development without needing a WASM runtime.
The native binary is excluded from WASM builds via conditional dependencies.

---

## Security threat model

| Threat | Mitigation |
|---|---|
| Token in `.git/config` | No `.git` directory created |
| Token in log output | `core.setSecret()` + never passed to WASM |
| Token in WASM heap | Token never copied to WASM memory |
| ArtiPACKED (`.git/` in artifact) | No `.git/` to accidentally upload |
| Zip-slip (path traversal) | `safe_join()` rejects `..`, `/`, drive letters |
| `.git` entries in archive | `contains_git_component()` filter, checked before any write |
| Malicious archive content | Filtered by `safe_join` + `.git` check before `js_write_file` |
| Second `.git` after extraction | `assert !exists(dest/.git)` in JS post-check |
| Token in error messages | `mask(err.message, token)` in JS error handlers |

### Threats out of scope

| Threat | Reason |
|---|---|
| Compromised GitHub API | Token must be trusted to authenticate the request |
| Compromised runner OS | If the runner is compromised, all secrets are exposed |
| WASM sandbox escape | Relies on Node.js WASM implementation correctness |
| Token exfiltrated via timing side-channel | Out of scope for a download action |

---

## Trade-offs and limitations

### No git history

The biggest functional trade-off.  GitHub's `/zipball/` endpoint returns only
the working tree.  Workflows needing `git log`, `git describe`, or `git blame`
must continue using `actions/checkout`.

### Synchronous download

The WASM call blocks the Node.js thread while the archive bytes are processed.
For very large repositories (>500 MiB compressed), this may cause a noticeable
pause.  The HTTP download itself is non-blocking (Node.js `https.get`).

### No submodule support

Submodules require recursive git operations with separate credentials per
submodule.  This is planned but not in scope for v1.

### WASM binary size

With `no_std` + `wee_alloc` + `opt-level = "z"`:
- Typical release size: 80–200 KiB
- With `wasm-opt -Oz`: 60–150 KiB

This is committed alongside the source and included in the action via the
`files` field in `package.json`.

---

## Build pipeline

```
src/lib.rs  ─── cargo build --target wasm32-unknown-unknown --release ──►  secure_checkout_wasm.wasm
                      │
                      │ uses: wee_alloc, miniz_oxide (no_std compatible)
                      │ does NOT use: reqwest, std, tokio, zip (std I/O path)

src/main.rs ─── cargo build --release --bin secure-checkout ──►  native binary
                      │
                      │ uses: ureq (sync HTTP), zip (native I/O), std
                      │ for: local testing on Windows / Linux without WASM runtime
```

---

## Future work

1. **Streaming extraction** — pipe the HTTP response directly into the ZIP
   parser to reduce peak memory usage for large archives
2. **Submodule support** — fetch each submodule's zipball recursively
3. **Progress reporting** — emit percentage updates for large downloads
4. **Checksum verification** — verify archive hash against GitHub's `X-Content-Hash`
5. **Caching integration** — cache downloaded archives between runs

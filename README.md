# secure-checkout-wasm

A secure drop-in replacement for `actions/checkout` — compiled from Rust to WebAssembly (`wasm32-unknown-unknown`).

Does everything `actions/checkout` does with stronger security guarantees: token never written to disk, no ArtiPACKED risk, no credential persistence.

Verified on GitHub Actions against three production Ethereum clients: Lighthouse, Geth, and Reth.

---

## Security comparison

| | `actions/checkout` | `secure-checkout-wasm` |
|---|---|---|
| Source files extracted | ✅ | ✅ |
| Git history (`git log`, `git describe`) | ✅ | ✅ via GitHub API |
| Submodules | ✅ | ✅ recursive ZIP |
| LFS files | ✅ | ✅ batch API |
| Token written to `.git/config` | ❌ yes by default | ✅ never |
| Token on disk anywhere | ❌ possible | ✅ never |
| ArtiPACKED attack surface | ❌ exists | ✅ eliminated |
| Token verified absent from config | ❌ no check | ✅ verified on every run |

---

## How to use

```yaml
steps:
  - uses: your-org/secure-checkout-wasm@v1
    with:
      repository: sigp/lighthouse
      ref: stable
      token: ${{ secrets.GITHUB_TOKEN }}
      path: lighthouse-src
```

### Inputs

| Input | Default | Description |
|---|---|---|
| `repository` | `${{ github.repository }}` | `owner/name` format |
| `ref` | `${{ github.sha }}` | Branch, tag, or commit SHA |
| `token` | `${{ github.token }}` | GitHub API token — never written to disk |
| `path` | `.` | Destination directory |
| `fetch-depth` | `1` | Commits to fetch for git history. Set `0` to skip |
| `submodules` | `false` | Checkout submodules |
| `lfs` | `false` | Download LFS files |

### Outputs

| Output | Description |
|---|---|
| `path` | Absolute path where the repository was checked out |
| `ref` | The ref that was checked out |

### With all features

```yaml
- uses: your-org/secure-checkout-wasm@v1
  with:
    repository: ${{ github.repository }}
    ref: ${{ github.sha }}
    token: ${{ secrets.GITHUB_TOKEN }}
    submodules: true
    lfs: true
    fetch-depth: 50
```

---

## Architecture

```
GitHub API (HTTPS)
     │  Authorization: Bearer <token>   ← in HTTP header only
     ▼
index.js (Node.js 20)
  • downloads ZIP via https.get()
  • token used once, never touches disk
  • copies ZIP bytes into WASM memory
  • calls extract_zip() — WASM filters .git, blocks path traversal
  • calls buildGitDir() — writes .git without token
  • verifies token absent from .git/config
     │
     ▼
secure_checkout_wasm.wasm (Rust, no_std)
  • parses ZIP central directory
  • filters .git entries before any write
  • safe_join() blocks path traversal (../, /etc, C:/)
  • calls js_write_file / js_create_dir per file
     │
     ▼
dest/   (source files + .git history, no credentials)
```

### Why the token stays in JavaScript

`wasm32-unknown-unknown` has no OS threads and no socket API. `reqwest::blocking` is explicitly disabled for this target. HTTP is handled in Node.js — the token is used in one `https.get()` call and never enters WASM memory.

---

## Building on Windows (Git Bash) and Linux

### Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
export PATH="$HOME/.cargo/bin:$PATH"

# Add WASM target
rustup target add wasm32-unknown-unknown

# Node.js 20+ required
node --version
```

### Build

```bash
# Clone
git clone https://github.com/your-org/secure-checkout-wasm
cd secure-checkout-wasm

# Install Node deps
npm install

# Build WASM
cargo build --target wasm32-unknown-unknown --release --lib
cp target/wasm32-unknown-unknown/release/secure_checkout_wasm.wasm .

# Validate
node scripts/validate-wasm.js
```

### Using the build script

```bash
./build.sh           # release WASM
./build.sh --dev     # debug WASM (faster compile)
./build.sh --all     # WASM + native CLI
./build.sh --validate
```

---

## Running tests

```bash
# Unit tests (no token needed)
cargo test --lib

# Integration tests (requires token)
export GITHUB_TOKEN=ghp_yourtoken
node scripts/test-local.js

# Against specific repo
node scripts/test-local.js --repo sigp/lighthouse --ref stable
```

---

## Windows-specific notes

- Run all commands from Git Bash (not cmd.exe or PowerShell)
- After installing Rust: `export PATH="$HOME/.cargo/bin:$PATH"`
- Add to `~/.bashrc` to make permanent
- `cargo test --lib` requires Visual Studio Build Tools (C++ workload) or MinGW
- The WASM build (`--lib`) works without any C toolchain
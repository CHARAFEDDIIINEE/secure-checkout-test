# secure-checkout-wasm

A secure, WebAssembly-powered alternative to [`actions/checkout`](https://github.com/actions/checkout).

Built with Rust compiled to **`wasm32-unknown-unknown`** — the correct WASM target for Node.js 20, compatible with Windows (Git Bash), Linux, and macOS.

---

## Why not `actions/checkout`?

| Vulnerability | `actions/checkout` | `secure-checkout-wasm` |
|---|---|---|
| Token in `.git/config` | Written by default (`persist-credentials: true`) | No `.git` directory created |
| ArtiPACKED | `.git/` accidentally uploaded in artifacts exposes the token | Nothing to upload — no `.git/` |
| Token in logs | Possible on verbose git errors | `core.setSecret()` + never passed to WASM |
| Residual credential files | Persist on self-hosted runners | No credential files created |

---

## Architecture

```
GitHub API (HTTPS)
     │  Authorization: Bearer <token>   ← in HTTP header only, in JS
     ▼
┌─────────────────────────────────────────────────────┐
│  index.js  (Node.js 20)                             │
│  • downloads ZIP via https.get()                    │
│  • token used once, reference dropped               │
│  • copies bytes into WASM linear memory             │
│  • calls extract_zip() in WASM                      │
│  • provides js_write_file / js_create_dir imports   │
└──────────────────────────┬──────────────────────────┘
                           │  archive bytes (no token)
                           ▼
┌─────────────────────────────────────────────────────┐
│  secure_checkout_wasm.wasm  (Rust, no_std)          │
│  • parses ZIP central directory                     │
│  • filters .git entries                             │
│  • safe_join() blocks path traversal                │
│  • calls js_write_file / js_create_dir per file     │
└─────────────────────────────────────────────────────┘
     │  plain files only  (no .git, no credentials)
     ▼
  $GITHUB_WORKSPACE/path/
```

### Why the token lives in JS, not WASM

`wasm32-unknown-unknown` has no OS threads and no socket API.
`reqwest::blocking` is explicitly `#[cfg(not(target_arch = "wasm32"))]`
in reqwest's own source — it **cannot** be used on this target.

Using the Node.js `https` module for the download is both the correct architecture
and the more secure one: the token is consumed by a single `https.get()` call
and never enters WASM linear memory.

---

## Usage

```yaml
steps:
  - uses: your-org/secure-checkout-wasm@v1
    with:
      repository: ${{ github.repository }}
      ref:        ${{ github.sha }}
      token:      ${{ secrets.GITHUB_TOKEN }}
      path:       src
```

Drop-in for `actions/checkout` when you don't need git history:

```yaml
# Before
- uses: actions/checkout@v4
  with:
    persist-credentials: false

# After
- uses: your-org/secure-checkout-wasm@v1
```

### Inputs

| Input | Default | Description |
|---|---|---|
| `repository` | `${{ github.repository }}` | `owner/name` format |
| `ref` | `${{ github.sha }}` | Branch, tag, or SHA |
| `token` | `${{ github.token }}` | GitHub API token |
| `path` | `.` | Checkout destination |
| `fetch-depth` | `1` | Accepted for compatibility; always shallow |

### Outputs

| Output | Description |
|---|---|
| `path` | Absolute path of the checkout |
| `ref` | The ref that was checked out |

---

## Building

### Prerequisites

- Rust stable ≥ 1.75
- Node.js ≥ 20

### Windows (Git Bash)

```bash
# 1. Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
export PATH="$HOME/.cargo/bin:$PATH"

# 2. Add the WASM target
rustup target add wasm32-unknown-unknown

# 3. Build the WASM module
cargo build --target wasm32-unknown-unknown --release

# 4. Copy the WASM file to the project root
cp target/wasm32-unknown-unknown/release/secure_checkout_wasm.wasm .

# 5. Install Node.js dependencies
npm install

# 6. Validate
node scripts/validate-wasm.js
```

### Linux / macOS

Same commands — they work identically in bash.

### Using npm shortcuts

```bash
npm run build        # cargo build --release + cp
npm run validate     # node scripts/validate-wasm.js
npm run test:unit    # cargo test
npm run audit        # cargo audit + npm audit
```

---

## Limitations vs `actions/checkout`

| Feature | `actions/checkout` | This action |
|---|---|---|
| Git history | ✓ Full or shallow | ✗ Archive only |
| Submodules | ✓ | ✗ (planned) |
| LFS | ✓ | ✗ (planned) |
| Sparse checkout | ✓ | ✗ |
| Post-checkout git commands | ✓ | ✗ |

Use this action when your workflow only needs source files (build, lint, test, deploy).

---

## License

MIT

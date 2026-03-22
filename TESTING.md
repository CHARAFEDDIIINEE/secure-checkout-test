# Testing Manual — secure-checkout-wasm

Step-by-step instructions for Windows (Git Bash) and Linux.

---

## Prerequisites

### Rust

```bash
# Install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
export PATH="$HOME/.cargo/bin:$PATH"

# Persist on Windows Git Bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Verify
rustc --version   # 1.75.0 or later
cargo --version
```

### WASM target

```bash
rustup target add wasm32-unknown-unknown

# Verify
rustup target list --installed | grep wasm32
# wasm32-unknown-unknown
```

### Node.js 20+

```bash
node --version   # v20.x.x or later
npm  --version
```

### Visual Studio Build Tools (Windows — for cargo test only)

Required only for `cargo test --lib`. The WASM build does not need it.

Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/
Select workload: **Desktop development with C++**

---

## Setup

```bash
git clone https://github.com/your-org/secure-checkout-wasm
cd secure-checkout-wasm
npm install
```

---

## Build the WASM module

```bash
# Release build
cargo build --target wasm32-unknown-unknown --release --lib
cp target/wasm32-unknown-unknown/release/secure_checkout_wasm.wasm .

# Debug build (faster compile, larger file)
cargo build --target wasm32-unknown-unknown --lib
cp target/wasm32-unknown-unknown/debug/secure_checkout_wasm.wasm .

# Validate exports
node scripts/validate-wasm.js
```

Expected output:
```
✓ File exists: 45,509 bytes
✓ WASM magic bytes valid (\0asm)
✓ Export: alloc
✓ Export: dealloc
✓ Export: extract_zip
✓ Export: validate_path
✓ Export: last_error_ptr
✓ Export: last_error_len
✓ Export: memory
✓ All checks passed
```

---

## Unit tests

Tests run on the native target. Covers `safe_join` and `.git` filtering — the core security functions.

```bash
cargo test --lib
```

Expected output:
```
running 6 tests
test tests::git_component_detection ... ok
test tests::safe_join_absolute ... ok
test tests::safe_join_dotdot ... ok
test tests::safe_join_drive ... ok
test tests::safe_join_normal ... ok
test tests::safe_join_dot_only ... ok
test result: ok. 6 passed; 0 failed
```

If you see linker errors on Windows, install Visual Studio Build Tools (see Prerequisites).

---

## Integration tests

Downloads real repositories and verifies all security properties.

```bash
export GITHUB_TOKEN=ghp_yourtoken

# All three Ethereum clients
node scripts/test-local.js

# Single repo
node scripts/test-local.js --repo sigp/lighthouse --ref stable

# With submodules
node scripts/test-local.js --repo sigp/lighthouse --ref stable --submodules
```

Expected output:
```
WASM loaded: 45,509 bytes

────────────────────────────────────────────────────────
Testing: sigp/lighthouse@stable
  Downloaded: 28,984,489 bytes
  ✓ extract_zip (ok:1247)
  ✓ no .git from ZIP
  ✓ token not in extracted files
  ✓ git history: HEAD → 3deab9b
  ✓ no token in .git/config

════════════════════════════════════════════════════════
SUMMARY
  ✓ PASS  sigp/lighthouse@stable
  ✓ PASS  ethereum/go-ethereum@master
  ✓ PASS  paradigmxyz/reth@main

3 passed, 0 failed
```

---

## GitHub Actions test

Push to your repository and watch the **run-test.yml** workflow run.

Go to: **your repo → Actions → Test secure-checkout-wasm**

All steps should be green:
```
✓ Checkout this action code
✓ Install Node dependencies
✓ Checkout Lighthouse via secure-checkout
✓ Checkout Geth via secure-checkout
✓ Checkout Reth via secure-checkout
✓ Verify security properties
✓ Verify git history works
✓ Summary
```

Summary step output:
```
===============================
✓ All security checks passed
Lighthouse: 1247 files
Geth:       2346 files
Reth:       1911 files
===============================
```

---

## Manual security verification

### 1. No token in .git/config

```bash
export GITHUB_TOKEN=ghp_yourtoken
export DEST="$HOME/test-checkout"

node scripts/test-local.js --repo sigp/lighthouse --ref stable

cat "$DEST/.git/config"
# Should show: url = https://github.com/sigp/lighthouse.git
# Must NOT show: token or ghp_ anywhere
```

### 2. Token not in any source file

```bash
grep -rF "$GITHUB_TOKEN" "$DEST/" --exclude-dir=".git" 2>/dev/null
echo "exit: $?"   # must be 1 (not found)
```

### 3. Git log works

```bash
git -C "$DEST" log --oneline -5
git -C "$DEST" describe --tags
```

### 4. Path traversal blocked (unit test)

```bash
cargo test safe_join_dotdot -- --nocapture
# test tests::safe_join_dotdot ... ok
```

### 5. .git filter works (unit test)

```bash
cargo test git_component_detection -- --nocapture
# test tests::git_component_detection ... ok
```

---

## Troubleshooting

### `wasm32-unknown-unknown` not installed
```
error: can't find crate for `std`
```
Fix: `rustup target add wasm32-unknown-unknown`

### WASM file not found
```
WASM not found at .../secure_checkout_wasm.wasm
```
Fix:
```bash
cargo build --target wasm32-unknown-unknown --release --lib
cp target/wasm32-unknown-unknown/release/secure_checkout_wasm.wasm .
```

### Linker error on `cargo test --lib` (Windows)
```
error: linking with `link.exe` failed
```
Fix: Install Visual Studio Build Tools with "Desktop development with C++" workload.
The WASM build itself does not need this.

### HTTP 401
```
HTTP 401: Bad credentials
```
Fix: Check your `GITHUB_TOKEN` is valid and has `public_repo` read scope.

### git log fails after checkout
```
error: inflate: data stream error
```
Fix: Update `index.js` — git objects must be zlib-compressed.
The fix is `require('zlib').deflateSync(raw)` when writing commit objects.
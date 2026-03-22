# Testing Manual — secure-checkout-wasm

Step-by-step instructions for **Windows (Git Bash)** and **Linux/macOS**.  
All commands are bash-compatible and work identically in Git Bash.

---

## Prerequisites

### Rust

```bash
# Install rustup and Rust stable
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Add cargo to PATH for the current session
export PATH="$HOME/.cargo/bin:$PATH"

# Add to your shell profile so it persists (Git Bash on Windows)
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Verify
rustc --version   # rustc 1.75.0 or later
cargo --version
```

**Windows note:** `rustup-init.exe` is also available at https://rustup.rs if you prefer a GUI installer.  
After installation, Git Bash automatically picks up `~/.cargo/bin` on the next launch.

### WASM target

```bash
rustup target add wasm32-unknown-unknown

# Confirm it is installed
rustup target list --installed | grep wasm32
# Expected: wasm32-unknown-unknown
```

### Node.js 20+

```bash
# Check existing version
node --version   # should be v20.x.x or later

# Install via nvm (works in Git Bash)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
```

**Windows alternative:** Download the LTS installer from https://nodejs.org

### Optional: wasm-opt (reduces .wasm size ~30%)

```bash
# Linux / macOS (Homebrew)
brew install binaryen

# Ubuntu / Debian
sudo apt install binaryen

# Windows: download binaryen-*.zip from
# https://github.com/WebAssembly/binaryen/releases
# and add the bin/ folder to PATH

wasm-opt --version   # verify
```

---

## Setup

```bash
# Clone or extract the repository
git clone https://github.com/your-org/secure-checkout-wasm
cd secure-checkout-wasm

# Install Node.js dependencies
npm install
```

---

## Build the WASM module

### Debug build (fast, ~10 seconds)

```bash
cargo build --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/debug/secure_checkout_wasm.wasm .
```

### Release build (optimised, ~2–4 minutes)

```bash
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/secure_checkout_wasm.wasm .

# Optional: further size reduction
wasm-opt -Oz --strip-debug secure_checkout_wasm.wasm -o secure_checkout_wasm.wasm

# Check size
wc -c secure_checkout_wasm.wasm   # typical: 100–300 KiB
```

### npm shortcut

```bash
npm run build        # release build + cp
npm run build:wasm:dev   # debug build + cp
```

### Validate the build

```bash
node scripts/validate-wasm.js
```

Expected output:
```
✓ File exists: 182,432 bytes
✓ WASM magic bytes valid (\0asm)
✓ Export: alloc
✓ Export: dealloc
✓ Export: extract_zip
✓ Export: validate_path
✓ Export: last_error_ptr
✓ Export: last_error_len
✓ Export: memory
✓ Instantiation and alloc/dealloc smoke test passed

✓ All checks passed
```

---

## Unit tests (no token required)

These run on the **native** target (not WASM) for speed.  
They cover: `safe_join`, `contains_git_component`, and the ZIP parser.

```bash
cargo test -- --test-output immediate
```

Expected:
```
running 7 tests
test tests::safe_join_normal ... ok
test tests::safe_join_dotdot ... ok
test tests::safe_join_absolute ... ok
test tests::safe_join_drive ... ok
test tests::safe_join_dot_only ... ok
test tests::git_component_detection ... ok
test result: ok. 6 passed; 0 failed
```

---

## Integration tests (requires GitHub token)

```bash
# Set your token
export GITHUB_TOKEN=ghp_your_token_here

# Run against the three default Ethereum clients
node scripts/test-local.js

# Run against a single repository
node scripts/test-local.js --repo sigp/lighthouse --ref stable

# Run against custom repos
node scripts/test-local.js \
  --repo sigp/lighthouse      --ref stable \
  --repo ethereum/go-ethereum --ref master \
  --repo paradigmxyz/reth     --ref main
```

Expected output:
```
WASM loaded: 182,432 bytes

────────────────────────────────────────────────────────
Testing: sigp/lighthouse@stable
  Downloaded: 14,532,018 bytes
  ✓ extract_zip returned 0 (ok:4823)
  ✓ no .git directory
  ✓ token not found in extracted files
  ✓ 4823 files extracted

... (geth, reth) ...

════════════════════════════════════════════════════════
SUMMARY
  ✓ PASS  sigp/lighthouse@stable
  ✓ PASS  ethereum/go-ethereum@master
  ✓ PASS  paradigmxyz/reth@main

3 passed, 0 failed
```

---

## Manual security verification

### 1. Verify no `.git` directory

```bash
DEST=/tmp/sc-verify
export GITHUB_TOKEN=ghp_your_token

node scripts/test-local.js --repo sigp/lighthouse --ref stable

# Find .git in the extracted directory
find /tmp/sc-test-* -name ".git" -type d 2>/dev/null
# Expected: no output
```

### 2. Verify token not in extracted files

```bash
# grep -rF returns exit 0 (found) or 1 (not found)
grep -rF "$GITHUB_TOKEN" /tmp/sc-test-*/ 2>/dev/null
echo "grep exit: $?"   # expected: 1 (not found)
```

### 3. Verify no credential files

```bash
find /tmp/sc-test-* -name "credentials" -o \
                     -name ".netrc"      -o \
                     -name "*.token" 2>/dev/null
# Expected: no output
```

### 4. Verify path traversal is blocked (unit test)

```bash
cargo test safe_join -- --nocapture
# Expected:
#   test tests::safe_join_dotdot ... ok
#   test tests::safe_join_absolute ... ok
#   test tests::safe_join_drive ... ok
```

### 5. Verify `.git` entries are filtered (unit test)

```bash
cargo test git_component -- --nocapture
# Expected:
#   test tests::git_component_detection ... ok
```

### 6. Verify token not in WASM binary

```bash
# Search for GitHub token patterns in the compiled binary
strings secure_checkout_wasm.wasm | grep -E "ghp_|ghs_|github_pat_"
# Expected: no output
```

---

## Running CI locally with `act`

`act` runs GitHub Actions workflows in Docker containers.

```bash
# Install act
# Linux:
curl --proto '=https' --tlsv1.2 -sSf \
  https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash
# macOS:
brew install act

# List jobs
act push --list

# Run unit tests only (no token needed)
act push -j unit-tests

# Run full comparison (needs token and Docker)
act push -j test-eth-clients \
  --secret GITHUB_TOKEN="$GITHUB_TOKEN"

# Single matrix entry
act push -j test-eth-clients \
  --secret GITHUB_TOKEN="$GITHUB_TOKEN" \
  --matrix client:lighthouse
```

---

## Dependency audit

```bash
# Rust CVE scan
cargo audit

# npm CVE scan
npm audit --audit-level=high

# Generate dependency trees for manual review
cargo tree   > cargo-tree.txt
npm ls --all > npm-tree.txt
```

---

## Troubleshooting

### `wasm32-unknown-unknown` not installed

```
error[E0463]: can't find crate for `std`
  = note: the `wasm32-unknown-unknown` target may not be installed
```

**Fix:** `rustup target add wasm32-unknown-unknown`

---

### `reqwest::blocking` compile error

```
error: `blocking` not supported when targeting wasm32
```

**Explanation:** This is expected if you attempt to add `reqwest` with `features = ["blocking"]` for this target.  
This project intentionally does **not** use reqwest — the HTTP call happens in `index.js` using Node's built-in `https` module.  
See the Architecture section in README.md.

---

### WASM file not found

```
WASM module not found at .../secure_checkout_wasm.wasm
```

**Fix:**
```bash
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/secure_checkout_wasm.wasm .
```

---

### `export PATH` not persisted on Windows Git Bash

After `rustup install`, add to `~/.bashrc`:
```bash
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

### HTTP 401 Unauthorized

```
HTTP 401: Bad credentials
```

**Fix:** Check that `GITHUB_TOKEN` is valid and has `contents: read` scope.

---

### HTTP 404 Not Found

```
HTTP 404 for https://api.github.com/repos/.../zipball/...
```

**Fix:** Verify the repository name (`owner/name`) and ref are correct.  
For private repos, ensure the token has access.

---

### Large WASM binary (> 2 MiB)

```bash
wasm-opt -Oz --strip-debug secure_checkout_wasm.wasm -o secure_checkout_wasm.wasm
```

This typically reduces release builds by 30–40%.

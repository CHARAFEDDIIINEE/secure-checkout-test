#!/usr/bin/env bash
# build.sh — Build helper for Windows (Git Bash) and Linux/macOS
#
# Usage:
#   ./build.sh              # release WASM build
#   ./build.sh --dev        # debug WASM build (faster)
#   ./build.sh --native     # native CLI binary for local testing
#   ./build.sh --all        # both WASM release and native binary
#   ./build.sh --clean      # remove build artifacts
#   ./build.sh --validate   # validate an existing .wasm file
#   ./build.sh --help

set -euo pipefail

WASM_TARGET="wasm32-unknown-unknown"
WASM_OUT_RELEASE="target/${WASM_TARGET}/release/secure_checkout_wasm.wasm"
WASM_OUT_DEBUG="target/${WASM_TARGET}/debug/secure_checkout_wasm.wasm"
DEST_WASM="secure_checkout_wasm.wasm"

# ── Colours (suppressed when not a terminal) ─────────────────────────────
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; NC=''
fi

log()  { echo -e "${GREEN}[build]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()  { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

# ── Dependency checks ────────────────────────────────────────────────────
check_deps() {
  command -v cargo   >/dev/null 2>&1 || die "cargo not found. Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
  command -v rustup  >/dev/null 2>&1 || die "rustup not found"
  command -v node    >/dev/null 2>&1 || die "node not found (need Node.js 20+)"

  # Check wasm32-unknown-unknown is installed
  if ! rustup target list --installed 2>/dev/null | grep -q "$WASM_TARGET"; then
    warn "wasm32-unknown-unknown not installed. Installing now..."
    rustup target add "$WASM_TARGET" || die "Failed to add WASM target"
  fi

  local RUST_VER
  RUST_VER=$(rustc --version | grep -oE '[0-9]+\.[0-9]+' | head -1)
  local MAJOR MINOR
  MAJOR=$(echo "$RUST_VER" | cut -d. -f1)
  MINOR=$(echo "$RUST_VER" | cut -d. -f2)
  if [ "$MAJOR" -lt 1 ] || ([ "$MAJOR" -eq 1 ] && [ "$MINOR" -lt 75 ]); then
    warn "Rust < 1.75 detected ($RUST_VER). Recommend: rustup update stable"
  fi

  local NODE_VER
  NODE_VER=$(node --version | tr -d 'v' | cut -d. -f1)
  if [ "$NODE_VER" -lt 20 ]; then
    die "Node.js 20+ required (found v${NODE_VER})"
  fi
}

# ── Build functions ───────────────────────────────────────────────────────
build_wasm_release() {
  log "Building WASM (release, wasm32-unknown-unknown)..."
  cargo build --target "$WASM_TARGET" --release --lib

  log "Copying $WASM_OUT_RELEASE → $DEST_WASM"
  cp "$WASM_OUT_RELEASE" "$DEST_WASM"

  local SIZE
  SIZE=$(wc -c < "$DEST_WASM" | tr -d ' ')
  log "WASM size: ${SIZE} bytes ($(( SIZE / 1024 )) KiB)"

  # Optional: further reduce with wasm-opt
  if command -v wasm-opt >/dev/null 2>&1; then
    log "wasm-opt found — optimising further..."
    wasm-opt -Oz --strip-debug "$DEST_WASM" -o "$DEST_WASM"
    SIZE=$(wc -c < "$DEST_WASM" | tr -d ' ')
    log "WASM size after wasm-opt: ${SIZE} bytes ($(( SIZE / 1024 )) KiB)"
  else
    warn "wasm-opt not found (optional). Install binaryen for additional size reduction."
  fi
}

build_wasm_debug() {
  log "Building WASM (debug, wasm32-unknown-unknown)..."
  cargo build --target "$WASM_TARGET" --lib

  log "Copying $WASM_OUT_DEBUG → $DEST_WASM"
  cp "$WASM_OUT_DEBUG" "$DEST_WASM"

  local SIZE
  SIZE=$(wc -c < "$DEST_WASM" | tr -d ' ')
  log "WASM debug size: ${SIZE} bytes ($(( SIZE / 1024 )) KiB)"
}

build_native() {
  log "Building native CLI binary (host target)..."
  cargo build --release --bin secure-checkout

  local BIN_PATH
  BIN_PATH=$(find target -name "secure-checkout" -not -name "*.d" 2>/dev/null | head -1)
  if [ -n "$BIN_PATH" ]; then
    log "Native binary: $BIN_PATH"
  fi
}

validate_wasm() {
  if [ ! -f "$DEST_WASM" ]; then
    die "$DEST_WASM not found. Run: ./build.sh first"
  fi
  log "Validating $DEST_WASM..."
  node scripts/validate-wasm.js
}

clean_build() {
  log "Cleaning build artifacts..."
  cargo clean
  rm -f "$DEST_WASM"
  log "Clean done"
}

# ── Help ─────────────────────────────────────────────────────────────────
show_help() {
  cat << 'EOF'
build.sh — secure-checkout-wasm build helper

Usage:
  ./build.sh              Build release WASM module (default)
  ./build.sh --dev        Build debug WASM module (faster compile)
  ./build.sh --native     Build native CLI binary for local testing
  ./build.sh --all        Build release WASM + native binary
  ./build.sh --validate   Validate existing .wasm file
  ./build.sh --clean      Remove build artifacts
  ./build.sh --help       Show this help

After building, test with:
  npm install
  node scripts/validate-wasm.js
  GITHUB_TOKEN=ghp_xxx node scripts/test-local.js

Windows Git Bash notes:
  • Run from inside Git Bash (not cmd.exe or PowerShell)
  • First time: export PATH="$HOME/.cargo/bin:$PATH"
  • Or add to ~/.bashrc permanently
EOF
}

# ── Entry point ───────────────────────────────────────────────────────────
MODE="${1:---release}"

case "$MODE" in
  --help|-h)   show_help; exit 0 ;;
  --clean)     check_deps; clean_build ;;
  --validate)  check_deps; validate_wasm ;;
  --dev)       check_deps; build_wasm_debug; validate_wasm ;;
  --native)    check_deps; build_native ;;
  --all)       check_deps; build_wasm_release; build_native; validate_wasm ;;
  --release|*) check_deps; build_wasm_release; validate_wasm ;;
esac

log "Build complete ✓"

#!/usr/bin/env node
/**
 * scripts/validate-wasm.js
 *
 * Checks that secure_checkout_wasm.wasm:
 *   1. Exists and has the correct WASM magic bytes.
 *   2. Exports all required functions.
 *   3. Can be instantiated with stub imports.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const WASM = path.join(__dirname, '..', 'secure_checkout_wasm.wasm');
const REQUIRED_EXPORTS = ['alloc','dealloc','extract_zip','validate_path',
                          'last_error_ptr','last_error_len','memory'];

async function main() {
  // 1. File exists
  if (!fs.existsSync(WASM)) {
    console.error(`✗ Not found: ${WASM}`);
    console.error('  Run: cargo build --target wasm32-unknown-unknown --release');
    console.error('  Then: cp target/wasm32-unknown-unknown/release/secure_checkout_wasm.wasm .');
    process.exit(1);
  }

  const bytes = fs.readFileSync(WASM);
  console.log(`✓ File exists: ${bytes.length.toLocaleString()} bytes`);

  // 2. Magic bytes  \0asm
  if (bytes[0]!==0x00||bytes[1]!==0x61||bytes[2]!==0x73||bytes[3]!==0x6d) {
    console.error('✗ Invalid WASM magic bytes');
    process.exit(1);
  }
  console.log('✓ WASM magic bytes valid (\\0asm)');

  // 3. Compile and inspect exports
  const mod     = await WebAssembly.compile(bytes);
  const exports = WebAssembly.Module.exports(mod).map(e => e.name);
  const expSet  = new Set(exports);

  let allOk = true;
  for (const sym of REQUIRED_EXPORTS) {
    if (expSet.has(sym)) {
      console.log(`✓ Export: ${sym}`);
    } else {
      console.error(`✗ Missing export: ${sym}`);
      allOk = false;
    }
  }
  if (!allOk) process.exit(1);

  // 4. Instantiate with stub imports
  const stub = {
    env: {
      js_write_file:  () => 0,
      js_create_dir:  () => 0,
    }
  };
  try {
    const { instance } = await WebAssembly.instantiate(bytes, stub);
    const ptr = instance.exports.alloc(32);
    if (ptr === 0) throw new Error('alloc(32) returned null');
    instance.exports.dealloc(ptr, 32);
    console.log('✓ Instantiation and alloc/dealloc smoke test passed');
  } catch (err) {
    console.error(`✗ Instantiation failed: ${err.message}`);
    process.exit(1);
  }

  console.log('\n✓ All checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });

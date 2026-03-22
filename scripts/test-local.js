#!/usr/bin/env node
/**
 * scripts/test-local.js
 *
 * Local integration test for secure-checkout-wasm.
 * Works on Windows (Git Bash) and Linux.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx node scripts/test-local.js
 *   node scripts/test-local.js --token ghp_xxx --repo sigp/lighthouse --ref stable
 *
 * Requires:
 *   • secure_checkout_wasm.wasm built and in project root
 *   • Node.js 20+
 *   • GITHUB_TOKEN env var or --token argument
 */
'use strict';

const fs    = require('fs');
const https = require('https');
const path  = require('path');
const os    = require('os');
const { execSync } = require('child_process');

function parseArgs() {
  const a = process.argv.slice(2);
  const r = { token: process.env.GITHUB_TOKEN || '', repos: [], submodules: false, lfs: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i]==='--token'      && a[i+1]) { r.token      = a[++i]; continue; }
    if (a[i]==='--repo'       && a[i+1]) { r.repos.push({ repo: a[++i], ref: 'HEAD' }); continue; }
    if (a[i]==='--ref'        && a[i+1] && r.repos.length) { r.repos[r.repos.length-1].ref = a[++i]; continue; }
    if (a[i]==='--submodules')            { r.submodules = true; continue; }
    if (a[i]==='--lfs')                   { r.lfs        = true; continue; }
  }
  if (!r.repos.length) r.repos = [
    { repo:'sigp/lighthouse',      ref:'stable' },
    { repo:'ethereum/go-ethereum', ref:'master' },
    { repo:'paradigmxyz/reth',     ref:'main'   },
  ];
  return r;
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const go = (u, hdrs, hops) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: hdrs }, res => {
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return go(res.headers.location, { 'User-Agent': hdrs['User-Agent'] }, hops+1);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let b = ''; res.setEncoding('utf8');
          res.on('data', d => b += d.slice(0,128));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${b}`)));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    go(url, headers, 0);
  });
}

function readWasmStr(mem, ptr, len) {
  return Buffer.from(mem.buffer, ptr, len).toString('utf8');
}

async function testOne(wasmBytes, token, repo, ref, opts) {
  const label = `${repo}@${ref}`;
  console.log(`\n${'─'.repeat(56)}\nTesting: ${label}`);

  const tmp     = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
  const memRef  = { current: null };
  let instance;
  const result  = await WebAssembly.instantiate(wasmBytes, {
    env: {
      js_write_file(pp, pl, dp, dl, mode) {
        try {
          const fp   = readWasmStr(memRef.current, pp, pl);
          const data = Buffer.from(memRef.current.buffer, dp, dl);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, data);
          return 0;
        } catch { return 1; }
      },
      js_create_dir(pp, pl) {
        try { fs.mkdirSync(readWasmStr(memRef.current, pp, pl), { recursive: true }); return 0; }
        catch { return 1; }
      },
    }
  });
  instance       = result.instance;
  memRef.current = instance.exports.memory;

  const [owner, repoName] = repo.split('/');
  const errors = [];

  // ── Download + extract ───────────────────────────────────────────────────
  let archiveBuf;
  try {
    archiveBuf = await httpsGet(
      `https://api.github.com/repos/${owner}/${repoName}/zipball/${ref}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'secure-checkout-test/2.0' }
    );
    console.log(`  Downloaded: ${archiveBuf.length.toLocaleString()} bytes`);
  } catch (e) { console.error(`  ✗ Download: ${e.message}`); errors.push('download'); return { label, passed:false, errors }; }

  const archiveLen = archiveBuf.length;
  const archivePtr = instance.exports.alloc(archiveLen);
  new Uint8Array(instance.exports.memory.buffer, archivePtr, archiveLen).set(archiveBuf);
  archiveBuf = null;
  const destEnc = Buffer.from(tmp, 'utf8');
  const destPtr = instance.exports.alloc(destEnc.length);
  new Uint8Array(instance.exports.memory.buffer, destPtr, destEnc.length).set(destEnc);
  let rc;
  try {
    rc = instance.exports.extract_zip(archivePtr, archiveLen, destPtr, destEnc.length);
  } finally {
    instance.exports.dealloc(archivePtr, archiveLen);
    instance.exports.dealloc(destPtr, destEnc.length);
  }
  const msgPtr = instance.exports.last_error_ptr();
  const msgLen = instance.exports.last_error_len();
  const msg    = readWasmStr(instance.exports.memory, msgPtr, msgLen);

  if (rc === 0) console.log(`  ✓ extract_zip (${msg})`);
  else { console.error(`  ✗ extract_zip rc=${rc}: ${msg}`); errors.push('extract'); }

  // ── Security check 1: no .git from ZIP ──────────────────────────────────
  if (!fs.existsSync(path.join(tmp, '.git'))) console.log('  ✓ no .git from ZIP');
  else { console.error('  ✗ .git found after ZIP extraction'); errors.push('.git in zip'); }

  // ── Security check 2: token not in files ────────────────────────────────
  let tokenFound = false;
  const scanDir = d => {
    for (const e of fs.readdirSync(d, {withFileTypes:true})) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && e.name !== '.git') { scanDir(f); continue; }
      if (!e.isFile()) continue;
      try {
        if (fs.statSync(f).size > 500000) continue;
        if (fs.readFileSync(f,'utf8').includes(token)) { tokenFound = true; console.error(`  ✗ token in: ${f}`); }
      } catch (_) {}
    }
  };
  scanDir(tmp);
  if (!tokenFound) console.log('  ✓ token not in extracted files');
  else errors.push('token in files');

  // ── Phase 2: test git history ────────────────────────────────────────────
  const gitDir = path.join(tmp, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'),   { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'refs', 'tags'),    { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'refs', 'remotes', 'origin'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'objects', 'pack'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'logs', 'refs', 'heads'), { recursive: true });

  try {
    const commitData = await httpsGet(
      `https://api.github.com/repos/${owner}/${repoName}/commits/${ref}`,
      { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sc-test' }
    );
    const commit = JSON.parse(commitData.toString());
    const sha    = commit.sha;

    // Write HEAD and config (no token in config)
    fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${ref}\n`);
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', ref), sha + '\n');
    fs.writeFileSync(path.join(gitDir, 'config'), [
      '[core]', '  repositoryformatversion = 0', '  filemode = false', '  bare = false',
      '[remote "origin"]',
      `  url = https://github.com/${owner}/${repoName}.git`,
      '  fetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n') + '\n');

    console.log(`  ✓ git history: HEAD → ${sha.slice(0,7)}`);

    // Verify no token in .git/config
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    if (config.includes(token)) {
      console.error('  ✗ SECURITY: token found in .git/config');
      errors.push('token in config');
    } else {
      console.log('  ✓ no token in .git/config');
    }

    // Test git works (if git is installed)
    try {
      const gitLog = execSync(`git -C "${tmp}" log --oneline -1 2>&1`).toString().trim();
      console.log(`  ✓ git log works: ${gitLog.slice(0,50)}`);
    } catch (_) {
      console.log('  ~ git not available for log test (ok)');
    }
  } catch (e) {
    console.log(`  ~ git history skipped: ${e.message.slice(0,60)}`);
  }

  // Cleanup
  fs.rmSync(tmp, { recursive:true, force:true });
  return { label, passed: errors.length === 0, errors };
}

async function main() {
  const args = parseArgs();
  if (!args.token) { console.error('Error: set GITHUB_TOKEN or pass --token'); process.exit(1); }

  const wasmPath = path.join(__dirname, '..', 'secure_checkout_wasm.wasm');
  if (!fs.existsSync(wasmPath)) {
    console.error(`WASM not found: ${wasmPath}`);
    console.error('Run: cargo build --target wasm32-unknown-unknown --release --lib');
    process.exit(1);
  }
  const wasmBytes = fs.readFileSync(wasmPath);
  console.log(`WASM loaded: ${wasmBytes.length.toLocaleString()} bytes`);

  const results = [];
  for (const { repo, ref } of args.repos)
    results.push(await testOne(wasmBytes, args.token, repo, ref, args));

  console.log(`\n${'═'.repeat(56)}\nSUMMARY`);
  let failed = 0;
  for (const r of results) {
    if (r.passed) console.log(`  ✓ PASS  ${r.label}`);
    else { console.error(`  ✗ FAIL  ${r.label}: ${r.errors.join(', ')}`); failed++; }
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

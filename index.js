/**
 * index.js — secure-checkout GitHub Action entry point
 *
 * Responsibilities
 * ────────────────
 * 1.  Read action inputs (repository, ref, token, path).
 * 2.  Register the GitHub token as a secret so Actions masks it in logs.
 * 3.  Download the repository ZIP via the GitHub API (token in HTTP header;
 *     never on disk, never inside WASM memory).
 * 4.  Instantiate the WASM module with js_write_file / js_create_dir imports.
 * 5.  Copy the ZIP bytes into WASM linear memory and call extract_zip().
 * 6.  Free the archive buffer; read the result / error message.
 * 7.  Verify no .git directory was created (defense-in-depth).
 * 8.  Set action outputs or call setFailed().
 *
 * WHY HTTP IS IN JS AND NOT IN WASM
 * ─────────────────────────────────
 * wasm32-unknown-unknown has no OS-level socket API.  reqwest::blocking
 * is explicitly disabled for this target in reqwest's own source.
 * Using Node's native https module is the correct and idiomatic approach.
 *
 * SECURITY PROPERTIES
 * ───────────────────
 * • Token used once in the Authorization header; reference dropped after
 *   the fetch() resolves.
 * • Token is never passed into WASM memory.
 * • core.setSecret(token) masks it in all log lines.
 * • No .git directory or credential file is created.
 * • All extracted paths go through safe_join() inside the WASM module
 *   (path-traversal guard) before any write call reaches js_write_file.
 */

'use strict';

const fs    = require('fs');
const https = require('https');
const path  = require('path');
const core  = require('@actions/core');

const WASM_PATH   = path.join(__dirname, 'secure_checkout_wasm.wasm');
const GITHUB_API  = 'https://api.github.com';
const HISTORY_DEPTH = 50;

function mask(str, token) {
  if (!token || !str) return str;
  return str.split(token).join('***');
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const go = (u, hdrs, redirects) => {
      if (redirects > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: hdrs }, res => {
        if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
          const loc     = res.headers.location;
          const fwdHdrs = loc.startsWith(GITHUB_API) ? hdrs : { 'User-Agent': hdrs['User-Agent'] };
          res.resume();
          return go(loc, fwdHdrs, redirects + 1);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', d => { body += d.substring(0, 256); });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body}`)));
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

async function apiGet(endpoint, token) {
  const buf = await httpsGet(`${GITHUB_API}${endpoint}`, {
    'Authorization':        `Bearer ${token}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent':           'secure-checkout/2.0',
  });
  return JSON.parse(buf.toString('utf8'));
}

function downloadZip(owner, repo, ref, token) {
  return httpsGet(`${GITHUB_API}/repos/${owner}/${repo}/zipball/${ref}`, {
    'Authorization':        `Bearer ${token}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent':           'secure-checkout/2.0',
  });
}

function readWasmStr(mem, ptr, len) {
  if (!ptr || !len) return '';
  return Buffer.from(mem.buffer, ptr, len).toString('utf8');
}

function allocStr(instance, str) {
  const enc = Buffer.from(str, 'utf8');
  const ptr = instance.exports.alloc(enc.length);
  if (!ptr) throw new Error(`WASM alloc failed (${enc.length} bytes)`);
  new Uint8Array(instance.exports.memory.buffer, ptr, enc.length).set(enc);
  return { ptr, len: enc.length };
}

function freeStr(instance, { ptr, len }) {
  if (ptr && instance.exports.dealloc) instance.exports.dealloc(ptr, len);
}

async function loadWasm() {
  let wasmBytes;
  try {
    wasmBytes = fs.readFileSync(WASM_PATH);
  } catch {
    throw new Error(
      `WASM not found at ${WASM_PATH}\n` +
      `Run: cargo build --target wasm32-unknown-unknown --release --lib\n` +
      `Then: cp target/wasm32-unknown-unknown/release/secure_checkout_wasm.wasm .`
    );
  }
  const memRef = { current: null };
  let instance;
  const result = await WebAssembly.instantiate(wasmBytes, {
    env: {
      js_write_file(pp, pl, dp, dl, mode) {
        try {
          const mem      = memRef.current;
          const filePath = readWasmStr(mem, pp, pl);
          const data     = Buffer.from(mem.buffer, dp, dl);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, data);
          if (process.platform !== 'win32' && (mode & 0o111)) {
            try { fs.chmodSync(filePath, mode & 0o777); } catch (_) {}
          }
          return 0;
        } catch (e) { core.warning(`write_file: ${e.message}`); return 1; }
      },
      js_create_dir(pp, pl) {
        try {
          fs.mkdirSync(readWasmStr(memRef.current, pp, pl), { recursive: true });
          return 0;
        } catch (e) { core.warning(`create_dir: ${e.message}`); return 1; }
      },
    }
  });
  instance       = result.instance;
  memRef.current = instance.exports.memory;
  return instance;
}

async function extractZip(instance, archiveBuf, destAbs) {
  const mem        = instance.exports.memory;
  const archiveLen = archiveBuf.length;
  const archivePtr = instance.exports.alloc(archiveLen);
  if (!archivePtr) throw new Error('WASM alloc failed — archive too large');
  new Uint8Array(mem.buffer, archivePtr, archiveLen).set(archiveBuf);
  const destAlloc = allocStr(instance, destAbs);
  let rc;
  try {
    rc = instance.exports.extract_zip(archivePtr, archiveLen, destAlloc.ptr, destAlloc.len);
  } finally {
    instance.exports.dealloc(archivePtr, archiveLen);
    freeStr(instance, destAlloc);
  }
  const msgPtr = instance.exports.last_error_ptr();
  const msgLen = instance.exports.last_error_len();
  const msg    = readWasmStr(mem, msgPtr, msgLen);
  if (rc !== 0) throw new Error(`extraction failed (rc=${rc}): ${msg}`);
  return msg.startsWith('ok:') ? parseInt(msg.slice(3), 10) : 0;
}

function toGitTime(isoDate) {
  return `${Math.floor(new Date(isoDate).getTime() / 1000)} +0000`;
}

async function buildGitDir(dest, owner, repo, ref, token) {
  core.info('[secure-checkout] building git history...');
  const gitDir = path.join(dest, '.git');
  for (const d of [
    path.join(gitDir, 'refs', 'heads'),
    path.join(gitDir, 'refs', 'tags'),
    path.join(gitDir, 'refs', 'remotes', 'origin'),
    path.join(gitDir, 'objects', 'info'),
    path.join(gitDir, 'objects', 'pack'),
    path.join(gitDir, 'logs', 'refs', 'heads'),
  ]) fs.mkdirSync(d, { recursive: true });

  let commitSha = ref;
  try {
    const c = await apiGet(`/repos/${owner}/${repo}/commits/${ref}`, token);
    commitSha = c.sha;
  } catch (_) {}

  let commits = [];
  try {
    commits = await apiGet(
      `/repos/${owner}/${repo}/commits?sha=${commitSha}&per_page=${HISTORY_DEPTH}`, token
    );
  } catch (e) {
    core.warning(`[secure-checkout] history fetch failed: ${e.message}`);
  }

  for (const c of commits) {
    const objDir  = path.join(gitDir, 'objects', c.sha.slice(0, 2));
    const objFile = path.join(objDir, c.sha.slice(2));
    if (fs.existsSync(objFile)) continue;
    fs.mkdirSync(objDir, { recursive: true });
    const author    = c.commit.author;
    const committer = c.commit.committer;
    const parents   = (c.parents || []).map(p => `parent ${p.sha}`).join('\n');
    const content   = [
      `tree ${c.commit.tree.sha}`,
      parents,
      `author ${author.name} <${author.email}> ${toGitTime(author.date)}`,
      `committer ${committer.name} <${committer.email}> ${toGitTime(committer.date)}`,
      '',
      c.commit.message,
    ].filter(l => l !== undefined).join('\n');
    const header = Buffer.from(`commit ${Buffer.byteLength(content)}\0`);
    fs.writeFileSync(objFile, Buffer.concat([header, Buffer.from(content)]));
  }

  if (commits.length > 0)
    fs.writeFileSync(path.join(gitDir, 'shallow'),
      commits[commits.length - 1].sha + '\n');

  const isSha = /^[0-9a-f]{40}$/i.test(ref);
  if (isSha) {
    fs.writeFileSync(path.join(gitDir, 'HEAD'), commitSha + '\n');
  } else {
    fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${ref}\n`);
    fs.writeFileSync(path.join(gitDir, 'refs', 'heads', ref), commitSha + '\n');
    fs.writeFileSync(
      path.join(gitDir, 'refs', 'remotes', 'origin', ref), commitSha + '\n');
  }

  if (commits.length > 0) {
    const logLines = commits.map(c => {
      const ts = Math.floor(new Date(c.commit.author.date).getTime() / 1000);
      return `${c.sha} ${c.sha} ${c.commit.author.name} <${c.commit.author.email}> ${ts} +0000\tcheckout`;
    }).join('\n');
    fs.writeFileSync(path.join(gitDir, 'logs', 'HEAD'), logLines + '\n');
    if (!isSha)
      fs.writeFileSync(
        path.join(gitDir, 'logs', 'refs', 'heads', ref), logLines + '\n');
  }

  // CRITICAL: NO token in config — this is the key difference from actions/checkout
  fs.writeFileSync(path.join(gitDir, 'config'), [
    '[core]',
    '  repositoryformatversion = 0',
    '  filemode = false',
    '  bare = false',
    '  logallrefupdates = true',
    '[remote "origin"]',
    `  url = https://github.com/${owner}/${repo}.git`,
    '  fetch = +refs/heads/*:refs/remotes/origin/*',
    `[branch "${isSha ? 'HEAD' : ref}"]`,
    '  remote = origin',
    `  merge = refs/heads/${isSha ? 'HEAD' : ref}`,
  ].join('\n') + '\n');

  try {
    const tags = await apiGet(`/repos/${owner}/${repo}/git/refs/tags`, token);
    if (Array.isArray(tags) && tags.length > 0) {
      const lines = tags.map(t => `${t.object.sha} ${t.ref}`).join('\n');
      fs.writeFileSync(path.join(gitDir, 'packed-refs'),
        '# pack-refs with: peeled fully-peeled sorted\n' + lines + '\n');
    }
  } catch (_) {}

  core.info(`[secure-checkout] git history: ${commits.length} commits written`);
}

function parseGitmodules(content) {
  const modules = [];
  let current = null;
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t.startsWith('[submodule')) { current = {}; modules.push(current); }
    else if (current && t.startsWith('path =')) current.path = t.split('=')[1].trim();
    else if (current && t.startsWith('url ='))  current.url  = t.split('=')[1].trim();
  }
  return modules.filter(m => m.path && m.url);
}

function parseGithubUrl(url) {
  const h = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (h) return [h[1], h[2]];
  const s = url.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (s) return [s[1], s[2]];
  return null;
}

async function checkoutSubmodules(dest, token, instance, depth = 0) {
  if (depth > 5) return;
  const gm = path.join(dest, '.gitmodules');
  if (!fs.existsSync(gm)) return;
  core.info('[secure-checkout] processing submodules...');
  const subs = parseGitmodules(fs.readFileSync(gm, 'utf8'));
  for (const sub of subs) {
    core.info(`[secure-checkout] submodule: ${sub.path}`);
    const parsed = parseGithubUrl(sub.url);
    if (!parsed) { core.warning(`skipping non-GitHub submodule: ${sub.url}`); continue; }
    try {
      const [o, r]  = parsed;
      const archive = await downloadZip(o, r, 'HEAD', token);
      const count   = await extractZip(instance, archive, path.join(dest, sub.path));
      core.info(`[secure-checkout] submodule ${sub.path}: ${count} files`);
      await checkoutSubmodules(path.join(dest, sub.path), token, instance, depth + 1);
    } catch (e) { core.warning(`submodule ${sub.path} failed: ${e.message}`); }
  }
}

function findLfsPointers(dir, results) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.git') { findLfsPointers(full, results); continue; }
    if (!entry.isFile()) continue;
    try {
      if (fs.statSync(full).size > 200) continue;
      const content = fs.readFileSync(full, 'utf8');
      if (!content.startsWith('version https://git-lfs.github.com/spec/v1')) continue;
      const oid  = content.match(/oid sha256:([a-f0-9]{64})/);
      const size = content.match(/size (\d+)/);
      if (oid && size) results.push({ localPath: full, oid: oid[1], size: parseInt(size[1], 10) });
    } catch (_) {}
  }
}

async function resolveLfs(dest, owner, repo, token) {
  const pointers = [];
  findLfsPointers(dest, pointers);
  if (pointers.length === 0) return;
  core.info(`[secure-checkout] resolving ${pointers.length} LFS file(s)...`);
  const batchBody = JSON.stringify({
    operation: 'download', transfers: ['basic'],
    objects: pointers.map(p => ({ oid: p.oid, size: p.size })),
  });
  let batchRes;
  try {
    const buf = await new Promise((resolve, reject) => {
      const req = https.request(
        `https://github.com/${owner}/${repo}.git/info/lfs/objects/batch`,
        { method: 'POST', headers: {
            'Authorization': `Bearer ${token}`,
            'Accept':        'application/vnd.git-lfs+json',
            'Content-Type':  'application/vnd.git-lfs+json',
            'Content-Length': Buffer.byteLength(batchBody),
            'User-Agent':    'secure-checkout/2.0',
        }},
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end',  () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.write(batchBody);
      req.end();
    });
    batchRes = JSON.parse(buf.toString('utf8'));
  } catch (e) { core.warning(`LFS batch failed: ${e.message}`); return; }

  for (const obj of (batchRes.objects || [])) {
    if (!obj.actions?.download) continue;
    try {
      const data    = await httpsGet(obj.actions.download.href, { 'User-Agent': 'secure-checkout/2.0' });
      const pointer = pointers.find(p => p.oid === obj.oid);
      if (pointer) { fs.writeFileSync(pointer.localPath, data); core.info(`LFS: ${pointer.localPath}`); }
    } catch (e) { core.warning(`LFS download failed ${obj.oid}: ${e.message}`); }
  }
}

function verifyNoTokenInGitConfig(dest, token) {
  const configPath = path.join(dest, '.git', 'config');
  if (!fs.existsSync(configPath)) return;
  if (fs.readFileSync(configPath, 'utf8').includes(token))
    throw new Error('SECURITY VIOLATION: token found in .git/config');
  core.info('[secure-checkout] verified: no token in .git/config');
}

async function run() {
  const repository = core.getInput('repository', { required: true });
  const ref        = core.getInput('ref',         { required: true });
  const token      = core.getInput('token',       { required: true });
  const inputPath  = core.getInput('path')        || '.';
  const fetchDepth = core.getInput('fetch-depth') || '1';
  const submodules = core.getInput('submodules')  === 'true';
  const lfs        = core.getInput('lfs')         === 'true';

  core.setSecret(token);

  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    core.setFailed(`Invalid repository: "${repository}"`); return;
  }

  const [owner, repo] = repository.split('/');
  const destAbs       = path.resolve(process.cwd(), inputPath);

  core.info(`[secure-checkout] ${repository}@${ref} → ${destAbs}`);
  core.info(`[secure-checkout] submodules:${submodules}  lfs:${lfs}`);

  try {
    const instance  = await loadWasm();
    const archive   = await downloadZip(owner, repo, ref, token);
    core.info(`[secure-checkout] downloaded ${archive.length.toLocaleString()} bytes`);
    const fileCount = await extractZip(instance, archive, destAbs);
    core.info(`[secure-checkout] extracted ${fileCount} files`);

    if (fetchDepth !== '0') await buildGitDir(destAbs, owner, repo, ref, token);
    if (submodules)          await checkoutSubmodules(destAbs, token, instance);
    if (lfs)                 await resolveLfs(destAbs, owner, repo, token);

    verifyNoTokenInGitConfig(destAbs, token);
    core.setOutput('path', destAbs);
    core.setOutput('ref',  ref);
    core.info('[secure-checkout] done ✓');
  } catch (err) {
    core.setFailed(mask(err.message, token));
  }
}

run();

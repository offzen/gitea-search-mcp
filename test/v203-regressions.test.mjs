#!/usr/bin/env node
/**
 * v2.0.3 regression tests (independent audit F3–F15). Index/filter behaviour (F1, F2, F5) lives in
 * test/indexer-resilience.test.py.
 *
 * All tests share one mirror fixture because lib/server.mjs resolves its runtime config once per process.
 * The resource guards are shrunk through env vars set BEFORE the server module is imported.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = process.platform !== 'win32';
const PY = process.platform === 'win32' ? 'python' : 'python3';
const GTS = path.join(ROOT, 'bin', 'gts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-v203-'));
const home = path.join(dir, 'home');
const mirror = path.join(dir, 'mirror');
fs.mkdirSync(home, { recursive: true });

function git(args, cwd) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
}

// ── fixture: own/app (main + maintenance branch), own/aaa-empty (no commits) ──────────────
const work = path.join(dir, 'work');
git(['init', '-q', '-b', 'main', work]);
fs.writeFileSync(path.join(work, 'a.txt'), 'line1\nline2\nline3\n');
fs.writeFileSync(path.join(work, 'big.txt'), 'x'.repeat(10000) + '\n');
fs.writeFileSync(path.join(work, 'empty.txt'), '');
fs.writeFileSync(path.join(work, 'README.md'), '# App\nV203DocSentinel reverse proxy\n');
git(['add', '-A'], work);
git(['commit', '-q', '-m', 'fix(auth): handle token [WIP'], work);
git(['checkout', '-q', '-b', 'maintenance'], work);
fs.writeFileSync(path.join(work, 'm.txt'), 'V203MaintOnlySentinel\n');
git(['add', '-A'], work);
git(['commit', '-q', '-m', 'maint'], work);
git(['checkout', '-q', 'main'], work);
fs.mkdirSync(path.join(mirror, 'own'), { recursive: true });
git(['clone', '-q', '--bare', work, path.join(mirror, 'own', 'app.git')]);
git(['init', '-q', '--bare', '-b', 'main', path.join(mirror, 'own', 'aaa-empty.git')]);

const cleanEnv = { ...process.env, HOME: home, USERPROFILE: home };
for (const k of Object.keys(cleanEnv)) if (/^(GITEA_|GITQ_|GTS_)/.test(k)) delete cleanEnv[k];

// Process-wide env for the in-process server tests (read once, on first tool call).
Object.assign(process.env, {
  HOME: home, USERPROFILE: home,
  GITEA_MIRROR_ROOT: mirror, GITEA_OWNERS: 'own',
  GITEA_MAX_BLOB_BYTES: '5000',            // F3: tiny blob limit instead of a 600 MB fixture
  GITEA_MAX_CHILD_OUTPUT_BYTES: '100000',  // F3: tiny child-output cap
  GITEA_MAX_CONCURRENCY: '2',              // F10
});
for (const k of ['GITEA_SEARCH_CLI', 'GTS_BIN', 'GITQ_BIN']) delete process.env[k];
const server = await import(pathToFileURL(path.join(ROOT, 'lib', 'server.mjs')).href);

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function gts(args, extraEnv = {}) {
  return spawnSync(PY, [GTS, '--mirror-root', mirror, '--owners', 'own', ...args], {
    encoding: 'utf8', env: { ...cleanEnv, GITEA_ALLOW_NO_JIEBA: '1', ...extraEnv }, timeout: 30000,   // hermetic: runners without jieba must not fail CLI-level tests
  });
}

function fakeGts(name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return file;
}

function withGtsBin(bin, fn) {
  process.env.GTS_BIN = bin;
  return Promise.resolve(fn()).finally(() => { delete process.env.GTS_BIN; });
}

// ── F1 (CLI level): an empty mirror no longer aborts `gts --reindex` ──────────────────────
test('F1 gts --reindex succeeds with an empty repo in the mirror and indexes the others', () => {
  const r = gts(['--reindex']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const d = gts(['-D', '--json', '--', 'V203DocSentinel']);
  assert.equal(d.status, 0, d.stderr);
  assert.equal(JSON.parse(d.stdout).results[0].repo, 'own/app');
});

// ── F1 (sync level): an empty *remote* repository must not fail the whole sync round ─────
test('F1 sync.sh treats an empty remote repo as success and picks it up after its first commit', { skip: !POSIX }, () => {
  const remotes = path.join(dir, 'remotes');
  const root = path.join(dir, 'empty-sync-root');
  fs.mkdirSync(path.join(remotes, 'own'), { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main', path.join(remotes, 'own', 'empty.git')]);
  const env = {
    ...cleanEnv, GITEA_MIRROR_ROOT: root, GITEA_OWNERS: 'own', GITQ_REMOTE: 'fakehost',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: 'fakehost:',
  };
  const syncSh = path.join(ROOT, 'scripts', 'sync.sh');
  const first = spawnSync('bash', [syncSh, '-r', 'empty'], { encoding: 'utf8', env, timeout: 60000 });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /ok\s+clone empty/);
  const seed = path.join(dir, 'seed-empty');
  git(['init', '-q', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), '# first\nV203FirstCommitSentinel\n');
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'first'], seed);
  git(['push', '-q', path.join(remotes, 'own', 'empty.git'), 'HEAD:main'], seed);
  const second = spawnSync('bash', [syncSh, '-r', 'empty'], { encoding: 'utf8', env, timeout: 60000 });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const found = spawnSync(PY, [GTS, '-D', '--json', '--', 'V203FirstCommitSentinel'], { encoding: 'utf8', env, timeout: 30000 });
  assert.equal(JSON.parse(found.stdout).total, 1, found.stdout + found.stderr);
});

// ── F4: literal message queries are not compiled as regexes ───────────────────────────────
test('F4 message mode treats `fix(auth` as a literal; invalid regex is rejected up front', () => {
  const lit = gts(['--json', '-m', '--', 'fix(auth']);
  assert.equal(lit.status, 0, lit.stderr);
  assert.equal(JSON.parse(lit.stdout).total, 1);
  const bad = gts(['--json', '-m', '-E', '--', 'fix(auth']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /正则不合法/);
  const badPath = gts(['--json', '-p', '-E', '--', '[']);
  assert.equal(badPath.status, 2);
});

// ── F6: exact branch matching ─────────────────────────────────────────────────────────────
test('F6 branch filter is exact; globs opt into prefix matching', () => {
  const total = (b) => {
    const r = gts(['--json', '-b', b, '--', 'V203MaintOnlySentinel']);
    return JSON.parse(r.stdout).total ?? 0;
  };
  assert.equal(total('main'), 0, '`main` must not also search `maintenance`');
  assert.equal(total('maintenance'), 1);
  assert.equal(total('maint*'), 1);
  assert.equal(total('HEAD'), 0);
});

// ── F13: capped totals are flagged ────────────────────────────────────────────────────────
test('F13 gts JSON exposes `capped` (false for a small result)', () => {
  const r = gts(['--json', '--', 'line1']);
  assert.equal(JSON.parse(r.stdout).capped, false);
});

// ── F3 / F9 / F14: read_file ──────────────────────────────────────────────────────────────
test('F3 read_file refuses blobs above GITEA_MAX_BLOB_BYTES and the process survives', async () => {
  const r = await server.readFile({ repo: 'own/app', path: 'big.txt' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^FILE_TOO_LARGE:/);
  const ok = await server.readFile({ repo: 'own/app', path: 'a.txt' });
  assert.equal(ok.isError, undefined);
});

test('F9 read_file rejects option-like or malformed refs without spawning git show', async () => {
  for (const ref of ['--output=/tmp/x', '-p', 'a:b', 'a b', 'x\ny']) {
    const r = await server.readFile({ repo: 'own/app', path: 'a.txt', ref });
    assert.equal(r.isError, true, ref);
    assert.match(r.text, /^INVALID_REF:/, ref);
  }
  const good = await server.readFile({ repo: 'own/app', path: 'a.txt', ref: 'maintenance' });
  assert.match(good.text, /line1/);
});

test('F14 read_file counts lines without the trailing-newline phantom and explains out-of-range offsets', async () => {
  const lim = await server.readFile({ repo: 'own/app', path: 'a.txt', limit: 2 });
  assert.match(lim.text, /共 3 行/);
  assert.match(lim.text, /offset=2/);
  const full = await server.readFile({ repo: 'own/app', path: 'a.txt', limit: 0 });
  assert.doesNotMatch(full.text, /已显示/);
  const past = await server.readFile({ repo: 'own/app', path: 'a.txt', offset: 100 });
  assert.match(past.text, /超出文件末尾/);
  assert.match(past.text, /共 3 行/);
  const empty = await server.readFile({ repo: 'own/app', path: 'empty.txt' });
  assert.match(empty.text, /空文件/);
});

// ── F3 (output cap) / F10 (cancellation, process groups, concurrency) ─────────────────────
test('F3 child output above the cap is cut off with OUTPUT_TOO_LARGE instead of crashing', { skip: !POSIX }, async () => {
  const bin = fakeGts('fake-flood', 'head -c 400000 /dev/zero | tr "\\0" "a"');
  const r = await withGtsBin(bin, () => server.searchCode({ query: 'x' }));
  assert.equal(r.isError, true);
  assert.match(r.text, /^OUTPUT_TOO_LARGE:/);
});

test('F10 aborting a request kills the whole child process group', { skip: !POSIX }, async () => {
  const pidFile = path.join(dir, 'grandchild.pid');
  const bin = fakeGts('fake-hang', `sleep 60 &\necho $! > "${pidFile}"\nwait`);
  const ac = new AbortController();
  const pending = withGtsBin(bin, () => server.searchCode({ query: 'x' }, { signal: ac.signal }));
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(pidFile), 'fake gts should have started its grandchild');
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
  ac.abort();
  const r = await pending;
  assert.equal(r.isError, true);
  assert.match(r.text, /^CANCELLED:/);
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    try { process.kill(grandchild, 0); await new Promise((res) => setTimeout(res, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the grandchild `sleep` must not outlive the aborted request');
});

test('F10 (Windows) aborting a request kills the whole process tree, not just the .cmd shell', { skip: POSIX }, async () => {
  const pidFile = path.join(dir, 'win-grandchild.pid');
  const sleeper = path.join(dir, 'win-sleeper.cjs');
  fs.writeFileSync(sleeper, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);\n`);
  const bin = path.join(dir, 'fake-hang.cmd');
  fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${sleeper}"\r\n`);
  const ac = new AbortController();
  const pending = withGtsBin(bin, () => server.searchCode({ query: 'x' }, { signal: ac.signal }));
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(pidFile), 'fake gts.cmd should have started its grandchild');
  await new Promise((r) => setTimeout(r, 200));
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
  ac.abort();
  const r = await pending;
  assert.equal(r.isError, true);
  assert.match(r.text, /^CANCELLED:/);
  let alive = true;
  for (let i = 0; i < 60 && alive; i += 1) {
    try { process.kill(grandchild, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; }
  }
  if (alive) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* ignore */ } }
  assert.equal(alive, false, 'the grandchild node process must not outlive the aborted request');
});

test('F10 concurrent tool calls are bounded by GITEA_MAX_CONCURRENCY', { skip: !POSIX }, async () => {
  const log = path.join(dir, 'conc.log');
  const bin = fakeGts('fake-conc', `echo S >> "${log}"\nsleep 0.4\necho E >> "${log}"\necho '{"results":[],"total":0,"repos_hit":0,"repos_scanned":0}'`);
  await withGtsBin(bin, () => Promise.all(Array.from({ length: 5 }, () => server.searchCode({ query: 'x' }))));
  let running = 0;
  let max = 0;
  for (const ch of fs.readFileSync(log, 'utf8').trim().split('\n')) {
    running += ch === 'S' ? 1 : -1;
    max = Math.max(max, running);
  }
  assert.ok(max <= 2, `observed ${max} concurrent children`);
  assert.ok(max >= 2, 'the limiter should still allow parallelism up to the limit');
});

test('F10 a request aborted while queued never starts a child', { skip: !POSIX }, async () => {
  const marker = path.join(dir, 'queued.marker');
  const slow = fakeGts('fake-slow', 'sleep 0.6\necho \'{"results":[],"total":0,"repos_hit":0,"repos_scanned":0}\'');
  const probe = fakeGts('fake-probe', `echo started >> "${marker}"\necho '{"results":[],"total":0,"repos_hit":0,"repos_scanned":0}'`);
  process.env.GTS_BIN = slow;
  const busy = [server.searchCode({ query: 'x' }), server.searchCode({ query: 'x' })];
  process.env.GTS_BIN = probe;
  const ac = new AbortController();
  const queued = server.searchCode({ query: 'x' }, { signal: ac.signal });
  ac.abort();
  const r = await queued;
  await Promise.all(busy);
  delete process.env.GTS_BIN;
  assert.match(r.text, /^CANCELLED:/);
  assert.equal(fs.existsSync(marker), false);
});

// ── F13: partial results ──────────────────────────────────────────────────────────────────
test('F13 partial failures keep the hits and flag PARTIAL_RESULT; zero hits + errors still fail closed', { skip: !POSIX }, async () => {
  const commit = git(['rev-parse', 'HEAD'], work).trim();
  const withHits = JSON.stringify({
    total: 1, repos_hit: 1, repos_failed: 1, repos_scanned: 1, complete: false, capped: true,
    errors: [{ repo: 'own/broken', stage: 'refs', rc: 128, message: 'boom' }],
    results: [{ repo: 'own/app', ref: 'main', path: 'a.txt', line: 1, text: 'line1', commit }],
  });
  const bin = fakeGts('fake-partial', `cat <<'JSON'\n${withHits}\nJSON\nexit 2`);
  const r = await withGtsBin(bin, () => server.searchCode({ query: 'line1' }));
  assert.equal(r.isError, undefined);
  assert.match(r.text, /PARTIAL_RESULT/);
  assert.match(r.text, /own\/app@main:a\.txt:1:line1/);
  assert.match(r.text, /全库命中 ≥ 1 条/);

  const noHits = JSON.stringify({ total: 0, repos_hit: 0, repos_failed: 1, complete: false,
    errors: [{ repo: 'own/broken', stage: 'refs', rc: 128, message: 'boom' }], results: [] });
  const bin2 = fakeGts('fake-failed', `cat <<'JSON'\n${noHits}\nJSON\nexit 2`);
  const r2 = await withGtsBin(bin2, () => server.searchCode({ query: 'line1' }));
  assert.equal(r2.isError, true);
});

test('F11 sync_mirror surfaces SYNC_BUSY so the caller knows the mirror may be stale', { skip: !POSIX }, async () => {
  const bin = fakeGts('fake-busy', `echo "SYNC_BUSY: 另一轮同步正在进行" >&2\necho '{"status":"busy","owners":["own"]}'`);
  const r = await withGtsBin(bin, () => server.syncMirror({}));
  assert.equal(r.isError, undefined);
  assert.match(r.text, /SYNC_BUSY/);
});

test('N3 search_code{sync:true} is read-only: no --sync argv, explicit SYNC_MOVED notice', { skip: !POSIX }, async () => {
  const argvLog = path.join(dir, 'n3-argv.log');
  const bin = fakeGts('fake-n3', `printf '%s\\n' "$*" > ${JSON.stringify(argvLog)}\necho '{"results":[],"total":0,"repos_hit":0,"repos_scanned":1}'`);
  const r = await withGtsBin(bin, () => server.searchCode({ query: 'x', sync: true }));
  assert.equal(r.isError, undefined);
  assert.doesNotMatch(fs.readFileSync(argvLog, 'utf8'), /--sync/);
  assert.match(r.text, /SYNC_MOVED/);
  assert.match(r.text, /sync_mirror/);
});

// ── F7 / F8: session export ───────────────────────────────────────────────────────────────
const hasZstd = spawnSync('zstd', ['--version']).status === 0;
const EXPORT = path.join(ROOT, 'scripts', 'session-export-incremental.py');

test('F7 a failed decompression is not stamped as exported and is retried', { skip: !POSIX || !hasZstd }, () => {
  const src = path.join(dir, 'sessions');
  const out = path.join(dir, 'export-out');
  const sdir = path.join(src, 'proj--', 'session-aaaaaaaa-bbbb-cccc-dddd');
  fs.mkdirSync(sdir, { recursive: true });
  const jsonl = '{"id":"aaaaaaaa-bbbb-cccc-dddd","createdAt":"2026-01-01T00:00:00","cwd":"/x"}\n'
    + '{"type":"user/message","data":{"source":{"kind":"user"},"text":"hello world"}}\n';
  const z = spawnSync('zstd', ['-q', '-c'], { input: jsonl });
  fs.writeFileSync(path.join(sdir, 'session.v4.jsonl.zstd'), z.stdout);
  const pyAbs = spawnSync('bash', ['-c', `command -v ${PY}`], { encoding: 'utf8' }).stdout.trim();

  const first = spawnSync(pyAbs, [EXPORT, '--src', src, '--out', out], { encoding: 'utf8', env: { ...cleanEnv, PATH: '/nonexistent' } });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.match(first.stderr, /EXPORT_FAILED/);
  const state = JSON.parse(fs.readFileSync(path.join(out, '.export-state-per-session.json'), 'utf8'));
  assert.deepEqual(state, {}, 'a failed session must not be stamped');

  const second = spawnSync(PY, [EXPORT, '--src', src, '--out', out], { encoding: 'utf8', env: cleanEnv });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const md = fs.readFileSync(path.join(out, 'proj', 'session-aaaaaaaa-bbbb.md'), 'utf8');
  assert.match(md, /hello world/);
});

test('F8 export redaction covers JSON, bare vendor keys, URL credentials and multi-key blocks', () => {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('sei', ${JSON.stringify(EXPORT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
fake = {
  'json_pw': '{"password": "fakepass 123"}',
  'single_quoted': "{'api_key': 'sk-FAKEFAKEFAKEFAKEFAKEFAKE1234'}",
  'bare_sk': 'key sk-FAKEFAKEFAKEFAKEFAKEFAKE1234 end',
  'aws': 'AK' + 'IAFAKEFAKEFAKEFAKE',
  'slack': 'xoxb-123456789012-FAKEFAKEFAKE',
  'url': 'https://user:fakepw123@host/r.git',
  'jwt': 'eyJFAKEFAKEFAKE.eyJFAKEFAKEFAKE.FAKEFAKEFAKESIG',
}
print(json.dumps({k: m.redact(v) for k, v in fake.items()}))
b, e = '-----BEGIN ' + 'RSA PRIVATE KEY-----', '-----END ' + 'RSA PRIVATE KEY-----'
two = b + '\\nAAA\\n' + e + '\\nKEEP ME\\n' + b + '\\nBBB\\n' + e
print(json.dumps(m.redact(two)))
print(json.dumps(m.redact('we discuss the token bucket algorithm')))
`;
  const r = spawnSync(PY, ['-c', code], { encoding: 'utf8', env: cleanEnv });
  assert.equal(r.status, 0, r.stderr);
  const [redacted, two, plain] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  for (const [k, v] of Object.entries(redacted)) {
    assert.doesNotMatch(v, /FAKE|fakepass|fakepw/, `${k} leaked: ${v}`);
  }
  assert.match(two, /KEEP ME/, 'text between two private keys must survive');
  assert.doesNotMatch(two, /AAA|BBB/);
  assert.equal(plain, 'we discuss the token bucket algorithm');
});

// ── F11: sync.sh global lock ──────────────────────────────────────────────────────────────
const hasFlock = POSIX && spawnSync('bash', ['-c', 'command -v flock']).status === 0;
test('F11 a second sync.sh exits 75 (SYNC_BUSY) while another holds the lock', { skip: !hasFlock }, () => {
  const root = path.join(dir, 'sync-root');
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  const script = [
    `exec 9>"${root}/state/sync.lock"`,
    'flock -n 9 || exit 99',
    `GITEA_MIRROR_ROOT="${root}" GITEA_OWNERS=own bash "${path.join(ROOT, 'scripts', 'sync.sh')}" -q -r demo 2>&1`,
    'echo "rc=$?"',
  ].join('\n');
  const holder = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: cleanEnv, timeout: 20000 });
  assert.match(holder.stdout, /SYNC_BUSY/, holder.stdout + holder.stderr);
  assert.match(holder.stdout, /rc=75/);
});

// ── F12: dsh-session-health skips active sessions ─────────────────────────────────────────
const HEALTH = path.join(ROOT, 'scripts', 'dsh-session-health.mjs');
function dshHome(name, { locked }) {
  const base = path.join(dir, name);
  const sdir = path.join(base, 'sessions', 'proj--', 'session-11111111-2222');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'session.v3.jsonl'),
    '{"version":3,"id":"11111111-2222"}\n{"type":"user/message","data":{"text":"hi"}}\n');
  fs.writeFileSync(path.join(sdir, 'session.lock'), '');
  return { base, sdir, lock: path.join(sdir, 'session.lock'), locked };
}
function runHealth(base, env = {}) {
  const r = spawnSync(process.execPath, [HEALTH, '--fix', '--json', '--dsh-home', base], {
    encoding: 'utf8', env: { ...cleanEnv, ...env }, timeout: 30000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

test('F12 --fix leaves a session with a held session.lock untouched, then migrates it once released', { skip: !POSIX }, async () => {
  const h = dshHome('dsh-active', { locked: true });
  const { spawn } = await import('node:child_process');
  const holder = spawn(PY, ['-c', `import fcntl,os,sys,time\nfd=os.open(${JSON.stringify(h.lock)},os.O_RDONLY)\nfcntl.flock(fd,fcntl.LOCK_EX)\nprint('locked',flush=True)\ntime.sleep(60)`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  try {
    const report = runHealth(h.base);
    assert.equal(report.sessions.skipped_active, 1);
    assert.equal(report.sessions.migrated, 0);
    assert.equal(fs.existsSync(path.join(h.sdir, 'session.v4.jsonl')), false);
  } finally {
    holder.kill('SIGKILL');
  }
  await new Promise((resolve) => holder.once('close', resolve));
  const after = runHealth(h.base);
  assert.equal(after.sessions.skipped_active, 0);
  assert.equal(fs.existsSync(path.join(h.sdir, 'session.v4.jsonl')), true);
});

test('F12 an unprobeable lock (no python) is treated as active, never rewritten', { skip: !POSIX }, () => {
  const h = dshHome('dsh-noprobe', { locked: false });
  const report = runHealth(h.base, { DSH_LOCK_PROBE_PYTHON: '/nonexistent/python' });
  assert.equal(report.sessions.skipped_active, 1);
  assert.equal(fs.existsSync(path.join(h.sdir, 'session.v4.jsonl')), false);
});

// ── F15: release gate ─────────────────────────────────────────────────────────────────────
test('F15 release gates packaging on reusable 3-platform CI before building artifacts', () => {
  const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /collect-test-counts\.py/);
  assert.match(ci, /respawn-mcp\.sh --selftest/);
  assert.match(release, /uses:\s*\.\/\.github\/workflows\/ci\.yml/);
  assert.match(release, /uses:\s*\.\/\.github\/workflows\/windows-ci\.yml/);
  assert.match(release, /needs:\s*\[preflight, ci, windows-ci\]/);
  assert.ok(release.indexOf('uses: ./.github/workflows/ci.yml') < release.indexOf('python -m build'), '3-platform CI must gate the build');
});

#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * test/audit-203-sync.test.mjs
 * Regressions for scripts/sync.sh audit findings:
 *   #2  Existing mirror with history preserves refs, HEAD OID, file content & FTS when upstream turns empty
 *   #4  HTTPS credentials bound strictly to expected forge origin/path; mismatched remotes never get token
 *   #10 First API sync works from non-existent mirror root; unwritable parent gives MIRROR_ROOT_NOT_WRITABLE
 *   #11 SSH clone failure -> HTTPS fallback resets rc, succeeds, and converges HEAD; both failing still fails
 *   #12 Enumeration cache partitioned by forge+owner; legacy/foreign cache rejected cleanly
 *   #13 No-flock lock paths (python3 fcntl.flock & hardened mkdir lock) prevent double-claim and alien cleanup
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readSyncState } from '../lib/mirror-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = process.platform !== 'win32';
const SYNC_SRC = path.join(ROOT, 'scripts', 'sync.sh');
const INDEXER_SRC = path.join(ROOT, 'lib', 'indexer.py');
const REAL_GIT = POSIX ? spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() : '';

function writeExe(p, content) {
  fs.writeFileSync(p, content, { mode: 0o755 });
}

function runGit(args, env) {
  const r = spawnSync(REAL_GIT, args, { env, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function baseGitEnv(home) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(GITEA_|GITQ_|GTS_)/.test(k)) delete env[k];
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Sync Audit',
    GIT_AUTHOR_EMAIL: 'sync@example.invalid',
    GIT_COMMITTER_NAME: 'Sync Audit',
    GIT_COMMITTER_EMAIL: 'sync@example.invalid',
    GITEA_ALLOW_NO_JIEBA: '1',
  };
}

function makeSeededUpstream(dir, env, branch = 'main', files = { 'doc.md': '# Seed\nEmptyUpstreamPreserveSentinel2202\n' }) {
  const work = path.join(dir, 'work-' + Math.random().toString(36).slice(2, 8));
  const upstream = path.join(dir, 'upstream-' + Math.random().toString(36).slice(2, 8) + '.git');
  runGit(['init', '-q', work], env);
  runGit(['-C', work, 'checkout', '-q', '-b', branch], env);
  for (const [k, v] of Object.entries(files)) {
    fs.writeFileSync(path.join(work, k), v);
  }
  runGit(['-C', work, 'add', '.'], env);
  runGit(['-C', work, 'commit', '-q', '-m', 'seed'], env);
  runGit(['init', '-q', '--bare', upstream], env);
  runGit(['--git-dir', upstream, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`], env);
  runGit(['-C', work, 'remote', 'add', 'origin', upstream], env);
  runGit(['-C', work, 'push', '-q', 'origin', branch], env);
  return { work, upstream, oid: runGit(['-C', work, 'rev-parse', branch], env) };
}

test('Audit #2: when upstream turns empty, existing mirror keeps branch ref OID, file content, and FTS hits intact', { skip: !POSIX }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const mirror = path.join(dir, 'mirror');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(mirror, 'fixture'), { recursive: true });

  const gitEnv = baseGitEnv(home);
  const { upstream, oid } = makeSeededUpstream(dir, gitEnv);
  const bare = path.join(mirror, 'fixture', 'demo.git');
  runGit(['clone', '-q', '--mirror', upstream, bare], gitEnv);

  const env = { ...gitEnv, GITEA_MIRROR_ROOT: mirror, GITEA_OWNERS: 'fixture', GITQ_JOBS: '1' };
  // Build initial FTS index
  const idx = spawnSync('python3', [INDEXER_SRC, '--mirror-root', mirror, '-o', 'fixture', '--build'], { env, encoding: 'utf8' });
  assert.equal(idx.status, 0, idx.stderr);
  const beforeFts = JSON.parse(spawnSync('python3', [INDEXER_SRC, '--mirror-root', mirror, '-o', 'fixture', '-q', 'EmptyUpstreamPreserveSentinel2202', '--json'], {
    env, encoding: 'utf8',
  }).stdout);
  assert.equal(beforeFts.total, 1);

  // Now make upstream completely empty
  runGit(['--git-dir', upstream, 'update-ref', '-d', 'refs/heads/main'], gitEnv);

  // Run real sync.sh (which also invokes real lib/indexer.py!)
  const syncRes = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(syncRes.status, 1, `expected fail closed, got: ${syncRes.stdout}\n${syncRes.stderr}`);
  assert.match(syncRes.stderr, /FAIL head demo :: HEAD_UNVERIFIED_REMOTE_HEAD/);

  // Verify ref OID, symbolic HEAD, git show content, AND FTS index are ALL preserved!
  assert.equal(runGit(['--git-dir', bare, 'symbolic-ref', 'HEAD'], gitEnv), 'refs/heads/main');
  assert.equal(runGit(['--git-dir', bare, 'show-ref', '--verify', '--hash', 'refs/heads/main'], gitEnv), oid);
  assert.match(runGit(['--git-dir', bare, 'show', 'main:doc.md'], gitEnv), /EmptyUpstreamPreserveSentinel2202/);
  const afterFts = JSON.parse(spawnSync('python3', [INDEXER_SRC, '--mirror-root', mirror, '-o', 'fixture', '-q', 'EmptyUpstreamPreserveSentinel2202', '--json'], {
    env, encoding: 'utf8',
  }).stdout);
  assert.equal(afterFts.total, 1, 'FTS document must survive failed empty-upstream sync');
});

test('Audit #4: askpass helper enforces exact origin/path binding and sync.sh never sends token to foreign remote', { skip: !POSIX }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const mirror = path.join(dir, 'mirror');
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(mirror, 'org', 'alien.git'), { recursive: true });
  fs.mkdirSync(fakeBin);

  // 1) Extract the exact askpass script from sync.sh and test prompt matching directly
  const syncSrc = fs.readFileSync(SYNC_SRC, 'utf8');
  const m = syncSrc.match(/cat > "\$GITQ_ASKPASS" <<'ASKPASS_EOF'[^\n]*\n([\s\S]*?)\nASKPASS_EOF/);
  assert.ok(m, 'must extract askpass script from sync.sh');
  const askpass = path.join(dir, 'askpass.sh');
  writeExe(askpass, m[1] + '\n');

  const canary = ['AUDIT4', 'FAKE', 'TOKEN', 'ZZ99'].join('_');
  const runAsk = (prompt, origin, prefix = '') => spawnSync(askpass, [prompt], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITQ_ASKPASS_USER: 'git',
      GITQ_ASKPASS_TOKEN: canary,
      GITQ_ASKPASS_ORIGIN: origin,
      GITQ_ASKPASS_PATH_PREFIX: prefix,
    },
  });

  // Matching origin (including default :443 normalization & uppercase host)
  assert.equal(runAsk("Username for 'https://forge.example.com': ", 'https://forge.example.com').stdout.trim(), 'git');
  assert.equal(runAsk("Password for 'https://git@FORGE.EXAMPLE.COM:443': ", 'https://forge.example.com').stdout.trim(), canary);
  // Path prefix match vs mismatch
  assert.equal(runAsk("Password for 'https://git@forge.example.com/sub/org/repo.git': ", 'https://forge.example.com', '/sub').stdout.trim(), canary);
  for (const badPrompt of [
    "Password for 'https://evil.example.com': ",
    "Password for 'http://forge.example.com': ",
    "Password for 'https://forge.example.com:8443': ",
    "Username for fixture",
    "Enter passphrase for key",
    "Password for 'https://forge.example.com/other/repo.git': ",
  ]) {
    const r = runAsk(badPrompt, 'https://forge.example.com', badPrompt.includes('/other/') ? '/sub' : '');
    assert.notEqual(r.status, 0, `must reject: ${badPrompt}`);
    assert.equal(r.stdout, '', `must print nothing on reject: ${badPrompt}`);
  }

  // 2) Existing mirror pointing to foreign HTTPS remote must NOT receive GIT_ASKPASS
  const seenAskpass = path.join(dir, 'seen-askpass.log');
  fs.writeFileSync(path.join(mirror, 'org', 'alien.git', 'config'), '[remote "origin"]\n\turl = https://evil.invalid/org/alien.git\n');
  writeExe(path.join(fakeBin, 'git'), `#!/bin/sh
case " $* " in
  *" remote ") printf 'origin\\n'; exit 0 ;;
  *" remote get-url "*) printf 'https://evil.invalid/org/alien.git\\n'; exit 0 ;;
  *" for-each-ref "*) exit 0 ;;
  *" count-objects "*) printf 'count: 0\\nin-pack: 0\\n'; exit 0 ;;
  *" remote update --prune "*)
    [ -n "\${GIT_ASKPASS:-}" ] && echo "LEAKED_ASKPASS" >> "${seenAskpass}"
    exit 1
    ;;
esac
exit 1
`);
  const env = {
    ...baseGitEnv(home),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITEA_MIRROR_ROOT: mirror,
    GITEA_OWNERS: 'org',
    GITEA_URL: 'https://forge.invalid',
    GITEA_TOKEN: canary,
    GITQ_JOBS: '1',
  };
  const syncRes = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'alien'], { env, encoding: 'utf8' });
  assert.equal(syncRes.status, 1);
  assert.equal(fs.existsSync(seenAskpass), false, 'GIT_ASKPASS must never be attached for foreign HTTPS remote');
  const logText = fs.existsSync(path.join(mirror, 'sync.log')) ? fs.readFileSync(path.join(mirror, 'sync.log'), 'utf8') : '';
  assert.equal((syncRes.stdout + syncRes.stderr + logText).includes(canary), false, 'token must never appear in logs/output');
});

test('Audit #10: first pure-API sync succeeds when mirror root does not exist yet; unwritable parent fails clearly', { skip: !POSIX }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-10-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);

  const gitEnv = baseGitEnv(home);
  const { upstream } = makeSeededUpstream(dir, gitEnv, 'main', { 'hello.md': '# Hello\nFirstApiSyncSentinel1010\n' });

  writeExe(path.join(fakeBin, 'curl'), `#!/bin/sh
for arg in "$@"; do case "$arg" in http://*|https://*) url=$arg ;; esac; done
case "$url" in
  *users/neworg/repos*page=1*) printf '[{"name":"firstrepo","has_wiki":false}]\\n'; exit 0 ;;
  *users/neworg/repos*page=2*) printf '[]\\n'; exit 0 ;;
  *) exit 22 ;;
esac
`);
  writeExe(path.join(fakeBin, 'git'), `#!/bin/sh
is_clone=0; dest=""
for arg in "$@"; do [ "$arg" = clone ] && is_clone=1; dest=$arg; done
if [ "$is_clone" -eq 1 ]; then exec "${REAL_GIT}" clone --mirror -q "${upstream}" "$dest"; fi
exec "${REAL_GIT}" "$@"
`);

  // Non-existent mirror root!
  const freshRoot = path.join(dir, 'brand-new-mirror');
  assert.equal(fs.existsSync(freshRoot), false);
  const env = {
    ...gitEnv,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITEA_MIRROR_ROOT: freshRoot,
    GITEA_OWNERS: 'neworg',
    GITEA_URL: 'https://forge.invalid',
    GITEA_TOKEN: 'TEST_TOKEN_10',
    GITQ_ENUM: 'api',
    GITQ_TRANSPORT: 'https',
    GITQ_JOBS: '1',
  };
  const r = spawnSync('/bin/bash', [SYNC_SRC, '-q'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, `first API sync failed:\n${r.stdout}\n${r.stderr}`);
  const fts = JSON.parse(spawnSync('python3', [INDEXER_SRC, '--mirror-root', freshRoot, '-o', 'neworg', '-q', 'FirstApiSyncSentinel1010', '--json'], {
    env, encoding: 'utf8',
  }).stdout);
  assert.equal(fts.total, 1);

  // Unwritable parent (blocked by a regular file so it fails even under root)
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'file');
  const badRes = spawnSync('/bin/bash', [SYNC_SRC, '-q'], {
    env: { ...env, GITEA_MIRROR_ROOT: path.join(blocker, 'sub') },
    encoding: 'utf8',
  });
  assert.notEqual(badRes.status, 0);
  assert.match(badRes.stderr, /MIRROR_ROOT_NOT_WRITABLE/);
});

test('Audit #11: auto transport resets rc on SSH failure -> HTTPS fallback succeeds & verifies HEAD; both failing fails', { skip: !POSIX }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-11-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const mirror = path.join(dir, 'mirror');
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);

  const gitEnv = baseGitEnv(home);
  const { upstream, oid } = makeSeededUpstream(dir, gitEnv);
  writeExe(path.join(fakeBin, 'git'), `#!/bin/sh
is_clone=0; prev=""; url=""; dest=""
for arg in "$@"; do
  [ "$arg" = clone ] && is_clone=1
  url=$prev; prev=$arg
done
dest=$prev
if [ "$is_clone" -eq 1 ]; then
  case "$url" in
    gitea:*) echo "ssh denied" >&2; exit 128 ;;
    https://*)
      if [ "\${AUDIT11_FAIL_HTTPS:-0}" = "1" ]; then echo "https denied" >&2; exit 128; fi
      exec "${REAL_GIT}" clone --mirror -q "${upstream}" "$dest"
      ;;
  esac
fi
exec "${REAL_GIT}" "$@"
`);
  const env = {
    ...gitEnv,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITEA_MIRROR_ROOT: mirror,
    GITEA_OWNERS: 'org',
    GITEA_URL: 'https://forge.invalid',
    GITEA_TOKEN: 'TEST_TOKEN_11',
    GITQ_TRANSPORT: 'auto',
    GITQ_JOBS: '1',
  };
  const okRes = spawnSync('/bin/bash', [SYNC_SRC, '-r', 'demo'], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(okRes.status, 0, okRes.stdout + okRes.stderr);
  assert.match(okRes.stdout, /^ok\s+clone\s+demo$/m);
  const status = fs.readFileSync(path.join(mirror, 'state', 'last_status'), 'utf8');
  assert.match(status, /\bok=1\b/);
  assert.match(status, /\bfail=0\b/);
  assert.equal(runGit(['--git-dir', path.join(mirror, 'org', 'demo.git'), 'rev-parse', 'HEAD'], gitEnv), oid);

  // Both SSH and HTTPS failing -> must still fail
  const failRes = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo2'], {
    env: { ...env, AUDIT11_FAIL_HTTPS: '1' },
    encoding: 'utf8',
  });
  assert.equal(failRes.status, 1);
  assert.match(failRes.stderr, /FAIL clone demo2/);
});

test('Audit #12: enumeration cache is partitioned per owner+forge and rejects legacy/foreign caches', { skip: !POSIX }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-12-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const mirror = path.join(dir, 'mirror');
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);

  writeExe(path.join(fakeBin, 'curl'), `#!/bin/sh
for arg in "$@"; do case "$arg" in http://*|https://*) url=$arg ;; esac; done
case "$url" in
  *users/alpha/repos*page=1*)
    [ "\${FAIL_ALPHA:-0}" = "1" ] && exit 22
    printf '[{"name":"alpha-only","has_wiki":false}]\\n'; exit 0 ;;
  *users/beta/repos*page=1*)
    printf '[{"name":"beta-only","has_wiki":false}]\\n'; exit 0 ;;
  *page=2*) printf '[]\\n'; exit 0 ;;
  *) exit 22 ;;
esac
`);
  const baseEnv = {
    ...baseGitEnv(home),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITEA_MIRROR_ROOT: mirror,
    GITEA_URL: 'https://forge.invalid',
    GITEA_TOKEN: 'TEST_TOKEN_12',
    GITQ_ENUM: 'api',
  };

  // Enumerate alpha then beta
  const rA = spawnSync('/bin/bash', [SYNC_SRC, '--list'], { env: { ...baseEnv, GITEA_OWNERS: 'alpha' }, encoding: 'utf8' });
  assert.equal(rA.status, 0, rA.stderr);
  assert.equal(rA.stdout.trim(), 'alpha-only');

  const rB = spawnSync('/bin/bash', [SYNC_SRC, '--list'], { env: { ...baseEnv, GITEA_OWNERS: 'beta' }, encoding: 'utf8' });
  assert.equal(rB.status, 0, rB.stderr);
  assert.equal(rB.stdout.trim(), 'beta-only');

  const betaCache = path.join(mirror, 'state', 'repos.forge.invalid_beta.cache');
  const betaBefore = fs.readFileSync(betaCache, 'utf8');

  // Now alpha API fails -> must get ONLY alpha-only (never beta-only!), and beta cache stays untouched
  const rADegraded = spawnSync('/bin/bash', [SYNC_SRC, '--list'], {
    env: { ...baseEnv, GITEA_OWNERS: 'alpha', FAIL_ALPHA: '1' },
    encoding: 'utf8',
  });
  assert.equal(rADegraded.status, 0, rADegraded.stderr);
  assert.match(rADegraded.stdout, /\balpha-only\b/);
  assert.doesNotMatch(rADegraded.stdout, /\bbeta-only\b/);
  assert.equal(fs.readFileSync(betaCache, 'utf8'), betaBefore);

  // Legacy headerless cache must be rejected and fall back to owner disk mirrors
  const legacy = path.join(dir, 'legacy.cache');
  fs.writeFileSync(legacy, '# legacy without owner\nforeign-repo\n');
  fs.mkdirSync(path.join(mirror, 'alpha', 'disk-alpha.git'), { recursive: true });
  const rLegacy = spawnSync('/bin/bash', [SYNC_SRC, '--list'], {
    env: { ...baseEnv, GITEA_OWNERS: 'alpha', FAIL_ALPHA: '1', GITQ_REPOS_CACHE: legacy },
    encoding: 'utf8',
  });
  assert.doesNotMatch(rLegacy.stdout, /\bforeign-repo\b/);
  assert.match(rLegacy.stdout, /\bdisk-alpha\b/);

  // Same origin + same owner + two different URL subpaths (/forge-a vs /forge-b) must have isolated caches & headers
  writeExe(path.join(fakeBin, 'curl'), `#!/bin/sh
for arg in "$@"; do case "$arg" in http://*|https://*) url=$arg ;; esac; done
case "$url" in
  */forge-a/api/v1/users/alpha/repos*page=1*)
    [ "\${FAIL_SUB:-0}" = "1" ] && exit 22
    printf '[{"name":"sub-a-only","has_wiki":false}]\\n'; exit 0 ;;
  */forge-b/api/v1/users/alpha/repos*page=1*)
    [ "\${FAIL_SUB:-0}" = "1" ] && exit 22
    printf '[{"name":"sub-b-only","has_wiki":false}]\\n'; exit 0 ;;
  *page=2*) printf '[]\\n'; exit 0 ;;
  *) exit 22 ;;
esac
`);
  const rSubA = spawnSync('/bin/bash', [SYNC_SRC, '--list'], {
    env: { ...baseEnv, GITEA_OWNERS: 'alpha', GITEA_URL: 'https://forge.invalid/forge-a' },
    encoding: 'utf8',
  });
  assert.equal(rSubA.status, 0, rSubA.stderr);
  assert.equal(rSubA.stdout.trim(), 'sub-a-only');

  const rSubB = spawnSync('/bin/bash', [SYNC_SRC, '--list'], {
    env: { ...baseEnv, GITEA_OWNERS: 'alpha', GITEA_URL: 'https://forge.invalid/forge-b' },
    encoding: 'utf8',
  });
  assert.equal(rSubB.status, 0, rSubB.stderr);
  assert.equal(rSubB.stdout.trim(), 'sub-b-only');

  const rSubADeg = spawnSync('/bin/bash', [SYNC_SRC, '--list'], {
    env: { ...baseEnv, GITEA_OWNERS: 'alpha', GITEA_URL: 'https://forge.invalid/forge-a', FAIL_SUB: '1' },
    encoding: 'utf8',
  });
  assert.equal(rSubADeg.status, 0, rSubADeg.stderr);
  assert.match(rSubADeg.stdout, /\bsub-a-only\b/);
  assert.doesNotMatch(rSubADeg.stdout, /\bsub-b-only\b/);

  const rSubBDeg = spawnSync('/bin/bash', [SYNC_SRC, '--list'], {
    env: { ...baseEnv, GITEA_OWNERS: 'alpha', GITEA_URL: 'https://forge.invalid/forge-b', FAIL_SUB: '1' },
    encoding: 'utf8',
  });
  assert.equal(rSubBDeg.status, 0, rSubBDeg.stderr);
  assert.match(rSubBDeg.stdout, /\bsub-b-only\b/);
  assert.doesNotMatch(rSubBDeg.stdout, /\bsub-a-only\b/);

  // Explicitly pointing /forge-b at /forge-a's cache file must be rejected by header check
  const stateFiles = fs.readdirSync(path.join(mirror, 'state')).filter((f) => f.includes('forge-a'));
  assert.equal(stateFiles.length, 1, `expected one forge-a cache file, got ${stateFiles}`);
  const rCrossSub = spawnSync('/bin/bash', [SYNC_SRC, '--list'], {
    env: {
      ...baseEnv,
      GITEA_OWNERS: 'alpha',
      GITEA_URL: 'https://forge.invalid/forge-b',
      FAIL_SUB: '1',
      GITQ_REPOS_CACHE: path.join(mirror, 'state', stateFiles[0]),
    },
    encoding: 'utf8',
  });
  assert.doesNotMatch(rCrossSub.stdout, /\bsub-a-only\b/);
  assert.match(rCrossSub.stdout, /\bdisk-alpha\b/);
});

test('sync-only JSON reports API, cache, stale cache and disk coverage from the current run', { skip: !POSIX }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-enum-coverage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const mirror = path.join(dir, 'mirror');
  const work = path.join(dir, 'work');
  const fakeBin = path.join(dir, 'bin');
  const cache = path.join(dir, 'repos.cache');
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(path.join(mirror, 'own'), { recursive: true });
  const env = {
    ...baseGitEnv(home), PATH: fakeBin + path.delimiter + process.env.PATH,
    GITEA_MIRROR_ROOT: mirror, GITEA_OWNERS: 'own', GITEA_URL: 'https://forge.invalid',
    GITQ_ENUM: 'api', GITQ_REPOS_CACHE: cache, GITQ_JOBS: '1',
  };
  runGit(['init', '-q', '-b', 'main', work], env);
  fs.writeFileSync(path.join(work, 'doc.md'), '# Sync coverage fixture\n');
  runGit(['-C', work, 'add', '.'], env);
  runGit(['-C', work, 'commit', '-qm', 'initial'], env);
  runGit(['clone', '-q', '--mirror', work, path.join(mirror, 'own', 'demo.git')], env);
  writeExe(path.join(fakeBin, 'curl'), `#!/bin/sh
[ "$FIXTURE_OFFLINE" = 1 ] && exit 22
for arg do case "$arg" in *page=2) printf '[]\\n'; exit 0 ;; esac; done
printf '[{"name":"demo","has_wiki":false}]\\n'
`);
  for (const [source, stale] of [['api', false], ['cache', false], ['cache', true], ['disk', false]]) {
    if (stale) fs.utimesSync(cache, new Date(0), new Date(0));
    if (source === 'disk') fs.unlinkSync(cache);
    const result = spawnSync('python3', [path.join(ROOT, 'bin', 'gts'), '--sync-only', '--json'], {
      env: { ...env, FIXTURE_OFFLINE: source === 'api' ? '0' : '1' }, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: source === 'api' ? 'ok' : 'degraded', owners: ['own'],
      degraded: source !== 'api', enum_source: source, cache_stale: stale,
      complete_repo_list: source === 'api', ok: 1, fail: 0, total: 1,
    });
    const state = readSyncState(mirror);
    assert.equal(state.enum_source, source);
    assert.equal(state.cache_stale, stale);
    assert.equal(state.sync_scope, 'full');
    assert.equal(state.sync_status, 'ok');
    assert.equal(state.index_status, 'ok');
    assert.ok(state.last_success);
  }
});

test('Audit #13: no-flock lock paths (python3 fcntl.flock and hardened mkdir fallback) prevent concurrent entry and stale/alien clobber', { skip: !POSIX }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-13-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);

  // Build a clean PATH containing essential tools EXCEPT flock (and optionally python3)
  function buildFilteredBin(name, omit) {
    const b = path.join(dir, name);
    fs.mkdirSync(b, { recursive: true });
    for (const cmd of ['bash', 'sh', 'awk', 'sed', 'grep', 'tr', 'cat', 'mkdir', 'rm', 'mv', 'date', 'stat', 'mktemp', 'chmod', 'xargs', 'sleep', 'timeout', 'hostname', 'head', 'tail', 'kill', 'basename', 'dirname', 'python3']) {
      if (omit.includes(cmd)) continue;
      const loc = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim();
      if (loc && fs.existsSync(loc)) fs.symlinkSync(loc, path.join(b, cmd));
    }
    return b;
  }

  // Path (1): no flock, WITH python3 fcntl.flock
  const noFlockBin = buildFilteredBin('bin-no-flock', ['flock']);
  const mirror1 = path.join(dir, 'm1');
  const held1 = path.join(dir, 'held1');
  const gitPidFile1 = path.join(dir, 'git1.pid');
  writeExe(path.join(noFlockBin, 'git'), `#!/bin/sh
echo $$ > "${gitPidFile1}"
echo locked > "${held1}"
sleep 30
`);
  const env1 = { ...baseGitEnv(home), PATH: noFlockBin, GITEA_MIRROR_ROOT: mirror1, GITEA_OWNERS: 'own', GITQ_JOBS: '1' };
  const holder1 = spawn('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: env1, stdio: 'pipe', detached: true });
  t.after(() => {
    try { process.kill(-holder1.pid, 'SIGKILL'); } catch {}
    try { process.kill(Number(fs.readFileSync(gitPidFile1, 'utf8').trim()), 'SIGKILL'); } catch {}
  });
  for (let i = 0; i < 100 && !fs.existsSync(held1); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(held1), 'holder1 should have acquired python3 fcntl lock');

  const contender1 = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: env1, encoding: 'utf8', timeout: 10000 });
  assert.equal(contender1.status, 75, `expected SYNC_BUSY 75 without flock, got ${contender1.status}: ${contender1.stderr}`);
  process.kill(-holder1.pid, 'SIGKILL');
  try { process.kill(Number(fs.readFileSync(gitPidFile1, 'utf8').trim()), 'SIGKILL'); } catch {}
  await new Promise((r) => holder1.once('close', r));

  // After SIGKILL, kernel releases fcntl.flock immediately; verify a new sync does NOT return 75
  writeExe(path.join(noFlockBin, 'git'), '#!/bin/sh\nexit 1\n');
  const afterKill1 = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: env1, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(afterKill1.status, 75, 'lock must be auto-released after SIGKILL');

  // Path (2): no flock AND no python3 -> hardened mkdir fallback
  const mkdirOnlyBin = buildFilteredBin('bin-mkdir-only', ['flock', 'python3']);
  writeExe(path.join(mkdirOnlyBin, 'git'), '#!/bin/sh\nexit 1\n');
  const mirror2 = path.join(dir, 'm2');
  const pauseFile = path.join(dir, 'pause.flag');
  fs.writeFileSync(pauseFile, 'hold');
  const env2 = { ...baseGitEnv(home), PATH: mkdirOnlyBin, GITEA_MIRROR_ROOT: mirror2, GITEA_OWNERS: 'own', GITQ_JOBS: '1' };

  // Start A paused strictly between `mkdir sync.lock.d` and writing `pid`
  const holderA = spawn('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], {
    env: { ...env2, GITQ_TEST_LOCK_PAUSE_FILE: pauseFile },
    stdio: 'pipe',
  });
  const lockDir2 = path.join(mirror2, 'state', 'sync.lock.d');
  for (let i = 0; i < 100 && !fs.existsSync(lockDir2); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(lockDir2), 'A must have created sync.lock.d');
  assert.equal(fs.existsSync(path.join(lockDir2, 'pid')), false, 'A must still be before pid write');

  // Process B arrives while pid file is still missing -> MUST return 75 (initializing = busy), NEVER rm -rf!
  const contenderB = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: env2, encoding: 'utf8', timeout: 10000 });
  assert.equal(contenderB.status, 75, `expected 75 during mkdir init race, got ${contenderB.status}: ${contenderB.stderr}`);
  assert.ok(fs.existsSync(lockDir2), 'B must NOT delete A initializing lock dir');

  // Release A and let it finish cleanly
  fs.unlinkSync(pauseFile);
  await new Promise((r) => holderA.once('close', r));
  assert.equal(fs.existsSync(lockDir2), false, 'A should clean up its own lock dir on exit');

  // Dead-PID stale lock recovery works
  fs.mkdirSync(lockDir2, { recursive: true });
  fs.writeFileSync(path.join(lockDir2, 'pid'), '9999999\n');
  fs.writeFileSync(path.join(lockDir2, 'owner'), '9999999:0:0\n');
  const recovered = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: env2, encoding: 'utf8', timeout: 10000 });
  assert.notEqual(recovered.status, 75, 'stale dead-PID lock must be reclaimed');

  // Concurrent stale-lock reclamation race: both contenders observe the SAME dead lock, pause at barrier,
  // then race simultaneously -> exactly one enters sync, the other returns 75, and winner's lock dir stays intact.
  const entriesLog = path.join(dir, 'reclaim-entries.log');
  const lockIntactLog = path.join(dir, 'reclaim-lock-intact.log');
  const gitHold = path.join(dir, 'hold-winner');
  writeExe(path.join(mkdirOnlyBin, 'git'), `#!/bin/sh
echo "$$" >> "${entriesLog}"
i=0
while [ -f "${gitHold}" ] && [ "$i" -lt 200 ]; do
  sleep 0.05
  i=$((i + 1))
done
if [ -d "${lockDir2}" ] && [ -f "${lockDir2}/pid" ]; then
  echo "INTACT" >> "${lockIntactLog}"
else
  echo "MISSING" >> "${lockIntactLog}"
fi
exit 1
`);
  const reclaimDir = lockDir2 + '.reclaim';
  function seedStale(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'pid'), '9999999\n');
    fs.writeFileSync(path.join(dirPath, 'owner'), '9999999:0:0\n');
  }
  for (const staleReclaim of [false, true]) {
    seedStale(lockDir2);
    if (staleReclaim) seedStale(reclaimDir);
    fs.rmSync(entriesLog, { force: true });
    fs.rmSync(lockIntactLog, { force: true });
    const pause = path.join(dir, 'race-' + staleReclaim + '.pause');
    const ready = path.join(dir, 'ready-' + staleReclaim);
    fs.mkdirSync(ready);
    fs.writeFileSync(pause, 'hold');
    fs.writeFileSync(gitHold, 'hold');
    const barrier = staleReclaim ? 'GITQ_TEST_RECLAIM_STALE' : 'GITQ_TEST_RECLAIM';
    const raceEnv = { ...env2, [barrier + '_PAUSE_FILE']: pause, [barrier + '_READY_DIR']: ready };
    const contenders = Array.from({ length: 2 }, () => spawn('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], {
      env: raceEnv, stdio: 'pipe',
    }));
    const completed = contenders.map((child) => new Promise((resolve) => child.once('close', resolve)));
    try {
      for (let i = 0; i < 120 && fs.readdirSync(ready).length < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(fs.readdirSync(ready).length, 2, 'both contenders must reach the stale-instance barrier');
      fs.unlinkSync(pause);
      for (let i = 0; i < 120 && !fs.existsSync(entriesLog); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(fs.existsSync(entriesLog), true, 'winner must acquire the lock and enter Git');
      assert.equal(await Promise.race(completed), 75, 'loser must exit while the winner is held in Git');
      assert.equal(fs.existsSync(path.join(lockDir2, 'owner')), true);
    } finally {
      fs.rmSync(pause, { force: true });
      fs.rmSync(gitHold, { force: true });
      await Promise.all(completed);
    }
    const codes = (await Promise.all(completed)).sort((a, b) => a - b);
    assert.deepEqual(codes, [1, 75], 'only one contender may reach the synthetic Git failure');
    assert.equal(fs.readFileSync(entriesLog, 'utf8').trim().split('\n').length, 1);
    assert.equal(fs.readFileSync(lockIntactLog, 'utf8').trim(), 'INTACT', 'winner must retain its lock until Git exits');
    assert.deepEqual(fs.readdirSync(path.dirname(lockDir2)).filter((name) => name.startsWith('sync.lock.d')), []);
  }

  // §3.1: A LIVE takeover holder (live PID or fresh initializing dir without PID) must remain fail-closed.
  const staleTakeover = reclaimDir + '.takeover.9999999_0_0';
  for (const liveKind of ['live-pid', 'fresh-init']) {
    fs.rmSync(lockDir2, { recursive: true, force: true });
    fs.rmSync(reclaimDir, { recursive: true, force: true });
    fs.rmSync(staleTakeover, { recursive: true, force: true });
    seedStale(lockDir2);
    seedStale(reclaimDir);
    fs.mkdirSync(staleTakeover, { recursive: true });
    if (liveKind === 'live-pid') {
      fs.writeFileSync(path.join(staleTakeover, 'pid'), `${process.pid}\n`);
      fs.writeFileSync(path.join(staleTakeover, 'owner'), `${process.pid}:1:1\n`);
    }
    const before = fs.statSync(staleTakeover);
    fs.rmSync(entriesLog, { force: true });
    const blocked = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: env2, encoding: 'utf8', timeout: 10000 });
    assert.equal(blocked.status, 75, `${liveKind}: ${blocked.stderr}`);
    assert.match(blocked.stderr, /SYNC_BUSY/, liveKind);
    assert.equal(fs.statSync(staleTakeover).ino, before.ino, liveKind);
    assert.equal(fs.readFileSync(path.join(reclaimDir, 'owner'), 'utf8'), '9999999:0:0\n', liveKind);
    assert.equal(fs.existsSync(entriesLog), false, liveKind);
  }

  // §3.1: A STALE takeover directory (dead PID, expired init without PID, or chained dead generations)
  // must self-heal instead of permanently wedging sync with SYNC_BUSY.
  for (const staleKind of ['dead-pid', 'expired-init', 'chained-dead']) {
    fs.rmSync(lockDir2, { recursive: true, force: true });
    fs.rmSync(reclaimDir, { recursive: true, force: true });
    for (const name of fs.readdirSync(path.dirname(lockDir2))) {
      if (name.startsWith('sync.lock.d')) fs.rmSync(path.join(path.dirname(lockDir2), name), { recursive: true, force: true });
    }
    seedStale(lockDir2);
    seedStale(reclaimDir);
    if (staleKind === 'dead-pid') {
      seedStale(staleTakeover);
    } else if (staleKind === 'expired-init') {
      fs.mkdirSync(staleTakeover, { recursive: true });
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(staleTakeover, old, old);
    } else {
      seedStale(staleTakeover);
      seedStale(`${staleTakeover}.1`);
    }
    fs.rmSync(entriesLog, { force: true });
    fs.rmSync(lockIntactLog, { force: true });
    const recovered = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: env2, encoding: 'utf8', timeout: 10000 });
    assert.equal(recovered.status, 1, `${staleKind} must recover past SYNC_BUSY into synthetic git:\n${recovered.stderr}`);
    assert.equal(fs.readFileSync(entriesLog, 'utf8').trim().split('\n').length, 1, staleKind);
    assert.equal(fs.readFileSync(lockIntactLog, 'utf8').trim(), 'INTACT', staleKind);
    assert.deepEqual(
      fs.readdirSync(path.dirname(lockDir2)).filter((name) => name.startsWith('sync.lock.d')),
      [],
      `${staleKind}: all stale lock/reclaim/takeover dirs must be cleaned up`,
    );
  }

  // §3.1: Concurrent stale-takeover race — two contenders observe the same dead takeover dir,
  // synchronize at barrier, and race for generation .1 -> exactly one wins and enters Git.
  seedStale(lockDir2);
  seedStale(reclaimDir);
  seedStale(staleTakeover);
  fs.rmSync(entriesLog, { force: true });
  fs.rmSync(lockIntactLog, { force: true });
  const takeoverPause = path.join(dir, 'race-takeover.pause');
  const takeoverReady = path.join(dir, 'ready-takeover');
  fs.mkdirSync(takeoverReady);
  fs.writeFileSync(takeoverPause, 'hold');
  fs.writeFileSync(gitHold, 'hold');
  const takeoverEnv = {
    ...env2,
    GITQ_TEST_TAKEOVER_STALE_PAUSE_FILE: takeoverPause,
    GITQ_TEST_TAKEOVER_STALE_READY_DIR: takeoverReady,
  };
  const takeoverContenders = Array.from({ length: 2 }, () => spawn('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], {
    env: takeoverEnv, stdio: 'pipe',
  }));
  const takeoverDone = takeoverContenders.map((child) => new Promise((resolve) => child.once('close', resolve)));
  try {
    for (let i = 0; i < 120 && fs.readdirSync(takeoverReady).length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.readdirSync(takeoverReady).length, 2, 'both contenders must reach the stale-takeover barrier');
    fs.unlinkSync(takeoverPause);
    for (let i = 0; i < 120 && !fs.existsSync(entriesLog); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.existsSync(entriesLog), true, 'winner must recover stale takeover and enter Git');
    assert.equal(await Promise.race(takeoverDone), 75, 'loser must exit SYNC_BUSY while winner is held in Git');
  } finally {
    fs.rmSync(takeoverPause, { force: true });
    fs.rmSync(gitHold, { force: true });
    await Promise.all(takeoverDone);
  }
  assert.deepEqual((await Promise.all(takeoverDone)).sort((a, b) => a - b), [1, 75]);
  assert.equal(fs.readFileSync(entriesLog, 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(lockIntactLog, 'utf8').trim(), 'INTACT');
  assert.deepEqual(fs.readdirSync(path.dirname(lockDir2)).filter((name) => name.startsWith('sync.lock.d')), []);

  // Re-audit R4/R5 + non-positive PID guard:
  // - Leading-zero generation suffix (e.g. .08) must not trigger Bash octal arithmetic failure.
  // - Corrupted pid=0 must not be treated as live via kill -0 0.
  // - Stale old-token orphan takeover dirs must be garbage-collected while live ones stay untouched.
  seedStale(lockDir2);
  fs.writeFileSync(path.join(lockDir2, 'pid'), '0\n');
  seedStale(reclaimDir);
  seedStale(`${staleTakeover}.08`);
  const oldOrphan = `${reclaimDir}.takeover.oldtoken_1_1`;
  const liveOther = `${reclaimDir}.takeover.livetoken_2_2`;
  seedStale(oldOrphan);
  fs.mkdirSync(liveOther, { recursive: true });
  fs.writeFileSync(path.join(liveOther, 'pid'), `${process.pid}\n`);
  fs.writeFileSync(path.join(liveOther, 'owner'), `${process.pid}:2:2\n`);
  fs.rmSync(entriesLog, { force: true });
  fs.rmSync(lockIntactLog, { force: true });
  const r4r5 = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: env2, encoding: 'utf8', timeout: 10000 });
  assert.equal(r4r5.status, 1, `R4/R5 recovery failed:\n${r4r5.stderr}`);
  assert.doesNotMatch(r4r5.stderr, /value too great for base/i);
  assert.equal(fs.readFileSync(entriesLog, 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(lockIntactLog, 'utf8').trim(), 'INTACT');
  assert.equal(fs.existsSync(`${staleTakeover}.08`), false, 'leading-zero stale generation must be cleaned');
  assert.equal(fs.existsSync(oldOrphan), false, 'dead old-token orphan takeover dir must be garbage-collected');
  assert.equal(fs.existsSync(liveOther), true, 'live takeover dir from another token must never be removed');
  fs.rmSync(liveOther, { recursive: true, force: true });
});

test('Audit #19: mirror with multiple remotes (or zero remotes) fails closed BEFORE any remote update --prune and preserves all refs/OIDs', { skip: !POSIX }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-19-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const mirror = path.join(dir, 'mirror');
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(path.join(mirror, 'org'), { recursive: true });

  const gitEnv = baseGitEnv(home);
  const up1 = makeSeededUpstream(dir, gitEnv, 'main', { 'a.txt': 'v1\n' });
  const up2 = makeSeededUpstream(dir, gitEnv, 'other', { 'b.txt': 'other\n' });
  // Seed a second branch on up1 before cloning mirror
  runGit(['--git-dir', up1.upstream, 'update-ref', 'refs/heads/keep-me', up1.oid], gitEnv);

  const bare = path.join(mirror, 'org', 'multi.git');
  runGit(['clone', '-q', '--mirror', up1.upstream, bare], gitEnv);
  // Add a second remote to the bare mirror
  runGit(['--git-dir', bare, 'remote', 'add', 'secondary', up2.upstream], gitEnv);

  // Now mutate up1 (advance main & delete keep-me) so any remote update --prune WOULD mutate local refs
  fs.writeFileSync(path.join(up1.work, 'a.txt'), 'v2-mutated\n');
  runGit(['-C', up1.work, 'add', 'a.txt'], gitEnv);
  runGit(['-C', up1.work, 'commit', '-q', '-m', 'advance'], gitEnv);
  runGit(['-C', up1.work, 'push', '-q', 'origin', 'main'], gitEnv);
  runGit(['--git-dir', up1.upstream, 'update-ref', '-d', 'refs/heads/keep-me'], gitEnv);

  const refsBefore = runGit(['--git-dir', bare, 'for-each-ref', '--format=%(refname) %(objectname)'], gitEnv);
  const gitCallsLog = path.join(dir, 'git.calls');
  writeExe(path.join(fakeBin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "${gitCallsLog}"
exec "${REAL_GIT}" "$@"
`);
  const env = {
    ...gitEnv,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITEA_MIRROR_ROOT: mirror,
    GITEA_OWNERS: 'org',
    GITQ_JOBS: '1',
  };

  const resMulti = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'multi'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(resMulti.status, 1);
  assert.match(resMulti.stderr, /FAIL head multi :: HEAD_UNVERIFIED_REMOTE_COUNT/);
  const refsAfter = runGit(['--git-dir', bare, 'for-each-ref', '--format=%(refname) %(objectname)'], gitEnv);
  assert.equal(refsAfter, refsBefore, 'all refs and OIDs must remain completely untouched on multi-remote failure');
  const calls = fs.readFileSync(gitCallsLog, 'utf8');
  assert.doesNotMatch(calls, /remote update/, 'sync_one must never invoke remote update when remote_count != 1');

  // Zero remotes case also fails closed before remote update
  runGit(['--git-dir', bare, 'remote', 'remove', 'origin'], gitEnv);
  runGit(['--git-dir', bare, 'remote', 'remove', 'secondary'], gitEnv);
  fs.writeFileSync(gitCallsLog, '');
  const resZero = spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'multi'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(resZero.status, 1);
  assert.match(resZero.stderr, /FAIL head multi :: HEAD_UNVERIFIED_REMOTE_COUNT/);
  assert.equal(runGit(['--git-dir', bare, 'for-each-ref', '--format=%(refname) %(objectname)'], gitEnv), refsBefore);
  assert.doesNotMatch(fs.readFileSync(gitCallsLog, 'utf8'), /remote update/);
});

test('Audit #20: subpath HTTPS forge auth uses Git 2.25-compatible `-c credential.useHttpPath=true` and rejects mismatched subpaths', { skip: !POSIX, timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-20-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const mirror = path.join(dir, 'mirror');
  const fakeBin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(fakeBin);

  const canary = ['AUDIT20', 'SUBPATH', 'TOKEN', '7742'].join('_');
  const argvLog = path.join(dir, 'git-argv.log');
  writeExe(path.join(fakeBin, 'git'), `#!/bin/sh
printf 'ARGV:%s|CFG_COUNT:%s\\n' "$*" "\${GIT_CONFIG_COUNT:-}" >> "${argvLog}"
exit 1
`);
  const stubEnv = {
    ...baseGitEnv(home),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITEA_MIRROR_ROOT: mirror,
    GITEA_OWNERS: 'org',
    GITEA_URL: 'https://forge.invalid/gitea',
    GITEA_TOKEN: canary,
    GITQ_TRANSPORT: 'https',
    GITQ_JOBS: '1',
  };
  spawnSync('/bin/bash', [SYNC_SRC, '-q', '-r', 'demo'], { env: stubEnv, encoding: 'utf8' });
  const logged = fs.readFileSync(argvLog, 'utf8');
  assert.match(logged, /ARGV:-c credential\.useHttpPath=true clone --mirror/, 'must pass -c credential.useHttpPath=true directly to git (Git 2.25+ compatible)');
  assert.match(logged, /\|CFG_COUNT:$/m, 'must not depend on Git 2.31+ GIT_CONFIG_COUNT');

  // Live local HTTP Basic-Auth verification with real git + real askpass:
  // /gitea/org/demo.git receives credentials; /other/org/demo.git does NOT.
  const expectedAuth = 'Basic ' + Buffer.from(`git:${canary}`, 'utf8').toString('base64');
  const seenAuth = [];
  const server = http.createServer((req, res) => {
    seenAuth.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="forge"' });
      res.end('auth required');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const liveEnv = {
    ...baseGitEnv(home),
    GITEA_MIRROR_ROOT: path.join(dir, 'live-mirror'),
    GITEA_OWNERS: 'org',
    GITEA_URL: `http://127.0.0.1:${port}/gitea`,
    GITEA_TOKEN: canary,
    GITQ_TRANSPORT: 'https',
    GITQ_JOBS: '1',
  };
  const runSyncAsync = (args, env) => new Promise((resolve) => {
    const child = spawn('/bin/bash', [SYNC_SRC, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

  // Allowed subpath clone triggers 401 -> askpass -> authenticated retry on /gitea/org/demo.git
  await runSyncAsync(['-q', '-r', 'demo'], liveEnv);
  assert.ok(
    seenAuth.some((r) => r.url.startsWith('/gitea/org/demo.git') && r.auth === expectedAuth),
    `expected real git to send subpath credentials via -c credential.useHttpPath=true; saw: ${JSON.stringify(seenAuth)}`,
  );

  // Mismatched subpath on an existing mirror pointing to /other/org/other.git must NEVER receive credentials
  seenAuth.length = 0;
  const badBare = path.join(dir, 'live-mirror', 'org', 'other.git');
  runGit(['init', '-q', '--bare', badBare], baseGitEnv(home));
  runGit(['--git-dir', badBare, 'remote', 'add', 'origin', `http://127.0.0.1:${port}/other/org/other.git`], baseGitEnv(home));
  await runSyncAsync(['-q', '-r', 'other'], liveEnv);
  assert.equal(
    seenAuth.some((r) => r.auth !== ''),
    false,
    `mismatched subpath remote must NEVER receive credentials; saw: ${JSON.stringify(seenAuth)}`,
  );
});

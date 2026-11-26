// SPDX-License-Identifier: Apache-2.0
/**
 * 2.0.3 post-fix audit (N1–N8) 回归：
 *   N1 PEM 私钥扫描必须线性（JS + Python）；
 *   N2 单行脱敏对常见凭据写法的正反用例；
 *   N6 敏感路径黑名单补项；
 *   N8 mightBePemBlockLine 剪枝不漏块内行；mirror 仓设置 gc.autoDetach=false。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  findPrivateKeyLineIndices,
  isSensitivePath,
  mightBePemBlockLine,
  redactSecrets,
} from '../lib/security.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.platform === 'win32' ? 'python' : 'python3';

test('N1 findPrivateKeyLineIndices is linear on many unclosed BEGIN lines', () => {
  const lines = Array.from({ length: 60000 }, () => '-----BEGIN ' + 'PRIVATE KEY-----');
  const t0 = Date.now();
  const { indices } = findPrivateKeyLineIndices(lines);
  const ms = Date.now() - t0;
  assert.equal(indices.size, 60000);
  // 旧实现 40000 行就要 22 秒；线性实现应远低于 1 秒（给慢 CI 留出两个数量级余量）。
  assert.ok(ms < 2000, `scan took ${ms}ms`);
});

test('N1 findPrivateKeyLineIndices keeps closed / unclosed / PGP semantics', () => {
  const closed = findPrivateKeyLineIndices(['a', '-----BEGIN ' + 'RSA PRIVATE KEY-----', 'AAAA', 'BBBB', '-----END RSA PRIVATE KEY-----', 'z']);
  assert.deepEqual([...closed.indices].sort(), [1, 2, 3, 4]);
  assert.deepEqual(closed.ranges, [[1, 4]]);

  const unclosed = findPrivateKeyLineIndices(['x', '-----BEGIN ' + 'PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0B', 'hello world']);
  assert.deepEqual([...unclosed.indices].sort(), [1, 2]);

  const pgp = findPrivateKeyLineIndices(['-----BEGIN PGP PRIVATE KEY BLOCK-----', 'Version: x', '', 'lQcYBGabc123abc123abc123', '-----END PGP PRIVATE KEY BLOCK-----', 'tail']);
  assert.deepEqual([...pgp.indices].sort(), [0, 1, 2, 3, 4]);

  const two = findPrivateKeyLineIndices(['-----BEGIN ' + 'PRIVATE KEY-----', 'A', '-----END PRIVATE KEY-----', 'mid', '-----BEGIN ' + 'PRIVATE KEY-----', 'B', '-----END PRIVATE KEY-----']);
  assert.deepEqual(two.ranges, [[0, 2], [4, 6]]);
});

test('N1 indexer._mask_private_key_blocks is linear and masks PGP blocks', () => {
  const code = `
import sys, time
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})
import indexer
raw = '-----BEGIN ' 'PRIVATE KEY-----\\n' * 120000
t = time.time(); indexer._mask_private_key_blocks(raw); dt = time.time() - t
assert dt < 5, dt
pgp = 'a\\n-----BEGIN PGP PRIVATE KEY BLOCK-----\\nlQcYBGabc123abc123abc123\\n-----END PGP PRIVATE KEY BLOCK-----\\nz'
assert indexer._mask_private_key_blocks(pgp) == 'a\\n[SECRET_REDACTED:private_key]\\nz', indexer._mask_private_key_blocks(pgp)
for p in ('.aws/credentials', 'x/.pgpass', 'a/terraform.tfstate', 'k/kubeconfig', 'a/.docker/config.json', 'a/.kube/config'):
    assert indexer.is_sensitive_path(p), p
for p in ('a/credentials', 'docs/kubeconfig.md', 'src/config.json'):
    assert not indexer.is_sensitive_path(p), p
print('OK')
`;
  const r = spawnSync(PY, ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /OK/);
});

test('N2 single-line redaction covers common credential shapes', () => {
  const must = [
    'MYSQL_ROOT_PASSWORD=Sup3rSecretPw99',
    'POSTGRES_PASSWORD: hunter2hunter2',
    '{"password": "Sup3rSecretPw99"}',
    'password: "short1"',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'token=abcdef0123456789abcdef',
    'client_secret="abc,def;ghi12345"',
    'SMTP_PASS=abcdefghijklmnop',
    'apiKey: abcdef0123456789',
    '  "secret": "s3cr3t-value-here",',
    'GITHUB_TOKEN: abcd1234efgh5678ijkl',
  ];
  for (const line of must) {
    const out = redactSecrets(line).text;
    assert.match(out, /SECRET_REDACTED:kv_secret/, `should redact: ${line} -> ${out}`);
  }
  const pgp = redactSecrets('-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQcYBGabc123\n-----END PGP PRIVATE KEY BLOCK-----').text;
  assert.equal(pgp, '[SECRET_REDACTED:private_key]');
});

test('N2 single-line redaction leaves code-shaped values and placeholders alone', () => {
  const keep = [
    'token: string',
    'password = getpass.getpass()',
    'if (password === confirmPassword) {',
    'secret_key = os.environ["X"]',
    'token = self.next_token()',
    'password: ${DB_PASSWORD}',
    'password=changeme',
    'password = password_input',
    'const token = getToken();',
    'compass=abcdefghijkl',
    'PASSWORD_MIN_LENGTH=12345678901',
    'password: ""',
    'pass: true',
    'token: Optional[str]',
    'secret: your-secret-here',
    'api_key = config.api_key',
    'token: abcdefghijkl',
  ];
  for (const line of keep) {
    assert.equal(redactSecrets(line).text, line, `should keep: ${line}`);
  }
});

test('N6 sensitive-path denylist covers cloud / terraform / kube credentials', () => {
  for (const p of ['a/.aws/credentials', 'x/.pgpass', 'terraform.tfstate', 'infra/prod.tfstate.backup', 'secrets/kubeconfig', 'a/.docker/config.json', 'a/.kube/config', '.htpasswd']) {
    assert.equal(isSensitivePath(p), true, p);
  }
  for (const p of ['docs/kubeconfig.md', 'a/credentials', 'src/config.json', 'a/id_rsa.pub', 'terraform.tfstate.example']) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

test('N8 mightBePemBlockLine accepts every possible in-block line shape (including quoted/commented/assigned) and rejects plain code', () => {
  for (const l of [
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    '-----END PRIVATE KEY-----',
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    'abcd==',
    '  QUJD  ',
    'Proc-Type: 4,ENCRYPTED',
    'DEK-Info: AES-128-CBC,ABCDEF',
    'Version: GnuPG v1',
    '=ABCD',
    // NEW-1: wrapped / quoted / commented / concatenated PEM body lines
    '"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"',
    '  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",',
    "'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n' +",
    '  MIIEvQIBADANBgkqhkiG9w0BAQEFAASC,',
    '  # MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    '  // MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
    '  - "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"',
    '  shell = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBHljFAKEFAKE=="',
    '  pem += "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n";',
    '  "Proc-Type: 4,ENCRYPTED",',
    '  "abcd=="',
    '  "AAAA",',
  ]) {
    assert.equal(mightBePemBlockLine(l), true, JSON.stringify(l));
  }
  for (const l of [
    'const x = 1;',
    'function foo() {',
    'function findPrivateKeyLineIndices(lines) {',
    'import { findPrivateKeyLineIndices } from "../lib/security.mjs";',
    '# comment here',
    '### Fixed',
    '# Changelog',
    'const p = "/usr/local/bin/some-long-script";',
    'const sha = "a1b2c3d4e5f678901234567890abcdef";',
    'import os',
    'a b c',
  ]) {
    assert.equal(mightBePemBlockLine(l), false, JSON.stringify(l));
  }
});

test('NEW-1 unclosed wrapped PEM blocks are redacted in both JS and Python', () => {
  const unclosedQuoted = findPrivateKeyLineIndices([
    'const k = [',
    '  "-----BEGIN ' + 'RSA PRIVATE KEY-----",',
    '  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",',
    '  // normal trailing comment',
  ]);
  assert.deepEqual([...unclosedQuoted.indices].sort(), [1, 2]);

  const code = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})
import indexer
raw = 'const k = [\\n  "-----BEGIN ' 'RSA PRIVATE KEY-----",\\n  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",\\n  // trailing\\n'
out = indexer._mask_private_key_blocks(raw)
assert 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' not in out, out
assert '[SECRET_REDACTED:private_key]' in out, out
assert '// trailing' in out, out
print('OK')
`;
  const r = spawnSync(PY, ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /OK/);
});

test('OBS-1 leading-slash base64 secrets are redacted while real filesystem paths stay intact', () => {
  const mustRedact = [
    'AWS_SECRET_ACCESS_KEY=/7aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789+/',
    'WG_PRIVATE_KEY=/aBcDeFg1234567890+xyzABcDefGhIjKlMnOpQrStU=',
    'API_KEY=/9j4AAQSkZJRgABAQEASABIAAD',
    'SECRET_KEY=/aB3dEf9G/hIjK2lMnOpQrStUvWxYz01234567',
    'API_KEY="/7aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789=="',
    'TOKEN=/AbCdEfGhIjKlMnOp',
    'TOKEN=/abc1234567890123',
    'TOKEN=/abcdefghijklmnopq',
    'Authorization: Bearer /identity',
  ];
  for (const line of mustRedact) {
    const out = redactSecrets(line).text;
    assert.match(out, /SECRET_REDACTED:(?:kv_secret|auth_header)/, `should redact slash-prefixed secret: ${line} -> ${out}`);
  }
  const mustKeep = [
    'private_key=/etc/ssl/private/server.key',
    'private_key=/identity',
    'private_key=/tls.key',
    'private_key=/run/identity',
    'key_file=/secret.pem',
    'cert=/ca.crt',
    'secret_file=/my-secret',
    'token=/token.txt',
    'token=/run/secrets/db_password',
    'key_file=/opt/MyProject2026/secret.key',
    'token=./secrets/dev.token',
    'private_key=~/keys/id_rsa',
    'private_key=C:\\secrets\\server.key',
  ];
  for (const line of mustKeep) {
    assert.equal(redactSecrets(line).text, line, `should keep path: ${line}`);
  }
});

// ── N3：sync_mirror 的成功 / 忙 / 失败 / 超时输出契约 ─────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';

const POSIX = process.platform !== 'win32';

async function withFakeGts(body, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-n3-'));
  const bin = path.join(dir, 'gts');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const prev = { GTS_BIN: process.env.GTS_BIN, GITEA_SEARCH_CLI: process.env.GITEA_SEARCH_CLI, GITEA_MIRROR_ROOT: process.env.GITEA_MIRROR_ROOT, GITEA_OWNERS: process.env.GITEA_OWNERS };
  process.env.GTS_BIN = bin;
  process.env.GITEA_SEARCH_CLI = bin;
  process.env.GITEA_MIRROR_ROOT = path.join(dir, 'mirror');
  process.env.GITEA_OWNERS = 'own';
  fs.mkdirSync(path.join(dir, 'mirror', 'own'), { recursive: true });
  try {
    const server = await import(`../lib/server.mjs?n3=${Date.now()}${Math.random()}`);
    return await fn(server);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('N3 sync_mirror reports ok / busy / failed and invokes gts --sync-only', { skip: !POSIX }, async () => {
  await withFakeGts(`echo "$*" > "$0.argv"\necho '{"status":"ok","owners":["own"]}'`, async (server) => {
    const r = await server.syncMirror({});
    assert.equal(r.isError, undefined);
    assert.match(r.text, /镜像同步完成/);
    const argv = fs.readFileSync(`${process.env.GTS_BIN}.argv`, 'utf8');
    assert.match(argv, /--sync-only/);
    assert.match(argv, /--json/);
  });
  await withFakeGts(`echo '{"status":"busy","owners":["own"]}'`, async (server) => {
    const r = await server.syncMirror({});
    assert.equal(r.isError, undefined);
    assert.match(r.text, /SYNC_BUSY/);
  });
  await withFakeGts(`echo "SYNC_FAILED: boom" >&2\nexit 1`, async (server) => {
    const r = await server.syncMirror({});
    assert.equal(r.isError, true);
    assert.match(r.text, /SYNC_FAILED/);
    assert.match(r.text, /boom/);
  });
});

test('sync_mirror distinguishes complete enumeration from cache, stale cache and disk', { skip: !POSIX }, async () => {
  for (const [source, stale, degradation, coverage] of [
    ['api', false, false, /已取得完整仓单/],
    ['cache', false, true, /枚举范围为仓库缓存/],
    ['cache', true, true, /过期仓库缓存/],
    ['disk', false, true, /本地镜像目录/],
  ]) {
    const payload = { status: degradation ? 'degraded' : 'ok', degraded: degradation, enum_source: source, cache_stale: stale };
    await withFakeGts(`echo '${JSON.stringify(payload)}'`, async (server) => {
      const result = await server.syncMirror({});
      assert.equal(result.isError, undefined, result.text);
      assert.match(result.text, coverage);
      assert.ok(result.text.includes('enum_source=' + source), result.text);
      assert.equal(result.text.includes('SYNC_DEGRADED'), degradation, result.text);
      if (degradation) assert.match(result.text, /未取得完整仓单/);
    });
  }
});

test('search_code omits PEM candidates when the pinned commit is missing, invalid or unreadable', { skip: !POSIX }, async () => {
  for (const [commit, reason] of [[undefined, 'invalid_commit'], ['main', 'invalid_commit'], ['1'.repeat(40), 'size_failed']]) {
    const marker = 'MIIEFAKEUNVERIFIEDPLACEHOLDER01234567';
    const payload = {
      total: 1, repos_hit: 1, repos_scanned: 1,
      results: [{ repo: 'own/app', ref: 'main', path: 'readme.md', line: 2, text: marker, commit }],
    };
    await withFakeGts(`echo '${JSON.stringify(payload)}'`, async (server) => {
      if (reason === 'size_failed') {
        const bare = path.join(process.env.GITEA_MIRROR_ROOT, 'own', 'app.git');
        const init = spawnSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8' });
        assert.equal(init.status, 0, init.stderr);
      }
      const result = await server.searchCode({ query: marker });
      assert.equal(result.isError, undefined, result.text);
      assert.ok(result.text.includes('[CONTENT_OMITTED:unverified_secret_scan:' + reason + ']'), result.text);
      assert.ok(!result.text.includes(marker), result.text);
    });
  }
});

test('NEW-1 search_code redacts middle quoted/concatenated PEM body lines when BEGIN/END do not match the query', { skip: !POSIX }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-new1-'));
  const work = path.join(dir, 'work');
  const mirror = path.join(dir, 'mirror');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(mirror, 'own'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const git = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  const bodyQuoted = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwQUOTEDNEEDLE99==';
  const bodyConcat = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwCONCATNEEDLE88==';
  const beginLine = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const endLine = '-----END ' + 'RSA PRIVATE KEY-----';

  git(['init', '-q', '-b', 'main', work]);
  git(['config', 'user.name', 'Test'], work);
  git(['config', 'user.email', 'test@example.invalid'], work);
  fs.writeFileSync(path.join(work, 'embedded.js'), [
    'const keyArr = [',
    `  "${beginLine}",`,
    `  "${bodyQuoted}",`,
    `  "${endLine}",`,
    '].join("\\n");',
    `let pem = "${beginLine}\\n";`,
    `pem += "${bodyConcat}\\n";`,
    `pem += "${endLine}\\n";`,
  ].join('\n') + '\n');
  git(['add', '.'], work);
  git(['commit', '-qm', 'init'], work);
  git(['clone', '-q', '--bare', work, path.join(mirror, 'own', 'app.git')]);

  const prev = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GTS_BIN: process.env.GTS_BIN,
    GITEA_SEARCH_CLI: process.env.GITEA_SEARCH_CLI,
    GITEA_MIRROR_ROOT: process.env.GITEA_MIRROR_ROOT,
    GITEA_OWNERS: process.env.GITEA_OWNERS,
  };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.GTS_BIN = path.join(ROOT, 'bin', 'gts');
  process.env.GITEA_SEARCH_CLI = path.join(ROOT, 'bin', 'gts');
  process.env.GITEA_MIRROR_ROOT = mirror;
  process.env.GITEA_OWNERS = 'own';
  try {
    const server = await import(`../lib/server.mjs?new1=${Date.now()}${Math.random()}`);
    const r1 = await server.searchCode({ query: 'QUOTEDNEEDLE99' });
    assert.equal(r1.isError, undefined, r1.text);
    assert.match(r1.text, /SECRET_REDACTED:private_key/);
    assert.equal(r1.text.includes(bodyQuoted), false, `quoted PEM body leaked: ${r1.text}`);

    const r2 = await server.searchCode({ query: 'CONCATNEEDLE88' });
    assert.equal(r2.isError, undefined, r2.text);
    assert.match(r2.text, /SECRET_REDACTED:private_key/);
    assert.equal(r2.text.includes(bodyConcat), false, `concatenated PEM body leaked: ${r2.text}`);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

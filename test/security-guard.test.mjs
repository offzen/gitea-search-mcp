#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * test/security-guard.test.mjs
 * Verifies default-on output secret redaction, sensitive-path blocking, and
 * audit telemetry (hit_repos / redacted_hits / blocked_sensitive) in gitea-search-mcp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isSensitivePath, redactSecrets } from '../lib/security.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

// Build synthetic test tokens dynamically so static secret scanners don't flag test code.
const FAKE_SK = ['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('-');
const FAKE_GHP = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'].join('_');
const FAKE_AWS = ['AKIA', '1234567890ABCDEF'].join('');
const FAKE_PEM = [
  '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  '-----END ' + 'OPENSSH PRIVATE KEY-----',
].join('\n');

test('isSensitivePath blocks credential files and archives while allowing .example templates', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('deploy/.env.production'), true);
  assert.equal(isSensitivePath('certs/server.pem'), true);
  assert.equal(isSensitivePath('ssh/id_ed25519'), true);
  assert.equal(isSensitivePath('backup/pack-sync.tar'), true);
  assert.equal(isSensitivePath('secrets/infisical.token'), true);
  assert.equal(isSensitivePath('codex/auth.json'), true);

  assert.equal(isSensitivePath('.env.example'), false);
  assert.equal(isSensitivePath('deploy/.env.sample'), false);
  assert.equal(isSensitivePath('config/service.conf.example'), false);
  assert.equal(isSensitivePath('docs/README.md'), false);
});

test('redactSecrets masks high-confidence tokens while keeping placeholders intact', () => {
  const sample = [
    `OPENAI_KEY=${FAKE_SK}`,
    `GH=${FAKE_GHP}`,
    `AWS=${FAKE_AWS}`,
    `Authorization: Bearer supersecretbearertoken123456`,
    `DATABASE_URL=postgres://admin:S3cr3tP@ss99@db.internal:5432/app`,
    `API_KEY=<YOUR_API_KEY>`,
    `password=changeme`,
    `private_key=/etc/ssl/private/server.key`,
    FAKE_PEM,
  ].join('\n');

  const res = redactSecrets(sample, { enabled: true });
  assert.ok(res.count >= 6, `expected >=6 redactions, got ${res.count}`);
  assert.equal(res.text.includes(FAKE_SK), false);
  assert.equal(res.text.includes(FAKE_GHP), false);
  assert.equal(res.text.includes(FAKE_AWS), false);
  assert.equal(res.text.includes('supersecretbearertoken123456'), false);
  assert.equal(res.text.includes('b3BlbnNzaC1rZXktdjE'), false);
  // Placeholders & paths remain intact
  assert.match(res.text, /API_KEY=<YOUR_API_KEY>/);
  assert.match(res.text, /password=changeme/);
  assert.match(res.text, /private_key=\/etc\/ssl\/private\/server\.key/);
});

test('stdio MCP server redacts secrets in search_code/search_docs/read_file and blocks .env reads', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-sec-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const work = path.join(dir, 'work');
  const mirror = path.join(dir, 'mirror');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(mirror, 'acme'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const git = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['init', '-q', '-b', 'main', work]);
  git(['config', 'user.name', 'Sec Test'], work);
  git(['config', 'user.email', 'sec@example.invalid'], work);
  fs.writeFileSync(path.join(work, 'notes.md'), `# SecNeedleDoc\nHere is leaked token ${FAKE_SK} and ${FAKE_GHP}\n`);
  fs.writeFileSync(path.join(work, '.env'), `SEC_NEEDLE_ENV=${FAKE_SK}\n`);
  fs.writeFileSync(path.join(work, '.env.example'), `SEC_NEEDLE_TEMPLATE=<PUT_KEY_HERE>\n`);
  git(['add', '.'], work);
  git(['commit', '-qm', 'init'], work);
  git(['clone', '-q', '--bare', work, path.join(mirror, 'acme', 'sec-demo.git')]);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    GITEA_MIRROR_ROOT: mirror,
    GITEA_OWNERS: 'acme',
    GITEA_ALLOW_NO_JIEBA: '1', // hermetic: runners without jieba must not fail this test
  };
  for (const k of Object.keys(env)) {
    if (/^(GITQ_|GTS_|GITEA_SEARCH_CONFIG|GITEA_AUDIT_|GITEA_REDACT_|GITEA_BLOCK_)/.test(k)) delete env[k];
  }
  const auditPath = path.join(dir, 'sec-audit.jsonl');
  env.GITEA_AUDIT_LOG = auditPath;
  if (IS_WIN) {
    const wrapper = path.join(dir, 'gts-sec-test.cmd');
    fs.writeFileSync(wrapper, `@echo off\r\npython "${path.join(ROOT, 'bin', 'gts')}" %*\r\n`);
    env.GITEA_SEARCH_CLI = wrapper;
  } else {
    env.GITEA_SEARCH_CLI = path.join(ROOT, 'bin', 'gts');
  }

  // Build FTS index first (should skip .env automatically)
  const idx = spawnSync(IS_WIN ? 'python' : 'python3', [path.join(ROOT, 'lib', 'indexer.py'), '--mirror-root', mirror, '-o', 'acme', '--build'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(idx.status, 0, `indexer failed: ${idx.stderr}`);

  const client = new Client({ name: 'sec-e2e-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'bin', 'mcp-server')],
    env,
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    // 1. search_code on leaked token doc -> redacted, never raw token
    const rCode = await client.callTool({ name: 'search_code', arguments: { query: 'SecNeedleDoc' } });
    assert.equal(rCode.isError, undefined);
    const rCode2 = await client.callTool({ name: 'search_code', arguments: { query: 'leaked token' } });
    assert.equal(rCode2.content[0].text.includes(FAKE_SK), false);
    assert.equal(rCode2.content[0].text.includes(FAKE_GHP), false);
    assert.match(rCode2.content[0].text, /SECRET_REDACTED:sk_api_key/);

    // 2. search_code matching .env -> blocked
    const rEnvSearch = await client.callTool({ name: 'search_code', arguments: { query: 'SEC_NEEDLE_ENV' } });
    assert.equal(rEnvSearch.content[0].text.includes(FAKE_SK), false);
    assert.match(rEnvSearch.content[0].text, /安全护栏：已屏蔽/);

    // 3. read_file on .env -> blocked; .env.example -> allowed
    const rEnvRead = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/sec-demo', path: '.env' } });
    assert.equal(rEnvRead.isError, true);
    assert.equal(rEnvRead.content[0].text.includes(FAKE_SK), false);

    const rTplRead = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/sec-demo', path: '.env.example' } });
    assert.equal(rTplRead.isError, undefined);
    assert.match(rTplRead.content[0].text, /SEC_NEEDLE_TEMPLATE/);

    // 4. read_file on notes.md -> redacted
    const rNotes = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/sec-demo', path: 'notes.md' } });
    assert.equal(rNotes.isError, undefined);
    assert.equal(rNotes.content[0].text.includes(FAKE_SK), false);
    assert.match(rNotes.content[0].text, /SECRET_REDACTED:sk_api_key/);

    // 5. search_docs on SecNeedleDoc -> redacted
    const rDocs = await client.callTool({ name: 'search_docs', arguments: { query: 'SecNeedleDoc' } });
    assert.equal(rDocs.isError, undefined);
    assert.equal(rDocs.content[0].text.includes(FAKE_SK), false);
  } finally {
    await client.close();
  }

  const audits = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const codeAudit = audits.find((x) => x.tool === 'search_code' && x.redacted_hits > 0);
  assert.ok(codeAudit, 'audit should record redacted_hits on search_code');
  assert.deepEqual(codeAudit.hit_repos, ['acme/sec-demo']);
  const envBlockAudit = audits.find((x) => x.tool === 'read_file' && x.blocked_sensitive === 1);
  assert.ok(envBlockAudit, 'audit should record blocked_sensitive on read_file');
});

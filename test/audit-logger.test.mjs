#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * test/audit-logger.test.mjs
 * Verifies opt-in JSONL audit telemetry in lib/audit.mjs and lib/server.mjs:
 *   - Disabled by default (zero file writes)
 *   - Explicit path & XDG/LocalAppData auto monthly file routing
 *   - Privacy-first query redaction by default, opt-in raw query logging
 *   - End-to-end stdio MCP calls record clientInfo, hits, truncated, elapsed_ms, alias flag
 *   - Wire CallToolResult never leaks internal `_audit` metadata
 *   - Unwritable audit log path fails safely without breaking tool calls
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
import { createAuditLogger, resolveAuditLogPath } from '../lib/audit.mjs';
import { createServer } from '../lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

function makeFixture(dir) {
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
  git(['config', 'user.name', 'Audit Test'], work);
  git(['config', 'user.email', 'audit@example.invalid'], work);
  fs.writeFileSync(path.join(work, 'README.md'), 'AuditSmokeNeedle line one\nline two\n');
  git(['add', 'README.md'], work);
  git(['commit', '-qm', 'init'], work);
  git(['clone', '-q', '--bare', work, path.join(mirror, 'acme', 'demo.git')]);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    GITEA_MIRROR_ROOT: mirror,
    GITEA_OWNERS: 'acme',
  };
  for (const k of Object.keys(env)) {
    if (/^(GITQ_|GTS_|GITEA_SEARCH_CONFIG|GITEA_AUDIT_)/.test(k)) delete env[k];
  }
  if (IS_WIN) {
    const wrapper = path.join(dir, 'gts-audit-test.cmd');
    fs.writeFileSync(wrapper, `@echo off\r\npython "${path.join(ROOT, 'bin', 'gts')}" %*\r\n`);
    env.GITEA_SEARCH_CLI = wrapper;
  } else {
    env.GITEA_SEARCH_CLI = path.join(ROOT, 'bin', 'gts');
  }
  return { home, mirror, env };
}

test('resolveAuditLogPath is disabled by default and routes auto/explicit paths across platforms', () => {
  const now = new Date('2026-11-24T06:00:00Z');
  assert.equal(resolveAuditLogPath({ env: {}, now }), null);
  assert.equal(resolveAuditLogPath({ env: { GITEA_AUDIT_LOG: '0' }, now }), null);
  assert.equal(resolveAuditLogPath({ env: { GITEA_AUDIT_LOG: 'false' }, now }), null);

  const linuxAuto = resolveAuditLogPath({
    env: { GITEA_AUDIT_LOG: '1', XDG_STATE_HOME: '/tmp/xdg-state' },
    platform: 'linux',
    homeDir: '/tmp/home',
    now,
  });
  assert.equal(linuxAuto, path.join('/tmp/xdg-state', 'gitea-search-mcp', 'audit-2026-11.jsonl'));

  const winAuto = resolveAuditLogPath({
    env: { GITEA_AUDIT_LOG: 'auto', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    platform: 'win32',
    homeDir: 'C:\\Users\\dev',
    now,
  });
  assert.match(winAuto, /gitea-search-mcp[\\/]audit-2026-11\.jsonl$/);

  const explicit = resolveAuditLogPath({
    env: { GITEA_AUDIT_LOG: '~/custom-audit.jsonl' },
    platform: 'linux',
    homeDir: '/tmp/home',
    now,
  });
  assert.equal(explicit, path.resolve('/tmp/home/custom-audit.jsonl'));
});

test('createAuditLogger redacts query by default and includes raw query only when opted in', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const redactedFile = path.join(dir, 'redacted.jsonl');
  const loggerA = createAuditLogger({
    env: { GITEA_AUDIT_LOG: redactedFile, GITEA_AUDIT_CLIENT: 'unit-host' },
  });
  loggerA.record({
    tool: 'search_code',
    rawTool: 'search_gitea',
    deprecatedAlias: true,
    args: { query: 'SuperSecretNeedle', repo: 'acme/demo', files_only: true },
    elapsedMs: 123.6,
    hits: 2,
    respBytes: 512,
    truncated: false,
    isError: false,
  });
  const recA = JSON.parse(fs.readFileSync(redactedFile, 'utf8').trim());
  assert.equal(recA.schema, 1);
  assert.equal(recA.client, 'unit-host');
  assert.equal(recA.tool, 'search_code');
  assert.equal(recA.raw_tool, 'search_gitea');
  assert.equal(recA.deprecated_alias, true);
  assert.equal(recA.elapsed_ms, 124);
  assert.equal(recA.hits, 2);
  assert.equal(recA.args_meta.query, undefined);
  assert.equal(recA.args_meta.query_len, 'SuperSecretNeedle'.length);
  assert.match(recA.args_meta.query_sha8, /^[0-9a-f]{8}$/);
  assert.equal(recA.args_meta.files_only, true);

  const rawFile = path.join(dir, 'raw.jsonl');
  const loggerB = createAuditLogger({
    env: { GITEA_AUDIT_LOG: rawFile, GITEA_AUDIT_INCLUDE_QUERY: '1' },
  });
  loggerB.record({
    tool: 'search_docs',
    rawTool: 'search_docs',
    args: { query: 'Caddy 429', kind: 'session' },
    elapsedMs: 42,
    internalMs: 2.345,
    hits: 1,
    respBytes: 256,
  });
  const recB = JSON.parse(fs.readFileSync(rawFile, 'utf8').trim());
  assert.equal(recB.args_meta.query, 'Caddy 429');
  assert.equal(recB.args_meta.kind, 'session');
  assert.equal(recB.internal_ms, 2.35);
});

test('unwritable audit log path fails safely and logs at most once without breaking createServer()', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Create a directory at the target file path so appendFileSync throws EISDIR
  const badPath = path.join(dir, 'already-a-dir');
  fs.mkdirSync(badPath);
  const errors = [];
  const auditLogger = createAuditLogger({
    env: { GITEA_AUDIT_LOG: badPath },
    logError: (msg) => errors.push(msg),
  });

  const server = createServer({ auditLogger });
  const callHandler = server._requestHandlers.get('tools/call');
  const r1 = await callHandler({ method: 'tools/call', params: { name: 'unknown_tool', arguments: {} } });
  const r2 = await callHandler({ method: 'tools/call', params: { name: 'unknown_tool', arguments: {} } });

  assert.equal(r1.isError, true);
  assert.equal(r2.isError, true);
  assert.equal('_audit' in r1, false, 'MCP wire result must never expose internal _audit');
  assert.equal(errors.length, 1, 'Write error should be logged at most once');
});

test('stdio MCP server writes accurate JSONL audit entries when GITEA_AUDIT_LOG is set', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { env } = makeFixture(dir);
  const auditPath = path.join(dir, 'mcp-audit.jsonl');
  env.GITEA_AUDIT_LOG = auditPath;

  const client = new Client({ name: 'audit-e2e-client', version: '1.2.3' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'bin', 'mcp-server')],
    env,
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const res1 = await client.callTool({ name: 'list_repositories', arguments: {} });
    assert.equal(res1.isError, undefined);
    assert.equal('_audit' in res1, false);

    const res2 = await client.callTool({ name: 'search_code', arguments: { query: 'AuditSmokeNeedle' } });
    assert.equal(res2.isError, undefined);
    assert.match(res2.content[0].text, /AuditSmokeNeedle/);

    const res3 = await client.callTool({ name: 'read_gitea_file', arguments: { repo: 'acme/demo', path: 'README.md' } });
    assert.equal(res3.isError, undefined);
    assert.match(res3.content[0].text, /AuditSmokeNeedle/);

    const res4 = await client.callTool({ name: 'search_code', arguments: { query: 'DefinitelyNoMatchXYZ999' } });
    assert.equal(res4.isError, undefined);
  } finally {
    await client.close();
  }

  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.equal(lines[0].client, 'audit-e2e-client');
  assert.equal(lines[0].client_version, '1.2.3');
  assert.equal(lines[0].tool, 'list_repositories');
  assert.equal(lines[0].hits, 1);

  assert.equal(lines[1].tool, 'search_code');
  assert.equal(lines[1].hits, 1);
  assert.equal(lines[1].args_meta.query, undefined);

  assert.equal(lines[2].tool, 'read_file');
  assert.equal(lines[2].raw_tool, 'read_gitea_file');
  assert.equal(lines[2].deprecated_alias, true);
  assert.equal(lines[2].hits, 1);

  assert.equal(lines[3].tool, 'search_code');
  assert.equal(lines[3].hits, 0);
  // Same process session ID across all 4 calls in one stdio connection
  assert.equal(new Set(lines.map((l) => l.proc_session_id)).size, 1);
});

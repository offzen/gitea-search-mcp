#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * test/audit-203-misc.test.mjs
 * Regressions for audit findings:
 *   #14 Codex CLI TOML / `codex mcp add` docs contract (+ live isolated codex CLI check if installed)
 *   #17 gts-audit --since filters per-call across T3, DSH, Codex and reconciles with server JSONL
 *   #18 Release workflow enforces exact-SHA 3-platform CI gate (static + behavioural via stub gh)
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
import { runAudit } from '../scripts/audit-usage.mjs';
import { createAuditLogger } from '../lib/audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = process.platform !== 'win32';

test('Audit #14: README and GETTING-STARTED document Codex CLI TOML and codex mcp add (verified against isolated codex CLI + MCP round-trip when available)', async (t) => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const gs = fs.readFileSync(path.join(ROOT, 'docs', 'GETTING-STARTED.md'), 'utf8');
  for (const [label, doc] of [['README.md', readme], ['docs/GETTING-STARTED.md', gs]]) {
    assert.match(doc, /\[mcp_servers\.gitea-search\]/, label);
    assert.match(doc, /\[mcp_servers\.gitea-search\.env\]/, label);
    assert.match(doc, /codex mcp add gitea-search/, label);
  }

  const codexBin = POSIX
    ? spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim()
    : '';
  if (codexBin) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-codex-doc-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const mirror = path.join(dir, 'mirror');
    const work = path.join(dir, 'work');
    const bare = path.join(mirror, 'acme-team', 'codex-demo.git');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    const gitEnv = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', work], { env: gitEnv }).status, 0);
    assert.equal(spawnSync('git', ['-C', work, 'config', 'user.name', 'Codex Test'], { env: gitEnv }).status, 0);
    assert.equal(spawnSync('git', ['-C', work, 'config', 'user.email', 'codex@example.invalid'], { env: gitEnv }).status, 0);
    fs.writeFileSync(path.join(work, 'HELLO.md'), '# Codex MCP Roundtrip\nCodexHostReadSentinel1414\n');
    assert.equal(spawnSync('git', ['-C', work, 'add', '.'], { env: gitEnv }).status, 0);
    assert.equal(spawnSync('git', ['-C', work, 'commit', '-q', '-m', 'seed'], { env: gitEnv }).status, 0);
    assert.equal(spawnSync('git', ['clone', '-q', '--bare', work, bare], { env: gitEnv }).status, 0);

    const env = { ...process.env, CODEX_HOME: dir, HOME: dir };
    const add = spawnSync(codexBin, [
      'mcp', 'add', 'gitea-search',
      '--env', `GITEA_MIRROR_ROOT=${mirror}`,
      '--env', 'GITEA_OWNERS=acme-team',
      '--', process.execPath, path.join(ROOT, 'bin', 'mcp-server'),
    ], { env, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stdout + add.stderr);
    const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    assert.match(toml, /\[mcp_servers\.gitea-search\]/);
    assert.match(toml, /\[mcp_servers\.gitea-search\.env\]/);
    const list = spawnSync(codexBin, ['mcp', 'list'], { env, encoding: 'utf8' });
    assert.equal(list.status, 0, list.stdout + list.stderr);
    assert.match(list.stdout, /gitea-search/);

    // Read back the parsed config from `codex mcp get --json` and launch the exact configured command/args/env
    const getRes = spawnSync(codexBin, ['mcp', 'get', '--json', 'gitea-search'], { env, encoding: 'utf8' });
    assert.equal(getRes.status, 0, getRes.stdout + getRes.stderr);
    const parsed = JSON.parse(getRes.stdout);
    const tr = parsed.transport || parsed;
    assert.equal(tr.command, process.execPath);
    assert.deepEqual(tr.args, [path.join(ROOT, 'bin', 'mcp-server')]);
    const launchEnv = { ...process.env, HOME: dir, ...(tr.env || {}), GITEA_ALLOW_NO_JIEBA: '1' };
    const client = new Client({ name: 'codex-doc-verify', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: tr.command, args: tr.args, env: launchEnv, stderr: 'pipe' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((x) => x.name).sort(), ['list_repositories', 'read_file', 'search_code', 'search_docs', 'sync_mirror']);
      const read = await client.callTool({ name: 'read_file', arguments: { repo: 'acme-team/codex-demo', path: 'HELLO.md' } });
      assert.equal(read.isError, undefined, read.content[0].text);
      assert.match(read.content[0].text, /CodexHostReadSentinel1414/);
    } finally {
      await client.close();
    }
  }
});

test('Audit #17: --since filters calls per call-start timestamp across T3, DSH, Codex and reconciles with audit_log', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-17-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cutoffIso = '2026-11-25T00:00:00Z';
  const beforeIso = '2026-11-24T23:55:00Z';
  const straddleStartIso = '2026-11-24T23:59:59Z';
  const straddleEndIso = '2026-11-25T00:00:02Z';
  const afterIso = '2026-11-25T00:05:00Z';
  const afterEndIso = '2026-11-25T00:05:01Z';

  // 1) Server JSONL audit log: 1 before, 1 missing ts, 1 straddling midnight (explicit started_ts via createAuditLogger),
  //    plus a legacy straddling log (without started_ts, derived from ts - elapsed_ms), and 1 in-window
  const auditDir = path.join(dir, 'audit');
  fs.mkdirSync(auditDir);
  const auditFile = path.join(auditDir, 'audit-2026-11.jsonl');
  fs.writeFileSync(auditFile, [
    JSON.stringify({ schema: 1, ts: beforeIso, proc_session_id: 's1', client: 'codex', tool: 'search_code', raw_tool: 'search_code', elapsed_ms: 100, hits: 1, is_error: true }),
    JSON.stringify({ schema: 1, proc_session_id: 's1', client: 'codex', tool: 'search_code', raw_tool: 'search_code', elapsed_ms: 100, hits: 1, is_error: false }),
    // Legacy straddling record (no started_ts): started 23:59:59Z, finished 00:00:02Z (elapsed 3000ms) -> must be excluded
    JSON.stringify({ schema: 1, ts: straddleEndIso, proc_session_id: 's1', client: 'codex', tool: 'search_code', raw_tool: 'search_code', elapsed_ms: 3000, hits: 1, is_error: true }),
  ].join('\n') + '\n');
  // Emit a real v2.0.3 server audit record for the straddling call (started_ts=23:59:59Z, ts=00:00:02Z)
  // and for the in-window call (started_ts=00:05:00Z, ts=00:05:01Z)
  const logger = createAuditLogger({ env: { GITEA_AUDIT_LOG: auditFile, GITEA_AUDIT_SESSION_ID: 's1', GITEA_AUDIT_CLIENT: 'codex' } });
  const recStraddle = logger.record({
    startedAt: new Date(straddleStartIso),
    now: new Date(straddleEndIso),
    tool: 'search_code',
    rawTool: 'search_code',
    elapsedMs: 3000,
    hits: 1,
    isError: true,
  });
  assert.equal(recStraddle.ts, '2026-11-25T00:00:02.000Z');
  assert.equal(recStraddle.started_ts, '2026-11-24T23:59:59.000Z');
  logger.record({
    startedAt: new Date(afterIso),
    now: new Date(afterEndIso),
    tool: 'search_docs',
    rawTool: 'search_docs',
    elapsedMs: 1000,
    hits: 2,
    isError: false,
  });

  // 2) T3 transcript spanning midnight (1 before, 1 missing created_at, 1 after)
  const t3Dir = path.join(dir, 't3');
  const t3Log = path.join(t3Dir, 'antigravity', 'brain', 't3-mid', '.system_generated', 'logs');
  fs.mkdirSync(t3Log, { recursive: true });
  fs.writeFileSync(path.join(t3Log, 'transcript.jsonl'), [
    JSON.stringify({ type: 'USER_INPUT', created_at: beforeIso }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE', created_at: beforeIso,
      tool_calls: [{ name: 'call_mcp_tool', args: { ServerName: 'gitea-search', ToolName: 'search_code', Arguments: { query: 'old' } } }],
    }),
    JSON.stringify({ type: 'GENERIC', created_at: beforeIso, content: '返回 0 条 / 全库命中 0 条', status: 'ERROR' }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'call_mcp_tool', args: { ServerName: 'gitea-search', ToolName: 'search_code', Arguments: { query: 'no-ts' } } }],
    }),
    JSON.stringify({ type: 'USER_INPUT', created_at: afterIso }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE', created_at: afterIso,
      tool_calls: [{ name: 'call_mcp_tool', args: { ServerName: 'gitea-search', ToolName: 'search_docs', Arguments: { query: 'new' } } }],
    }),
    JSON.stringify({ type: 'GENERIC', created_at: afterEndIso, content: '【文档/会话全文检索】命中 2 篇相关文档（耗时 2.5ms [OK]）' }),
  ].join('\n') + '\n');

  // 3) DSH v4 session spanning midnight (1 before, 1 straddling start<cutoff<end, 1 after)
  const dshHome = path.join(dir, 'dsh');
  const dshSess = path.join(dshHome, 'sessions', 'ws', 'dsh-mid');
  fs.mkdirSync(dshSess, { recursive: true });
  fs.writeFileSync(path.join(dshSess, 'session.v4.jsonl'), [
    JSON.stringify({ type: 'session', id: 'dsh-mid', createdAt: Date.parse(beforeIso) }),
    JSON.stringify({ type: 'turn/start', time: Date.parse(beforeIso), data: { turn: 1 } }),
    JSON.stringify({ type: 'tool/call', time: Date.parse(beforeIso), data: { callId: 'b1', name: 'mcp__gitea-search__search_code', arguments: '{"query":"old"}' } }),
    JSON.stringify({ type: 'tool/result', time: Date.parse(beforeIso) + 200, data: { message: { toolCallId: 'b1', isError: true, content: [{ type: 'text', text: 'error' }] } } }),
    JSON.stringify({ type: 'tool/call', time: Date.parse(straddleStartIso), data: { callId: 'st1', name: 'mcp__gitea-search__search_code', arguments: '{"query":"straddle"}' } }),
    JSON.stringify({ type: 'tool/result', time: Date.parse(straddleEndIso), data: { message: { toolCallId: 'st1', content: [{ type: 'text', text: '返回 1 条 / 全库命中 1 条' }] } } }),
    JSON.stringify({ type: 'tool/call', time: Date.parse(afterIso), data: { callId: 'a1', name: 'mcp__gitea-search__search_docs', arguments: '{"query":"new"}' } }),
    JSON.stringify({ type: 'tool/result', time: Date.parse(afterEndIso), data: { message: { toolCallId: 'a1', content: [{ type: 'text', text: '命中 2 篇相关文档' }] } } }),
  ].join('\n') + '\n');

  // 4) Codex rollout spanning midnight (1 before, 1 straddling, 1 after)
  const codexHome = path.join(dir, 'codex');
  const codexSess = path.join(codexHome, 'sessions', '2026', '11', '25');
  fs.mkdirSync(codexSess, { recursive: true });
  fs.writeFileSync(path.join(codexSess, 'rollout-2026-11-25-mid.jsonl'), [
    JSON.stringify({ type: 'session_meta', timestamp: beforeIso, payload: { id: 'cx-mid' } }),
    JSON.stringify({ type: 'event_msg', timestamp: beforeIso, payload: { type: 'user_message', text: 'old' } }),
    JSON.stringify({ type: 'response_item', timestamp: beforeIso, payload: { type: 'function_call', call_id: 'cb1', name: 'mcp__gitea-search__search_code', arguments: '{"query":"old"}' } }),
    JSON.stringify({ type: 'response_item', timestamp: beforeIso, payload: { type: 'function_call_output', call_id: 'cb1', output: 'CONFIG_ERROR' } }),
    JSON.stringify({ type: 'response_item', timestamp: straddleStartIso, payload: { type: 'function_call', call_id: 'cs1', name: 'mcp__gitea-search__search_code', arguments: '{"query":"straddle"}' } }),
    JSON.stringify({ type: 'response_item', timestamp: straddleEndIso, payload: { type: 'function_call_output', call_id: 'cs1', output: '返回 1 条 / 全库命中 1 条' } }),
    JSON.stringify({ type: 'response_item', timestamp: afterIso, payload: { type: 'function_call', call_id: 'ca1', name: 'mcp__gitea-search__search_docs', arguments: '{"query":"new"}' } }),
    JSON.stringify({ type: 'response_item', timestamp: afterEndIso, payload: { type: 'function_call_output', call_id: 'ca1', output: '命中 2 篇相关文档' } }),
  ].join('\n') + '\n');

  const rep = runAudit({
    noAuto: true,
    since: cutoffIso,
    auditLogs: [auditDir],
    t3Dirs: [t3Dir],
    dshHomes: [dshHome],
    codexHomes: [codexHome],
  });

  // All 4 sources must count ONLY the 1 in-window search_docs call with 0 errors!
  for (const key of ['audit_log', 't3', 'dsh', 'codex']) {
    assert.equal(rep.sources[key].calls_total, 1, `${key} calls_total mismatch`);
    assert.deepEqual(rep.sources[key].by_tool, { search_docs: 1 }, `${key} by_tool mismatch`);
    assert.equal(rep.sources[key].quality.error_calls, 0, `${key} pre-window error must not leak`);
  }

  // Without --since, all calls (including pre-window and missing-ts) are counted
  const full = runAudit({
    noAuto: true,
    auditLogs: [auditDir],
    t3Dirs: [t3Dir],
    dshHomes: [dshHome],
    codexHomes: [codexHome],
  });
  assert.equal(full.sources.audit_log.calls_total, 5);
  assert.equal(full.sources.t3.calls_total, 3);
  assert.equal(full.sources.dsh.calls_total, 3);
  assert.equal(full.sources.codex.calls_total, 3);
});

test('Audit #18: release.yml enforces exact-SHA 3-platform gate via workflow_call and preserves Ruleset check names', () => {
  const readLf = (file) => fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8').replace(/\r\n/g, '\n');
  const ci = readLf('ci.yml');
  const winCi = readLf('windows-ci.yml');
  const release = readLf('release.yml');

  // ci.yml and windows-ci.yml are reusable workflows and do not duplicate-trigger on v* tag pushes.
  assert.match(ci, /^\s{2}workflow_call:/m);
  assert.match(winCi, /^\s{2}workflow_call:/m);
  assert.doesNotMatch(ci, /^\s{4}tags:/m, 'ci.yml should be invoked via workflow_call from release.yml on tags');
  assert.doesNotMatch(winCi, /^\s{4}tags:/m, 'windows-ci.yml should be invoked via workflow_call from release.yml on tags');

  // release.yml fails fast on metadata/hygiene, fans out to both platform workflows on the exact tag SHA,
  // and only builds/attests/uploads after both succeed.
  assert.match(release, /^\s{2}preflight:/m);
  assert.match(release, /^\s{2}ci:\n[\s\S]*?needs:\s*\[preflight\][\s\S]*?uses:\s*\.\/\.github\/workflows\/ci\.yml/m);
  assert.match(release, /^\s{2}windows-ci:\n[\s\S]*?needs:\s*\[preflight\][\s\S]*?uses:\s*\.\/\.github\/workflows\/windows-ci\.yml/m);
  assert.match(release, /^\s{2}release:\n[\s\S]*?needs:\s*\[preflight, ci, windows-ci\]/m);
  assert.ok(release.indexOf('preflight:') < release.indexOf('release:'));

  // Preserve the exact job names pinned by GitHub Ruleset main-required-status-checks.
  assert.match(ci, /name: Unit \+ E2E \+ Floors \(Ubuntu, py\$\{\{ matrix\.python \}\}, node\$\{\{ matrix\.node \}\}\)/);
  assert.match(ci, /python: '3\.12'\n\s+node: '22'/);
  assert.match(ci, /name: Packaging \(wheel \+ sdist \+ npm pack\) & Hygiene/);
  assert.match(ci, /name: Unit \+ E2E \+ Floors \(macOS, py3\.12, node22\)/);
  assert.match(winCi, /name: W5 gts\.exe 是真实 PE 文件/);
  assert.match(winCi, /name: W10 Git Bash full E2E/);
});

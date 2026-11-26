#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * test/audit-usage.test.mjs
 * Verifies scripts/audit-usage.mjs across all 4 data sources (Layer-1 audit JSONL,
 * T3/Antigravity transcripts, DSH v4 .jsonl/.zstd sessions, Codex rollout JSONL),
 * phase analysis, Search Episode deduplication, penalty deduction, and CLI formats.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  compressZstd as libCompressZstd,
  decompressZstd as libDecompressZstd,
  isMultiFrameZstd,
  splitZstdFrames,
} from '../lib/zstd.mjs';
import {
  analyzeSessions,
  clusterEpisodes,
  estimateSavings,
  formatMarkdownReport,
  normalizeToolName,
  parseAuditLogs,
  parseCodexSession,
  parseDshSession,
  parseT3Transcript,
  runAudit,
} from '../scripts/audit-usage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT_CLI = path.join(ROOT, 'scripts', 'audit-usage.mjs');

function hasZstdSupport() {
  if (typeof zlib.zstdCompressSync === 'function') return true;
  const r = spawnSync('zstd', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

const HAS_ZSTD = hasZstdSupport();

function compressZstd(buf) {
  return libCompressZstd(buf);
}

test('normalizeToolName maps v2 bare names, v1/legacy aliases, and host prefixes consistently', () => {
  assert.equal(normalizeToolName('search_code', 'gitea-search'), 'search_code');
  assert.equal(normalizeToolName('mcp__gitea-search__search_docs'), 'search_docs');
  assert.equal(normalizeToolName('mcp__gitea_search__read_file'), 'read_file');
  assert.equal(normalizeToolName('mcp__gitorca_search__read_gitorca_file'), 'read_file');
  assert.equal(normalizeToolName('mcp__gitorca_search__search_gitorca'), 'search_code');
  assert.equal(normalizeToolName('mcp__gitorca_search__search_gitorca_hybrid'), 'search_hybrid');
  assert.equal(normalizeToolName('mcp__gitorca_search__search_workspace_code'), 'search_workspace_code');
  assert.equal(normalizeToolName('list_gitea_repos'), 'list_repositories');
  assert.equal(normalizeToolName('sync_mirror'), 'sync_mirror');
  assert.equal(normalizeToolName('mcp__gitea_search__sync_mirror'), 'sync_mirror');
  assert.equal(normalizeToolName('read_file', ''), null, 'bare read_file without gitea-search server hint must not be misclassified');
  assert.equal(normalizeToolName('read_file', 'gitea-search'), 'read_file');
  assert.equal(normalizeToolName('run_command', ''), null);
});

test('discoverDefaultSources finds /data/dsh-*/state/.dsh and separates idle lazy_schema_only_sessions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-autodiscover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Simulate /data/dsh-node1/state/.dsh
  const dataRoot = path.join(dir, 'data');
  const dshSess = path.join(dataRoot, 'dsh-node1', 'state', '.dsh', 'sessions', 'ws1', 's1');
  fs.mkdirSync(dshSess, { recursive: true });
  fs.writeFileSync(path.join(dshSess, 'session.v4.jsonl'), [
    JSON.stringify({ type: 'session', id: 's1', createdAt: 1795400000000 }),
    JSON.stringify({ type: 'turn/start', time: 1795400000100, data: { turn: 1 } }),
    JSON.stringify({ type: 'tool/call', time: 1795400001000, data: { callId: 'w1', name: 'mcp__gitorca_search__search_workspace_code', arguments: '{"query":"auth"}' } }),
    JSON.stringify({ type: 'tool/result', time: 1795400001200, data: { message: { toolCallId: 'w1', content: [{ type: 'text', text: '命中 2 个文件' }] } } }),
  ].join('\n') + '\n');

  // Simulate T3 with 1 active session + 1 idle lazy-schema-only session
  const t3Providers = path.join(dir, '.t3', 'userdata', 'providers');
  const sActive = path.join(t3Providers, 'agy', 'brain', 't3-active', '.system_generated', 'logs');
  const sIdle = path.join(t3Providers, 'agy', 'brain', 't3-idle', '.system_generated', 'logs');
  fs.mkdirSync(sActive, { recursive: true });
  fs.mkdirSync(sIdle, { recursive: true });
  fs.writeFileSync(path.join(sActive, 'transcript.jsonl'), [
    JSON.stringify({ type: 'USER_INPUT', created_at: '2026-11-24T01:00:00Z' }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T01:00:05Z',
      tool_calls: [
        { name: 'read_file', args: { Path: '/x/mcp/gitea-search/search_docs.json' } },
        { name: 'call_mcp_tool', args: { ServerName: 'gitea-search', ToolName: 'search_docs', Arguments: { query: 'hello' } } },
      ],
    }),
    JSON.stringify({ type: 'GENERIC', created_at: '2026-11-24T01:00:06Z', content: '命中 1 篇' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(sIdle, 'transcript.jsonl'), [
    JSON.stringify({ type: 'USER_INPUT', created_at: '2026-11-24T02:00:00Z' }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T02:00:05Z',
      tool_calls: [
        { name: 'read_file', args: { Path: '/x/skills/gitea-search/SKILL.md' } },
      ],
    }),
  ].join('\n') + '\n');

  const cli = spawnSync(
    process.execPath,
    [AUDIT_CLI, '--json'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        USERPROFILE: dir,
        DSH_HOME: '',
        T3_DATA_DIR: '',
        CODEX_HOME: '',
        GITEA_AUDIT_LOG: '0',
        GITEA_AUDIT_DATA_ROOT: dataRoot,
      },
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.sources.dsh.calls_total, 1);
  assert.equal(parsed.sources.dsh.by_tool.search_workspace_code, 1);
  assert.equal(parsed.sources.dsh.savings.episodes_by_kind.E2_code_search, 1);
  assert.equal(parsed.sources.t3.sessions_active, 1);
  assert.equal(parsed.sources.t3.lazy_schema_sessions, 1);
  assert.equal(parsed.sources.t3.lazy_schema_only_sessions, 1);
});

test('clusterEpisodes deduplicates consecutive read_file calls on the same repo into one E3 episode', () => {
  const calls = [
    { tool: 'read_file', turn: 1, toolIndexInSession: 1, repo: 'acme/app', elapsedMs: 300, isZeroHit: false, isError: false, sync: false },
    { tool: 'read_file', turn: 1, toolIndexInSession: 2, repo: 'acme/app', elapsedMs: 280, isZeroHit: false, isError: false, sync: false },
    { tool: 'read_file', turn: 1, toolIndexInSession: 3, repo: 'acme/app', elapsedMs: 310, isZeroHit: false, isError: false, sync: false },
    { tool: 'read_file', turn: 1, toolIndexInSession: 4, repo: 'acme/app', elapsedMs: 290, isZeroHit: false, isError: false, sync: false },
    { tool: 'read_file', turn: 1, toolIndexInSession: 5, repo: 'acme/app', elapsedMs: 300, isZeroHit: false, isError: false, sync: false },
  ];
  const eps = clusterEpisodes(calls, 3);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].kind, 'E3_direct_read');
  assert.equal(eps[0].distinctRepos, 1);
  assert.equal(eps[0].callCount, 5);

  const savings = estimateSavings([{ lazySchemaReads: 0, stepIntervalsSec: [], calls }], { llmStepSec: 12 });
  assert.equal(savings.total_episodes, 1);
  // Conservative E3 (1 distinct repo): gross = 3s + 0.5*12s = 9s, minus ~1.48s mcp exec = ~7.5s (not 5x!)
  assert.ok(savings.tiers.conservative.net_saved_sec < 10, `Expected deduplicated savings <10s, got ${savings.tiers.conservative.net_saved_sec}`);
});

test('estimateSavings deducts zero-hit retries, lazy schema reads, and sync blocking penalties', () => {
  const sess = {
    lazySchemaReads: 2,
    stepIntervalsSec: [10, 12, 14],
    calls: [
      { tool: 'search_docs', turn: 1, toolIndexInSession: 2, repo: '', elapsedMs: 900, isZeroHit: true, isError: false, sync: false },
      { tool: 'search_docs', turn: 1, toolIndexInSession: 3, repo: '', elapsedMs: 800, isZeroHit: false, isError: false, sync: true },
    ],
  };
  const sv = estimateSavings([sess], { llmStepSec: 10 });
  assert.equal(sv.total_episodes, 1);
  assert.equal(sv.episodes_by_kind.E1_docs_session, 1);
  const b = sv.tiers.baseline.penalty_breakdown_sec;
  assert.equal(b.zero_hit_retries, 5);   // 1 zero-hit * 0.5 * 10s
  assert.equal(b.lazy_schema_reads, 10); // 1 session * 10s
  assert.equal(b.sync_blocking, 15);     // 1 sync call * 15s
  assert.ok(sv.tiers.baseline.net_saved_sec < sv.tiers.baseline.gross_saved_sec);
});

test('runAudit parses all 4 sources (audit JSONL, T3, DSH .zstd, Codex) and formats text/json/markdown', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-multi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 1. Layer-1 audit JSONL
  const auditDir = path.join(dir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(auditDir, 'audit-2026-11.jsonl'), [
    JSON.stringify({ schema: 1, ts: '2026-11-24T01:00:00Z', proc_session_id: 'p1', client: 'codex', tool: 'search_docs', raw_tool: 'search_docs', elapsed_ms: 420, internal_ms: 2.1, hits: 3, resp_bytes: 1200, truncated: false, is_error: false, args_meta: { kind: 'doc' } }),
    JSON.stringify({ schema: 1, ts: '2026-11-24T01:00:08Z', proc_session_id: 'p1', client: 'codex', tool: 'read_file', raw_tool: 'read_file', elapsed_ms: 210, hits: 1, resp_bytes: 2400, truncated: false, is_error: false, args_meta: { repo: 'acme/docs' } }),
  ].join('\n') + '\n');

  // 2. T3/Antigravity transcript.jsonl (with double-JSON-encoded args, lazy schema read, + Turn 2 call)
  const t3Dir = path.join(dir, 't3');
  const t3LogDir = path.join(t3Dir, 'antigravity', 'brain', 'sess-t3-001', '.system_generated', 'logs');
  fs.mkdirSync(t3LogDir, { recursive: true });
  fs.writeFileSync(path.join(t3LogDir, 'transcript.jsonl'), [
    JSON.stringify({ type: 'USER_INPUT', created_at: '2026-11-24T02:00:00Z' }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T02:00:10Z',
      tool_calls: [
        { name: 'read_file', args: { Path: '"/home/u/.t3/mcp/gitea-search/search_docs.json"' } },
        { name: 'call_mcp_tool', args: { ServerName: '"gitea-search"', ToolName: '"search_docs"', Arguments: '{"query":"caddy 429"}' } },
      ],
    }),
    JSON.stringify({ type: 'GENERIC', created_at: '2026-11-24T02:00:11Z', content: '{"name":"search_docs"}' }),
    JSON.stringify({ type: 'GENERIC', created_at: '2026-11-24T02:00:11Z', content: '【文档/会话全文检索】命中 2 篇相关文档（耗时 3.2ms [OK]）' }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T02:00:22Z',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: '"ls"' } },
        { name: 'run_command', args: { CommandLine: '"pwd"' } },
        { name: 'run_command', args: { CommandLine: '"git status"' } },
      ],
    }),
    JSON.stringify({ type: 'USER_INPUT', created_at: '2026-11-24T02:05:00Z' }),
    JSON.stringify({
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-24T02:05:12Z',
      tool_calls: [
        { name: 'call_mcp_tool', args: { ServerName: '"gitea-search"', ToolName: '"search_code"', Arguments: '{"query":"validateForm","repo":"acme/web"}' } },
      ],
    }),
    JSON.stringify({ type: 'GENERIC', created_at: '2026-11-24T02:05:13Z', content: '返回 0 条 / 全库命中 0 条\n（无命中。可试...' }),
  ].join('\n') + '\n');

  // 3. DSH v4 multi-frame .zstd session (concatenated frames like append-only DSH logs)
  const dshHome = path.join(dir, 'dsh');
  const dshSessDir = path.join(dshHome, 'sessions', 'ws-a', 'dsh-sess-001');
  fs.mkdirSync(dshSessDir, { recursive: true });
  const dshFrame1 = JSON.stringify({ type: 'session', id: 'dsh-sess-001', createdAt: 1795400000000 }) + '\n';
  const dshFrame2 = [
    JSON.stringify({ type: 'turn/start', time: 1795400000100, data: { turn: 1 } }),
    JSON.stringify({ type: 'tool/call', time: 1795400001000, data: { callId: 'c1', name: 'mcp__gitorca_search__search_gitorca', arguments: '{"query":"nginx"}' } }),
    JSON.stringify({ type: 'tool/result', time: 1795400001350, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '返回 2 条 / 全库命中 2 条' }] } } }),
    JSON.stringify({ type: 'tool/call', time: 1795400002000, data: { callId: 'c2', name: 'mcp__gitorca_search__read_gitorca_file', arguments: '{"repo":"acme/ops","path":"nginx.conf"}' } }),
    JSON.stringify({ type: 'tool/result', time: 1795400002300, data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: '# acme/ops@main:nginx.conf\n// mentions CONFIG_ERROR and 30 个仓 in docs\nserver {}' }] } } }),
    JSON.stringify({ type: 'tool/call', time: 1795400005000, data: { callId: 'c3', name: 'bash', arguments: '{"cmd":"echo ok"}' } }),
    JSON.stringify({ type: 'tool/result', time: 1795400005100, data: { message: { toolCallId: 'c3', content: [{ type: 'text', text: 'ok' }] } } }),
  ].join('\n') + '\n';
  if (HAS_ZSTD) {
    fs.writeFileSync(
      path.join(dshSessDir, 'session.v4.jsonl.zstd'),
      Buffer.concat([compressZstd(Buffer.from(dshFrame1, 'utf8')), compressZstd(Buffer.from(dshFrame2, 'utf8'))]),
    );
  } else {
    fs.writeFileSync(
      path.join(dshSessDir, 'session.v4.jsonl'),
      dshFrame1 + dshFrame2,
      'utf8',
    );
  }

  // 4. Codex rollout JSONL
  const codexHome = path.join(dir, 'codex');
  const codexSessDir = path.join(codexHome, 'sessions', '2026', '11', '24');
  fs.mkdirSync(codexSessDir, { recursive: true });
  fs.writeFileSync(path.join(codexSessDir, 'rollout-2026-11-24-abc.jsonl'), [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-11-24T03:00:00Z', payload: { id: 'codex-001' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-11-24T03:00:01Z', payload: { type: 'user_message', text: 'find compose' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-11-24T03:00:10Z', payload: { type: 'function_call', call_id: 'cx1', name: 'mcp__gitea-search__search_code', arguments: '{"query":"docker-compose"}' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-11-24T03:00:10.400Z', payload: { type: 'function_call_output', call_id: 'cx1', output: '返回 1 条 / 全库命中 1 条' } }),
  ].join('\n') + '\n');

  const report = runAudit({
    noAuto: true,
    auditLogs: [auditDir],
    t3Dirs: [t3Dir],
    dshHomes: [dshHome],
    codexHomes: [codexHome],
  });

  // Layer-1 audit_log assertions
  assert.equal(report.sources.audit_log.calls_total, 2);
  assert.equal(report.sources.audit_log.by_tool.search_docs, 1);
  assert.equal(report.sources.audit_log.by_tool.read_file, 1);

  // T3 assertions: lazy schema read excluded from calls_total, tracked separately
  assert.equal(report.sources.t3.sessions_active, 1);
  assert.equal(report.sources.t3.calls_total, 2);
  assert.equal(report.sources.t3.lazy_schema_sessions, 1);
  assert.equal(report.sources.t3.quality.zero_hit_calls, 1);
  assert.equal(report.sources.t3.quality.internal_fts_ms.p50, 3.2);
  assert.equal(report.sources.t3.phase.turn2_plus_calls, 1);

  // DSH assertions: zstd decompressed, callId matched, exact ms latency recorded
  assert.equal(report.sources.dsh.sessions_active, 1);
  assert.equal(report.sources.dsh.calls_total, 2);
  assert.equal(report.sources.dsh.by_tool.search_code, 1);
  assert.equal(report.sources.dsh.by_tool.read_file, 1);
  assert.equal(report.sources.dsh.quality.elapsed_ms.samples, 2);
  assert.equal(report.sources.dsh.quality.elapsed_ms.p50, 325);
  assert.equal(report.sources.dsh.quality.error_calls, 0);
  assert.equal(report.sources.dsh.savings.total_episodes, 1);

  // Codex assertions
  assert.equal(report.sources.codex.sessions_active, 1);
  assert.equal(report.sources.codex.calls_total, 1);
  assert.equal(report.sources.codex.by_tool.search_code, 1);
  assert.equal(report.sources.codex.quality.elapsed_ms.p50, 400);

  // CLI smoke check for --json and --markdown
  const cliJson = spawnSync(
    process.execPath,
    [AUDIT_CLI, '--no-auto', '--audit-log', auditDir, '--t3-dir', t3Dir, '--dsh-home', dshHome, '--codex-home', codexHome, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(cliJson.status, 0, cliJson.stderr);
  const parsedCli = JSON.parse(cliJson.stdout);
  assert.equal(parsedCli.sources.dsh.calls_total, 2);

  const cliMd = spawnSync(
    process.execPath,
    [AUDIT_CLI, '--no-auto', '--dsh-home', dshHome, '--markdown'],
    { encoding: 'utf8' },
  );
  assert.equal(cliMd.status, 0, cliMd.stderr);
  assert.match(cliMd.stdout, /\| `dsh` \| 1\/1 \|/);
});

test('all usage sources distinguish sync_mirror, ignored inline sync and legacy inline sync', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.jsonl');
  const ts = '2026-11-24T00:00:00Z';
  for (const legacy of [false, true]) {
    const search = legacy ? 'search_gitea' : 'search_code';
    const text = legacy ? '返回 1 条' : '⚠️ SYNC_MOVED: 本次未同步';
    const calls = [
      { name: legacy ? search : 'sync_mirror', args: legacy ? { sync: true } : {}, text: '完成' },
      { name: search, args: legacy ? {} : { sync: true }, text },
    ];
    const bySource = {
      audit_log: {
        parse: (source) => parseAuditLogs([source]).sessions,
        records: calls.map(({ name, args }, index) => ({
          ts, tool: name, proc_session_id: 'audit-fixture',
          args_meta: legacy || index === 0 ? args : { sync_ignored: true },
        })),
      },
      t3: {
        parse: (source) => [parseT3Transcript(source)],
        records: calls.flatMap(({ name, args, text }) => [
          { type: 'PLANNER_RESPONSE', created_at: ts, tool_calls: [
            { name: 'call_mcp_tool', args: { ServerName: 'gitea-search', ToolName: name, Arguments: args } },
          ] },
          { type: 'GENERIC', content: text, created_at: ts },
        ]),
      },
      dsh: {
        parse: (source) => [parseDshSession(source)],
        records: calls.flatMap(({ name, args, text }, index) => [
          { type: 'tool/call', time: ts, data: { name, callId: index + 1, arguments: args } },
          { type: 'tool/result', time: ts, data: { message: { toolCallId: index + 1, content: [{ text }] } } },
        ]),
      },
      codex: {
        parse: (source) => [parseCodexSession(source)],
        records: calls.flatMap(({ name, args, text }, index) => [
          { type: 'response_item', timestamp: ts, payload: {
            type: 'function_call', name: 'mcp__gitea-search__' + name, call_id: index + 1, arguments: JSON.stringify(args),
          } },
          { type: 'response_item', timestamp: ts, payload: {
            type: 'function_call_output', call_id: index + 1, output: { content: [{ text }] },
          } },
        ]),
      },
    };
    for (const [source, { parse, records }] of Object.entries(bySource)) {
      fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const sessions = parse(file);
      assert.deepEqual(sessions[0].calls.map((call) => call.sync), [true, false], source);
      const summary = analyzeSessions(sessions);
      assert.equal(summary.calls_total, 2, source);
      assert.equal(summary.savings.sync_calls, 1, source);
      assert.equal(summary.savings.total_episodes, 1, source);
      assert.equal(summary.savings.episodes_by_kind.E3_direct_read, 0, source);
      assert.deepEqual(summary.by_tool, legacy ? { search_code: 2 } : { sync_mirror: 1, search_code: 1 }, source);
      if (!legacy) {
        const syncOnly = { ...sessions[0], calls: [sessions[0].calls[0]] };
        assert.equal(estimateSavings([syncOnly]).tiers.baseline.gross_saved_sec, 0, source);
        const markdown = formatMarkdownReport({ generated_at: ts, sources: { [source]: summary } });
        assert.match(markdown, /sync_mirror=1, search_code=1 \| 1 \|/);
      }
    }
  }
});

test('lib/zstd.mjs splits and decompresses multi-frame (+ skippable) payloads natively and fails closed without CLI', (t) => {
  if (!HAS_ZSTD) {
    t.skip('Neither Node zlib.zstdCompressSync nor zstd CLI is available in this environment');
    return;
  }

  const p1 = Buffer.from('{"frame":1,"role":"session"}\n', 'utf8');
  const p2 = Buffer.from('{"frame":2,"role":"user","text":"hello"}\n', 'utf8');
  const p3 = Buffer.from('{"frame":3,"role":"assistant","text":"world"}\n', 'utf8');
  // RFC 8878 skippable frame: magic 0x184D2A50 + 4-byte LE length (4) + 4 arbitrary bytes
  const skippable = Buffer.alloc(12);
  skippable.writeUInt32LE(0x184d2a50, 0);
  skippable.writeUInt32LE(4, 4);
  skippable.write('SKIP', 8, 'ascii');

  const combined = Buffer.concat([
    compressZstd(p1),
    skippable,
    compressZstd(p2),
    compressZstd(p3),
  ]);

  const frames = splitZstdFrames(combined);
  assert.equal(frames.length, 3, 'Skippable frame must be skipped and all 3 data frames returned');
  assert.equal(isMultiFrameZstd(combined), true);

  // Decompress with nonexistent zstdBin to prove Node 22+ handles multi-frame natively without CLI
  if (typeof zlib.zstdDecompressSync === 'function') {
    const out = libDecompressZstd(combined, { zstdBin: '/nonexistent/zstd-cli' }).toString('utf8');
    assert.equal(out, p1.toString('utf8') + p2.toString('utf8') + p3.toString('utf8'));
  }

  // Force CLI with nonexistent binary must fail closed (never silently return frame 1 only)
  assert.throws(
    () => libDecompressZstd(combined, { forceCli: true, zstdBin: '/nonexistent/zstd-cli' }),
    /fail-closed|Failed to decompress/i,
  );

  // parseDshSession must surface a warning and return null rather than truncated frame-1 session
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-zstd-failclosed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zstdPath = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(zstdPath, combined);
  const warnings = [];
  const res = parseDshSession(zstdPath, null, {
    forceCli: true,
    zstdBin: '/nonexistent/zstd-cli',
    onWarning: (w) => warnings.push(w),
  });
  assert.equal(res, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Skipped unreadable DSH session/);
});

test('dsh-session-health.mjs --fix preserves all frames when migrating multi-frame legacy .zstd', (t) => {
  if (!HAS_ZSTD) {
    t.skip('Neither Node zlib.zstdCompressSync nor zstd CLI is available in this environment');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-dsh-multiframe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const dshHome = path.join(dir, '.dsh');
  const sessDir = path.join(dshHome, 'sessions', 'ws-test', 'sess-mf-001');
  fs.mkdirSync(sessDir, { recursive: true });

  const frame1 = JSON.stringify({ type: 'session', version: 1, id: 'sess-mf-001', createdAt: 1795400000000 }) + '\n';
  const frame2 = JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'plugin', plugin: 'compact' }, text: 'hello frame 2' } }) + '\n';
  const frame3 = JSON.stringify({ type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'reply frame 3' }] } } }) + '\n';
  const multiFrame = Buffer.concat([
    compressZstd(Buffer.from(frame1, 'utf8')),
    compressZstd(Buffer.from(frame2, 'utf8')),
    compressZstd(Buffer.from(frame3, 'utf8')),
  ]);
  fs.writeFileSync(path.join(sessDir, 'session.jsonl.zstd'), multiFrame);

  const env = { ...process.env, HOME: dir, USERPROFILE: dir };
  delete env.DSH_PERSISTENCE_MODULE;
  delete env.DSH_FORCE_ZSTD_CLI;

  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'dsh-session-health.mjs'), '--fix', '--dsh-home', dshHome, '--json'],
    { encoding: 'utf8', env },
  );
  assert.equal(res.status, 0, `dsh-session-health --fix failed:\n${res.stderr}\n${res.stdout}`);

  const v4Path = path.join(sessDir, 'session.v4.jsonl.zstd');
  assert.equal(fs.existsSync(v4Path), true, 'session.v4.jsonl.zstd must be written');
  const decompressed = libDecompressZstd(fs.readFileSync(v4Path)).toString('utf8');
  const outLines = decompressed.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(outLines.length, 3, `Expected all 3 frames preserved, got ${outLines.length}`);
  assert.equal(outLines[0].version, 4);
  assert.equal(outLines[1].data.source.kind, 'compact-checkpoint');
  assert.equal(outLines[2].data.message.content[0].text, 'reply frame 3');
});

test('v2.0.3 audit §3.4/§3.7: SYNC_MOVED in search hit content does not mask legacy sync, and paired results preserve args_meta.sync_ignored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-sync-edge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.jsonl');
  const ts = '2026-11-24T00:00:00Z';

  // Legacy search_code(sync:true) whose matched hit text echoes SYNC_MOVED (and even the literal string inside code)
  const hitEchoText = [
    '返回 2 条 / 全库命中 2 条 / 1 个仓',
    'acme/repo@main:docs/USAGE.md:102:| `SYNC_MOVED` | 旧调用方向只读 search_code 传入了 sync |',
    "acme/repo@main:lib/server.mjs:982:    lines.push('⚠️ SYNC_MOVED: search_code 已是只读工具');",
  ].join('\n');
  const realBannerText = [
    '返回 1 条 / 全库命中 1 条 / 1 个仓',
    '⚠️ SYNC_MOVED: search_code 已是只读工具，不再支持 sync 参数，本次未同步。',
  ].join('\n');

  const cases = {
    audit_log: {
      parse: (source) => parseAuditLogs([source]).sessions,
      records: [
        { ts, tool: 'search_code', proc_session_id: 'edge', args: { sync: true, query: 'SYNC_MOVED' }, args_meta: { sync: true }, output: hitEchoText },
        { ts, tool: 'search_code', proc_session_id: 'edge', args: { sync: true, query: 'foo' }, args_meta: { sync_ignored: true }, output: '返回 1 条' },
        { ts, tool: 'search_code', proc_session_id: 'edge', args: { sync: true, query: 'bar' }, args_meta: {}, output: realBannerText },
      ],
    },
    t3: {
      parse: (source) => [parseT3Transcript(source)],
      records: [
        { type: 'PLANNER_RESPONSE', created_at: ts, tool_calls: [
          { name: 'call_mcp_tool', args: { ServerName: 'gitea-search', ToolName: 'search_code', Arguments: { sync: true, query: 'SYNC_MOVED' } } },
        ] },
        { type: 'GENERIC', content: `Created At: ${ts}\nCompleted At: ${ts}\n${hitEchoText}`, created_at: ts },
        { type: 'PLANNER_RESPONSE', created_at: ts, tool_calls: [
          { name: 'call_mcp_tool', args_meta: { sync_ignored: true }, args: { ServerName: 'gitea-search', ToolName: 'search_code', Arguments: { sync: true, query: 'foo' } } },
        ] },
        { type: 'GENERIC', content: '返回 1 条', created_at: ts },
        { type: 'PLANNER_RESPONSE', created_at: ts, tool_calls: [
          { name: 'call_mcp_tool', args: { ServerName: 'gitea-search', ToolName: 'search_code', Arguments: { sync: true, query: 'bar' } } },
        ] },
        { type: 'GENERIC', content: `Created At: ${ts}\nCompleted At: ${ts}\n${realBannerText}`, created_at: ts },
      ],
    },
    dsh: {
      parse: (source) => [parseDshSession(source)],
      records: [
        { type: 'tool/call', time: ts, data: { name: 'search_code', callId: 'c1', arguments: { sync: true, query: 'SYNC_MOVED' } } },
        { type: 'tool/result', time: ts, data: { message: { toolCallId: 'c1', content: [{ text: hitEchoText }] } } },
        { type: 'tool/call', time: ts, data: { name: 'search_code', callId: 'c2', args_meta: { sync_ignored: true }, arguments: { sync: true, query: 'foo' } } },
        { type: 'tool/result', time: ts, data: { message: { toolCallId: 'c2', content: [{ text: '返回 1 条' }] } } },
        { type: 'tool/call', time: ts, data: { name: 'search_code', callId: 'c3', arguments: { sync: true, query: 'bar' } } },
        { type: 'tool/result', time: ts, data: { message: { toolCallId: 'c3', content: [{ text: realBannerText }] } } },
      ],
    },
    codex: {
      parse: (source) => [parseCodexSession(source)],
      records: [
        { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'mcp__gitea-search__search_code', call_id: 'c1', arguments: JSON.stringify({ sync: true, query: 'SYNC_MOVED' }) } },
        { type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: 'c1', output: { content: [{ text: hitEchoText }] } } },
        { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'mcp__gitea-search__search_code', call_id: 'c2', args_meta: { sync_ignored: true }, arguments: JSON.stringify({ sync: true, query: 'foo' }) } },
        { type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: 'c2', output: { content: [{ text: '返回 1 条' }] } } },
        { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'mcp__gitea-search__search_code', call_id: 'c3', arguments: JSON.stringify({ sync: true, query: 'bar' }) } },
        { type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: 'c3', output: { content: [{ text: realBannerText }] } } },
      ],
    },
  };

  for (const [source, { parse, records }] of Object.entries(cases)) {
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const sessions = parse(file);
    assert.deepEqual(
      sessions[0].calls.map((c) => c.sync),
      [true, false, false],
      `${source}: hit-content SYNC_MOVED must stay sync=true; args_meta.sync_ignored and real SYNC_MOVED banner must be sync=false`,
    );
  }
});

test('Re-audit R2/R3: structured {content} string and array outputs unwrap for SYNC_MOVED, isZeroHit, isError, and internalMs', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-r2r3-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const file = path.join(tmpDir, 'codex.jsonl');
  const ts = '2026-11-26T12:00:00.000Z';
  const records = [
    { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'mcp__gitea-search__search_code', call_id: 'c1', arguments: JSON.stringify({ sync: true, query: 'alpha' }) } },
    { type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: 'c1', output: { content: '⚠️ SYNC_MOVED: search_code 不再支持 sync\n（无命中，耗时 12ms）' } } },
    { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'mcp__gitea-search__search_docs', call_id: 'c2', arguments: JSON.stringify({ query: 'missing' }) } },
    { type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: 'c2', output: { content: [{ text: '（无命中，耗时 25ms）' }] } } },
    { type: 'response_item', timestamp: ts, payload: { type: 'function_call', name: 'mcp__gitea-search__read_file', call_id: 'c3', arguments: JSON.stringify({ repo: 'demo', path: 'x' }) } },
    { type: 'response_item', timestamp: ts, payload: { type: 'function_call_output', call_id: 'c3', output: { content: '读取失败：NOT_FOUND' } } },
  ];
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const session = parseCodexSession(file);
  assert.equal(session.calls.length, 3);
  assert.equal(session.calls[0].sync, false, 'string content SYNC_MOVED banner must not count as sync');
  assert.equal(session.calls[0].isZeroHit, true);
  assert.equal(session.calls[0].internalMs, 12);
  assert.equal(session.calls[1].isZeroHit, true, 'array content zero-hit must unwrap cleanly');
  assert.equal(session.calls[1].internalMs, 25);
  assert.equal(session.calls[2].isError, true, 'string content error must unwrap cleanly');
});

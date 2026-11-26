#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * test/audit-203-core.test.mjs
 * Regressions for the independent 2.0.3 audit findings:
 *   #1  Shared-index owner scoping across search_docs / gts -D / indexer.py -q
 *   #3  Missing owner dir aborts atomic --reindex --full without replacing healthy DB
 *   #5  Multiline PEM private-key redaction across pagination, single-line hits & FTS snippets
 *   #6  POSIX cancel of search_code(sync=true) kills inner sync.sh & descendants
 *   #7  search_code MCP tool annotations reflect sync:true write/openWorld capability
 *   #8  FTS perf-metrics.jsonl omits raw query text unless GITEA_AUDIT_INCLUDE_QUERY=1
 *   #9  GITEA_EXCLUDE_REPOS prunes existing FTS rows on incremental build & restores when removed
 *   #16 UTF-8 branch names (e.g. 功能/中文) round-trip from search_code to read_file & gts --read
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = process.platform !== 'win32';
const PY = POSIX ? 'python3' : 'python';
const GTS = path.join(ROOT, 'bin', 'gts');
const INDEXER = path.join(ROOT, 'lib', 'indexer.py');

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeBareRepo(baseDir, mirrorRoot, owner, name, files, extraBranches = {}) {
  const work = path.join(baseDir, `work-${owner}-${name}`);
  const bare = path.join(mirrorRoot, owner, `${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  runGit(['init', '-q', '-b', 'main', work], baseDir);
  runGit(['config', 'user.name', 'Audit Test'], work);
  runGit(['config', 'user.email', 'audit@example.invalid'], work);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(work, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  runGit(['add', '.'], work);
  runGit(['commit', '-q', '-m', 'seed'], work);
  for (const [branch, bFiles] of Object.entries(extraBranches)) {
    runGit(['checkout', '-q', '-b', branch], work);
    for (const [rel, content] of Object.entries(bFiles)) {
      const full = path.join(work, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    runGit(['add', '.'], work);
    runGit(['commit', '-q', '-m', `branch ${branch}`], work);
    runGit(['checkout', '-q', 'main'], work);
  }
  runGit(['clone', '-q', '--bare', work, bare], baseDir);
  return bare;
}

function cleanEnvFor(dir, mirrorRoot, owners, extra = {}) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(GITEA_|GITQ_|GTS_)/.test(k)) delete env[k];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_STATE_HOME = path.join(home, '.local', 'state');
  env.GITEA_MIRROR_ROOT = mirrorRoot;
  env.GITEA_OWNERS = owners;
  env.GITEA_ALLOW_NO_JIEBA = '1';
  if (!POSIX) {
    const wrapper = path.join(dir, 'gts-audit-test.cmd');
    if (!fs.existsSync(wrapper)) {
      fs.writeFileSync(wrapper, `@echo off\r\npython "${GTS}" %*\r\n`);
    }
    env.GITEA_SEARCH_CLI = wrapper;
  } else {
    env.GITEA_SEARCH_CLI = GTS;
  }
  return { ...env, ...extra };
}

async function withMcpClient(env, fn) {
  const client = new Client({ name: 'audit-203-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'bin', 'mcp-server')],
    env,
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test('Audit #1 & #7: shared index enforces owner scope in search_docs/CLI/indexer and search_code annotations reflect sync:true', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirror = path.join(dir, 'mirror');

  makeBareRepo(dir, mirror, 'alpha', 'shared-app', {
    'guide.md': '# AlphaSecretTitle\nSharedScopeMarker9911 only for alpha team.\n',
  });
  makeBareRepo(dir, mirror, 'beta', 'shared-app', {
    'guide.md': '# BetaConfidentialTitle\nSharedScopeMarker9911 belongs strictly to beta team.\n',
  });

  const dualEnv = cleanEnvFor(dir, mirror, 'alpha,beta');
  const idx = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'alpha,beta', '--build', '--full'], {
    env: dualEnv, encoding: 'utf8',
  });
  assert.equal(idx.status, 0, idx.stderr);

  // Single-owner client configured ONLY for alpha on the shared mirror_root
  const alphaEnv = cleanEnvFor(dir, mirror, 'alpha');
  await withMcpClient(alphaEnv, async (client) => {
    // #7: verify tools/list annotations (search_code supports sync:true -> remote update --prune)
    const list = await client.listTools();
    const byName = Object.fromEntries(list.tools.map((tool) => [tool.name, tool]));
    // N3：search_code 严格只读（Codex 对 destructiveHint:true / openWorldHint:true 的工具会逐次要求审批），
    // 唯一会写镜像的是独立的 sync_mirror。
    assert.equal(byName.search_code.annotations.readOnlyHint, true);
    assert.equal(byName.search_code.annotations.destructiveHint, false);
    assert.equal(byName.search_code.annotations.openWorldHint, false);
    assert.equal(byName.sync_mirror.annotations.readOnlyHint, false);
    assert.equal(byName.sync_mirror.annotations.destructiveHint, true);
    assert.equal(byName.sync_mirror.annotations.openWorldHint, true);
    assert.ok(!('sync' in byName.search_code.inputSchema.properties), 'search_code schema must not advertise sync');
    assert.equal(byName.read_file.annotations.readOnlyHint, true);
    assert.equal(byName.read_file.annotations.destructiveHint, false);
    assert.equal(byName.read_file.annotations.openWorldHint, false);
    assert.equal(byName.list_repositories.annotations.readOnlyHint, true);
    assert.equal(byName.list_repositories.annotations.destructiveHint, false);
    assert.equal(byName.search_docs.annotations.readOnlyHint, true);
    assert.equal(byName.search_docs.annotations.destructiveHint, false);

    // #1: list_repositories sees only alpha
    const repos = await client.callTool({ name: 'list_repositories', arguments: {} });
    assert.match(repos.content[0].text, /alpha\/shared-app/);
    assert.doesNotMatch(repos.content[0].text, /beta\/shared-app/);

    // #1: unfiltered search_docs must NOT leak beta
    const docsAll = await client.callTool({ name: 'search_docs', arguments: { query: 'SharedScopeMarker9911', max_results: 10 } });
    assert.match(docsAll.content[0].text, /alpha\/shared-app/);
    assert.doesNotMatch(docsAll.content[0].text, /beta\/shared-app|BetaConfidentialTitle/);

    // #1: bare repo name and glob repo pattern must stay intersected with alpha
    for (const repoPat of ['shared-app', 'shared-*', '*app']) {
      const docsFilt = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'SharedScopeMarker9911', repo: repoPat, max_results: 10 },
      });
      assert.match(docsFilt.content[0].text, /alpha\/shared-app/, repoPat);
      assert.doesNotMatch(docsFilt.content[0].text, /beta\/shared-app|BetaConfidentialTitle/, repoPat);
    }

    // #1: read_file rejects beta/shared-app
    const readBeta = await client.callTool({ name: 'read_file', arguments: { repo: 'beta/shared-app', path: 'guide.md' } });
    assert.equal(readBeta.isError, true);
  });

  // Direct indexer.py -q with -o alpha must also enforce owner scope
  const direct = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'alpha', '-q', 'SharedScopeMarker9911', '--json'], {
    env: alphaEnv, encoding: 'utf8',
  });
  assert.equal(direct.status, 0, direct.stderr);
  const directJson = JSON.parse(direct.stdout);
  assert.deepEqual(directJson.results.map((r) => r.repo), ['alpha/shared-app']);

  // Dual-owner client sees both
  await withMcpClient(dualEnv, async (client) => {
    const docsBoth = await client.callTool({ name: 'search_docs', arguments: { query: 'SharedScopeMarker9911', max_results: 10 } });
    assert.match(docsBoth.content[0].text, /alpha\/shared-app/);
    assert.match(docsBoth.content[0].text, /beta\/shared-app/);
  });
});

test('Audit #3: --reindex --full rejects missing owner dir and preserves healthy DB; existing empty dir is allowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-3-'));
  try {
    const mirror = path.join(dir, 'mirror');
    makeBareRepo(dir, mirror, 'alpha', 'a1', { 'doc.md': '# A1\nAlphaFullRebuildSentinel\n' });
    makeBareRepo(dir, mirror, 'beta', 'b1', { 'doc.md': '# B1\nBetaFullRebuildSentinel\n' });
    const env = cleanEnvFor(dir, mirror, 'alpha,beta');

    const init = spawnSync(PY, [GTS, '--reindex', '--full'], { env, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);

    // Move beta away (unmounted directory) -> full rebuild MUST fail and keep beta searchable
    const betaDir = path.join(mirror, 'beta');
    const betaAway = path.join(dir, 'beta-away');
    fs.renameSync(betaDir, betaAway);
    const missOne = spawnSync(PY, [GTS, '--reindex', '--full'], { env, encoding: 'utf8' });
    assert.notEqual(missOne.status, 0, 'missing one owner dir must fail --full');
    assert.match(missOne.stderr, /INDEX_INPUT_INCOMPLETE.*beta/);

    const qBeta = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'alpha,beta', '-q', 'BetaFullRebuildSentinel', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(JSON.parse(qBeta.stdout).total, 1, 'old DB must stay intact');

    // Move alpha away too -> ALL missing must fail and keep old DB intact
    const alphaDir = path.join(mirror, 'alpha');
    const alphaAway = path.join(dir, 'alpha-away');
    fs.renameSync(alphaDir, alphaAway);
    const missAll = spawnSync(PY, [GTS, '--reindex', '--full'], { env, encoding: 'utf8' });
    assert.notEqual(missAll.status, 0, 'missing all owner dirs must fail --full');
    assert.match(missAll.stderr, /INDEX_INPUT_INCOMPLETE/);
    const qAlpha = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'alpha,beta', '-q', 'AlphaFullRebuildSentinel', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(JSON.parse(qAlpha.stdout).total, 1);

    // Restore alpha, create beta as an existing-but-empty directory -> valid full rebuild
    fs.renameSync(alphaAway, alphaDir);
    fs.mkdirSync(betaDir);
    const emptyOk = spawnSync(PY, [GTS, '--reindex', '--full'], { env, encoding: 'utf8' });
    assert.equal(emptyOk.status, 0, emptyOk.stderr);
    const qBetaEmpty = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'alpha,beta', '-q', 'BetaFullRebuildSentinel', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(JSON.parse(qBetaEmpty.stdout).total, 0);

    // Restore real beta repos -> full rebuild recovers beta docs
    fs.rmdirSync(betaDir);
    fs.renameSync(betaAway, betaDir);
    const recovered = spawnSync(PY, [GTS, '--reindex', '--full'], { env, encoding: 'utf8' });
    assert.equal(recovered.status, 0, recovered.stderr);
    const qBetaBack = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'alpha,beta', '-q', 'BetaFullRebuildSentinel', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(JSON.parse(qBetaBack.stdout).total, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Audit #5: multiline PEM private key is redacted across read_file pagination, search_code line hits, and search_docs snippets', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirror = path.join(dir, 'mirror');

  // Construct harmless synthetic PEM placeholder dynamically
  const beginLine = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const body1 = 'MIIEFAKEPLACEHOLDERLINEONE1111111111111111111111111111';
  const body2 = 'MIIEFAKEPLACEHOLDERLINETWO2222222222222222222222222222';
  const body3 = 'MIIEFAKEPLACEHOLDERLINETHREE33333333333333333333333333';
  const endLine = '-----END ' + 'RSA PRIVATE KEY-----';
  const docLines = [
    '# RunbookPemAuditSentinel',
    'Line 2 normal preface text',
    beginLine,
    body1,
    body2,
    body3,
    endLine,
    'Line 8 normal epilogue after key block',
    'Line 9 final verification line',
  ];
  makeBareRepo(dir, mirror, 'acme', 'docs', { 'runbook.md': docLines.join('\n') + '\n' });
  const env = cleanEnvFor(dir, mirror, 'acme');
  const idx = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'acme', '--build'], { env, encoding: 'utf8' });
  assert.equal(idx.status, 0, idx.stderr);

  await withMcpClient(env, async (client) => {
    // 1. Whole read
    const full = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/docs', path: 'runbook.md', limit: 0 } });
    for (const s of [body1, body2, body3]) assert.equal(full.content[0].text.includes(s), false, 'full read leaked body');
    assert.match(full.content[0].text, /Line 8 normal epilogue/);

    // 2. Cross-page: starts at line 0, stops mid-key (before END)
    const crossStart = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/docs', path: 'runbook.md', offset: 0, limit: 5 } });
    for (const s of [body1, body2, body3]) assert.equal(crossStart.content[0].text.includes(s), false, 'cross-start leaked body');
    assert.match(crossStart.content[0].text, /SECRET_REDACTED:private_key/);

    // 3. Strictly interior slice (lines 4-6: NO BEGIN, NO END in window!)
    const middleOnly = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/docs', path: 'runbook.md', offset: 3, limit: 3 } });
    for (const s of [body1, body2, body3]) assert.equal(middleOnly.content[0].text.includes(s), false, 'interior page leaked body');
    assert.match(middleOnly.content[0].text, /SECRET_REDACTED:private_key/);

    // 4. Lines outside block keep exact original 0-based line offsets (offset=7 -> Line 8)
    const afterBlock = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/docs', path: 'runbook.md', offset: 7, limit: 2 } });
    assert.match(afterBlock.content[0].text, /Line 8 normal epilogue/);
    assert.match(afterBlock.content[0].text, /Line 9 final verification/);
    assert.equal(afterBlock.content[0].text.includes(body3), false);

    // 5. search_code matching an interior key-body line must redact it
    const codeHit = await client.callTool({ name: 'search_code', arguments: { query: 'MIIEFAKEPLACEHOLDERLINETWO' } });
    assert.equal(codeHit.content[0].text.includes(body2), false, 'search_code leaked interior PEM line');
    assert.match(codeHit.content[0].text, /SECRET_REDACTED:private_key/);

    // 6. search_docs snippet near the key block must not leak key body
    const docHit = await client.callTool({ name: 'search_docs', arguments: { query: 'RunbookPemAuditSentinel' } });
    for (const s of [body1, body2, body3]) assert.equal(docHit.content[0].text.includes(s), false, 'search_docs snippet leaked body');
  });

  // 7. Oversized blob (> GITEA_MAX_BLOB_BYTES): search_code MUST fail closed (preserve repo/ref/path/line, omit body)
  const bigLines = [
    '# LargePemAuditSentinel',
    'x'.repeat(2048),
    beginLine,
    body1,
    body2,
    body3,
    endLine,
    'y'.repeat(2048),
  ];
  makeBareRepo(dir, mirror, 'acme', 'bigdocs', { 'large.md': bigLines.join('\n') + '\n' });
  const lowCapEnv = cleanEnvFor(dir, mirror, 'acme', { GITEA_MAX_BLOB_BYTES: '1024' });
  await withMcpClient(lowCapEnv, async (client) => {
    const bigHit = await client.callTool({ name: 'search_code', arguments: { query: 'MIIEFAKEPLACEHOLDERLINETWO', repo: 'acme/bigdocs' } });
    assert.equal(bigHit.isError, undefined);
    const txt = bigHit.content[0].text;
    assert.match(txt, /acme\/bigdocs@main:large\.md:5:\[CONTENT_OMITTED:unverified_secret_scan:oversize\]/);
    assert.equal(txt.includes(body2), false, 'oversized file must NOT leak interior PEM line');
    assert.match(txt, /无法完整扫描对应文件/);
  });

  // 8. Legacy FTS index lacking body_raw column: must verify via bare mirror or fail-closed omit snippet
  const legacySrc = path.join(dir, 'legacy-src');
  const legacyMirror = path.join(dir, 'legacy-mirror');
  fs.mkdirSync(legacySrc, { recursive: true });
  const legacyBare = makeBareRepo(legacySrc, legacyMirror, 'acme', 'docs', { 'runbook.md': docLines.join('\n') + '\n' }, {
    next: { 'runbook.md': '# NewBranchOnlySentinel\nDifferent lines after indexing.\n' },
  });
  const blobSha = runGit(['--git-dir', legacyBare, 'rev-parse', 'main:runbook.md'], legacySrc);
  const legacyEnv = cleanEnvFor(dir, legacyMirror, 'acme');
  const buildLegacy = spawnSync(PY, ['-c', `
import os, sqlite3, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'lib'))})
import indexer
db = indexer.get_db_path(${JSON.stringify(legacyMirror)})
os.makedirs(os.path.dirname(db), exist_ok=True)
conn = sqlite3.connect(db)
conn.execute("CREATE VIRTUAL TABLE docs_fts USING fts5(repo, ref, path, title, body, kind UNINDEXED, mtime UNINDEXED)")
conn.execute("CREATE TABLE file_blobs (repo TEXT, ref TEXT, path TEXT, blob_sha TEXT, PRIMARY KEY (repo, ref, path))")
conn.execute("CREATE TABLE doc_rowid (repo TEXT, ref TEXT, path TEXT, rowid_val INTEGER, PRIMARY KEY (repo, ref, path))")
conn.execute("CREATE TABLE repo_heads (repo TEXT PRIMARY KEY, head_commit TEXT, default_ref TEXT)")
body = ${JSON.stringify(docLines.join('\n') + '\n')}
cur = conn.execute("INSERT INTO docs_fts(repo, ref, path, title, body, kind, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   ("acme/docs", "main", "runbook.md", "RunbookPemAuditSentinel", body, "doc", 1))
conn.execute("INSERT INTO doc_rowid VALUES (?, ?, ?, ?)", ("acme/docs", "main", "runbook.md", cur.lastrowid))
conn.execute("INSERT INTO file_blobs VALUES (?, ?, ?, ?)", ("acme/docs", "main", "runbook.md", ${JSON.stringify(blobSha)}))
conn.execute("PRAGMA user_version=2")
conn.commit()
conn.close()
`], { env: legacyEnv, encoding: 'utf8' });
  assert.equal(buildLegacy.status, 0, buildLegacy.stderr);
  const nextOid = runGit(['--git-dir', legacyBare, 'rev-parse', 'next'], legacySrc);
  runGit(['--git-dir', legacyBare, 'update-ref', 'refs/heads/main', nextOid], legacySrc);

  await withMcpClient(legacyEnv, async (client) => {
    const result = await client.callTool({ name: 'search_docs', arguments: { query: body2 } });
    const snippet = result.content[0].text;
    assert.match(snippet, /摘要:.*RunbookPemAuditSentinel.*\[SECRET_REDACTED:private_key\].*Line 8 normal epilogue/);
    assert.ok(!snippet.includes(body2) && !snippet.includes('NewBranchOnlySentinel'), snippet);
  });

  // Case B: bare mirror unreadable / oversized -> fail-closed omit snippet
  const legOmit = JSON.parse(spawnSync(PY, [INDEXER, '--mirror-root', legacyMirror, '-o', 'acme', '-q', body2, '--json'], {
    env: { ...legacyEnv, GITEA_MAX_BLOB_BYTES: '64' }, encoding: 'utf8',
  }).stdout);
  assert.equal(legOmit.total, 1);
  assert.equal(legOmit.results[0].snippet, '[SNIPPET_OMITTED:legacy_index_unverified]');
  assert.equal(legOmit.results[0].snippet.includes(body2), false);

  for (const oid of [null, '1'.repeat(40), nextOid]) {
    const updateLegacy = spawnSync(PY, ['-c', [
      'import sqlite3, sys, indexer',
      'with sqlite3.connect(indexer.get_db_path(sys.argv[1])) as conn:',
      '    conn.execute("UPDATE file_blobs SET blob_sha=?", (sys.argv[2] or None,))',
    ].join('\n'), legacyMirror, oid ?? ''], {
      env: { ...legacyEnv, PYTHONPATH: path.join(ROOT, 'lib') }, encoding: 'utf8',
    });
    assert.equal(updateLegacy.status, 0, updateLegacy.stderr);
    const result = spawnSync(PY, [INDEXER, '--mirror-root', legacyMirror, '-o', 'acme', '-q', body2, '--json'], {
      env: legacyEnv, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).results[0].snippet, '[SNIPPET_OMITTED:legacy_index_unverified]');
  }

  // 9. Aborted signal during search_code private-key inspection returns CANCELLED (never leaks raw text)
  const origEnv5 = { ...process.env };
  Object.assign(process.env, cleanEnvFor(dir, mirror, 'acme'));
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in origEnv5)) delete process.env[k];
    Object.assign(process.env, origEnv5);
  });
  const srv5 = await import(`../lib/server.mjs?audit5cancel=${Date.now()}`);
  const preAborted = new AbortController();
  preAborted.abort();
  const cancelledHit = await srv5.searchCode({ query: 'MIIEFAKEPLACEHOLDERLINETWO' }, { signal: preAborted.signal });
  assert.equal(cancelledHit.isError, true);
  assert.match(cancelledHit.text, /^CANCELLED:/);
  assert.equal(cancelledHit.text.includes(body2), false);
});

test('unclosed placeholder blocks have identical coverage in full reads, pages, grep and FTS', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-unclosed-pem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirror = path.join(dir, 'mirror');
  const begin = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const redacted = '[SECRET_REDACTED:private_key]';
  const fixtures = [
    {
      name: 'bare', preface: '# BarePemFixture', block: [begin, 'Proc-Type: 4,ENCRYPTED', '', 'MIIEFAKEBODY01234567', 'TQ=='],
      next: '// normal trailing comment',
    },
    {
      name: 'wrapped', preface: '# WrappedPemFixture',
      block: ['  "' + begin + '",', '  // PLACEHOLDERCHUNK001', '  > "FakeMixedCasePlaceholder",', '  - "QUJD",'],
      next: 'return key;',
    },
    {
      name: 'assigned', preface: '# AssignedPemFixture',
      block: ['pem = "' + begin + '\\n";', 'pem += "FakeAssignedChunk1234\\n";', 'lines.append("Zm8=\\n")'],
      next: 'const x = 1;',
    },
  ];
  const files = Object.fromEntries(fixtures.map(({ name, preface, block, next }) => [
    name + '.md', [preface, ...block, next, 'Ordinary line after the boundary.'].join('\n') + '\n',
  ]));
  makeBareRepo(dir, mirror, 'acme', 'docs', files);
  const env = cleanEnvFor(dir, mirror, 'acme');
  const index = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'acme', '--build'], { env, encoding: 'utf8' });
  assert.equal(index.status, 0, index.stderr);

  await withMcpClient(env, async (client) => {
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, result.content[0].text);
      return result.content[0].text;
    };
    const hits = (await call('search_code', { query: '.*', regex: true, max_results: 40 })).split('\n');
    for (const { name, preface, block, next } of fixtures) {
      const file = name + '.md';
      const args = { repo: 'acme/docs', path: file };
      const full = (await call('read_file', { ...args, limit: 0 })).split('\n').slice(2);
      assert.deepEqual(full.slice(0, block.length + 2), [preface, ...block.map(() => redacted), next]);
      const page = (await call('read_file', { ...args, offset: block.length, limit: 2 })).split('\n').slice(2, 4);
      assert.deepEqual(page, [redacted, next]);
      block.forEach((_, i) => assert.ok(hits.includes('acme/docs@main:' + file + ':' + (i + 2) + ':' + redacted)));
      assert.ok(hits.includes('acme/docs@main:' + file + ':' + (block.length + 2) + ':' + next));
      const docs = await call('search_docs', { query: preface.slice(2) });
      const snippet = docs.split('\n').find((line) => line.startsWith('  摘要: '));
      assert.ok(snippet.includes(redacted + ' ' + next), snippet);
      for (const line of block.filter(Boolean)) assert.ok(!snippet.includes(line), snippet);
    }
  });
});

test('search_code verifies grep results against the pinned commit across a local ref update', { skip: !POSIX }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-pinned-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirror = path.join(dir, 'mirror');
  const marker = 'MIIEFAKEPINNEDFIXTURE01234567';
  const bare = makeBareRepo(dir, mirror, 'acme', 'docs', {
    'doc.md': ['-----BEGIN ' + 'RSA PRIVATE KEY-----', marker, 'Normal trailing line.', ''].join('\n'),
  }, { next: { 'doc.md': '# V2\nOrdinary new second line.\n' } });
  const v1 = runGit(['--git-dir', bare, 'rev-parse', 'main'], dir);
  const v2 = runGit(['--git-dir', bare, 'rev-parse', 'next'], dir);
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const shim = path.join(dir, 'git');
  // Complete real grep first, then advance the fixture ref before allowing grep's caller to proceed.
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'for arg do [ "$arg" = grep ] && found=1; done',
    'if [ "$found" != 1 ]; then exec "$FIXTURE_GIT" "$@"; fi',
    '"$FIXTURE_GIT" "$@"',
    'rc=$?',
    '"$FIXTURE_GIT" --git-dir="$FIXTURE_BARE" update-ref refs/heads/main "$FIXTURE_NEXT" || exit 2',
    'exit "$rc"',
  ].join('\n') + '\n', { mode: 0o755 });
  const env = cleanEnvFor(dir, mirror, 'acme', {
    PATH: dir + path.delimiter + process.env.PATH, FIXTURE_GIT: git, FIXTURE_BARE: bare, FIXTURE_NEXT: v2,
  });
  const cli = spawnSync(PY, [GTS, '--json', '-b', 'main', marker], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const [hit] = JSON.parse(cli.stdout).results;
  assert.equal(hit.commit, v1);
  assert.equal(hit.ref, 'main');
  assert.equal(hit.path, 'doc.md');
  assert.equal(runGit(['--git-dir', bare, 'rev-parse', 'main'], dir), v2);
  runGit(['--git-dir', bare, 'update-ref', 'refs/heads/main', v1], dir);

  await withMcpClient(env, async (client) => {
    const result = await client.callTool({ name: 'search_code', arguments: { query: marker, branch: 'main' } });
    const output = result.content[0].text;
    assert.equal(result.isError, undefined, output);
    assert.match(output, /acme\/docs@main:doc\.md:2:\[SECRET_REDACTED:private_key\]/);
    assert.ok(!output.includes(marker), output);
  });
  assert.equal(runGit(['--git-dir', bare, 'rev-parse', 'main'], dir), v2);
});

test('Audit #6: POSIX cancel of search_code(sync=true) through real sync.sh + xargs + timeout kills git worker with no delayed write and releases lock', { skip: !POSIX, timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const app = path.join(dir, 'app');
  const mirror = path.join(dir, 'mirror');
  const fakeBin = path.join(dir, 'fakebin');
  fs.mkdirSync(path.join(app, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(app, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(mirror, 'state'), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  makeBareRepo(dir, mirror, 'own', 'demo', { 'a.txt': 'hello\n' });

  // Copy real bin/gts, lib/*.py, AND real scripts/sync.sh (preserving real xargs & GNU timeout)
  fs.copyFileSync(GTS, path.join(app, 'bin', 'gts'));
  fs.chmodSync(path.join(app, 'bin', 'gts'), 0o755);
  fs.copyFileSync(path.join(ROOT, 'scripts', 'sync.sh'), path.join(app, 'scripts', 'sync.sh'));
  fs.chmodSync(path.join(app, 'scripts', 'sync.sh'), 0o755);
  for (const f of ['config.py', 'indexer.py', 'mirror_state.py']) {
    fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(app, 'lib', f));
  }

  const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const lockPath = path.join(mirror, 'state', 'sync.lock');
  const readyFile = path.join(dir, 'sync.ready');
  const pidFile = path.join(dir, 'git.pid');
  const writeMarker = path.join(dir, 'post-cancel.written');

  // Replace ONLY git: pass through metadata commands, block on `remote update --prune`
  fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh
case " $* " in
  *" remote ") printf 'origin\\n'; exit 0 ;;
  *" ls-remote "*) printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\\trefs/heads/main\\n'; exit 0 ;;
  *" remote update --prune "*)
    echo $$ > "${pidFile}"
    echo ready > "${readyFile}"
    sleep 1
    echo delayed-write > "${writeMarker}"
    sleep 30
    exit 0
    ;;
esac
exec "${realGit}" "$@"
`, { mode: 0o755 });

  // Run server.searchCode directly with real bin/gts + real scripts/sync.sh + real xargs + real GNU timeout
  const origEnv = { ...process.env };
  const env = cleanEnvFor(dir, mirror, 'own', {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GTS_BIN: path.join(app, 'bin', 'gts'),
    GITEA_SEARCH_CLI: path.join(app, 'bin', 'gts'),
    GITQ_JOBS: '1',
    GITQ_ENUM: 'ssh', // falls back to disk mirror (own/demo.git) without network
  });
  Object.assign(process.env, env);
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
    Object.assign(process.env, origEnv);
  });

  const server = await import(`../lib/server.mjs?audit6=${Date.now()}`);
  const ac = new AbortController();
  const pending = server.syncMirror({}, { signal: ac.signal });

  for (let i = 0; i < 160 && !fs.existsSync(readyFile); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(fs.existsSync(readyFile), 'real sync.sh -> xargs -> timeout -> git worker must have started');
  const gitPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(gitPid) && gitPid > 0);

  ac.abort();
  const res = await pending;
  assert.equal(res.isError, true);
  assert.match(res.text, /^CANCELLED:/);

  // Inner git worker (even underneath GNU timeout!) must be dead
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    try { process.kill(gitPid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, 'git worker under real sync.sh + xargs + GNU timeout must not outlive MCP cancellation');

  // Lock must be immediately re-acquirable
  const relock = spawnSync(PY, ['-c', `import fcntl, os; fd=os.open(${JSON.stringify(lockPath)}, os.O_RDWR|os.O_CREAT); fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)`]);
  assert.equal(relock.status, 0, 'sync.lock must be immediately released after cancel');

  // Wait past the stub git's 1s write delay and verify ZERO post-cancel writes occurred
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(fs.existsSync(writeMarker), false, 'cancelled git worker must never perform delayed writes');
});

test('Audit #8: perf-metrics.jsonl omits raw query text by default and opts in with GITEA_AUDIT_INCLUDE_QUERY=1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-8-'));
  try {
    const mirror = path.join(dir, 'mirror');
    makeBareRepo(dir, mirror, 'acme', 'app', { 'doc.md': '# PerfPrivacy\nUniqueNonSecretMarker8842\n' });
    const env = cleanEnvFor(dir, mirror, 'acme', { GITEA_AUDIT_LOG: '0' });
    delete env.GITEA_AUDIT_INCLUDE_QUERY;

    assert.equal(spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'acme', '--build'], { env }).status, 0);
    const q1 = spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'acme', '-q', 'UniqueNonSecretMarker8842', '--json'], {
      env, encoding: 'utf8',
    });
    assert.equal(q1.status, 0, q1.stderr);

    const perfLog = path.join(mirror, 'state', 'perf-metrics.jsonl');
    const raw1 = fs.readFileSync(perfLog, 'utf8');
    assert.equal(raw1.includes('UniqueNonSecretMarker8842'), false, 'raw query must NOT appear in perf-metrics.jsonl by default');
    const stats = spawnSync(PY, [GTS, '--perf-stats', '--json'], { env, encoding: 'utf8' });
    assert.equal(stats.status, 0, stats.stderr);
    assert.ok(JSON.parse(stats.stdout).operations.fts_search.count >= 1);

    // Explicit opt-in records truncated query
    const optInEnv = { ...env, GITEA_AUDIT_INCLUDE_QUERY: '1' };
    assert.equal(spawnSync(PY, [INDEXER, '--mirror-root', mirror, '-o', 'acme', '-q', 'UniqueNonSecretMarker8842', '--json'], {
      env: optInEnv,
    }).status, 0);
    const raw2 = fs.readFileSync(perfLog, 'utf8');
    assert.equal(raw2.includes('UniqueNonSecretMarker8842'), true, 'opt-in GITEA_AUDIT_INCLUDE_QUERY=1 should record query');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Audit #9: adding a repo to GITEA_EXCLUDE_REPOS prunes its stale FTS rows incrementally and restores when removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-9-'));
  try {
    const mirror = path.join(dir, 'mirror');
    makeBareRepo(dir, mirror, 'acme', 'keep', { 'doc.md': '# Keep\nKeepSentinel9001\n' });
    makeBareRepo(dir, mirror, 'acme', 'noisy', { 'doc.md': '# Noisy\nNoisySentinel9002\n' });
    const env = cleanEnvFor(dir, mirror, 'acme');

    assert.equal(spawnSync(PY, [GTS, '--reindex'], { env }).status, 0);
    const before = JSON.parse(spawnSync(PY, [GTS, '-D', '--json', 'NoisySentinel9002'], { env, encoding: 'utf8' }).stdout);
    assert.equal(before.total, 1);

    // Exclude noisy and run incremental rebuild -> FTS returns 0, code search still hits
    const exclEnv = { ...env, GITEA_EXCLUDE_REPOS: 'noisy' };
    assert.equal(spawnSync(PY, [GTS, '--reindex'], { env: exclEnv }).status, 0);
    const afterExcl = JSON.parse(spawnSync(PY, [GTS, '-D', '--json', 'NoisySentinel9002'], { env: exclEnv, encoding: 'utf8' }).stdout);
    assert.equal(afterExcl.total, 0, 'excluded repo must be pruned from FTS');
    const keepStill = JSON.parse(spawnSync(PY, [GTS, '-D', '--json', 'KeepSentinel9001'], { env: exclEnv, encoding: 'utf8' }).stdout);
    assert.equal(keepStill.total, 1);
    const codeHit = spawnSync(PY, [GTS, '--json', 'NoisySentinel9002'], { env: exclEnv, encoding: 'utf8' });
    assert.equal(codeHit.status, 0);
    assert.equal(JSON.parse(codeHit.stdout).total, 1, 'code search must still see excluded repo');

    // Remove exclusion and run incremental rebuild -> FTS restores hits
    assert.equal(spawnSync(PY, [GTS, '--reindex'], { env }).status, 0);
    const restored = JSON.parse(spawnSync(PY, [GTS, '-D', '--json', 'NoisySentinel9002'], { env, encoding: 'utf8' }).stdout);
    assert.equal(restored.total, 1, 'removing exclusion must restore FTS hits incrementally');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Audit #16: UTF-8 branch names round-trip from search_code to read_file and gts --read while invalid refs stay rejected', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-16-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirror = path.join(dir, 'mirror');

  makeBareRepo(
    dir,
    mirror,
    'acme',
    'i18n',
    { 'README.md': 'main branch only\n' },
    { '功能/中文': { 'exclusive.md': 'OnlyOnUtf8BranchSentinel1616\n中文分支专属正文\n' } },
  );
  const env = cleanEnvFor(dir, mirror, 'acme');

  // CLI gts --read with UTF-8 branch
  const cliRead = spawnSync(PY, [GTS, '-r', 'acme/i18n', '-b', '功能/中文', '--read', 'exclusive.md'], {
    env, encoding: 'utf8',
  });
  assert.equal(cliRead.status, 0, cliRead.stderr);
  assert.match(cliRead.stdout, /中文分支专属正文/);

  // MCP search_code -> exact ref -> read_file
  await withMcpClient(env, async (client) => {
    const search = await client.callTool({ name: 'search_code', arguments: { query: 'OnlyOnUtf8BranchSentinel1616' } });
    assert.equal(search.isError, undefined);
    const match = /(acme\/i18n)@([^\s:]+):(exclusive\.md):/.exec(search.content[0].text);
    assert.ok(match, `expected UTF-8 ref hit in:\n${search.content[0].text}`);
    const [, repo, ref, filePath] = match;
    assert.equal(ref, '功能/中文');

    const read = await client.callTool({ name: 'read_file', arguments: { repo, ref, path: filePath } });
    assert.equal(read.isError, undefined, read.content[0].text);
    assert.match(read.content[0].text, /中文分支专属正文/);

    // Invalid refs remain rejected
    for (const badRef of ['--output=/tmp/x', '-p', 'a:b', 'a b', 'x\ny', 'main..HEAD', 'a@{0}']) {
      const bad = await client.callTool({ name: 'read_file', arguments: { repo, ref: badRef, path: 'README.md' } });
      assert.equal(bad.isError, true, badRef);
      assert.match(bad.content[0].text, /^INVALID_REF:/, badRef);
    }
  });
});

test('v2.0.3 audit §3.2/§3.8/§3.9: replace refs are ignored uniformly across search_code, read_file, gts --read and annotated tags peel to tree', { timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-audit-replace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mirror = path.join(dir, 'mirror');

  const bare = makeBareRepo(
    dir,
    mirror,
    'acme',
    'snap',
    { 'orig.txt': 'OriginalUnreplacedMarker3232\n' },
    { alt: { 'replaced.txt': 'ReplacedObjectMarker3232\n' } },
  );
  const git = (args) => {
    const r = spawnSync('git', [`--git-dir=${bare}`, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e.invalid' },
    });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  const mainCommit = git(['rev-parse', 'refs/heads/main']);
  const altCommit = git(['rev-parse', 'refs/heads/alt']);
  const mainTree = git(['rev-parse', 'refs/heads/main^{tree}']);
  // Attach a commit replace ref on main -> alt AND delete alt so alt's content only exists via refs/replace
  git(['update-ref', `refs/replace/${mainCommit}`, altCommit]);
  git(['update-ref', '-d', 'refs/heads/alt']);
  // Attach an annotated tag pointing directly to the tree object (tests §3.8 ^{} peeling)
  git(['tag', '-a', 'tree-tag', '-m', 'annotated tag to tree', mainTree]);

  const env = cleanEnvFor(dir, mirror, 'acme');

  // CLI gts: content, path, message, and --read must all observe the unreplaced original object
  const cliContent = spawnSync(PY, [GTS, '-r', 'acme/snap', '-b', 'main', '--json', 'OriginalUnreplacedMarker3232'], { env, encoding: 'utf8' });
  assert.equal(cliContent.status, 0, cliContent.stderr);
  assert.equal(JSON.parse(cliContent.stdout).total, 1);

  const cliReplaced = spawnSync(PY, [GTS, '-r', 'acme/snap', '-b', 'main', '--json', 'ReplacedObjectMarker3232'], { env, encoding: 'utf8' });
  assert.equal(cliReplaced.status, 1, `replace ref leaked into content search: ${cliReplaced.stdout}`);

  const cliPathOrig = spawnSync(PY, [GTS, '-r', 'acme/snap', '-b', 'main', '-p', '--json', 'orig.txt'], { env, encoding: 'utf8' });
  assert.equal(cliPathOrig.status, 0, cliPathOrig.stderr);
  assert.equal(JSON.parse(cliPathOrig.stdout).total, 1);

  const cliPathReplaced = spawnSync(PY, [GTS, '-r', 'acme/snap', '-b', 'main', '-p', '--json', 'replaced.txt'], { env, encoding: 'utf8' });
  assert.equal(cliPathReplaced.status, 1, `replace ref leaked into path search: ${cliPathReplaced.stdout}`);

  const cliMsg = spawnSync(PY, [GTS, '-r', 'acme/snap', '-b', 'main', '-m', '--json', 'branch alt'], { env, encoding: 'utf8' });
  assert.equal(cliMsg.status, 1, `replace ref leaked into message search: ${cliMsg.stdout}`);

  const cliRead = spawnSync(PY, [GTS, '-r', 'acme/snap', '-b', 'main', '--read', 'orig.txt'], { env, encoding: 'utf8' });
  assert.equal(cliRead.status, 0, cliRead.stderr);
  assert.match(cliRead.stdout, /OriginalUnreplacedMarker3232/);

  // Annotated tag pointing to a tree must peel cleanly in gts content/path search and --read
  const cliTreeTagSearch = spawnSync(PY, [GTS, '-r', 'acme/snap', '-A', '-b', 'tree-tag', '--json', 'OriginalUnreplacedMarker3232'], { env, encoding: 'utf8' });
  assert.equal(cliTreeTagSearch.status, 0, cliTreeTagSearch.stderr + cliTreeTagSearch.stdout);
  assert.equal(JSON.parse(cliTreeTagSearch.stdout).total, 1);

  const cliTreeTagRead = spawnSync(PY, [GTS, '-r', 'acme/snap', '-b', 'tree-tag', '--read', 'orig.txt'], { env, encoding: 'utf8' });
  assert.equal(cliTreeTagRead.status, 0, cliTreeTagRead.stderr);
  assert.match(cliTreeTagRead.stdout, /OriginalUnreplacedMarker3232/);

  // MCP read_file must match search_code's --no-replace-objects view and peel annotated tree tags
  await withMcpClient(env, async (client) => {
    const readOrig = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/snap', ref: 'main', path: 'orig.txt' } });
    assert.equal(readOrig.isError, undefined, readOrig.content[0].text);
    assert.match(readOrig.content[0].text, /OriginalUnreplacedMarker3232/);

    const readReplaced = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/snap', ref: 'main', path: 'replaced.txt' } });
    assert.equal(readReplaced.isError, true, 'read_file must not follow refs/replace');

    const readTag = await client.callTool({ name: 'read_file', arguments: { repo: 'acme/snap', ref: 'tree-tag', path: 'orig.txt' } });
    assert.equal(readTag.isError, undefined, readTag.content[0].text);
    assert.match(readTag.content[0].text, /OriginalUnreplacedMarker3232/);
  });
});

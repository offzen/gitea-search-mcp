#!/usr/bin/env node
// audit-b #15：probe-stdio 对 search_code / search_gitea 首行的命中统计必须接受
// 精确数字、零命中与 capped 下界（`≥ N`），且仍须在 isError / 无效响应时失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, 'scripts', 'probe-stdio.mjs');

// 假 server：tools/call 的回复由环境变量 FAKE_STD / FAKE_ALIAS（JSON：{text,isError}）决定。
const FAKE = `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { serverInfo: { name: 'fake', version: '0' }, capabilities: {} } });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: ['list_repositories', 'read_file', 'search_code', 'search_docs', 'sync_mirror'].map((name) => ({ name })) } });
  else if (msg.method === 'tools/call') {
    const spec = JSON.parse(process.env[msg.params.name === 'search_code' ? 'FAKE_STD' : 'FAKE_ALIAS']);
    if (spec.raw) send({ id: msg.id, result: spec.raw });
    else send({ id: msg.id, result: { content: [{ type: 'text', text: spec.text }], ...(spec.isError ? { isError: true } : {}) } });
  }
});
`;

function runProbe(t, std, alias) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-b-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = path.join(dir, 'fake-mcp-server.mjs');
  fs.writeFileSync(server, FAKE);
  return spawnSync(process.execPath, [PROBE, server, 'q'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, GITQ_MIRROR_ROOT: '/tmp/test-mirror', FAKE_STD: JSON.stringify(std), FAKE_ALIAS: JSON.stringify(alias) },
  });
}

const line = (n, lower = false) => ({
  text: `返回 3 条 / 全库命中 ${lower ? '≥ ' : ''}${n} 条 / 2 个仓（扫了 5 个镜像仓；镜像 last_sync: x）\nrepo:path:1: foo`,
});

for (const [label, reply] of [
  ['精确数字', line(42)],
  ['零命中', line(0)],
  ['capped 下界 ≥ N', line(200, true)],
]) {
  test(`probe：标准名与别名均接受 ${label} 首行`, (t) => {
    const r = runProbe(t, reply, reply);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /search_gitea 仍可透明转发/);
    assert.doesNotMatch(r.stdout, /✗/);
  });
}

test('probe：标准名与别名对不同形态混合回复同样通过', (t) => {
  const r = runProbe(t, line(200, true), line(0));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

for (const [label, bad] of [
  ['isError', { text: '返回 1 条 / 全库命中 1 条 /', isError: true }],
  ['无命中统计的无效文本', { text: 'something unrelated' }],
  ['空文本', { text: '' }],
  ['JSON-RPC error', { raw: undefined, text: undefined }],
]) {
  for (const side of ['std', 'alias']) {
    test(`probe：${side === 'std' ? 'search_code' : 'search_gitea'} 的 ${label} 必须失败`, (t) => {
      const good = line(1);
      const badReply = label === 'JSON-RPC error' ? { raw: {}, text: '' } : bad;
      const r = side === 'std' ? runProbe(t, badReply, good) : runProbe(t, good, badReply);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /✗/);
    });
  }
}

#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const gate = fs.readFileSync(new URL('../scripts/ci/linux-gate.sh', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.gitea/workflows/ci.yml', import.meta.url), 'utf8');
const githubCi = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const windowsCi = fs.readFileSync(new URL('../.github/workflows/windows-ci.yml', import.meta.url), 'utf8');
const releaseCi = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('gate2 workflow runs isolated Linux gate with full Python/Node test dependencies', () => {
  assert.match(workflow, /name: gate2 Linux CI/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /scripts\/ci\/linux-gate\.sh/);
  assert.match(workflow, /--upgrade build jieba PyYAML/);
  assert.doesNotMatch(workflow, /windows-latest|self-hosted|vtwsl/i);
});

test('Linux gate strips ambient config aliases and enforces four-cell packaging + hygiene', () => {
  for (const name of [
    'GITEA_MIRROR_ROOT', 'GITEA_MIRROR_PATH', 'GITQ_MIRROR_ROOT',
    'GITEA_OWNERS', 'GITEA_OWNER', 'GITQ_OWNER', 'GITEA_SEARCH_CONFIG',
  ]) {
    assert.match(gate, new RegExp(name));
  }
  assert.match(gate, /collect-test-counts\.py/);
  assert.match(gate, /respawn-mcp\.sh --selftest/);
  assert.match(gate, /test-python-package\.py/);
  assert.match(gate, /test-npm-package\.mjs/);
  assert.match(gate, /check-public-hygiene\.py/);
});

test('GitHub workflows run Linux, macOS, and Windows gates via reusable workflow_call and attest releases', () => {
  assert.doesNotMatch(githubCi, /hosted-linux-receipt|hosted-macos-receipt|write-gate-receipt/);
  assert.doesNotMatch(windowsCi, /hosted-windows-receipt|write-gate-receipt/);
  assert.match(githubCi, /workflow_call:/);
  assert.match(githubCi, /collect-test-counts\.py/);
  assert.match(githubCi, /test-npm-package\.mjs/);
  assert.match(githubCi, /check-public-hygiene\.py/);
  assert.match(githubCi, /test-macos:/);
  assert.match(windowsCi, /workflow_call:/);
  for (const job of ['windows-pe:', 'windows-ps:', 'windows-tests:', 'windows-git-bash:']) {
    assert.match(windowsCi, new RegExp(job));
  }
  assert.match(windowsCi, /W9.*CRLF/);
  assert.match(releaseCi, /uses:\s*\.\/\.github\/workflows\/ci\.yml/);
  assert.match(releaseCi, /uses:\s*\.\/\.github\/workflows\/windows-ci\.yml/);
  assert.match(releaseCi, /actions\/attest-build-provenance@v2/);
});

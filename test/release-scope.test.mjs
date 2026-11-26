#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../lib/server.mjs', import.meta.url), 'utf8');
const naming = fs.readFileSync(new URL('../docs/TOOL-NAMING.md', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const pyproject = fs.readFileSync(new URL('../pyproject.toml', import.meta.url), 'utf8');
const setupLinux = fs.readFileSync(new URL('../scripts/setup.sh', import.meta.url), 'utf8');
const setupMac = fs.readFileSync(new URL('../scripts/setup-macos.sh', import.meta.url), 'utf8');
const setupWindows = fs.readFileSync(new URL('../scripts/setup-windows.ps1', import.meta.url), 'utf8');
const windowsCi = fs.readFileSync(new URL('../.github/workflows/windows-ci.yml', import.meta.url), 'utf8');
const packageGate = fs.readFileSync(new URL('../scripts/test-python-package.py', import.meta.url), 'utf8');
const releaseWorkflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const releaseGuide = fs.readFileSync(new URL('../docs/dev/RELEASE.md', import.meta.url), 'utf8');

test('package, lockfile, pyproject, and MCP server identity stay aligned', () => {
  assert.equal(pkg.name, 'gitea-search-mcp');
  assert.equal(lock.name, 'gitea-search-mcp');
  assert.equal(lock.packages[''].name, 'gitea-search-mcp');
  assert.match(pyproject, /name = "gitea-search-mcp"/);
  assert.equal(pkg.version, lock.version);
  assert.equal(pkg.version, lock.packages[''].version);
  assert.match(pyproject, new RegExp(`version = "${pkg.version.replace(/\./g, '\\.')}"`));
  assert.match(server, /const SERVER_NAME = 'gitea-search-mcp'/);
  assert.match(server, /PKG_META\.version/);
  const forbiddenFallback = new RegExp([
    ['node', 'fallback'].join('-'),
    ['GITEA', 'FORCE', 'NODE', 'FALLBACK'].join('_'),
    ['needs', 'Fallback'].join(''),
  ].join('|'));
  assert.doesNotMatch(server, forbiddenFallback);
});

test('document search declares default-branch scope and cold-start boundary', () => {
  assert.match(server, /scope: default-branches/);
  assert.match(server, /Python\/jieba.*cold|Python\/jieba.*冷启动/);
  assert.match(server, /search_code.*全部 heads/);
});

test('tool naming uses the three-layer host-portable model', () => {
  assert.match(naming, /MCP server 裸名/);
  assert.match(naming, /宿主注册\/函数名/);
  assert.match(naming, /GUI 友好显示名/);
  assert.match(naming, /实际名称必须以当前宿主工具注册表为准/);
});

test('optional skill exists and is not auto-installed', () => {
  const skillPath = 'extras/dsh-skill/gitea-search/SKILL.md';
  const skill = fs.readFileSync(new URL(`../${skillPath}`, import.meta.url), 'utf8');
  assert.match(skill, /default branch/i);
  assert.match(skill, /Install it explicitly/);
  for (const installer of [setupLinux, setupMac, setupWindows]) {
    assert.doesNotMatch(installer, /extras[\\/]dsh-skill|gitea-search[\\/]SKILL\.md/);
  }
});

test('Python and npm artifact validators exist and cover every installed module', () => {
  assert.match(pyproject, /"share\/gitea-search-mcp\/bin"\s*=\s*\["bin\/gts"\]/);
  assert.match(pyproject, /"share\/gitea-search-mcp\/lib"\s*=\s*\[[^\]]*"lib\/indexer\.py"[^\]]*"lib\/config\.py"[^\]]*\]/s);
  assert.equal(fs.existsSync(new URL('../scripts/test-python-package.py', import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('../scripts/test-npm-package.mjs', import.meta.url)), true);
});

test('Windows hosted gates preserve UTF-8 output and native fallback prerequisites', () => {
  assert.match(packageGate, /encoding="utf-8"/);
  assert.match(packageGate, /errors="replace"/);
  assert.match(packageGate, /Path\(config\["mirror_root"\]\)\.mkdir/);
  assert.match(windowsCi, /foreach \(\$isolatedHome in/);
  assert.doesNotMatch(windowsCi, /foreach \(\$home in/);
  assert.match(windowsCi, /choco install sqlite/);
  assert.match(windowsCi, /GTS_BIN=.*command -v/);
  assert.match(windowsCi, /export GTS_BIN/);
  assert.match(setupWindows, /@\('python', @\(\)\), @\('py', @\('-3'\)\)/);
  assert.match(setupWindows, /pathlib\.Path\(sys\.executable\)\.resolve\(\)\.parent/);
});

test('private release candidates share verification and only public tags attest and publish', () => {
  const steps = releaseWorkflow.split(/\n      - name: /).slice(1);
  const verification = steps.filter((step) => /check-public-hygiene\.py|sha256sum/.test(step));
  assert.equal(verification.length, 2);
  for (const step of verification) assert.doesNotMatch(step, /^ {8}if:/m);
  const publicSteps = steps.filter((step) => /repository\.private == false/.test(step));
  assert.equal(publicSteps.length, 2);
  assert.match(publicSteps[0], /uses: actions\/attest-build-provenance@v2/);
  assert.match(publicSteps[1], /gh release upload/);
  assert.match(releaseWorkflow, /uses:\s*\.\/\.github\/workflows\/ci\.yml/);
  assert.match(releaseWorkflow, /uses:\s*\.\/\.github\/workflows\/windows-ci\.yml/);
  assert.match(releaseWorkflow, /needs: \[preflight, ci, windows-ci\]/);
  assert.doesNotMatch(releaseWorkflow, /continue-on-error:/);
  const privateSteps = steps.filter((step) => /repository\.private == true/.test(step));
  assert.equal(privateSteps.length, 1);
  assert.match(privateSteps[0], /::notice::.*Attested releases are published only from the public release repository/);
  assert.match(releaseGuide, /个人私有 GitHub 仓.*候选版本/);
});

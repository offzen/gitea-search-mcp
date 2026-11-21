#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * scripts/test-npm-package.mjs
 * Validates the built `npm pack` tarball from outside the source checkout
 * (4th cell of the packaging matrix alongside checkout, wheel, and sdist).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: IS_WIN && /\.(cmd|bat)$/i.test(cmd),
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  return res;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-npm-pack-test-'));
try {
  const packDir = path.join(scratch, 'pack');
  const unpackDir = path.join(scratch, 'unpacked');
  const neutralCwd = path.join(scratch, 'neutral-cwd');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(unpackDir, { recursive: true });
  fs.mkdirSync(neutralCwd, { recursive: true });

  const npmCmd = IS_WIN ? 'npm.cmd' : 'npm';
  run(npmCmd, ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: ROOT });

  const tarballs = fs.readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `Expected 1 .tgz tarball, found: ${tarballs.join(', ')}`);
  const tarball = path.join(packDir, tarballs[0]);

  run('tar', ['-xzf', tarball, '-C', unpackDir]);
  const pkgRoot = path.join(unpackDir, 'package');

  // 1. Verify required user-facing files are bundled
  const requiredPaths = [
    'package.json',
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
    'UPGRADING.md',
    'bin/mcp-server',
    'bin/gts',
    'src/index.js',
    'lib/server.mjs',
    'lib/config.mjs',
    'lib/config.py',
    'lib/indexer.py',
    'docs/USAGE.md',
    'docs/POST-INSTALL.md',
    'docs/OPERATIONS.md',
    'docs/BOUNDARIES.md',
    'docs/TOOL-NAMING.md',
  ];
  for (const rel of requiredPaths) {
    assert.equal(fs.existsSync(path.join(pkgRoot, rel)), true, `Missing required path in npm tarball: ${rel}`);
  }

  // 2. Verify internal dev/test assets are NOT leaked into published npm tarball
  for (const excluded of ['test', 'docs/dev', 'PROVENANCE.json', 'PROJECT-STATE.md', 'RELEASE-NOTES.md']) {
    assert.equal(fs.existsSync(path.join(pkgRoot, excluded)), false, `Excluded path leaked into npm tarball: ${excluded}`);
  }

  // Link existing node_modules offline so @modelcontextprotocol/sdk resolves without network access
  const rootNodeModules = path.join(ROOT, 'node_modules');
  assert.equal(fs.existsSync(rootNodeModules), true, 'Run npm ci before test-npm-package.mjs');
  fs.symlinkSync(rootNodeModules, path.join(pkgRoot, 'node_modules'), IS_WIN ? 'junction' : 'dir');

  // 3. Static schema export from unpacked tarball in a neutral working directory
  const dump = run(process.execPath, [path.join(pkgRoot, 'bin', 'mcp-server'), '--dump-schema'], { cwd: neutralCwd });
  const schema = JSON.parse(dump.stdout);
  assert.equal(schema.service, 'gitea-search-mcp');
  assert.equal(schema.version, pkg.version);
  assert.equal(schema.functions?.length, 4);

  // 4. End-to-end stdio handshake & search against an isolated bare mirror
  const work = path.join(scratch, 'work');
  const mirror = path.join(scratch, 'mirror');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(path.join(mirror, 'acme'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  run('git', ['init', '-q', '-b', 'main', work]);
  run('git', ['-C', work, 'config', 'user.name', 'Pack Test']);
  run('git', ['-C', work, 'config', 'user.email', 'pack@example.invalid']);
  fs.writeFileSync(path.join(work, 'README.md'), 'NpmPackSmokeToken verification\n');
  run('git', ['-C', work, 'add', 'README.md']);
  run('git', ['-C', work, 'commit', '-qm', 'init']);
  run('git', ['clone', '-q', '--bare', work, path.join(mirror, 'acme', 'demo.git')]);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GITEA_MIRROR_ROOT: mirror,
    GITEA_OWNERS: 'acme',
  };
  delete env.GITEA_SEARCH_CONFIG;
  delete env.GTS_BIN;
  delete env.GITQ_BIN;

  if (IS_WIN) {
    const py = 'python';
    const wrapper = path.join(scratch, 'gts-pack.cmd');
    fs.writeFileSync(wrapper, `@echo off\r\n${py} "${path.join(pkgRoot, 'bin', 'gts')}" %*\r\n`);
    env.GITEA_SEARCH_CLI = wrapper;
  } else {
    fs.chmodSync(path.join(pkgRoot, 'bin', 'gts'), 0o755);
    env.GITEA_SEARCH_CLI = path.join(pkgRoot, 'bin', 'gts');
  }

  run(
    process.execPath,
    [path.join(ROOT, 'scripts', 'probe-stdio.mjs'), path.join(pkgRoot, 'bin', 'mcp-server'), 'NpmPackSmokeToken'],
    { cwd: neutralCwd, env },
  );

  process.stdout.write(`NPM_PACK_OK: ${tarballs[0]} verified outside source checkout\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

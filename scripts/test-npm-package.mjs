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
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function extractTgz(tgzPath, destDir) {
  const tar = zlib.gunzipSync(fs.readFileSync(tgzPath));
  const rootResolved = path.resolve(destDir);
  let offset = 0;
  let nextPathOverride = null;

  const readCString = (buf, start, len) => {
    const sub = buf.subarray(start, start + len);
    const nul = sub.indexOf(0);
    return (nul === -1 ? sub : sub.subarray(0, nul)).toString('utf8');
  };

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;

    const modeRaw = readCString(header, 100, 8).trim();
    const fileMode = modeRaw ? parseInt(modeRaw, 8) : 0o644;
    const sizeRaw = readCString(header, 124, 12).trim();
    const size = sizeRaw ? parseInt(sizeRaw, 8) : 0;
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const dataStart = offset;
    const dataEnd = dataStart + size;
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === 'x' || typeFlag === 'g') {
      // PAX extended header: "<len> <key>=<value>\n"
      const paxText = tar.subarray(dataStart, dataEnd).toString('utf8');
      let pos = 0;
      while (pos < paxText.length) {
        const sp = paxText.indexOf(' ', pos);
        if (sp === -1) break;
        const recLen = parseInt(paxText.slice(pos, sp), 10);
        if (!recLen || recLen <= 0) break;
        const rec = paxText.slice(sp + 1, pos + recLen - 1);
        const eq = rec.indexOf('=');
        if (eq !== -1 && rec.slice(0, eq) === 'path') {
          nextPathOverride = rec.slice(eq + 1);
        }
        pos += recLen;
      }
      continue;
    }

    if (typeFlag === 'L') {
      nextPathOverride = readCString(tar, dataStart, size);
      continue;
    }

    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const entryName = nextPathOverride ?? (prefix ? `${prefix}/${name}` : name);
    nextPathOverride = null;
    if (!entryName) continue;

    const outPath = path.resolve(rootResolved, entryName);
    if (outPath !== rootResolved && !outPath.startsWith(rootResolved + path.sep)) {
      throw new Error(`Unsafe tar entry path: ${entryName}`);
    }

    if (typeFlag === '5' || entryName.endsWith('/')) {
      fs.mkdirSync(outPath, { recursive: true });
    } else if (typeFlag === '0') {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, tar.subarray(dataStart, dataEnd), { mode: fileMode });
      if (!IS_WIN && (fileMode & 0o111) !== 0) {
        fs.chmodSync(outPath, fileMode & 0o777);
      }
    }
  }
}

function winQuoteArg(arg) {
  const s = String(arg);
  if (!/[\s"&|<>^()]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

function run(cmd, args, opts = {}) {
  const useCmdExe = IS_WIN && /\.(cmd|bat)$/i.test(cmd);
  const spawnCmd = useCmdExe ? (process.env.ComSpec || 'cmd.exe') : cmd;
  const spawnArgs = useCmdExe
    ? ['/d', '/s', '/c', `"${[cmd, ...args].map(winQuoteArg).join(' ')}"`]
    : args;
  const res = spawnSync(spawnCmd, spawnArgs, {
    encoding: 'utf8',
    windowsVerbatimArguments: useCmdExe,
    windowsHide: true,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
  assert.equal(
    String(res.stderr || '').includes('DEP0190'),
    false,
    `Unexpected Node DEP0190 warning while running ${cmd}:\n${res.stderr}`,
  );
  return res;
}

function walkFiles(dir, relBase = '') {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(`${rel}/`, ...walkFiles(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gts-npm-pack-test-'));
try {
  const packDir = path.join(scratch, 'pack');
  const unpackDir = path.join(scratch, 'unpacked');
  const neutralCwd = path.join(scratch, 'neutral-cwd');
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(unpackDir, { recursive: true });
  fs.mkdirSync(neutralCwd, { recursive: true });

  const explicitTarball = process.argv[2] ? path.resolve(process.argv[2]) : null;
  let tarball;
  if (explicitTarball) {
    assert.equal(fs.existsSync(explicitTarball), true, `Tarball argument not found: ${explicitTarball}`);
    tarball = explicitTarball;
  } else {
    const npmCmd = IS_WIN ? 'npm.cmd' : 'npm';
    run(npmCmd, ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: ROOT });
    const tarballs = fs.readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
    assert.equal(tarballs.length, 1, `Expected 1 .tgz tarball, found: ${tarballs.join(', ')}`);
    tarball = path.join(packDir, tarballs[0]);
  }

  extractTgz(tarball, unpackDir);
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
    'lib/mirror-state.mjs',
    'lib/mirror_state.py',
    'lib/next-actions.mjs',
    'scripts/sync.sh',
    'scripts/probe-stdio.mjs',
    'scripts/doctor-mcp.sh',
    'scripts/doctor-mcp.ps1',
    'scripts/onboarding.sh',
    'scripts/onboarding.ps1',
    'docs/USAGE.md',
    'docs/POST-INSTALL.md',
    'docs/OPERATIONS.md',
    'docs/BOUNDARIES.md',
    'docs/TOOL-NAMING.md',
  ];
  for (const rel of requiredPaths) {
    assert.equal(fs.existsSync(path.join(pkgRoot, rel)), true, `Missing required path in npm tarball: ${rel}`);
  }

  // 2. Verify internal dev/CI/test assets and Python bytecode caches are NOT leaked into published npm tarball
  for (const excluded of [
    'test',
    'docs/dev',
    'scripts/ci',
    'scripts/test-npm-package.mjs',
    'scripts/test-python-package.py',
    'scripts/collect-test-counts.py',
    'scripts/check-public-hygiene.py',
    'scripts/run-e2e-test.sh',
    'scripts/run-realdata-test.sh',
    'PROVENANCE.json',
    'PROJECT-STATE.md',
    'RELEASE-NOTES.md',
  ]) {
    assert.equal(fs.existsSync(path.join(pkgRoot, excluded)), false, `Excluded path leaked into npm tarball: ${excluded}`);
  }
  const bundledEntries = walkFiles(pkgRoot);
  const leakedBytecode = bundledEntries.filter((p) => p.includes('__pycache__') || /\.(pyc|pyo)$/i.test(p));
  assert.deepEqual(leakedBytecode, [], `Python bytecode leaked into npm tarball: ${leakedBytecode.join(', ')}`);

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
    [path.join(pkgRoot, 'scripts', 'probe-stdio.mjs'), path.join(pkgRoot, 'bin', 'mcp-server'), 'NpmPackSmokeToken'],
    { cwd: neutralCwd, env },
  );

  process.stdout.write(`NPM_PACK_OK: ${path.basename(tarball)} verified outside source checkout\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

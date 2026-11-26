#!/usr/bin/env node
/**
 * gitea-search-mcp —— 把本地 Gitea / Forgejo / Git 裸镜像暴露成通用 MCP 工具。
 *
 * 为什么需要它：Gitea/Forgejo 服务端未开 repo indexer 时，网页/API 无法跨仓搜文件内容；
 * 本服务基于本地 bare mirror，让任意 MCP 宿主（Claude Desktop / Cursor / Cline /
 * Windsurf / Codex / DSH 等）直接搜到并读出可复用内容（代码、脚本、compose、runbook、
 * 排障记录、文档与导出会话）。
 *
 * 工具（v2.x 标准裸名；tools/call 透明兼容 v1.x search_gitea* 与历史 search_gitorca*）：
 *   search_code        内容 / 路径 / 提交信息搜索（跨全部镜像仓、全部本地分支）
 *   search_docs        文档 / 会话 / 配置 / 脚本 SQLite FTS5 + Jieba 全文检索
 *   read_file          按 仓+路径[+ref] 读文件全文（搜到之后直接取用）
 *   list_repositories  列出镜像里的仓（可按名字过滤）
 *
 * 依赖：Python 3.10+、jieba、gts CLI（bin/gts 或已安装的 gts / gts.exe）、
 *       本地 bare 镜像、@modelcontextprotocol/sdk（本目录 node_modules）。
 *
 * 注意：stdout 只能出现 JSON-RPC，日志与废弃告警一律走 stderr。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.mjs';
import { readSyncState } from './mirror-state.mjs';
import { createAuditLogger } from './audit.mjs';
import { findPrivateKeyLineIndices, getSecurityPolicy, isSensitivePath, mightBePemBlockLine, redactSecrets } from './security.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const MODULE_DIR = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));
const PKG_META = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SERVER_NAME = 'gitea-search-mcp';
const SERVER_VERSION = PKG_META.version || '0.0.0';

let _runtimeInitialized = false;
let EFFECTIVE_CONFIG = {
  mirror_root: '',
  owners: [],
  sources: { mirror_root: 'uninitialized', owners: 'missing' },
  config_path: null,
  valid: false,
  errors: ['config not initialized'],
  warnings: [],
};
let MIRROR_ROOT = '';
let OWNERS = [];
let OWNER = '';
let MIRROR = '';
let CONFIG_ERROR = '';
let MAX_READ_BYTES = 60000;
let READ_DEFAULT_LINES = 400;
let MAX_RESULTS = 200;
let MAX_SEARCH_BYTES = 131072;
let MAX_LINE_BYTES = 2000;
let MAX_CONCURRENCY = 4;
let MAX_BLOB_BYTES = 32 * 1024 * 1024;
let MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024;
let SYNC_TIMEOUT_MS = 900 * 1000;
const _WARNED_ENV = new Set();

function readEnvWithLegacy(primary, legacy) {
  if (process.env[primary] !== undefined && process.env[primary] !== '') {
    return process.env[primary];
  }
  if (legacy && process.env[legacy] !== undefined && process.env[legacy] !== '') {
    if (!_WARNED_ENV.has(legacy)) {
      _WARNED_ENV.add(legacy);
      log(`⚠️ 环境变量 ${legacy} 已废弃，请改用 ${primary}。`);
    }
    return process.env[legacy];
  }
  return undefined;
}

function ensureRuntimeConfig() {
  if (_runtimeInitialized) return EFFECTIVE_CONFIG;
  _runtimeInitialized = true;
  EFFECTIVE_CONFIG = resolveConfig({ projectDir: path.join(MODULE_DIR, '..') });
  MIRROR_ROOT = EFFECTIVE_CONFIG.mirror_root;
  OWNERS = EFFECTIVE_CONFIG.owners;
  OWNER = OWNERS[0] || '';
  MIRROR = OWNER ? path.join(MIRROR_ROOT, OWNER) : MIRROR_ROOT;
  CONFIG_ERROR = EFFECTIVE_CONFIG.valid ? '' : `CONFIG_ERROR: ${EFFECTIVE_CONFIG.errors.join('; ')}`;
  const maxReadRaw = Number(readEnvWithLegacy('GITEA_MAX_READ_BYTES', 'GITQ_MAX_READ_BYTES'));
  MAX_READ_BYTES = maxReadRaw > 0 ? maxReadRaw : 60000;
  const readLinesRaw = Number(readEnvWithLegacy('GITEA_READ_DEFAULT_LINES', 'GITQ_READ_DEFAULT_LINES'));
  READ_DEFAULT_LINES = readLinesRaw > 0 ? readLinesRaw : 400;
  // 命中条数硬夹：max_results 是软约束（模型可传大数），这里硬夹到 GITEA_MAX_RESULTS（默认 200），
  // 防止输出面无限放大；配合字节护栏形成双层有界。
  const maxResultsRaw = Number(readEnvWithLegacy('GITEA_MAX_RESULTS', 'GITQ_MAX_RESULTS'));
  MAX_RESULTS = maxResultsRaw > 0 ? Math.min(maxResultsRaw, 1000) : 200;
  // 输出护栏：单行上限 + 总量上限，防止压缩/打包单行大文件撑爆上下文，均可用 env 覆盖。
  const maxSearchRaw = Number(readEnvWithLegacy('GITEA_MAX_SEARCH_BYTES', 'GITQ_MAX_SEARCH_BYTES'));
  MAX_SEARCH_BYTES = maxSearchRaw > 0 ? maxSearchRaw : 131072;
  const maxLineRaw = Number(readEnvWithLegacy('GITEA_MAX_LINE_BYTES', 'GITQ_MAX_LINE_BYTES'));
  MAX_LINE_BYTES = maxLineRaw > 0 ? maxLineRaw : 2000;
  // 2.0.3 资源护栏：并发上限、可读 blob 上限、子进程输出上限、同步超时（均可用 env 覆盖）。
  const concRaw = Math.floor(Number(process.env.GITEA_MAX_CONCURRENCY));
  MAX_CONCURRENCY = concRaw > 0 ? Math.min(concRaw, 64) : 4;
  const blobRaw = Number(process.env.GITEA_MAX_BLOB_BYTES);
  MAX_BLOB_BYTES = blobRaw > 0 ? blobRaw : 32 * 1024 * 1024;
  const childOutRaw = Number(process.env.GITEA_MAX_CHILD_OUTPUT_BYTES);
  MAX_CHILD_OUTPUT_BYTES = childOutRaw > 0 ? childOutRaw : 64 * 1024 * 1024;
  const syncRaw = Number(process.env.GITEA_SYNC_TIMEOUT);
  SYNC_TIMEOUT_MS = (syncRaw > 0 ? syncRaw : 900) * 1000;
  return EFFECTIVE_CONFIG;
}

/** 截断到字节上限，并退掉残缺的 UTF-8 序列（**含孤立首字节**，否则切出半个汉字会漏 U+FFFD）。 */
function truncateUtf8(s, maxBytes) {
  let b = Buffer.from(s).subarray(0, Math.max(0, maxBytes));
  while (b.length > 0 && (b[b.length - 1] & 0xc0) === 0x80) b = b.subarray(0, b.length - 1);
  while (b.length > 0 && (b[b.length - 1] & 0xc0) === 0xc0) b = b.subarray(0, b.length - 1);
  return b;
}

/**
 * search_gitea 的输出护栏：就地截断超长行、丢弃超出总量预算的行。
 * 2026-10-14 加固（与 dsh-search-delivery/gitea-search-guard/cap-search-lines.mjs 对齐）：
 *   · 截断标注**计入单行配额**（此前标注拼在配额外，「单行上限 2000B」实际渲染 2050B）
 *   · 护栏提示行**计入总量预算**并做预留+收尾（此前提示在预算外，上限设得比提示还小时产出照超）
 *   · 截断退**孤立 UTF-8 首字节**（此前只退续位字节，切在汉字中间会漏 U+FFFD）
 * @param {string[]} lines 已拼好的结果行（含首行统计与末尾提示）。
 * @returns {[string[], string[]]} [截断后的行, 护栏提示行（追加到结果尾部）]。
 */
function capSearchLines(lines) {
  const capped = [];
  const notes = [];
  let used = 0;
  let clippedLines = 0;
  let clippedBytes = 0;
  let dropped = 0;
  let budgetDropped = 0;
  for (const raw of lines) {
    let line = raw;
    const rawLen = Buffer.byteLength(line);
    if (rawLen > MAX_LINE_BYTES) {
      // 标注算进配额：先给标注留位置，放不下就换更短标注。
      let tag = `[…截断，原行 ${rawLen}B > 单行上限 ${MAX_LINE_BYTES}B]`;
      if (Buffer.byteLength(tag) >= MAX_LINE_BYTES) tag = `[…${rawLen}B]`;
      const budget = MAX_LINE_BYTES - Buffer.byteLength(tag);
      line = (budget > 0 ? truncateUtf8(line, budget).toString('utf8') : '') + tag;
      clippedLines += 1;
      clippedBytes += rawLen - Buffer.byteLength(line);
    }
    const lineLen = Buffer.byteLength(line);
    if (used + lineLen > MAX_SEARCH_BYTES) {
      dropped += 1;
      continue;
    }
    capped.push(line);
    used += lineLen;
  }
  if (clippedLines > 0) {
    notes.push(`⚠️ 输出护栏：${clippedLines} 行超单行上限 ${MAX_LINE_BYTES}B 已就地截断（省约 ${(clippedBytes / 1024).toFixed(0)}KB）。` +
      `这类行多为压缩/打包产物：改用 files_only=true 探路，再 read_file 按文件取（自带 60KB 截断）。`);
  }
  if (dropped > 0) {
    notes.push(`⚠️ 输出护栏：总量达 ${MAX_SEARCH_BYTES}B，末尾 ${dropped} 行被丢弃。` +
      `要全部命中请缩 max_results / 限定 repo / 用 files_only=true；护栏上限可经 env GITEA_MAX_SEARCH_BYTES 调大。`);
  }
  // 提示行也必须落在预算内：先按最宽计数预留，再收尾，保证「最终产出 ≤ 预算」是硬承诺。
  const bytes = (arr) => arr.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  const budgetNote = (n) => `⚠️ 输出护栏：为容纳本提示又丢弃 ${n} 行（预算 ${MAX_SEARCH_BYTES}B 过小，建议调大 GITEA_MAX_SEARCH_BYTES）。`;
  while (capped.length > 0 && bytes(capped) + bytes(notes) + Buffer.byteLength(budgetNote(999999)) > MAX_SEARCH_BYTES) {
    capped.pop();
    budgetDropped += 1;
  }
  if (budgetDropped > 0) notes.push(budgetNote(budgetDropped));
  while (capped.length > 0 && bytes([...capped, ...notes]) > MAX_SEARCH_BYTES) capped.pop();
  if (bytes(notes) > MAX_SEARCH_BYTES) {
    notes.length = 0;
    const minimal = `⚠️ 输出护栏：预算 ${MAX_SEARCH_BYTES}B 过小，已省略明细。请调大 GITEA_MAX_SEARCH_BYTES。`;
    notes.push(Buffer.byteLength(minimal) <= MAX_SEARCH_BYTES ? minimal : truncateUtf8(minimal, MAX_SEARCH_BYTES).toString('utf8'));
  }
  return [capped, notes];
}

function log(...a) {
  process.stderr.write(`[${SERVER_NAME}] ` + a.join(' ') + '\n');
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ── Windows 平台适配 ────────────────────────────────────────────────────────
// 背景（见 HANDOFF-2026-10-28 与 admin-input 两份分析）：
//   1) Windows 的 CreateProcess **只认 PE 文件**，没有 shebang 机制 ⇒ bin/gts（python 脚本、
//      无扩展名）在 Windows 上根本无法被 spawn 执行。必须有一个 .exe 入口
//      （pip install 生成的 console_scripts launcher，或 PyInstaller 产物）。
//   2) 旧代码 fs.accessSync(c, X_OK) 在 Windows 上**可执行性判定退化为存在性检查**，
//      会把 bin/gts 误判成「找到了」，随后 spawn 失败抛 EFTYPE/ENOEXEC —— 用户看到的
//      不是那条友好的「找不到 gts CLI」提示，而是莫名其妙的错误。这里改为按平台判定。
//   3) .cmd / .bat 是**批处理**，不在 CreateProcess 的直执行范围内，只能靠 shell:true
//      交给 cmd.exe 展开（见 run()）。因此 findSearchCli 必须把选中的类型带出去。
const IS_WIN = process.platform === 'win32';
let NEXT = null;
try { NEXT = await import('./next-actions.mjs'); } catch (error) { log('optional next-actions unavailable:', error?.message || error); }
const WIN_EXEC_EXTS = ['.exe', '.com'];
const WIN_SHELL_EXTS = ['.cmd', '.bat'];

/**
 * 平台感知的路径归一化：把用户传入的 path 转成 git tree object 内可定位的形式。
 *
 * git tree object 内部一律以 "/" 分隔，所以 Windows 侧传来的 "docs\readme.md"
 * 必须转成 "docs/readme.md" 才能命中。但反斜杠在两类文件系统上语义相反：
 *   - Windows (NTFS)："\" 是保留分隔符，文件名里不可能出现 → 见到即可安全转换
 *   - POSIX (ext4/APFS)："\" 是**合法文件名字符**，"a\b.md" 是真实存在的单文件名，
 *     Git 会如实保留。无脑转换会让 git show 静默返回另一个文件（"a/b.md"）的内容，
 *     且不报错 —— 调用方（含 LLM）会拿着错误内容继续推理。
 * 因此 POSIX 侧必须保持路径原样，只剥除首部 "/" 以对齐 git 的相对路径语义。
 */
function normalizeGitPath(p) {
  const s = String(p || '');
  return IS_WIN ? s.replace(/\\/g, '/').replace(/^\/+/, '') : s.replace(/^\/+/, '');
}

/** Windows 下判定该路径能否被 CreateProcess 直接执行（PE），或需 shell 展开（批处理）。 */
function classifyWinExecutable(p) {
  const ext = path.extname(String(p)).toLowerCase();
  if (WIN_EXEC_EXTS.includes(ext)) return 'direct';
  if (WIN_SHELL_EXTS.includes(ext)) return 'shell';
  return null; // .py / 无扩展名（bin/gts）等一律不可执行
}

/** 跨平台的可执行性判定。返回 'direct' | 'shell' | null。 */
function probeExecutable(c) {
  try {
    const st = fs.statSync(c);
    if (!st.isFile()) return null;
    if (IS_WIN) return classifyWinExecutable(c);
    fs.accessSync(c, fs.constants.X_OK);
    return 'direct';
  } catch {
    return null;
  }
}

/**
 * PATH 命中的「像不像本项目 CLI」启发式诊断 —— **不是安全边界，不构成身份校验**。
 *
 * 它只是跑一次 `--help` 再匹配文本：任何恶意/同名程序都可以印出 "gitea" 字样蒙混过关，
 * 而且「为了校验先执行它」本身就是在运行不可信程序。因此真正的安全约束是机械的、发生在
 * 执行任何候选之前：PATH 只接受绝对路径目录（safePathDirs），命中后做 realpath 并重新校验
 * 可执行性（见 resolveSearchCli）。
 *
 * 本函数保留的唯一用途是可用性提示：实测 Linux 上 22 个 PATH 目录 × 3 个基名会生成 63 个
 * 候选，其中恰好叫 gts 的别家程序（例如 libgts-bin 的 GNU Triangulated Surface 工具）
 * 会被「可执行」选中，随后报含糊的「输出无法解析」。命中该启发式失败时跳过并给出明确提示。
 * 固定安装位（/usr/local/bin、~/bin、dist 产物）属官方约定位置，不做诊断。
 */
const GTS_IDENTITY_RE = /gitea|gitq|dsh-search/i;

function looksLikeGtsCli(bin, kind) {
  try {
    const r = spawnSync(bin, ['--help'], {
      timeout: 5000,
      windowsHide: true,
      shell: IS_WIN && kind === 'shell',
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    });
    if (r.error || r.status === null) return false;
    return GTS_IDENTITY_RE.test(`${r.stdout || ''}\n${r.stderr || ''}`);
  } catch {
    return false;
  }
}

/**
 * 机械约束：PATH 只接受**绝对路径**目录。
 * 空项、`.`、相对路径（含 Windows 的 `C:foo`）一律拒绝——它们会让进程在当前工作目录
 * （可能是被检出的不可信仓库）里解析出同名可执行文件并运行。返回 { dirs, rejected }，
 * rejected 保留原文（空项用 '(空项)' 表示）以便给出可诊断的提示。
 */
function safePathDirs(rawPath) {
  const dirs = [];
  const rejected = [];
  if (rawPath === undefined || rawPath === null) return { dirs, rejected }; // PATH 未设置：没有任何项
  for (const raw of String(rawPath).split(path.delimiter)) {
    const d = raw.trim().replace(/^"|"$/g, '');
    if (d && path.isAbsolute(d)) dirs.push(d);
    else rejected.push(raw.trim() === '' ? '(空项)' : raw);
  }
  return { dirs, rejected };
}

/** 显式 GTS_BIN/GITQ_BIN 不可用时，给出具体原因。 */
function explainUnusable(c) {
  let st;
  try { st = fs.statSync(c); } catch (e) { return e.code === 'ENOENT' ? '文件不存在' : `无法访问（${e.code || e.message}）`; }
  if (!st.isFile()) return '不是普通文件';
  if (IS_WIN) return '在 Windows 上不是可执行文件（需要 .exe 或 .cmd）';
  return '没有执行权限';
}

// 探测结果缓存：候选已从 11 个膨胀到 69 个（含 PATH 派生），且全部是同步 statSync，
// 会阻塞事件循环。search/list/docs 每次工具调用都会触发一次，必须缓存。
// 例外：显式指定 GTS_BIN/GITQ_BIN 时不缓存——那是用户自救路径，改了应立即生效。
let _cachedSearchCli = null;
let _searchCliResolved = false;

function findSearchCli() {
  const hasExplicit = Boolean(process.env.GITEA_SEARCH_CLI || process.env.GTS_BIN || process.env.GITQ_BIN);
  if (hasExplicit) return resolveSearchCli();
  if (_searchCliResolved) return _cachedSearchCli;
  _cachedSearchCli = resolveSearchCli();
  _searchCliResolved = true;
  return _cachedSearchCli;
}

function resolveSearchCli() {
  const home = os.homedir();
  // 显式指定（GITEA_SEARCH_CLI > GTS_BIN > GITQ_BIN）优先级最高：这是用户自救路径，也是官方文档推荐的
  // Windows 用法（把 GITEA_SEARCH_CLI / GTS_BIN 指向 gts.exe）。**显式设置了就必须可用**：
  // 不可用时返回 { error }（调用方作为结构化错误上报），绝不静默回落到固定位/PATH，
  // 否则用户会以为自己在用指定的版本。仅当三者都未设置才走后面的自动查找。
  // 相对路径按当前目录解析成绝对路径，保证「探测的文件」与「spawn 的文件」是同一个（裸名 spawn 会去 PATH 里找）。
  const explicitVar = process.env.GITEA_SEARCH_CLI
    ? 'GITEA_SEARCH_CLI'
    : (process.env.GTS_BIN ? 'GTS_BIN' : (process.env.GITQ_BIN ? 'GITQ_BIN' : null));
  if (explicitVar) {
    if (explicitVar === 'GITQ_BIN') {
      log('⚠️ 环境变量 GITQ_BIN 已废弃，请改用 GITEA_SEARCH_CLI（或 GTS_BIN）。');
    }
    const raw = process.env[explicitVar];
    const c = path.resolve(expandHome(raw));
    const kind = probeExecutable(c);
    if (kind) return { bin: c, kind };
    return {
      error: `错误：${explicitVar}=${raw} 指向的 gts CLI 不可用（${c}：${explainUnusable(c)}）。\n`
        + `显式指定的 ${explicitVar} 不会静默回落到 PATH/固定安装位；请修正该路径，或取消设置 ${explicitVar} 以使用自动查找。`,
    };
  }

  const posix = [
    path.join(MODULE_DIR, '..', 'bin', 'gts'),
    path.join(MODULE_DIR, '..', 'bin', 'gitq'),
    path.join(MODULE_DIR, 'bin', 'gts'),
    path.join(MODULE_DIR, 'bin', 'gitq'),
    path.join(MODULE_DIR, 'gts'),
    path.join(MODULE_DIR, 'gitq'),
    '/usr/local/bin/gts',
    '/usr/local/bin/dsh-search',
    '/usr/local/bin/gitq',
    path.join(home, 'bin', 'gts'),
    path.join(home, 'bin', 'gitq'),
  ];
  // Windows 专属候选：PyInstaller 的 dist 产物、pip 的 Scripts 目录、仓库根。
  const win = [
    path.join(MODULE_DIR, '..', 'dist', 'gts', 'gts.exe'),
    path.join(MODULE_DIR, '..', 'dist', 'gts.exe'),
    path.join(MODULE_DIR, '..', 'bin', 'gts.exe'),
    path.join(MODULE_DIR, '..', 'bin', 'gts.cmd'),
    path.join(home, 'AppData', 'Roaming', 'Python', 'Scripts', 'gts.exe'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Scripts', 'gts.exe'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Scripts', 'gts.exe')] : []),
  ];
  // 同一目录里，Windows 还会尝试「gts + 各扩展名」的变体。
  const winVariants = IS_WIN
    ? [...WIN_EXEC_EXTS, ...WIN_SHELL_EXTS].map((e) => path.join(MODULE_DIR, '..', 'bin', 'gts' + e))
    : [];

  // 从 PATH 环境变量搜索（支持已配置进 PATH 的环境或已激活的 venv/conda）。
  // 只用绝对路径目录：空项/`.`/相对目录会在 cwd（可能是不可信仓库）里解析出植入的程序。
  const { dirs: pathDirs, rejected: pathRejected } = safePathDirs(process.env.PATH);
  const pathCands = [];
  const baseNames = ['gts', 'gitq', 'dsh-search'];
  for (const d of pathDirs) {
    for (const b of baseNames) {
      if (IS_WIN) {
        for (const ext of [...WIN_EXEC_EXTS, ...WIN_SHELL_EXTS]) {
          pathCands.push(path.join(d, b + ext));
        }
      } else {
        pathCands.push(path.join(d, b));
      }
    }
  }

  // 1) 固定安装位优先：官方约定位置，命中即用，零额外开销
  const fixed = [...posix, ...win, ...winVariants].filter(Boolean);
  for (const c of fixed) {
    const kind = probeExecutable(c);
    if (kind) return { bin: c, kind };
  }
  // 2) 固定位全未命中才动用 PATH：先拒绝非绝对路径项，命中后 realpath 并对解析结果重新校验，
  //    最后才做（非安全边界的）启发式诊断。采用并 spawn 的是 realpath 之后的真实文件。
  if (pathRejected.length) {
    log(`警告：PATH 含非绝对路径项，已忽略（相对目录/空项/当前目录会让仓库内植入的程序被执行）：${pathRejected.map((x) => JSON.stringify(x)).join(', ')}`);
  }
  for (const c of pathCands) {
    if (!probeExecutable(c)) continue;
    let real;
    try { real = fs.realpathSync(c); } catch (e) {
      log(`提示：PATH 中的 ${c} 无法解析真实路径（${e.code || e.message}），已跳过。`);
      continue;
    }
    const realKind = path.isAbsolute(real) ? probeExecutable(real) : null;
    if (!realKind) {
      log(`提示：PATH 中的 ${c} 解析为 ${real}，但它不是可执行的普通文件，已跳过。`);
      continue;
    }
    if (looksLikeGtsCli(real, realKind)) return { bin: real, kind: realKind };
    log(`提示：PATH 中的 ${c}（${real}）可执行，但其 --help 不含 Gitea/gitq/dsh-search 特征，不像是本项目的 gts CLI，已跳过（仅启发式提示，非安全判定）。`);
  }
  return null;
}

const findGts = findSearchCli;

/** 找不到 gts CLI 时的平台化提示。Python 3.10+ 与 gts CLI 为硬性必备依赖，缺失必须明确 fail-closed。 */
function missingCliMessage() {
  if (IS_WIN) {
    return '错误：找不到可执行的 gts CLI（本服务需要 Python 3.10+ 与 gts CLI，不提供无 Python 降级模式）。\n'
      + 'Windows 的 CreateProcess 只认 .exe（不认 shebang），因此 bin/gts 这种 Python 脚本无法被直接执行。\n'
      + '请任选其一：\n'
      + '  1) 在项目根目录执行 `python -m pip install ".[fts]"`，生成 <Python>\\Scripts\\gts.exe，并设 GITEA_SEARCH_CLI（或 GTS_BIN）指向它；\n'
      + '  2) 用 PyInstaller 打包：`pyinstaller --onedir --name gts --hidden-import=indexer --paths=lib bin\\gts`，\n'
      + '     再设 GITEA_SEARCH_CLI=<项目>\\dist\\gts\\gts.exe。\n'
      + '注意：GITEA_SEARCH_CLI / GTS_BIN 必须是单个可执行文件路径，不能写成 "python bin\\gts"（后者会 ENOENT）。';
  }
  return '错误：找不到 gts CLI（本服务需要 Python 3.10+、jieba 与 gts CLI，不提供无 Python 降级模式）。\n'
    + '请在项目根目录执行 `python3 -m pip install ".[fts]"`，或设 GITEA_SEARCH_CLI（兼容 GTS_BIN）指向可执行的 bin/gts。';
}

// Windows 下 shell:true 的引号处理：cmd.exe 会解释 & | < > ^ 等元字符，
// 而搜索模式（pattern）是用户/模型可控的任意字符串，必须逐参数加引号并转义，
// 否则一个 `a&b` 就能变成命令注入。这里只做「一个参数 → 一个带引号 token」。
//
// 前置拒绝：含 \r \n \0 的参数**不能**安全地放进 cmd.exe 命令行 —— 换行会在该处截断命令行
// （其后的内容被当作新命令或被丢弃），NUL 同理。pattern 是模型可控输入，所以这里明确抛错
// （err.code === 'ARG_REJECTED'）而不是静默截断/清洗。
function winQuoteArg(a) {
  const s = String(a);
  const ctrl = /[\r\n\0]/.exec(s);
  if (ctrl) {
    const err = new Error(`ARG_REJECTED: 参数 ${JSON.stringify(s.slice(0, 40))} 含换行/NUL 字符（${JSON.stringify(ctrl[0])}），cmd.exe 会在该处截断命令行，已拒绝（未构造命令行）。请去掉换行后重试。`);
    err.code = 'ARG_REJECTED';
    throw err;
  }
  // cmd.exe 的引号约定（与 CommandLineToArgvW 对齐）：
  //   1) 双引号内的 " 用 "" 表示（cmd 自身规则）；
  //   2) **紧贴收尾引号的反斜杠必须翻倍** —— 否则那个 \ 会把收尾引号转义掉，
  //      引号失配，后面的字符被当作命令的一部分。
  // 实测（2026-10-28，GitHub windows-latest W8-6）：
  //   参数 'trailing\' 直接拼成 "trailing\" 时往返失败，实际收到 'trailing""'。
  //   规则：字符串末尾连续的 N 个反斜杠，在收尾引号前要变成 2N 个。
  const trail = /\\+$/.exec(s);
  const escaped = trail ? s.slice(0, trail.index) + '\\'.repeat(trail[0].length * 2) : s;
  return '"' + escaped.replace(/"/g, '""') + '"';
}

// cmd.exe 命令行拼装：把已逐个加引号的参数用空格连成一条命令串。
// 只用于 shell 分支（.cmd/.bat），必须配合 cmd /d /s /c 使用 —— 见 run()。
// cmd /d /s /c 的命令串拼装。
//
// /s 的准确语义（微软文档 + 2026-10-28 windows-latest 实测）：
//   加上 /s 后，cmd 只在「整条命令**恰好被一对引号包裹**」时才剥掉最外层这对引号，
//   然后才解析内部元字符。若命令串没有外层包裹引号，/s 不生效，cmd 退回
//   「裸删首个引号 + 末个引号、其余引号当字面量」的朴素解析 —— 逐参数引号失去定界作用。
// 实测症状（未加外层引号时）：cmd 把 `-e"` 切成独立 token，
// 报 '-e" "process.stdout.write' is not recognized as an internal or external command。
//
// 因此这里必须做两层引用：
//   ① 每个参数各自用 winQuoteArg 包一层（字面量保真 + " 翻倍）
//   ② 整条串再包一层 "..."，供 /s 剥壳
//
// ⚠️ /s **不**解决 %VAR% 展开：/s 只改变「外层引号如何剥除」的规则；cmd 在解析阶段展开
// %VAR%，与引号、/s 都无关（W8-8 实测 %PATH% 仍被展开）。所以 % 的安全性不能指望 /s。
//
// 前置拒绝（先于任何命令行构造，参数可能来自模型）：
//   · 含 \r \n \0 的参数 —— 见 winQuoteArg；
//   · 目标是 .cmd/.bat 时，含 % ! ^ & | < > 的参数 —— 批处理经 %*（或 %1…）转发时会被
//     **二次解析**（BatBadBut 类），外层怎么加引号都挡不住，只能拒绝。.exe 直执行不经 cmd，
//     不受此限（run() 对 .exe 根本不走本函数）。
function cmdLine(binPath, args) {
  const all = [binPath, ...args].map(String);
  for (const a of all) winQuoteArg(a); // 仅用于触发控制字符校验；先全部校验再拼装
  if (/\.(cmd|bat)$/i.test(all[0])) {
    all.slice(1).forEach((a, i) => {
      const bad = [...new Set(a.match(/[%!^&|<>]/g) || [])];
      if (bad.length) {
        const err = new Error(`ARG_REJECTED: 参数 #${i + 1} ${JSON.stringify(a.slice(0, 40))} 含 cmd 元字符 ${bad.join(' ')}；目标 ${all[0]} 是 .cmd/.bat，经 %* 转发会被 cmd.exe 二次解析（BatBadBut 类），无法安全转义，已拒绝。请改用 gts.exe（pip install . 生成），或去掉这些字符。`);
        err.code = 'ARG_REJECTED';
        throw err;
      }
    });
  }
  const inner = [winQuoteArg(binPath), ...args.map(winQuoteArg)].join(' ');
  // 整串外层包裹：内部的 " 已经翻倍，这里不能再翻倍，否则 /s 剥壳后会多出引号。
  return `"${inner}"`;
}

function run(cmd, args, opts) {
  // opts 可含 timeoutMs / signal / maxBytes（兼容旧的数字超时参数）；注意：测试用朴素括号配平切函数，
  // 签名与注释里不要出现花括号。
  const o = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
  return new Promise((resolve) => {
    // ── Windows 适配（2026-10-28）──────────────────────────────────────────
    // run() 只接收 bin 路径（字符串）。批处理（.cmd/.bat）在 Windows 上必须经
    // cmd.exe 才能执行，故只在「选了 shell 类型」时开 shell:true；.exe/PE 直执行。
    // 注意：bin 可能是 { bin, kind } 结构，调用方通过 gtsInvocation() 归一化。
    const spec = typeof cmd === 'string' ? { bin: cmd, kind: 'direct' } : cmd;
    const binPath = spec.bin;
    const useShell = IS_WIN && spec.kind === 'shell';
    // 批处理分支：显式构造 `cmd /d /s /c "<已引号化的整形命令>"`。
    //
    // 为什么必须自己拼、而不是交给 Node 的 shell+windowsVerbatimArguments ——
    // 实测（GitHub windows-latest，W8-6）：spawn(命令串, {shell:true,
    // windowsVerbatimArguments:true}) 里 Node 只会做 `cmd.exe /d /s /c "<串>"` 这一步，
    // 但**不加 /s 时 cmd 会退回「裸删首个引号 + 末个引号、其余引号当字面量」的朴素解析**：
    //   · 逐参数引号不再是定界符；
    //   · 首尾引号被删后，`a&b` 这类模式串直接成为命令分隔符 ⇒ 命令注入
    // 加上 /s 后 cmd 才按「整条命令被一对引号包裹」剥壳，内部引号作定界符解析 ——
    // 也就是说 /s 只修「引号剥除规则」，从而挡住 & | < > ^ 的注入。
    // **/s 并不阻止 %VAR% 展开**（cmd 在解析阶段展开，与引号、/s 无关；见 W8-8），
    // 所以含 % 的参数对 .cmd/.bat 目标由 cmdLine 前置拒绝，而不是靠 /s。
    if (useShell) {
      let shaped;
      try {
        shaped = cmdLine(binPath, args);
      } catch (e) {
        // 参数被拒绝：在构造命令行/spawn 之前就返回明确错误，绝不静默截断或清洗。
        return resolve({ code: -1, out: '', err: String((e && e.message) || e), timedOut: false });
      }
      const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', shaped], {
        windowsVerbatimArguments: true,
        windowsHide: true,
        env: { ...process.env, GITQ_MIRROR_ROOT: MIRROR_ROOT, GITEA_MIRROR_ROOT: MIRROR_ROOT, GITQ_OWNER: OWNERS.join(','), GITEA_OWNERS: OWNERS.join(',') },
      });
      return carry(p, o, resolve);
    }
    const p = spawn(binPath, args, {
      windowsHide: true,
      // POSIX：独立进程组，超时/取消时整组终止（gts 的 git grep / sync.sh 子孙进程不再变孤儿）。
      detached: !IS_WIN,
      env: { ...process.env, GITQ_MIRROR_ROOT: MIRROR_ROOT, GITEA_MIRROR_ROOT: MIRROR_ROOT, GITQ_OWNER: OWNERS.join(','), GITEA_OWNERS: OWNERS.join(','), GITEA_MANAGED_PGROUP: IS_WIN ? '0' : '1' },
    });
    return carry(p, o, resolve);
  });
}

const ACTIVE_CHILDREN = new Set();

/** 收集 POSIX 上某进程的全部后代 PID（用于在杀进程组前兜底捕获脱离进程组的子孙进程）。 */
function listDescendantPidsPosix(rootPid) {
  if (IS_WIN || !rootPid) return [];
  try {
    const out = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).stdout || '';
    const children = new Map();
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    const order = [];
    const stack = [rootPid];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (cur !== rootPid) order.push(cur);
      for (const ch of children.get(cur) || []) stack.push(ch);
    }
    return order.reverse();
  } catch {
    return [];
  }
}

/** 终止子进程（POSIX 上终止整个进程组并兜底清理后代；Windows 上用 taskkill /T /F 终止整棵进程树）。 */
function killTree(p, sig = 'SIGKILL') {
  try {
    if (IS_WIN && p.pid) {
      // cmd.exe → gts.exe(distlib 启动器) → python.exe → git.exe：仅 p.kill() 只会杀最外层，孙进程成孤儿。
      // 必须先 taskkill /T（此时父进程仍在，才能沿父子关系遍历整棵树），且同步执行以避免与 p.kill() 抢跑。
      const tk = spawnSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      if (tk.error || tk.status !== 0) p.kill(sig);
    } else if (p.pid) {
      // 先在父进程尚存时采样后代 PID，再终止整个进程组，最后补杀任何已另建进程组的后代。
      const descendants = listDescendantPidsPosix(p.pid);
      try { process.kill(-p.pid, sig); } catch { /* group may already be gone */ }
      for (const pid of descendants) {
        try { process.kill(pid, sig); } catch { /* already gone */ }
      }
      try { p.kill(sig); } catch { /* already gone */ }
    } else p.kill(sig);
  } catch {
    try { p.kill(sig); } catch { /* already gone */ }
  }
}

function killAllChildren() {
  for (const p of ACTIVE_CHILDREN) killTree(p);
  ACTIVE_CHILDREN.clear();
}

// 并发闸：每次工具调用都会起一个 Python/jieba 进程，不设上限时并行调用会拖垮宿主。
let _activeSlots = 0;
const _slotWaiters = [];

function pumpSlots() {
  while (_activeSlots < MAX_CONCURRENCY && _slotWaiters.length) {
    const w = _slotWaiters.shift();
    if (w.signal) w.signal.removeEventListener('abort', w.onAbort);
    w.grant();
  }
}

function acquireSlot(signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
    const release = () => { _activeSlots -= 1; pumpSlots(); };
    const grant = () => { _activeSlots += 1; resolve(release); };
    if (_activeSlots < MAX_CONCURRENCY) return grant();
    const waiter = { grant, signal };
    waiter.onAbort = () => {
      const i = _slotWaiters.indexOf(waiter);
      if (i >= 0) _slotWaiters.splice(i, 1);
      resolve(null);
    };
    if (signal) signal.addEventListener('abort', waiter.onAbort, { once: true });
    _slotWaiters.push(waiter);
  });
}

/** 带并发闸的 run：排队期间被取消则直接返回 aborted。 */
async function runLimited(cmd, args, opts = {}) {
  const o = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
  const release = await acquireSlot(o.signal);
  if (!release) return { code: null, out: '', err: '', timedOut: false, aborted: true, outputTruncated: false };
  try {
    return await run(cmd, args, o);
  } finally {
    release();
  }
}

/**
 * 收集子进程输出并一次性解码（direct 与 shell 两条 spawn 路径共用）。
 *
 * 2.0.3：
 *   · 输出有上限（opts.maxBytes，默认 GITEA_MAX_CHILD_OUTPUT_BYTES）：超限即终止子进程并标记
 *     outputTruncated，避免超大 blob/输出把 Node 撑爆（旧实现对 >512M 字符的输出在 close 回调里
 *     抛 ERR_STRING_TOO_LONG，整个 MCP 进程崩溃）；
 *   · 解码放进 try/catch：任何解码异常都变成结构化结果，绝不在事件回调里抛出；
 *   · 支持 AbortSignal 取消与进程组终止；超时/取消后若 stdio 迟迟不关闭，5s 后强制收尾。
 */
function carry(p, opts, resolve) {
  const o = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
  const timeoutMs = o.timeoutMs > 0 ? o.timeoutMs : 120000;
  const maxBytes = o.maxBytes > 0 ? o.maxBytes : MAX_CHILD_OUTPUT_BYTES;
  const signal = o.signal;
  const ERR_CAP = 4 * 1024 * 1024;
  // 2026-10-15 修：**必须收 Buffer、最后一次性解码**（按块 toString 会在多字节字符边界产出 U+FFFD）。
  const outChunks = [];
  const errChunks = [];
  let outBytes = 0;
  let errBytes = 0;
  let done = false;
  let timedOut = false;
  let aborted = false;
  let outputTruncated = false;
  let force = null;
  ACTIVE_CHILDREN.add(p);

  const decode = (chunks, limit) => {
    try {
      let b = Buffer.concat(chunks);
      if (limit && b.length > limit) b = b.subarray(0, limit);
      return b.toString('utf8');
    } catch {
      return '';
    }
  };
  const onAbort = () => { aborted = true; killTree(p); armForce(); };
  const finish = (code, extraErr = '') => {
    if (done) return;
    done = true;
    clearTimeout(t);
    if (force) clearTimeout(force);
    if (signal) signal.removeEventListener('abort', onAbort);
    ACTIVE_CHILDREN.delete(p);
    resolve({
      code,
      out: decode(outChunks, outputTruncated ? 1024 * 1024 : 0),
      err: extraErr + decode(errChunks, 0),
      timedOut,
      aborted,
      outputTruncated,
    });
  };
  function armForce() {
    if (force || done) return;
    force = setTimeout(() => finish(null), 5000);
    if (force.unref) force.unref();
  }
  // 超时：先打标记再 kill，close 事件里据此上报 timedOut（被 SIGKILL 的进程 code 为 null）。
  const t = setTimeout(() => { if (!done) { timedOut = true; killTree(p); armForce(); } }, timeoutMs);
  p.stdout.on('data', (d) => {
    outBytes += d.length;
    if (outBytes > maxBytes) {
      if (!outputTruncated) { outputTruncated = true; killTree(p); armForce(); }
      return;
    }
    outChunks.push(d);
  });
  p.stderr.on('data', (d) => {
    errBytes += d.length;
    if (errBytes <= ERR_CAP) errChunks.push(d);
  });
  p.on('error', (e) => finish(-1, String(e)));
  p.on('close', (code) => finish(code));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
}

// core.quotePath=false：否则非 ASCII（中文）路径会以 "\345\257\274…" 形式返回，
// 读文件时对不上号。core.pager/color.ui 是防非 tty 下的意外转义。
const GIT = ['git', '--no-replace-objects', '-c', 'core.pager=cat', '-c', 'color.ui=false', '-c', 'core.quotePath=false'];

function resolveRepo(repo) {
  // owner/repo 精确定位；裸 repo 仅在全局唯一时兼容，歧义必须 fail closed。
  const raw = IS_WIN ? String(repo || '').trim().replace(/\\/g, '/') : String(repo || '').trim();
  const parts = raw.split('/');
  if (![1, 2].includes(parts.length) || parts.some((p) => !p || p === '.' || p === '..' || !/^[A-Za-z0-9._-]+$/.test(p))) {
    return { error: `INVALID_REPO: 仓库名必须是 repo 或 owner/repo：${repo}` };
  }
  if (parts.length === 2) {
    const [owner, name] = parts;
    if (!OWNERS.includes(owner)) return { error: `REPO_NOT_IN_MIRROR: ${owner}/${name}` };
    const dir = path.join(MIRROR_ROOT, owner, name + '.git');
    return fs.existsSync(dir) ? { repo: `${owner}/${name}`, dir } : { error: `REPO_NOT_IN_MIRROR: ${owner}/${name}` };
  }
  const matches = [];
  for (const owner of OWNERS) {
    const dir = path.join(MIRROR_ROOT, owner, parts[0] + '.git');
    if (fs.existsSync(dir)) matches.push({ repo: `${owner}/${parts[0]}`, dir });
  }
  if (matches.length > 1) {
    return { error: `AMBIGUOUS_REPO: 裸仓名 ${parts[0]} 匹配多个仓：${matches.map((m) => m.repo).join(', ')}；请使用 owner/repo` };
  }
  return matches[0] || { error: `REPO_NOT_IN_MIRROR: ${parts[0]}` };
}

function gitDir(repo) {
  return resolveRepo(repo).dir || null;
}

function mirrorInfo() {
  let last = '未知';
  try { last = fs.readFileSync(path.join(MIRROR_ROOT, 'last_sync'), 'utf8').trim(); } catch { /* ignore */ }
  let n = 0;
  for (const o of OWNERS) {
    try {
      n += fs.readdirSync(path.join(MIRROR_ROOT, o)).filter((e) => e.endsWith('.git')).length;
    } catch { /* ignore */ }
  }
  const emptyWarn = n === 0
    ? `⚠️ 镜像目录为空或未就绪（当前 MIRROR_ROOT=${MIRROR_ROOT}，OWNERS=${OWNERS.join(',')}，已扫描 0 个 .git 镜像仓）。请检查环境变量 GITEA_MIRROR_ROOT / GITEA_OWNERS 是否仍为默认占位符，或先执行 scripts/sync.sh 同步镜像。`
    : '';
  const syncState = readSyncState(MIRROR_ROOT);
  const staleWarn = NEXT ? NEXT.staleNotice(syncState) : '';
  return { last, count: n, emptyWarn, staleWarn };
}

// ── 工具实现 ────────────────────────────────────────────────────────────────

/**
 * 把模型可控的查询和值参数与 gts 控制选项机械分隔。
 *
 * argparse 会把位置参数 `--sync` / `--reindex` 等重新解释为控制选项；选项值若以 `-` 开头，
 * 使用分离的 `--repo value` 形态也会被当成下一个选项。值选项统一绑定为 `--name=value`，
 * 查询前插入 `--`，保证查询永远只是数据。
 */
function buildSearchArgs(a, n) {
  const args = ['--json', '-n', String(n)];
  const mode = a.mode || 'content';
  if (mode === 'path') args.push('-p');
  else if (mode === 'message') args.push('-m');
  if (a.regex) args.push('-E');
  if (a.case_sensitive) args.push('-s');
  if (a.files_only) args.push('-l');
  if (a.repo) args.push(`--repo=${a.repo}`);
  if (a.branch) args.push(`--branch=${a.branch}`);
  args.push('--', a.query);
  return args;
}

function buildListReposArgs(a) {
  const args = ['--repos', '--json'];
  if (a.filter) args.push(`--repo=${a.filter}`);
  return args;
}

function buildDocsArgs(a, n) {
  const args = ['-D', '--json', '-n', String(n)];
  if (a.repo) args.push(`--repo=${a.repo}`);
  if (a.kind) args.push(`--kind=${a.kind}`);
  args.push('--', a.query);
  return args;
}

/** 子进程被取消 / 输出超限时的统一结构化结果；返回 null 表示正常。 */
function childFailure(res, what, hint) {
  if (res && res.aborted) {
    return { text: `CANCELLED: ${what} 已被客户端取消，子进程已终止。`, isError: true };
  }
  if (res && res.outputTruncated) {
    return {
      text: `OUTPUT_TOO_LARGE: ${what} 的输出超过上限（${MAX_CHILD_OUTPUT_BYTES}B）已终止子进程。${hint || ''}`,
      isError: true,
    };
  }
  return null;
}

// ref 校验：允许合法 UTF-8 分支/标签名（如 功能/中文）与普通修订（HEAD~1），
// 不得以 '-' / '/' / '.' 开头，不含 ':'、空白、控制字符、'..' 与 '@{'。
const REF_BAD_RE = /[\x00-\x1f\x7f\s:\\?*\[]|\.\./;
function validRef(ref) {
  if (typeof ref !== 'string' || !ref) return false;
  if (/^[-/.]/.test(ref) || /[/.]$/.test(ref)) return false;
  if (ref.includes('//') || ref.includes('@{')) return false;
  return !REF_BAD_RE.test(ref);
}

async function resolveRefOid(gitdir, ref, signal) {
  const rev = await runLimited('git', [...GIT.slice(1), `--git-dir=${gitdir}`, 'rev-parse', '--verify', '--end-of-options', `${ref}^{}`], {
    signal,
    timeoutMs: 30000,
  });
  const cancelled = childFailure(rev, 'read_file');
  if (cancelled) return { cancelled };
  const oid = (rev.out || '').trim();
  if (rev.code !== 0 || !oid) return { error: (rev.err || '').trim() };
  return { oid };
}

async function loadPrivateKeyLinesForHit(repo, commit, filePath, signal, cache) {
  if (signal?.aborted) {
    return { status: 'cancelled', result: { text: 'CANCELLED: search_code 已被客户端取消，子进程已终止。', isError: true } };
  }
  const key = `${repo}\0${commit}\0${filePath}`;
  if (cache.has(key)) return cache.get(key);
  const failUnverified = (reason) => {
    const out = { status: 'unverified', reason };
    cache.set(key, out);
    return out;
  };
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
    return failUnverified('invalid_commit');
  }
  const resolved = resolveRepo(repo);
  if (!resolved.dir) return failUnverified('repo_unresolved');
  const cleanPath = normalizeGitPath(filePath);
  if (!cleanPath) return failUnverified('invalid_path');
  const spec = `${commit}:${cleanPath}`;
  const gitArgs = [...GIT.slice(1), `--git-dir=${resolved.dir}`];
  const sizeRes = await runLimited('git', [...gitArgs, 'cat-file', '-s', spec], {
    signal,
    timeoutMs: 15000,
  });
  if (sizeRes.aborted) {
    return { status: 'cancelled', result: { text: 'CANCELLED: search_code 已被客户端取消，子进程已终止。', isError: true } };
  }
  if (sizeRes.code !== 0 || sizeRes.timedOut) return failUnverified('size_failed');
  const size = Number((sizeRes.out || '').trim());
  if (!Number.isFinite(size) || size < 0) return failUnverified('size_invalid');
  if (size > MAX_BLOB_BYTES) return failUnverified('oversize');
  const blobRes = await runLimited('git', [...gitArgs, 'show', spec], {
    signal,
    timeoutMs: 30000,
    maxBytes: MAX_BLOB_BYTES + 1024 * 1024,
  });
  if (blobRes.aborted) {
    return { status: 'cancelled', result: { text: 'CANCELLED: search_code 已被客户端取消，子进程已终止。', isError: true } };
  }
  if (blobRes.code !== 0 || blobRes.timedOut || blobRes.outputTruncated) return failUnverified('read_failed');
  let found;
  if (!blobRes.out || !blobRes.out.includes('PRIVATE KEY')) {
    found = new Set();
  } else {
    const lines = blobRes.out.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    found = findPrivateKeyLineIndices(lines).indices;
  }
  const checked = { status: 'checked', lines: found };
  cache.set(key, checked);
  return checked;
}

async function searchCode(a, ctx = {}) {
  ensureRuntimeConfig();
  if (CONFIG_ERROR) return { text: `${CONFIG_ERROR}\nresolved_config=${JSON.stringify(EFFECTIVE_CONFIG)}`, isError: true };
  const gts = findGts();
  if (!gts || gts.error) return { text: gts ? gts.error : missingCliMessage(), isError: true };

  const mode = a.mode || 'content';
  // 条数硬夹（MAX_RESULTS）：模型可传大数，但护栏不让输出面无限放大。默认条数 5（先定位再精读）。
  const want = Number(a.max_results) > 0 ? Math.floor(Number(a.max_results)) : 5;
  const n = Math.min(want, MAX_RESULTS);
  const clampedNote = want > MAX_RESULTS ? `（请求 ${want} 条，已硬夹到 ${MAX_RESULTS}）` : '';

  // 2.0.3：search_code 严格只读，不再触发镜像同步（同步由独立的 sync_mirror 工具承担）。
  const res = await runLimited(gts, buildSearchArgs(a, n), { timeoutMs: 120000, signal: ctx.signal });
  const { code, out, err, timedOut } = res;
  const bad = childFailure(res, 'search_code', '请缩小 query / 限定 repo / 降低 max_results。');
  if (bad) return bad;
  const mi = mirrorInfo();
  let j;
  try { if (timedOut) throw new Error('timed out'); j = JSON.parse(out); } catch {
    const warn = mi.emptyWarn ? `\n${mi.emptyWarn}` : '';
    if (NEXT) return NEXT.failureResult({ code, out, err, timedOut }, 'search');
    return { text: `gts 输出无法解析（rc=${code}）：\n${out.slice(0, 800)}\n${err.slice(0, 400)}${warn}`, isError: true };
  }
  let partialWarn = '';
  if (code !== 0 && code !== 1) {
    const structured = Array.isArray(j?.errors) && j.errors.length > 0;
    // 2.0.3：部分仓失败但其余仓有命中时，返回命中并显式标注 PARTIAL，而不是整体丢弃（零命中仍 fail-closed）。
    const partial = code === 2 && structured && Array.isArray(j.results) && j.results.length > 0;
    if (partial) {
      partialWarn = `⚠️ PARTIAL_RESULT(GIT_SEARCH_FAILED): ${j.repos_failed ?? j.errors.length} 个仓搜索失败，下列结果不完整，` +
        `不可据此断言其余仓零命中。失败详情：` +
        j.errors.slice(0, 5).map((error) => `${error.repo}: ${error.stage} rc=${error.rc ?? 'unknown'}`).join('; ');
    }
    if (!partial) {
      const failureErr = structured ? `GIT_SEARCH_FAILED:\n${j.errors.map((error) => {
        const rc = error.rc === null || error.rc === undefined ? 'unknown' : error.rc;
        return `${error.repo}: ${error.stage} rc=${rc}: ${error.message}`;
      }).join('\n')}\n${err}` : err;
      if (NEXT) return NEXT.failureResult({ code, out, err: failureErr, timedOut }, 'search');
      return { text: `GIT_SEARCH_FAILED: search 失败（rc=${code}）\n${failureErr}`, isError: true };
    }
  }
  const rows = j.results || [];
  const sec = getSecurityPolicy();
  let blockedSensitive = 0;
  let redactedHits = 0;
  const redactedRules = new Set();
  const hitRepoSet = new Set();
  const safeRows = [];
  for (const r of rows) {
    if (sec.blockSensitivePaths && r.path && isSensitivePath(r.path)) {
      blockedSensitive += 1;
      continue;
    }
    if (r.repo) hitRepoSet.add(r.repo);
    safeRows.push(r);
  }
  const lines = [];
  const shown = safeRows.length;
  const total = Number(j.total) || rows.length;
  const moreNote = total > rows.length ? `，还有 ${total - rows.length} 条未显示（要更多请调大 max_results 或缩小 query）` : '';
  const fbNote = j.match_mode === 'line_and_fallback' ? '；原短语连写 0 命中，已自动回退为同行多词 AND 匹配' : '';
  const lowerBound = j.capped ? '≥ ' : '';
  lines.push(
    `返回 ${shown} 条 / 全库命中 ${lowerBound}${total} 条 / ${j.repos_hit} 个仓（扫了 ${j.repos_scanned} 个镜像仓；` +
    `镜像 last_sync: ${j.mirror_last_sync || mi.last}${moreNote}${clampedNote}${fbNote}）`
  );
  if (partialWarn) lines.push(partialWarn);
  // 旧版（≤2.0.2）调用方可能仍传 sync:true：不执行同步，但必须明确告知，避免把旧镜像结果当成最新。
  if (a.sync) {
    lines.push('⚠️ SYNC_MOVED: search_code 已是只读工具，不再支持 sync 参数，本次未同步，结果基于当前镜像（可能略旧）；需要刷新镜像请先调用 sync_mirror。');
  }
  if (j.capped) lines.push('（有仓命中触顶，命中总数是下界；请缩小 query 或限定 repo）');
  if (mi.staleWarn) lines.push(mi.staleWarn);
  if (!safeRows.length) {
    if (mi.emptyWarn) {
      lines.push(mi.emptyWarn);
    }
    if (blockedSensitive > 0) {
      lines.push(`⚠️ 安全护栏：已屏蔽 ${blockedSensitive} 条敏感路径命中（如 .env / 私钥 / 凭据文件）。`);
    } else {
      lines.push(
        '（无命中。可试：① 若查跨行多词、中文文档或历史会话，请改调 search_docs（FTS5 + jieba 分词，支持多词跨行与会话检索）；' +
        '② 换更短关键词或设 regex:true；③ 用 list_repositories 确认仓名；④ 切勿手写脚本遍历解压 .dsh/sessions/*.zstd）'
      );
    }
  }
  const pkCache = new Map();
  let unverifiedOmitted = 0;
  for (const r of safeRows) {
    let rawLine;
    if (mode === 'content') {
      let lineText;
      if (a.files_only) {
        lineText = '';
      } else {
        let handledByBlockCheck = false;
        if (sec.redactSecrets && Number.isInteger(r.line) && r.line > 0 && mightBePemBlockLine(r.text)) {
          const pkCheck = await loadPrivateKeyLinesForHit(r.repo, r.commit, r.path, ctx.signal, pkCache);
          if (pkCheck.status === 'cancelled') return pkCheck.result;
          if (pkCheck.status === 'unverified') {
            handledByBlockCheck = true;
            lineText = `[CONTENT_OMITTED:unverified_secret_scan:${pkCheck.reason}]`;
            unverifiedOmitted += 1;
          } else if (pkCheck.lines.has(r.line - 1)) {
            handledByBlockCheck = true;
            lineText = '[SECRET_REDACTED:private_key]';
            redactedHits += 1;
            redactedRules.add('private_key_block');
          }
        }
        if (!handledByBlockCheck) {
          const txt = r.text ?? '';
          const red = redactSecrets(txt, { enabled: sec.redactSecrets });
          if (red.count > 0) {
            redactedHits += red.count;
            for (const id of red.rules) redactedRules.add(id);
          }
          lineText = red.text;
        }
      }
      rawLine = a.files_only ? `${r.repo}@${r.ref}:${r.path}` : `${r.repo}@${r.ref}:${r.path}:${r.line ?? ''}:${lineText}`;
    } else if (mode === 'path') {
      rawLine = `${r.repo}@${r.ref}:${r.path}`;
    } else {
      const red = redactSecrets(r.subject ?? '', { enabled: sec.redactSecrets });
      if (red.count > 0) {
        redactedHits += red.count;
        for (const id of red.rules) redactedRules.add(id);
      }
      rawLine = `${r.repo} ${r.commit} ${r.date} ${red.text}`;
    }
    lines.push(rawLine);
  }
  if (safeRows.length) {
    if (mode === 'content') lines.push('');
    lines.push('提示：用 read_file(repo, path, ref) 读上面命中的文件全文。');
  }
  if (blockedSensitive > 0 && safeRows.length > 0) {
    lines.push(`⚠️ 安全护栏：已屏蔽 ${blockedSensitive} 条敏感路径命中。`);
  }
  if (unverifiedOmitted > 0) {
    lines.push(`⚠️ 安全护栏：${unverifiedOmitted} 条命中因无法完整扫描对应文件（如超过 GITEA_MAX_BLOB_BYTES=${MAX_BLOB_BYTES}B 或对象读取失败），已保留仓/路径/行号并省略正文；如需查看请在客户端侧用 git 核查或调大上限。`);
  }
  if (redactedHits > 0) {
    lines.push(`⚠️ 安全护栏：已自动脱敏 ${redactedHits} 处疑似密钥（规则：${[...redactedRules].join(', ')}）。`);
  }
  const [cappedLines, guardNotes] = capSearchLines(lines);
  return {
    text: [...cappedLines, ...guardNotes].join('\n'),
    _audit: {
      hits: total,
      truncated: guardNotes.length > 0,
      hitRepos: [...hitRepoSet],
      redactedHits,
      blockedSensitive,
    },
  };
}

async function readFile(a, ctx = {}) {
  ensureRuntimeConfig();
  if (CONFIG_ERROR) return { text: `${CONFIG_ERROR}\nresolved_config=${JSON.stringify(EFFECTIVE_CONFIG)}`, isError: true };
  const resolved = resolveRepo(a.repo);
  if (!resolved.dir) return { text: `错误：${resolved.error}（用 list_repositories 看完整 owner/repo。）`, isError: true };
  const d = resolved.dir;
  const repoId = resolved.repo;
  // 平台感知归一化（POSIX 上反斜杠是合法文件名字符，禁止转换，详见 normalizeGitPath）
  const p = normalizeGitPath(a.path);
  if (!p) return { text: '错误：需要 path。', isError: true };
  const sec = getSecurityPolicy();
  if (sec.blockSensitivePaths && isSensitivePath(p)) {
    return {
      text: `⚠️ 安全护栏：已拦截敏感路径读取（${repoId}:${p}）。该路径匹配凭据/私钥/归档黑名单；若确需核查请改用零回显密钥工具，或在受控环境下显式设置 GITEA_BLOCK_SENSITIVE_PATHS=0。`,
      isError: true,
      _audit: { hits: 0, truncated: false, hitRepos: [repoId], blockedSensitive: 1 },
    };
  }

  let ref = a.ref;
  if (ref !== undefined && ref !== null && ref !== '' && !validRef(ref)) {
    // 2.0.3：以 '-' 开头的 ref 会被 git 当作选项，其余非法字符同样拒绝。
    return { text: `INVALID_REF: ref 含非法字符或以 '-' 开头：${JSON.stringify(String(ref).slice(0, 80))}（应为分支/tag/commit 名，如 main、v1.0、HEAD~1）。`, isError: true };
  }
  if (!ref) {
    const r = await runLimited('git', [...GIT.slice(1), `--git-dir=${d}`, 'symbolic-ref', '--short', 'HEAD'], { signal: ctx.signal, timeoutMs: 30000 });
    const cand = (r.out || '').trim();
    ref = validRef(cand) ? cand : 'HEAD';
  }
  const spec = `${ref}:${p}`;
  const rev = await resolveRefOid(d, ref, ctx.signal);
  if (rev.cancelled) return rev.cancelled;
  if (!rev.oid) {
    return {
      text: `读取失败：${repoId}:${spec}\n${(rev.error || '').slice(0, 400)}\n` +
            `（路径区分大小写；用 search_code(mode:"path") 确认确切路径与 ref。）`,
      isError: true,
    };
  }
  const gitSpec = `${rev.oid}:${p}`;
  // 先取对象大小：超过上限直接拒绝（旧实现把整个 blob 读进 Node 内存，>512M 字符会让进程崩溃）。
  const sizeRes = await runLimited('git', [...GIT.slice(1), `--git-dir=${d}`, 'cat-file', '-s', gitSpec], { signal: ctx.signal, timeoutMs: 30000 });
  const cancelled = childFailure(sizeRes, 'read_file');
  if (cancelled) return cancelled;
  if (sizeRes.code !== 0) {
    return {
      text: `读取失败：${repoId}:${spec}\n${(sizeRes.err || '').trim().slice(0, 400)}\n` +
            `（路径区分大小写；用 search_code(mode:"path") 确认确切路径与 ref。）`,
      isError: true,
    };
  }
  const objectSize = Number((sizeRes.out || '').trim());
  if (Number.isFinite(objectSize) && objectSize > MAX_BLOB_BYTES) {
    return {
      text: `FILE_TOO_LARGE: ${repoId}:${spec} 共 ${objectSize} 字节，超过 read_file 可读上限 ${MAX_BLOB_BYTES}B（可经 GITEA_MAX_BLOB_BYTES 调整）。` +
            `请用 search_code 定位具体片段，或在客户端侧用 git 取该文件。`,
      isError: true,
    };
  }
  const res = await runLimited('git', [...GIT.slice(1), `--git-dir=${d}`, 'show', gitSpec], {
    timeoutMs: 60000, signal: ctx.signal, maxBytes: MAX_BLOB_BYTES + 1024 * 1024,
  });
  const gone = childFailure(res, 'read_file');
  if (gone) return gone;
  if (res.timedOut) {
    return { text: `读取失败：${repoId}:${spec} —— git show 超时（60s）已被终止；检查磁盘、仓库规模和进程状态后再重试。`, isError: true };
  }
  if (res.code !== 0) {
    return {
      text: `读取失败：${repoId}:${spec}\n${(res.err || '').trim().slice(0, 400)}\n` +
            `（路径区分大小写；用 search_code(mode:"path") 确认确切路径与 ref。）`,
      isError: true,
    };
  }
  const notes = [];
  const allLines = res.out.split('\n');
  // 2.0.3：结尾换行产生的空尾元素不算一行（旧实现 3 行文件显示「共 4 行」）。
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') allLines.pop();
  const totalLines = res.out === '' ? 0 : allLines.length;
  if (totalLines === 0) {
    return { text: `# ${repoId}@${ref}:${p}\n\n…（空文件）`, _audit: { hits: 1, truncated: false } };
  }
  // 审计 #5：先在完整文件上识别多行私钥块行区间，再按原始行号分页与计字节，
  // 确保跨页/块内切片不会因缺少 BEGIN/END 上下文而漏脱敏，同时块外行号与续读 offset 保持 1:1 对齐。
  const pkInfo = sec.redactSecrets ? findPrivateKeyLineIndices(allLines) : { indices: new Set(), ranges: [] };
  const maskedAllLines = pkInfo.indices.size > 0
    ? allLines.map((line, idx) => (pkInfo.indices.has(idx) ? '[SECRET_REDACTED:private_key]' : line))
    : allLines;

  const wantLimit = a.limit === undefined || a.limit === null
    ? READ_DEFAULT_LINES
    : Math.floor(Number(a.limit));
  const limit = Number.isFinite(wantLimit) && wantLimit > 0 ? wantLimit : (wantLimit === 0 ? 0 : READ_DEFAULT_LINES);
  const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
  if (offset >= totalLines) {
    return {
      text: `# ${repoId}@${ref}:${p}\n\n…（offset=${offset} 已超出文件末尾，该文件共 ${totalLines} 行；有效 offset 范围 0-${totalLines - 1}）`,
      _audit: { hits: 1, truncated: false },
    };
  }
  const start = offset;
  const requestedEnd = limit > 0 ? Math.min(start + limit, totalLines) : totalLines;
  let end = start;
  let bodyBytes = 0;
  while (end < requestedEnd) {
    const lineBytes = Buffer.byteLength(maskedAllLines[end]);
    const separatorBytes = end > start ? 1 : 0;
    if (bodyBytes + separatorBytes + lineBytes > MAX_READ_BYTES) break;
    bodyBytes += separatorBytes + lineBytes;
    end += 1;
  }

  let body;
  if (end === start && start < requestedEnd) {
    body = truncateUtf8(maskedAllLines[start], MAX_READ_BYTES).toString('utf8');
    end = start + 1;
    notes.push(`第 ${start + 1} 行超过 ${MAX_READ_BYTES} 字节，仅显示 partial 前缀，行内剩余内容无法通过 offset 续读`);
  } else {
    body = maskedAllLines.slice(start, end).join('\n');
  }
  const touchedPkBlocks = pkInfo.ranges.filter(([rStart, rEnd]) => rEnd >= start && rStart < end).length;
  const red = redactSecrets(body, { enabled: sec.redactSecrets });
  body = red.text;
  const totalRedacted = red.count + touchedPkBlocks;
  const allRules = new Set(red.rules);
  if (touchedPkBlocks > 0) allRules.add('private_key_block');
  if (totalRedacted > 0) {
    notes.push(`安全护栏已自动脱敏 ${totalRedacted} 处疑似密钥（${[...allRules].join(', ')}）`);
  }
  if (end < totalLines) {
    notes.push(`已显示第 ${start + 1}-${end} 行，共 ${totalLines} 行（续读：offset=${end}；取全文：limit=0）`);
  }
  const note = notes.length ? `\n\n…（${notes.join('；')}）` : '';
  return {
    text: `# ${repoId}@${ref}:${p}\n\n${body}${note}`,
    _audit: {
      hits: 1,
      truncated: notes.length > 0,
      hitRepos: [repoId],
      redactedHits: totalRedacted,
    },
  };
}

async function listRepositories(a, ctx = {}) {
  ensureRuntimeConfig();
  if (CONFIG_ERROR) return { text: `${CONFIG_ERROR}\nresolved_config=${JSON.stringify(EFFECTIVE_CONFIG)}`, isError: true };
  const gts = findGts();
  if (!gts || gts.error) return { text: gts ? gts.error : missingCliMessage(), isError: true };
  const res = await runLimited(gts, buildListReposArgs(a), { signal: ctx.signal });
  const { out, err, timedOut } = res;
  const bad = childFailure(res, 'list_repositories');
  if (bad) return bad;
  const mi = mirrorInfo();
  const warnSuffix = mi.emptyWarn ? `\n${mi.emptyWarn}` : '';
  let j;
  try { if (timedOut) throw new Error('timed out'); j = JSON.parse(out); } catch {
    if (NEXT) return NEXT.failureResult({ code: null, out, err, timedOut }, 'repos');
    return { text: `解析失败：${out.slice(0, 500)}${err.slice(0, 300)}${warnSuffix}`, isError: true };
  }
  return {
    text: `${j.count} 个仓（镜像 last_sync: ${j.mirror_last_sync || mi.last}）\n` + (j.repos || []).join('\n') + (!j.count ? warnSuffix : ''),
    _audit: { hits: Number(j.count) || 0, truncated: false },
  };
}

async function searchDocs(a, ctx = {}) {
  ensureRuntimeConfig();
  if (CONFIG_ERROR) return { text: `${CONFIG_ERROR}\nresolved_config=${JSON.stringify(EFFECTIVE_CONFIG)}`, isError: true };
  const gts = findGts();
  if (!gts || gts.error) return { text: gts ? gts.error : missingCliMessage(), isError: true };

  const want = Number(a.max_results) > 0 ? Math.floor(Number(a.max_results)) : 5;
  const n = Math.min(want, MAX_RESULTS);

  const res = await runLimited(gts, buildDocsArgs(a, n), { signal: ctx.signal });
  const { code, out, err, timedOut } = res;
  const bad = childFailure(res, 'search_docs', '请缩小 query 或限定 repo。');
  if (bad) return bad;
  const mi = mirrorInfo();
  let j;
  try { if (timedOut) throw new Error('timed out'); j = JSON.parse(out); } catch {
    const warn = mi.emptyWarn ? `\n${mi.emptyWarn}` : '';
    if (NEXT) return NEXT.failureResult({ code, out, err, timedOut }, 'docs');
    return { text: `gts 文档搜索输出无法解析（rc=${code}）：\n${out.slice(0, 800)}\n${err.slice(0, 400)}${warn}`, isError: true };
  }
  if (j.error) {
    const warn = mi.emptyWarn ? `\n${mi.emptyWarn}` : '';
    return { text: `搜索错误：${j.error}${warn}`, isError: true };
  }

  const rows = j.results || [];
  const sec = getSecurityPolicy();
  let blockedSensitive = 0;
  let redactedHits = 0;
  const redactedRules = new Set();
  const hitRepoSet = new Set();
  const safeRows = [];
  for (const r of rows) {
    if (sec.blockSensitivePaths && r.path && isSensitivePath(r.path)) {
      blockedSensitive += 1;
      continue;
    }
    if (r.repo) hitRepoSet.add(r.repo);
    safeRows.push(r);
  }
  const lines = [];
  const perfNote = j.perf && typeof j.perf.elapsed_ms === 'number'
    ? `；耗时 ${j.perf.elapsed_ms.toFixed(1)}ms [${j.perf.status || 'OK'}]`
    : '';
  const countText = j.total_relation === 'gt'
    ? `返回 ${safeRows.length} 篇相关文档（还有更多）`
    : (j.total_relation === 'gte'
      ? `返回 ${safeRows.length} 篇相关文档（总数可能更多）`
      : `命中 ${safeRows.length} 篇相关文档`);
  lines.push(`【文档/会话全文检索】${countText}（scope: default-branches；FTS5 相关度排序${perfNote}）：`);
  if (mi.staleWarn) lines.push(mi.staleWarn);
  if (!safeRows.length) {
    if (mi.emptyWarn) {
      lines.push(mi.emptyWarn);
    }
    if (blockedSensitive > 0) {
      lines.push(`⚠️ 安全护栏：已屏蔽 ${blockedSensitive} 篇敏感路径命中。`);
    } else {
      if (Array.isArray(j.repo_unmatched) && j.repo_unmatched.length && j.note) {
        lines.push(j.note);
      }
      lines.push('（无命中。FTS 仅覆盖每仓默认分支；可试：换关键词 / 去掉 repo，或用 search_code 搜全部 heads，再用 read_file(ref=...) 精读。）');
    }
  }
  for (const r of safeRows) {
    const titleRed = redactSecrets(r.title ?? '', { enabled: sec.redactSecrets });
    const snipRed = redactSecrets(r.snippet ?? '', { enabled: sec.redactSecrets });
    redactedHits += titleRed.count + snipRed.count;
    for (const id of titleRed.rules) redactedRules.add(id);
    for (const id of snipRed.rules) redactedRules.add(id);
    lines.push(`• [${r.repo}@${r.ref}] ${r.path} (${titleRed.text})`);
    lines.push(`  摘要: ${snipRed.text}`);
  }
  if (safeRows.length) {
    lines.push('');
    lines.push('提示：用 read_file(repo, path, ref) 读上面命中文档的全文。');
  }
  if (blockedSensitive > 0 && safeRows.length > 0) {
    lines.push(`⚠️ 安全护栏：已屏蔽 ${blockedSensitive} 篇敏感路径命中。`);
  }
  if (redactedHits > 0) {
    lines.push(`⚠️ 安全护栏：已自动脱敏 ${redactedHits} 处疑似密钥（规则：${[...redactedRules].join(', ')}）。`);
  }
  const [cappedLines, guardNotes] = capSearchLines(lines);
  return {
    text: [...cappedLines, ...guardNotes].join('\n'),
    _audit: {
      hits: safeRows.length,
      truncated: guardNotes.length > 0,
      internalMs: j.perf && typeof j.perf.elapsed_ms === 'number' ? j.perf.elapsed_ms : undefined,
      hitRepos: [...hitRepoSet],
      redactedHits,
      blockedSensitive,
    },
  };
}

async function syncMirror(a, ctx = {}) {
  ensureRuntimeConfig();
  if (CONFIG_ERROR) return { text: `${CONFIG_ERROR}\nresolved_config=${JSON.stringify(EFFECTIVE_CONFIG)}`, isError: true };
  const gts = findGts();
  if (!gts || gts.error) return { text: gts ? gts.error : missingCliMessage(), isError: true };

  // 超时必须覆盖同步时长（否则只杀 gts、留下孤儿同步）。
  const res = await runLimited(gts, ['--sync-only', '--json'], { timeoutMs: SYNC_TIMEOUT_MS + 60000, signal: ctx.signal });
  const bad = childFailure(res, 'sync_mirror');
  if (bad) return bad;
  const { code, out, err, timedOut } = res;
  const mi = mirrorInfo();
  if (timedOut) {
    return { text: `SYNC_FAILED: 同步超时（${Math.round(SYNC_TIMEOUT_MS / 1000)}s），已终止同步进程组。`, isError: true };
  }
  let j = null;
  try { j = JSON.parse(out); } catch { /* fall through to generic failure */ }
  if (code !== 0 || !j) {
    const tail = String(err || out || '').trim().split('\n').slice(-6).join('\n').slice(0, 800);
    return { text: `SYNC_FAILED: 同步失败（rc=${code}）\n${tail}`, isError: true };
  }
  const busy = j.status === 'busy';
  const source = j.enum_source;
  const degraded = j.degraded === true || j.status === 'degraded' || source === 'cache' || source === 'disk';
  let head = '✅ 镜像同步完成。';
  if (busy) {
    head = '⚠️ SYNC_BUSY: 另一轮同步正在进行，本次未重复同步；检索将基于当前镜像（可能略旧），稍后可再调用 sync_mirror 或查看 state/last_status。';
  } else if (degraded) {
    const coverage = source === 'disk' ? '本地镜像目录' : source === 'cache'
      ? (j.cache_stale === true ? '过期仓库缓存' : '仓库缓存')
      : '已知仓库';
    head = `⚠️ SYNC_DEGRADED: 已知仓同步完成，枚举范围为${coverage}（enum_source=${source || 'unknown'}）。本轮未取得完整仓单，新推送的仓库可能未被发现。`;
  } else if (source === 'api' || source === 'ssh') {
    head += ` 已取得完整仓单（enum_source=${source}）。`;
  } else if (source === 'only') {
    head += ' 枚举范围为指定仓库（enum_source=only）。';
  }
  const warn = mi.staleWarn ? `\n${mi.staleWarn}` : '';
  return {
    text: `${head}\n镜像 ${mi.count} 个仓，last_sync: ${mi.last}${warn}`,
    _audit: { hits: mi.count, truncated: false },
  };
}

const TOOLS = [
  {
    name: 'search_code',
    description:
      '在本地 Gitea / Forgejo / Git 裸镜像里搜索代码内容 / 文件路径 / 提交信息，覆盖所有镜像仓的全部本地分支。' +
      '用来找回可复用的内容：脚本、docker-compose、runbook/手册、命令、排障记录、配置片段。' +
      'Gitea 服务端未开代码索引时，网页/API 无法跨仓搜内容，需用本工具。' +
      'mode=content 搜文件内容（默认，按字面量、不分大小写，多词短语 0 命中时自动回退同行多词 AND）；mode=path 搜文件路径；mode=message 搜提交信息。' +
      '只覆盖已推送并同步到镜像的内容，本机未推送的工作副本不在内；本工具严格只读，需要刷新镜像时请先调用 sync_mirror。' +
      '⚠️ 若查跨行多词组合、中文问题、历史故障或历史会话，请优先用 search_docs（SQLite FTS5 + jieba 分词），严禁手写脚本遍历解压 .dsh/sessions/*.zstd。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词。默认按字面量匹配；regex:true 时按扩展正则（egrep 语法）。' },
        mode: { type: 'string', enum: ['content', 'path', 'message'], description: '默认 content（搜文件内容）。' },
        repo: { type: 'string', description: '限定仓库，推荐 owner/repo（按完整身份子串匹配）；逗号分隔多个，支持 * ? 通配（整名匹配），如 "example-repo,myorg/app-*"。不含 / 的裸名按仓名子串匹配各 owner 的仓（`app` 会命中 `myapp`）。' },
        branch: { type: 'string', description: '限定分支（默认搜全部分支；HEAD=默认分支）。无通配符时精确匹配（`main` 不会命中 `maintenance`）；前缀/模糊请写 `main*`；逗号分隔多个。' },
        regex: { type: 'boolean', description: '按扩展正则解释 query。' },
        case_sensitive: { type: 'boolean', description: '区分大小写（默认不区分）。' },
        files_only: { type: 'boolean', description: '只列命中文件，不显示行内容。' },
        max_results: { type: 'integer', description: '最多返回条数，默认 5（省上下文：先定位再精读）；超 GITEA_MAX_RESULTS(默认200) 会被硬夹并在首行标注。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'read_file',
    description:
      '从本地 Gitea / Forgejo / Git 镜像里读出一个文件（搜到之后直接取用内容，不必 clone）。' +
      'ref 省略时用该仓默认分支。**默认只返回前 400 行**（省上下文），' +
      '需要别的段落用 offset/limit 续读，取全文用 limit=0。' +
      '另有字节上限（默认 60KB，可经 GITEA_MAX_READ_BYTES 调整）；单个文件超过 GITEA_MAX_BLOB_BYTES（默认 32MiB）时返回 FILE_TOO_LARGE，请改用 search_code 定位片段。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '仓名，推荐完整 owner/repo；裸名仅在全局唯一时接受。' },
        path: { type: 'string', description: '仓内相对路径，如 "bin/gts"。' },
        ref: { type: 'string', description: '分支/tag/commit，默认该仓默认分支。必须是普通修订名（不得以 - 开头，不含 : 与空白），否则返回 INVALID_REF。' },
        offset: { type: 'integer', description: '从第几行开始（0 基，默认 0）。配合 limit 做分段读取。' },
        limit: { type: 'integer', description: '返回多少行，默认 400（GITEA_READ_DEFAULT_LINES 可调）；传 0 表示不限行数（仍受字节上限约束）。' },
      },
      required: ['repo', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_repositories',
    description: '列出本地 Gitea / Forgejo / Git 镜像里的仓名（可按名字过滤），用来确认仓名或盘点。',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '仓名子串或通配，如 "service"、"myorg/dsh-*"。省略则全列。' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'search_docs',
    description:
      '在本地 Gitea / Forgejo / Git 镜像所有仓库的默认分支中，对 Markdown 文档、会话导出（如 dsh-session-archive）与手册执行 SQLite FTS5 全文检索（scope: default-branches）。' +
      'SQLite warm query 可毫秒级返回；MCP 端到端延迟还包含 Python/jieba 进程冷启动。' +
      '比普通代码搜索更适合查找历史排查记录、配置说明、决策原因与既往方案。' +
      '内置 jieba 中文分词与多词跨行检索（覆盖用户消息与助手回复）。当内置 session_search 查中文或多词返回 0 命中时，应首选本工具（可设 kind="session"），严禁手写脚本全量解压 .zstd 会话文件。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词或短语（如 "Caddy 证书"、"反向代理配置"）' },
        repo: { type: 'string', description: '可选：限定仓库（与 search_code 同一套规则：owner/repo 按完整身份、裸名按仓名子串、含 * ? 按整名通配，逗号分隔多个；如 "session*"、"myorg/app"）' },
        kind: { type: 'string', description: '可选：按内容类型过滤，逗号分隔。取值 doc（文档）/session（会话导出）/config（yml/conf/env 等配置）/script（sh/service 等脚本）。不填=全部。' },
        max_results: { type: 'integer', description: '最多返回条数，默认 5（省上下文：先定位再精读）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'sync_mirror',
    description:
      '增量同步本地镜像并更新 FTS 索引（git remote update --prune + 索引重建，约 10-30s，上限 GITEA_SYNC_TIMEOUT）。' +
      '这是唯一会写镜像的工具：上游已删除的分支/标签会在本地镜像中被修剪，因此带 destructiveHint。' +
      '仅在“刚推送了提交、必须立刻检索到”时显式调用一次；镜像另有定时自动同步，不要在循环里调用。' +
      '若另一轮同步正在进行，不会重复同步并返回 SYNC_BUSY。搜索类工具（search_code / search_docs / read_file）永远只读。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];

// 向后兼容别名映射（承诺保留至 v3.0.0 前）：
// tools/list 仅暴露 5 个标准中性工具名；tools/call 同时透明转发 v1.x (search_gitea*)
// 与历史 (search_gitorca*) 两族旧名，并在 stderr 输出废弃告警。
const TOOL_ALIASES = {
  search_gitea: 'search_code',
  search_gitea_docs: 'search_docs',
  read_gitea_file: 'read_file',
  list_gitea_repos: 'list_repositories',
  search_gitorca: 'search_code',
  search_gitorca_docs: 'search_docs',
  read_gitorca_file: 'read_file',
  list_gitorca_repos: 'list_repositories',
};

const IMPLEMENTATIONS = {
  search_code: searchCode,
  read_file: readFile,
  list_repositories: listRepositories,
  search_docs: searchDocs,
  sync_mirror: syncMirror,
};

/**
 * 静态导出 Function Calling JSON Schema（面向非 stdio 编排框架与离线契约检查）。
 * 纯静态：不读配置/镜像、不连传输层、不 spawn 子进程。
 */
function dumpSchema(opts = {}) {
  const functions = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema || { type: 'object', properties: {} },
  }));
  if (opts.compact) return { functions };
  return { service: SERVER_NAME, version: SERVER_VERSION, transport: 'stdio', functions };
}

/** 创建已注册工具的 MCP Server 实例（未连接传输层，便于单测与任意入口复用）。 */
function createServer(opts = {}) {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  const audit = opts.auditLogger || createAuditLogger({ logError: (...m) => log(...m) });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: a = {} } = req.params || {};
    const t0 = Date.now();
    const targetName = TOOL_ALIASES[name];
    const effectiveName = targetName || name;
    const deprecatedAlias = Boolean(targetName);
    // 注意：MCP 的 CallToolResult 必须是 { content: [{type:'text',text}] }；
    // 写成 { text } 会被原样序列化，content 变成 []，客户端拿不到正文。
    const wrap = (r) => {
      const elapsedMs = Date.now() - t0;
      if (elapsedMs > 5000) {
        log(`[PERF-CRITICAL] tool=${name} elapsed=${elapsedMs}ms (>5000ms)`);
      } else if (elapsedMs > 2000) {
        log(`[PERF-WARN] tool=${name} elapsed=${elapsedMs}ms (>2000ms)`);
      }
      const meta = r && r._audit && typeof r._audit === 'object' ? r._audit : {};
      audit.record({
        clientInfo: typeof server.getClientVersion === 'function' ? server.getClientVersion() : undefined,
        startedAt: new Date(t0),
        tool: effectiveName,
        rawTool: name,
        deprecatedAlias,
        args: a,
        elapsedMs,
        internalMs: meta.internalMs,
        hits: meta.hits,
        hitRepos: meta.hitRepos,
        redactedHits: meta.redactedHits,
        blockedSensitive: meta.blockedSensitive,
        respBytes: Buffer.byteLength(String(r?.text || ''), 'utf8'),
        truncated: Boolean(meta.truncated),
        isError: Boolean(r?.isError),
      });
      return {
        content: [{ type: 'text', text: r.text }],
        ...(r.isError ? { isError: true } : {}),
      };
    };
    try {
      if (deprecatedAlias) {
        log(`⚠️ 工具 ${name} 已废弃，请改用 ${targetName}`);
      }
      const impl = IMPLEMENTATIONS[effectiveName];
      if (!impl) return wrap({ text: `未知工具：${name}`, isError: true });
      return wrap(await impl(a, { signal: extra?.signal }));
    } catch (e) {
      log('tool error', name, String((e && e.stack) || e));
      return wrap({ text: `内部错误：${String((e && e.message) || e)}`, isError: true });
    }
  });

  return server;
}

/** 连接标准 MCP stdio 传输并打印启动诊断日志到 stderr。 */
function installShutdownHooks() {
  // 宿主退出/断开 stdio 时终止仍在运行的 gts / git / sync 进程组，避免孤儿进程。
  process.on('exit', () => killAllChildren());
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { killAllChildren(); process.exit(0); });
  }
  process.stdin.on('end', () => { killAllChildren(); });
}

async function startStdioServer() {
  ensureRuntimeConfig();
  installShutdownHooks();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const _gtsAtStart = findGts();
  log(`started; mirror=${MIRROR}; config_sources=${JSON.stringify(EFFECTIVE_CONFIG.sources)}; platform=${process.platform}; gts=${_gtsAtStart && !_gtsAtStart.error ? `${_gtsAtStart.bin} (${_gtsAtStart.kind})` : '(未找到)'}`);
  if (CONFIG_ERROR) log(CONFIG_ERROR);
  if (_gtsAtStart?.error) {
    log(_gtsAtStart.error);
  } else if (!_gtsAtStart) {
    log(IS_WIN
      ? '提示：Windows 上检索需要 .exe 或 .cmd 入口。推荐 `pip install .` 生成 Scripts\\gts.exe，'
        + '或用 PyInstaller 打包后设 GITEA_SEARCH_CLI / GTS_BIN=C:\\path\\to\\gts.exe。详见 docs/OPERATIONS.md §1.3。'
      : '提示：请设 GITEA_SEARCH_CLI / GTS_BIN 或安装到 /usr/local/bin/gts。');
  }
  return server;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
}

if (isDirectRun()) {
  await startStdioServer();
}

export {
  SERVER_NAME,
  SERVER_VERSION,
  TOOLS,
  TOOL_ALIASES,
  createServer,
  dumpSchema,
  startStdioServer,
  searchCode,
  readFile,
  listRepositories,
  searchDocs,
  syncMirror,
};

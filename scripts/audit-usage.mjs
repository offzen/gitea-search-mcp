#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * scripts/audit-usage.mjs (CLI: gts-audit)
 *
 * Debugging & observability utility for gitea-search-mcp:
 *   1) Audits MCP tool usage across Layer-1 server JSONL logs (`GITEA_AUDIT_LOG`)
 *      and Layer-2 local host session transcripts (T3/Antigravity, DSH v4, Codex).
 *   2) Analyzes invocation phases (session opening vs mid-execution vs follow-up turns)
 *      and separates T3 lazy-loaded MCP schema reads from real tool invocations.
 *   3) Clusters adjacent calls into Search Episodes and estimates net time saved vs
 *      non-MCP fallback workflows (conservative / baseline / optimistic), explicitly
 *      deducting zero-hit retries, lazy schema overhead, and `sync: true` blocking time.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStateDir } from '../lib/audit.mjs';
import { decompressZstd as decompressZstdRaw } from '../lib/zstd.mjs';

const IS_WIN = process.platform === 'win32';

const TOOL_NORMALIZATION = {
  sync_mirror: 'sync_mirror',
  search_code: 'search_code',
  search_gitea: 'search_code',
  search_gitorca: 'search_code',
  search_docs: 'search_docs',
  search_gitea_docs: 'search_docs',
  search_gitorca_docs: 'search_docs',
  read_file: 'read_file',
  read_gitea_file: 'read_file',
  read_gitorca_file: 'read_file',
  list_repositories: 'list_repositories',
  list_gitea_repos: 'list_repositories',
  list_gitorca_repos: 'list_repositories',
  search_gitea_hybrid: 'search_hybrid',
  search_gitorca_hybrid: 'search_hybrid',
  search_hybrid: 'search_hybrid',
  search_gitea_semantic: 'search_semantic',
  search_gitorca_semantic: 'search_semantic',
  search_semantic: 'search_semantic',
  search_workspace_code: 'search_workspace_code',
  search_gitea_workspace_code: 'search_workspace_code',
  search_gitorca_workspace_code: 'search_workspace_code',
};

const TIER_PARAMS = {
  conservative: {
    label: '保守下界 (Conservative)',
    E1_docs_session: { savedSteps: 2.0, savedExecSec: 15 },
    E2_code_search: { savedSteps: 1.0, savedExecSec: 8 },
    E3_direct_read: { savedSteps: 0.5, savedExecSec: 3 },
  },
  baseline: {
    label: '基线估值 (Baseline)',
    E1_docs_session: { savedSteps: 3.0, savedExecSec: 28 },
    E2_code_search: { savedSteps: 2.0, savedExecSec: 16 },
    E3_direct_read: { savedSteps: 0.75, savedExecSec: 6 },
  },
  optimistic: {
    label: '乐观上界 (Optimistic)',
    E1_docs_session: { savedSteps: 4.0, savedExecSec: 45 },
    E2_code_search: { savedSteps: 3.0, savedExecSec: 25 },
    E3_direct_read: { savedSteps: 1.0, savedExecSec: 10 },
  },
};

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function decompressZstd(buf, opts = {}) {
  return decompressZstdRaw(buf, {
    forceCli: opts.forceCli ?? (process.env.GITEA_AUDIT_FORCE_ZSTD_CLI === '1'),
    zstdBin: opts.zstdBin,
  });
}

function unwrapJsonValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return val;
}

function normalizeToolName(rawName, serverHint = '') {
  const s = String(rawName || '').trim();
  if (!s) return null;
  let server = String(serverHint || '').toLowerCase();

  // Strip common host prefixes: mcp__gitea-search__search_code, mcp__gitea_search__read_file, mcp_gitea-search_search_code, etc.
  let stripped = s;
  const dblPrefix = /^mcp__([a-z0-9_-]+?)__(.+)$/i.exec(stripped);
  if (dblPrefix) {
    if (!server) server = dblPrefix[1].toLowerCase();
    stripped = dblPrefix[2];
  } else {
    const sglPrefix = /^mcp_((?:gitea|gitorca)[-_]?search|[a-z0-9-]+)_(.+)$/i.exec(stripped);
    if (sglPrefix) {
      if (!server) server = sglPrefix[1].toLowerCase();
      stripped = sglPrefix[2];
    }
  }
  stripped = stripped
    .replace(/^gitea[-_]?search[:./]+/i, '')
    .replace(/^gitorca[-_]?search[:./]+/i, '');

  const isGiteaServer = /gitea[-_]?search|gitorca[-_]?search/.test(server);
  const lowerFull = s.toLowerCase();
  const lowerStripped = stripped.toLowerCase();

  // Direct match on unambiguous gitea/gitorca names
  if (/(gitea|gitorca)/.test(lowerFull)) {
    if (TOOL_NORMALIZATION[lowerStripped]) return TOOL_NORMALIZATION[lowerStripped];
    for (const [k, v] of Object.entries(TOOL_NORMALIZATION)) {
      if (lowerFull.endsWith(k)) return v;
    }
  }

  // Match bare v2.0.0 names when server hint confirms gitea-search OR tool name itself is specific
  if (isGiteaServer && TOOL_NORMALIZATION[lowerStripped]) {
    return TOOL_NORMALIZATION[lowerStripped];
  }
  if (['search_docs', 'search_code', 'list_repositories', 'search_workspace_code', 'sync_mirror'].includes(lowerStripped)) {
    if (!dblPrefix && !server && lowerStripped !== lowerFull) return null;
    return TOOL_NORMALIZATION[lowerStripped];
  }
  return null;
}

const SYNC_MOVED_BANNER_RE = /(?:^|\n)⚠️\s*SYNC_MOVED:\s/;

function isSyncCall(tool, args = {}, meta = {}, output = '') {
  if (tool === 'sync_mirror') return true;
  if (tool !== 'search_code' || meta?.sync_ignored || meta?.sync === false) return false;
  if (output && SYNC_MOVED_BANNER_RE.test(stripToolEnvelope(output))) return false;
  return args?.sync === true || meta?.sync === true;
}

function toolOutputText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const texts = value.map((item) => (typeof item?.text === 'string' ? item.text : '')).filter(Boolean);
    if (texts.length) return texts.join('\n');
  } else if (typeof value === 'object' && Array.isArray(value.content)) {
    const texts = value.content.map((item) => (typeof item?.text === 'string' ? item.text : '')).filter(Boolean);
    if (texts.length) return texts.join('\n');
  } else if (typeof value === 'object' && typeof value.content === 'string') {
    return value.content;
  }
  return JSON.stringify(value);
}

function parseTimestampMs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val > 1e12 ? val : val * 1000;
  }
  if (typeof val === 'string' && val.trim()) {
    const ms = Date.parse(val);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function parseSinceArg(sinceStr, nowMs = Date.now()) {
  if (!sinceStr) return null;
  const s = String(sinceStr).trim();
  const relMatch = /^(\d+)([dhm])$/i.exec(s);
  if (relMatch) {
    const n = Number(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const mult = unit === 'd' ? 86400_000 : unit === 'h' ? 3600_000 : 60_000;
    if (unit === 'd') {
      // Align to local 00:00:00 midnight so natural-day boundaries are preserved
      const d = new Date(nowMs);
      d.setHours(0, 0, 0, 0);
      return d.getTime() - n * 86400_000;
    }
    return nowMs - n * mult;
  }
  const parsed = Date.parse(s);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --since value: ${sinceStr} (expected YYYY-MM-DD or Nd/Nh/Nm)`);
  }
  return parsed;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)));
  return s[idx];
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function walkMatchingFiles(rootDir, predicate, maxDepth = 6) {
  const results = [];
  if (!rootDir || !fs.existsSync(rootDir)) return results;

  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < maxDepth && ent.name !== 'node_modules' && ent.name !== '.git' && ent.name !== 'attachments') {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else if (ent.isFile() && predicate(full, ent.name)) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

function stripToolEnvelope(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/^(?:(?:Created|Completed) At:[^\n]*\n)+/, '').trimStart();
}

function detectZeroHitFromText(text) {
  const body = stripToolEnvelope(text);
  if (!body) return false;
  return /(?:^|\n)（无命中|(?:^|[^\d])命中\s*0\s*篇|(?:^|[^\d])全库命中\s*0\s*条|(?:^|[^\d])返回\s*0\s*条|(?:^|[^\d])0\s*个仓/.test(body);
}

function detectErrorFromText(text) {
  const body = stripToolEnvelope(text);
  if (!body) return false;
  return /^(?:搜索错误：|读取失败：|内部错误：|CONFIG_ERROR:|GIT_SEARCH_FAILED:|未知工具：)/.test(body);
}

function detectInternalMsFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = /耗时\s+([0-9.]+)ms/.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * 统一时间窗口过滤口径（审计 #17）：
 * - 未指定 --since（sinceMs === null）时，所有调用（含缺失时间戳的旧记录）全部计入；
 * - 指定 --since 时，统一按调用发起/请求时间戳（tsMs）过滤，仅保留 tsMs >= sinceMs 的调用；
 * - 跨边界调用（开始早于 sinceMs、返回晚于 sinceMs）按开始时间判定为窗口外，与服务端 JSONL 审计日志口径一致；
 * - 启用时间窗时，缺失时间戳（tsMs === null）的调用予以排除，防止无法定位时间的历史调用混入统计。
 */
function isCallInWindow(tsMs, sinceMs) {
  if (sinceMs === null || sinceMs === undefined) return true;
  return typeof tsMs === 'number' && Number.isFinite(tsMs) && tsMs >= sinceMs;
}

/** Parse Layer-1 MCP Server audit JSONL file(s). */
function parseAuditLogs(pathsOrDirs, sinceMs = null) {
  const files = [];
  for (const p of pathsOrDirs) {
    const resolved = path.resolve(expandHome(p));
    if (!fs.existsSync(resolved)) continue;
    const st = fs.statSync(resolved);
    if (st.isFile()) {
      files.push(resolved);
    } else if (st.isDirectory()) {
      for (const ent of fs.readdirSync(resolved)) {
        if (/^audit.*\.jsonl$/i.test(ent)) {
          files.push(path.join(resolved, ent));
        }
      }
    }
  }

  const bySession = new Map();
  let totalRecords = 0;

  for (const file of files.sort()) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const endTsMs = parseTimestampMs(rec.ts);
      const explicitStartMs = parseTimestampMs(rec.started_ts);
      // 审计 #17：优先使用显式调用开始时间 started_ts；旧日志无 started_ts 时按 ts - elapsed_ms
      // 推算开始时间（毫秒级近似，与宿主按请求发起时间过滤的口径保持一致）。
      let tsMs = explicitStartMs;
      if (tsMs === null && endTsMs !== null) {
        const elapsed = typeof rec.elapsed_ms === 'number' && Number.isFinite(rec.elapsed_ms) && rec.elapsed_ms >= 0
          ? rec.elapsed_ms
          : 0;
        tsMs = endTsMs - elapsed;
      }
      if (!isCallInWindow(tsMs, sinceMs)) continue;
      totalRecords += 1;
      const sid = String(rec.proc_session_id || `${rec.pid || 'unknown'}-${file}`);
      if (!bySession.has(sid)) {
        bySession.set(sid, {
          source: 'audit_log',
          host: rec.client || 'unknown',
          sessionId: sid,
          totalTurns: null,
          totalTools: 0,
          lazySchemaReads: 0,
          stepIntervalsSec: [],
          calls: [],
        });
      }
      const sess = bySession.get(sid);
      sess.totalTools += 1;
      const argsMeta = rec.args_meta || {};
      const tool = normalizeToolName(rec.tool || rec.raw_tool, 'gitea-search') || rec.tool || 'unknown';
      sess.calls.push({
        tool,
        rawTool: rec.raw_tool || rec.tool || 'unknown',
        turn: null,
        toolIndexInTurn: null,
        toolIndexInSession: sess.totalTools,
        tsMs,
        elapsedMs: typeof rec.elapsed_ms === 'number' ? rec.elapsed_ms : null,
        internalMs: typeof rec.internal_ms === 'number' ? rec.internal_ms : null,
        hits: typeof rec.hits === 'number' ? rec.hits : null,
        isZeroHit: tool !== 'sync_mirror' && rec.hits === 0,
        isError: Boolean(rec.is_error),
        truncated: Boolean(rec.truncated),
        sync: isSyncCall(tool, rec.args, argsMeta, toolOutputText(rec.output ?? rec.content)),
        repo: argsMeta.repo || '',
      });
    }
  }

  return { filesScanned: files.length, totalRecords, sessions: [...bySession.values()] };
}

/** Parse a single T3/Antigravity transcript.jsonl file. */
function parseT3Transcript(filePath, sinceMs = null) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const objs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      objs.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  if (!objs.length) return null;

  let lastTs = null;
  for (const o of objs) {
    const t = parseTimestampMs(o?.created_at);
    if (t !== null) lastTs = t;
  }
  if (sinceMs !== null && (lastTs === null || lastTs < sinceMs)) return null;

  const matchCid = /[/\\]brain[/\\]([^/\\]+)[/\\]/.exec(filePath);
  const sessionId = matchCid ? matchCid[1] : path.basename(path.dirname(filePath));

  let userTurn = 0;
  let toolInTurn = 0;
  let toolInSession = 0;
  let lazySchemaReads = 0;
  const calls = [];
  const stepIntervalsSec = [];
  let prevPlannerTs = null;

  for (let i = 0; i < objs.length; i += 1) {
    const o = objs[i];
    const tsMs = parseTimestampMs(o.created_at);
    if (o.type === 'USER_INPUT') {
      userTurn += 1;
      toolInTurn = 0;
      prevPlannerTs = tsMs;
      continue;
    }
    if (o.type === 'PLANNER_RESPONSE' && tsMs && prevPlannerTs && tsMs > prevPlannerTs) {
      const deltaSec = (tsMs - prevPlannerTs) / 1000;
      if (deltaSec >= 1 && deltaSec <= 120 && isCallInWindow(tsMs, sinceMs)) stepIntervalsSec.push(deltaSec);
      prevPlannerTs = tsMs;
    }
    const tcs = Array.isArray(o.tool_calls) ? o.tool_calls : [];
    for (let k = 0; k < tcs.length; k += 1) {
      const tc = tcs[k];
      toolInSession += 1;
      toolInTurn += 1;
      const name = String(tc.name || '');
      let args = tc.arguments ?? tc.args ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { _raw: args };
        }
      }
      const argsStr = JSON.stringify(args);

      // Track Antigravity lazy MCP schema / skill reads separately
      if (
        (name === 'read_file' || name === 'view_file')
        && (/[/\\]mcp[/\\]gitea-search[/\\]/.test(argsStr) || /[/\\]skills[/\\]gitea-search[/\\]SKILL\.md/.test(argsStr))
      ) {
        if (isCallInWindow(tsMs, sinceMs)) lazySchemaReads += 1;
        continue;
      }

      let normalized = null;
      let rawTool = name;
      let innerArgs = args;
      if (name === 'call_mcp_tool') {
        const srv = String(unwrapJsonValue(args.ServerName ?? args.serverName ?? '') || '');
        const tn = String(unwrapJsonValue(args.ToolName ?? args.toolName ?? '') || '');
        if (/gitea[-_]?search|gitorca[-_]?search/i.test(srv)) {
          normalized = normalizeToolName(tn, srv) || tn;
          rawTool = `${srv}:${tn}`;
          const parsedInner = unwrapJsonValue(args.Arguments ?? args.arguments ?? {});
          innerArgs = parsedInner && typeof parsedInner === 'object' ? parsedInner : {};
        }
      } else {
        normalized = normalizeToolName(name, '');
      }

      if (normalized) {
        // Match the k-th tool response step immediately following this planner step
        let internalMs = null;
        let isZeroHit = false;
        let isError = false;
        let content = '';
        const respStep = objs[i + 1 + k];
        if (respStep && respStep.type !== 'USER_INPUT' && respStep.type !== 'PLANNER_RESPONSE') {
          content = toolOutputText(respStep.content);
          if (content) {
            internalMs = detectInternalMsFromText(content);
            if (normalized !== 'read_file' && normalized !== 'sync_mirror' && detectZeroHitFromText(content)) isZeroHit = true;
            if (respStep.status === 'ERROR' || detectErrorFromText(content)) isError = true;
          }
        }
        calls.push({
          tool: normalized,
          rawTool,
          turn: Math.max(1, userTurn),
          toolIndexInTurn: toolInTurn,
          toolIndexInSession: toolInSession,
          tsMs,
          elapsedMs: null,
          internalMs,
          hits: isZeroHit ? 0 : null,
          isZeroHit,
          isError,
          truncated: false,
          sync: isSyncCall(normalized, innerArgs, tc.args_meta ?? innerArgs?.args_meta ?? {}, content),
          repo: typeof innerArgs?.repo === 'string' ? innerArgs.repo : '',
        });
      }
    }
  }

  return {
    source: 't3',
    host: 'T3 Code (Antigravity)',
    sessionId,
    totalTurns: Math.max(1, userTurn),
    totalTools: toolInSession,
    lazySchemaReads,
    stepIntervalsSec,
    calls: calls.filter((c) => isCallInWindow(c.tsMs, sinceMs)),
  };
}

/** Parse a single DSH v4 (.zstd or .jsonl) session file. */
function parseDshSession(filePath, sinceMs = null, opts = {}) {
  let text;
  try {
    const rawBuf = fs.readFileSync(filePath);
    text = filePath.endsWith('.zstd') || filePath.endsWith('.zst')
      ? decompressZstd(rawBuf, opts).toString('utf8')
      : rawBuf.toString('utf8');
  } catch (err) {
    if (typeof opts.onWarning === 'function') {
      opts.onWarning(`Skipped unreadable DSH session (${path.basename(filePath)}): ${err?.message || err}`);
    }
    return null;
  }

  const lines = text.split('\n');
  let sessionId = path.basename(path.dirname(filePath));
  let turn = 0;
  let toolInTurn = 0;
  let toolInSession = 0;
  let lastTs = null;
  let prevStepEndTs = null;
  const stepIntervalsSec = [];
  const pending = new Map();
  const calls = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const type = obj.type || '';
    const data = obj.data && typeof obj.data === 'object' ? obj.data : {};
    const tsMs = parseTimestampMs(obj.time ?? obj.createdAt);
    if (tsMs !== null) lastTs = tsMs;

    if (type === 'session' && obj.id) {
      sessionId = String(obj.id);
    } else if (type === 'turn/start') {
      turn = Number(data.turn) || (turn + 1);
      toolInTurn = 0;
      prevStepEndTs = tsMs;
    } else if (type === 'step/start' && tsMs && prevStepEndTs && tsMs > prevStepEndTs) {
      const deltaSec = (tsMs - prevStepEndTs) / 1000;
      if (deltaSec >= 1 && deltaSec <= 120 && isCallInWindow(tsMs, sinceMs)) stepIntervalsSec.push(deltaSec);
    } else if (type === 'step/end' && tsMs) {
      prevStepEndTs = tsMs;
    } else if (type === 'tool/call') {
      toolInSession += 1;
      toolInTurn += 1;
      const rawName = String(data.name || data.toolName || '');
      const callId = String(data.callId || data.id || '');
      const normalized = normalizeToolName(rawName, '');
      if (normalized) {
        const parsedArgs = unwrapJsonValue(data.arguments ?? data.input ?? {});
        const args = parsedArgs && typeof parsedArgs === 'object' ? parsedArgs : {};
        const argsMeta = data.args_meta ?? args.args_meta ?? {};
        const rec = {
          tool: normalized,
          rawTool: rawName,
          turn: Math.max(1, turn),
          toolIndexInTurn: toolInTurn,
          toolIndexInSession: toolInSession,
          tsMs,
          elapsedMs: null,
          internalMs: null,
          hits: null,
          isZeroHit: false,
          isError: false,
          truncated: false,
          sync: isSyncCall(normalized, args, argsMeta),
          repo: typeof args?.repo === 'string' ? args.repo : '',
        };
        calls.push(rec);
        if (callId) pending.set(callId, { rec, startMs: tsMs, args, argsMeta });
      }
    } else if (type === 'tool/result') {
      const msg = data.message && typeof data.message === 'object' ? data.message : {};
      const callId = String(msg.toolCallId || msg.source?.callId || data.callId || '');
      if (callId && pending.has(callId)) {
        const { rec, startMs, args, argsMeta } = pending.get(callId);
        pending.delete(callId);
        if (tsMs && startMs && tsMs >= startMs && tsMs - startMs < 600_000) {
          rec.elapsedMs = tsMs - startMs;
        }
        const textOut = Array.isArray(msg.content)
          ? msg.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
          : toolOutputText(msg.content ?? data.output);
        if (textOut) {
          rec.sync = isSyncCall(rec.tool, args, argsMeta, textOut);
          rec.internalMs = detectInternalMsFromText(textOut);
          rec.isZeroHit = rec.tool !== 'read_file' && rec.tool !== 'sync_mirror' && detectZeroHitFromText(textOut);
          if (rec.isZeroHit) rec.hits = 0;
          if (msg.isError || data.isError || detectErrorFromText(textOut)) {
            rec.isError = true;
          }
          if (/输出护栏/.test(textOut)) rec.truncated = true;
        }
      }
    }
  }

  if (sinceMs !== null && (lastTs === null || lastTs < sinceMs)) return null;

  return {
    source: 'dsh',
    host: 'DSH v4',
    sessionId,
    totalTurns: Math.max(1, turn),
    totalTools: toolInSession,
    lazySchemaReads: 0,
    stepIntervalsSec,
    calls: calls.filter((c) => isCallInWindow(c.tsMs, sinceMs)),
  };
}

/** Parse a single Codex rollout-*.jsonl session file. */
function parseCodexSession(filePath, sinceMs = null) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let sessionId = path.basename(filePath, '.jsonl');
  let userTurn = 0;
  let toolInTurn = 0;
  let toolInSession = 0;
  let lastTs = null;
  let prevEventTs = null;
  const stepIntervalsSec = [];
  const pending = new Map();
  const calls = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const tsMs = parseTimestampMs(obj.timestamp ?? obj.created_at);
    if (tsMs !== null) lastTs = tsMs;
    const type = obj.type || '';
    const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;

    if (type === 'session_meta' && payload.id) {
      sessionId = String(payload.id);
    } else if (
      (type === 'event_msg' && payload.type === 'user_message')
      || (type === 'response_item' && payload.type === 'message' && payload.role === 'user')
    ) {
      userTurn += 1;
      toolInTurn = 0;
      prevEventTs = tsMs;
    } else if (type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
      toolInSession += 1;
      toolInTurn += 1;
      if (tsMs && prevEventTs && tsMs > prevEventTs) {
        const deltaSec = (tsMs - prevEventTs) / 1000;
        if (deltaSec >= 1 && deltaSec <= 120 && isCallInWindow(tsMs, sinceMs)) stepIntervalsSec.push(deltaSec);
      }
      prevEventTs = tsMs;
      const rawName = String(payload.name || '');
      const normalized = normalizeToolName(rawName, '');
      if (normalized) {
        let args = payload.arguments ?? payload.input ?? {};
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        const callId = String(payload.call_id || payload.id || '');
        const argsMeta = payload.args_meta ?? args?.args_meta ?? {};
        const rec = {
          tool: normalized,
          rawTool: rawName,
          turn: Math.max(1, userTurn),
          toolIndexInTurn: toolInTurn,
          toolIndexInSession: toolInSession,
          tsMs,
          elapsedMs: null,
          internalMs: null,
          hits: null,
          isZeroHit: false,
          isError: false,
          truncated: false,
          sync: isSyncCall(normalized, args, argsMeta),
          repo: typeof args?.repo === 'string' ? args.repo : '',
        };
        calls.push(rec);
        if (callId) pending.set(callId, { rec, startMs: tsMs, args, argsMeta });
      }
    } else if (
      type === 'response_item'
      && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
    ) {
      const callId = String(payload.call_id || payload.id || '');
      if (callId && pending.has(callId)) {
        const { rec, startMs, args, argsMeta } = pending.get(callId);
        pending.delete(callId);
        if (tsMs && startMs && tsMs >= startMs && tsMs - startMs < 600_000) {
          rec.elapsedMs = tsMs - startMs;
        }
        const outStr = toolOutputText(payload.output);
        rec.sync = isSyncCall(rec.tool, args, argsMeta, outStr);
        rec.internalMs = detectInternalMsFromText(outStr);
        rec.isZeroHit = rec.tool !== 'sync_mirror' && detectZeroHitFromText(outStr);
        if (rec.isZeroHit) rec.hits = 0;
        if (detectErrorFromText(outStr)) rec.isError = true;
        if (/输出护栏/.test(outStr)) rec.truncated = true;
      }
      prevEventTs = tsMs;
    }
  }

  if (sinceMs !== null && (lastTs === null || lastTs < sinceMs)) return null;

  return {
    source: 'codex',
    host: 'Codex',
    sessionId,
    totalTurns: Math.max(1, userTurn),
    totalTools: toolInSession,
    lazySchemaReads: 0,
    stepIntervalsSec,
    calls: calls.filter((c) => isCallInWindow(c.tsMs, sinceMs)),
  };
}

/**
 * Cluster consecutive calls within a session into Search Episodes so repeated
 * read_file / chained refinements on the same task do not double-count savings.
 */
function clusterEpisodes(calls, episodeGap = 3) {
  if (!calls.length) return [];
  const episodes = [];
  let cur = null;

  for (const call of calls) {
    if (call.tool === 'sync_mirror') continue;
    const canJoin = cur !== null && (
      (call.turn === cur.turn && (
        (call.toolIndexInSession - cur.lastToolIdx) <= episodeGap
        || (call.repo && cur.repos.has(call.repo) && (call.toolIndexInSession - cur.lastToolIdx) <= episodeGap * 3)
      ))
      || (cur.turn === null && call.tsMs && cur.lastTsMs && (call.tsMs - cur.lastTsMs) <= 90_000)
    );

    if (!canJoin) {
      cur = {
        turn: call.turn,
        firstToolIdx: call.toolIndexInSession,
        lastToolIdx: call.toolIndexInSession,
        lastTsMs: call.tsMs,
        repos: new Set(),
        calls: [],
      };
      episodes.push(cur);
    }
    cur.lastToolIdx = call.toolIndexInSession;
    cur.lastTsMs = call.tsMs;
    if (call.repo) cur.repos.add(call.repo);
    cur.calls.push(call);
  }

  return episodes.map((ep) => {
    const toolSet = new Set(ep.calls.map((c) => c.tool));
    const effectiveCalls = ep.calls.filter((c) => !c.isZeroHit && !c.isError);
    let kind = 'E3_direct_read';
    if (toolSet.has('search_docs') || toolSet.has('search_hybrid') || toolSet.has('search_semantic')) {
      kind = 'E1_docs_session';
    } else if (toolSet.has('search_code') || toolSet.has('search_workspace_code')) {
      kind = 'E2_code_search';
    }
    const zeroHitCalls = ep.calls.filter((c) => c.isZeroHit).length;
    const syncCalls = ep.calls.filter((c) => c.sync).length;
    const mcpExecSec = ep.calls.reduce((sum, c) => sum + ((c.elapsedMs ?? 450) / 1000), 0);
    return {
      kind,
      callCount: ep.calls.length,
      effectiveCount: effectiveCalls.length,
      zeroHitCalls,
      syncCalls,
      distinctRepos: Math.max(1, ep.repos.size),
      mcpExecSec,
    };
  });
}

/** Estimate net time saved across conservative / baseline / optimistic tiers. */
function estimateSavings(sessions, opts = {}) {
  const episodeGap = Number(opts.episodeGap) > 0 ? Number(opts.episodeGap) : 3;
  const observedIntervals = sessions.flatMap((s) => s.stepIntervalsSec || []);
  const observedMedian = median(observedIntervals);
  const llmStepSec = Number(opts.llmStepSec) > 0
    ? Number(opts.llmStepSec)
    : (observedMedian !== null ? Math.min(25, Math.max(6, Number(observedMedian.toFixed(1)))) : 12);

  const allEpisodes = [];
  let lazyOverheadSessions = 0;
  let totalZeroHitCalls = 0;
  let totalSyncCalls = 0;
  let standaloneSyncSec = 0;

  for (const sess of sessions) {
    if (!sess.calls.length) continue;
    if (sess.lazySchemaReads > 0) lazyOverheadSessions += 1;
    for (const call of sess.calls) {
      if (call.tool !== 'sync_mirror') continue;
      totalSyncCalls += 1;
      standaloneSyncSec += (call.elapsedMs ?? 15_000) / 1000;
    }
    const eps = clusterEpisodes(sess.calls, episodeGap);
    for (const ep of eps) {
      allEpisodes.push(ep);
      totalZeroHitCalls += ep.zeroHitCalls;
      totalSyncCalls += ep.syncCalls;
    }
  }

  const episodeCounts = { E1_docs_session: 0, E2_code_search: 0, E3_direct_read: 0 };
  for (const ep of allEpisodes) episodeCounts[ep.kind] += 1;

  const activeSessionCount = sessions.filter((s) => s.calls.length > 0).length;
  const tiers = {};

  for (const [tierKey, cfg] of Object.entries(TIER_PARAMS)) {
    let grossExecSavedSec = 0;
    let grossLlmSavedSec = 0;
    let mcpExecTotalSec = 0;
    let penaltyZeroHitSec = 0;
    let penaltySyncSec = standaloneSyncSec;

    for (const ep of allEpisodes) {
      mcpExecTotalSec += ep.mcpExecSec;
      // Only award savings if the episode produced at least one non-zero-hit, non-error result
      if (ep.effectiveCount > 0) {
        const spec = cfg[ep.kind];
        // For E3_direct_read, scale conservatively by distinct repos (capped at 3) rather than raw read count
        const multiplier = ep.kind === 'E3_direct_read' ? Math.min(3, ep.distinctRepos) : 1;
        grossExecSavedSec += spec.savedExecSec * multiplier;
        grossLlmSavedSec += spec.savedSteps * llmStepSec * multiplier;
      }
      // Deduct zero-hit retry penalty (half an LLM step per zero-hit refinement)
      penaltyZeroHitSec += ep.zeroHitCalls * (0.5 * llmStepSec);
      // Legacy searches with inline sync retain their historical blocking estimate.
      penaltySyncSec += ep.syncCalls * 15;
    }

    // Deduct lazy schema loading overhead (1 LLM round-trip per session that read schema files)
    const penaltyLazySchemaSec = lazyOverheadSessions * llmStepSec;
    const totalPenaltySec = mcpExecTotalSec + penaltyZeroHitSec + penaltySyncSec + penaltyLazySchemaSec;
    const grossTotalSec = grossExecSavedSec + grossLlmSavedSec;
    const netSavedSec = Math.max(0, grossTotalSec - totalPenaltySec);

    tiers[tierKey] = {
      label: cfg.label,
      gross_saved_sec: Number(grossTotalSec.toFixed(1)),
      gross_exec_saved_sec: Number(grossExecSavedSec.toFixed(1)),
      gross_llm_saved_sec: Number(grossLlmSavedSec.toFixed(1)),
      penalty_sec: Number(totalPenaltySec.toFixed(1)),
      penalty_breakdown_sec: {
        mcp_exec: Number(mcpExecTotalSec.toFixed(1)),
        zero_hit_retries: Number(penaltyZeroHitSec.toFixed(1)),
        lazy_schema_reads: Number(penaltyLazySchemaSec.toFixed(1)),
        sync_blocking: Number(penaltySyncSec.toFixed(1)),
      },
      net_saved_sec: Number(netSavedSec.toFixed(1)),
      net_saved_min: Number((netSavedSec / 60).toFixed(2)),
      net_saved_sec_per_active_session: activeSessionCount > 0
        ? Number((netSavedSec / activeSessionCount).toFixed(1))
        : 0,
    };
  }

  return {
    model: 'episode-clustered-net-savings-v1',
    llm_step_sec: llmStepSec,
    llm_step_source: Number(opts.llmStepSec) > 0
      ? 'cli_override'
      : (observedMedian !== null ? 'observed_session_median' : 'default_fallback'),
    episode_gap: episodeGap,
    total_episodes: allEpisodes.length,
    episodes_by_kind: episodeCounts,
    zero_hit_calls: totalZeroHitCalls,
    lazy_schema_sessions: lazyOverheadSessions,
    sync_calls: totalSyncCalls,
    tiers,
  };
}

/** Aggregate statistics for a group of sessions belonging to one source/host. */
function analyzeSessions(sessions, opts = {}) {
  const sinceMs = opts.sinceMs !== undefined ? opts.sinceMs : null;
  const scopedSessions = sinceMs !== null
    ? sessions.map((s) => ({ ...s, calls: (s.calls || []).filter((c) => isCallInWindow(c.tsMs, sinceMs)) }))
    : sessions;
  const totalSessions = scopedSessions.length;
  const activeSessions = scopedSessions.filter((s) => s.calls.length > 0);
  const allCalls = activeSessions.flatMap((s) => s.calls);

  const byTool = {};
  const firstCallTiming = { turn1_opening: 0, turn1_mid_late: 0, turn2_plus: 0, unknown: 0 };
  const relativePosition = { opening_0_20: 0, early_20_50: 0, late_50_80: 0, wrapup_80_100: 0, unknown: 0 };
  let turn2PlusCalls = 0;
  let zeroHitCalls = 0;
  let errorCalls = 0;
  let truncatedCalls = 0;
  let lazySchemaSessions = 0;
  let lazySchemaOnlySessions = 0;

  const elapsedMsArr = [];
  const internalMsArr = [];

  for (const sess of scopedSessions) {
    if (!sess.calls.length) {
      if (sess.lazySchemaReads > 0) lazySchemaOnlySessions += 1;
      continue;
    }
    if (sess.lazySchemaReads > 0) lazySchemaSessions += 1;

    const first = sess.calls[0];
    if (first.turn === null || !sess.totalTools) {
      firstCallTiming.unknown += 1;
    } else {
      const rel = first.toolIndexInSession / Math.max(1, sess.totalTools);
      if (first.turn <= 1 && rel <= 0.25) firstCallTiming.turn1_opening += 1;
      else if (first.turn <= 1) firstCallTiming.turn1_mid_late += 1;
      else firstCallTiming.turn2_plus += 1;
    }

    for (const c of sess.calls) {
      byTool[c.tool] = (byTool[c.tool] || 0) + 1;
      if (c.isZeroHit) zeroHitCalls += 1;
      if (c.isError) errorCalls += 1;
      if (c.truncated) truncatedCalls += 1;
      if (typeof c.elapsedMs === 'number') elapsedMsArr.push(c.elapsedMs);
      if (typeof c.internalMs === 'number') internalMsArr.push(c.internalMs);
      if (c.turn !== null && c.turn >= 2) turn2PlusCalls += 1;

      if (c.turn === null || !sess.totalTools) {
        relativePosition.unknown += 1;
      } else {
        const rel = c.toolIndexInSession / Math.max(1, sess.totalTools);
        if (rel <= 0.2) relativePosition.opening_0_20 += 1;
        else if (rel <= 0.5) relativePosition.early_20_50 += 1;
        else if (rel <= 0.8) relativePosition.late_50_80 += 1;
        else relativePosition.wrapup_80_100 += 1;
      }
    }
  }

  const savings = estimateSavings(activeSessions, opts);

  return {
    sessions_total: totalSessions,
    sessions_active: activeSessions.length,
    adoption_rate_pct: totalSessions > 0 ? Number(((activeSessions.length * 100) / totalSessions).toFixed(1)) : 0,
    calls_total: allCalls.length,
    avg_calls_per_active_session: activeSessions.length > 0
      ? Number((allCalls.length / activeSessions.length).toFixed(1))
      : 0,
    by_tool: byTool,
    lazy_schema_sessions: lazySchemaSessions,
    ...(lazySchemaOnlySessions > 0 ? { lazy_schema_only_sessions: lazySchemaOnlySessions } : {}),
    phase: {
      first_call_timing: firstCallTiming,
      all_calls_relative_position: relativePosition,
      turn2_plus_calls: turn2PlusCalls,
      turn2_plus_share_pct: allCalls.length > 0 ? Number(((turn2PlusCalls * 100) / allCalls.length).toFixed(1)) : 0,
    },
    quality: {
      zero_hit_calls: zeroHitCalls,
      zero_hit_rate_pct: allCalls.length > 0 ? Number(((zeroHitCalls * 100) / allCalls.length).toFixed(1)) : 0,
      error_calls: errorCalls,
      truncated_calls: truncatedCalls,
      elapsed_ms: elapsedMsArr.length ? {
        samples: elapsedMsArr.length,
        p50: Math.round(median(elapsedMsArr)),
        p90: Math.round(percentile(elapsedMsArr, 0.9)),
        mean: Math.round(mean(elapsedMsArr)),
      } : null,
      internal_fts_ms: internalMsArr.length ? {
        samples: internalMsArr.length,
        p50: Number(median(internalMsArr).toFixed(2)),
        mean: Number(mean(internalMsArr).toFixed(2)),
      } : null,
    },
    savings,
  };
}

function discoverDefaultSources(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const auditDirs = [];
  const stateDir = defaultStateDir(env, process.platform, home);
  if (fs.existsSync(stateDir)) auditDirs.push(stateDir);
  if (env.GITEA_AUDIT_LOG && !['0', 'false', 'off', '1', 'true', 'on', 'auto'].includes(env.GITEA_AUDIT_LOG.toLowerCase())) {
    auditDirs.push(env.GITEA_AUDIT_LOG);
  }

  const t3Dirs = [];
  for (const cand of [env.T3_DATA_DIR, path.join(home, '.t3', 'userdata', 'providers')]) {
    if (cand && fs.existsSync(expandHome(cand))) t3Dirs.push(expandHome(cand));
  }

  const dshDirs = [];
  const seenDsh = new Set();
  const addDshDir = (cand) => {
    if (!cand) return;
    const expanded = expandHome(cand);
    if (!fs.existsSync(expanded)) return;
    let real = expanded;
    try {
      real = fs.realpathSync(expanded);
    } catch {
      // keep expanded path
    }
    if (!seenDsh.has(real)) {
      seenDsh.add(real);
      dshDirs.push(expanded);
    }
  };
  for (const cand of [env.DSH_HOME, path.join(home, '.dsh')]) {
    addDshDir(cand);
  }
  const inTmpHome = path.resolve(expandHome(home)).startsWith(path.resolve(os.tmpdir()));
  const dataRoot = env.GITEA_AUDIT_DATA_ROOT !== undefined
    ? env.GITEA_AUDIT_DATA_ROOT
    : (!IS_WIN && !inTmpHome ? '/data' : '');
  if (dataRoot && fs.existsSync(dataRoot)) {
    try {
      for (const ent of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (ent.isDirectory() && /^dsh[-_]/i.test(ent.name)) {
          addDshDir(path.join(dataRoot, ent.name, 'state', '.dsh'));
        }
      }
    } catch {
      // ignore unreadable /data
    }
  }

  const codexDirs = [];
  for (const cand of [env.CODEX_HOME, path.join(home, '.codex')]) {
    if (cand && fs.existsSync(expandHome(cand))) codexDirs.push(expandHome(cand));
  }

  return { auditDirs, t3Dirs, dshDirs, codexDirs };
}

function runAudit(opts = {}) {
  const sinceMs = opts.since ? parseSinceArg(opts.since) : null;
  const sourceFilter = new Set(
    String(opts.source || 'all')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const wantAll = sourceFilter.has('all') || sourceFilter.size === 0;
  const defaults = opts.noAuto ? { auditDirs: [], t3Dirs: [], dshDirs: [], codexDirs: [] } : discoverDefaultSources();

  const auditPaths = opts.auditLogs?.length ? opts.auditLogs : defaults.auditDirs;
  const t3Dirs = opts.t3Dirs?.length ? opts.t3Dirs : defaults.t3Dirs;
  const dshDirs = opts.dshHomes?.length ? opts.dshHomes : defaults.dshDirs;
  const codexDirs = opts.codexHomes?.length ? opts.codexHomes : defaults.codexDirs;

  const sources = {};
  const combinedHostSessions = [];

  if (wantAll || sourceFilter.has('audit')) {
    const parsed = parseAuditLogs(auditPaths, sinceMs);
    if (parsed.filesScanned > 0 || opts.auditLogs?.length) {
      sources.audit_log = {
        files_scanned: parsed.filesScanned,
        ...analyzeSessions(parsed.sessions, opts),
      };
    }
  }

  if (wantAll || sourceFilter.has('t3')) {
    const files = t3Dirs.flatMap((d) => walkMatchingFiles(expandHome(d), (_full, name) => name === 'transcript.jsonl', 7));
    const sessions = files.map((f) => parseT3Transcript(f, sinceMs)).filter(Boolean);
    if (sessions.length || opts.t3Dirs?.length) {
      sources.t3 = {
        files_scanned: files.length,
        ...analyzeSessions(sessions, opts),
      };
      combinedHostSessions.push(...sessions);
    }
  }

  if (wantAll || sourceFilter.has('dsh')) {
    const files = dshDirs.flatMap((d) => {
      const root = expandHome(d);
      const sessRoot = fs.existsSync(path.join(root, 'sessions')) ? path.join(root, 'sessions') : root;
      return walkMatchingFiles(
        sessRoot,
        (_full, name) => /^session\.v\d+\.jsonl(?:\.zstd?)?$/i.test(name) || /\.jsonl(?:\.zstd?)?$/i.test(name),
        4,
      );
    });
    const dshWarnings = [];
    const sessions = files
      .map((f) => parseDshSession(f, sinceMs, {
        forceCli: opts.forceZstdCli,
        zstdBin: opts.zstdBin,
        onWarning: (msg) => {
          if (dshWarnings.length < 10) dshWarnings.push(msg);
        },
      }))
      .filter(Boolean);
    if (sessions.length || dshWarnings.length || opts.dshHomes?.length) {
      sources.dsh = {
        files_scanned: files.length,
        ...(dshWarnings.length ? { unreadable_files: dshWarnings.length, warnings: dshWarnings } : {}),
        ...analyzeSessions(sessions, opts),
      };
      combinedHostSessions.push(...sessions);
    }
  }

  if (wantAll || sourceFilter.has('codex')) {
    const files = codexDirs.flatMap((d) => {
      const root = expandHome(d);
      const sessRoot = fs.existsSync(path.join(root, 'sessions')) ? path.join(root, 'sessions') : root;
      return walkMatchingFiles(sessRoot, (_full, name) => /^rollout-.*\.jsonl$/i.test(name), 5);
    });
    const sessions = files.map((f) => parseCodexSession(f, sinceMs)).filter(Boolean);
    if (sessions.length || opts.codexHomes?.length) {
      sources.codex = {
        files_scanned: files.length,
        ...analyzeSessions(sessions, opts),
      };
      combinedHostSessions.push(...sessions);
    }
  }

  const summary = combinedHostSessions.length
    ? analyzeSessions(combinedHostSessions, opts)
    : (sources.audit_log || analyzeSessions([], opts));

  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    since: sinceMs ? new Date(sinceMs).toISOString() : null,
    sources,
    combined_host_summary: summary,
  };
}

function pct(part, total) {
  if (!total) return '0.0%';
  return `${((part * 100) / total).toFixed(1)}%`;
}

function formatTextReport(report) {
  const lines = [];
  lines.push('=== gitea-search-mcp Usage & Time-Savings Audit ===');
  lines.push(`Generated: ${report.generated_at}${report.since ? ` | Since: ${report.since}` : ''}`);
  const keys = Object.keys(report.sources);
  if (!keys.length) {
    lines.push('No audit logs or host transcripts found. Pass --audit-log, --t3-dir, --dsh-home, or --codex-home.');
    return lines.join('\n');
  }

  for (const key of keys) {
    const s = report.sources[key];
    lines.push('');
    lines.push(`[${key}] sessions=${s.sessions_active}/${s.sessions_total} (${s.adoption_rate_pct}%) | calls=${s.calls_total} (avg ${s.avg_calls_per_active_session}/active) | files=${s.files_scanned}`);
    const toolsStr = Object.entries(s.by_tool)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    if (toolsStr) lines.push(`  Tools: ${toolsStr}`);

    const fc = s.phase.first_call_timing;
    const fcKnown = fc.turn1_opening + fc.turn1_mid_late + fc.turn2_plus;
    if (fcKnown > 0) {
      lines.push(
        `  First-call phase: Turn1-Open(<=25%)=${fc.turn1_opening} (${pct(fc.turn1_opening, fcKnown)}), `
        + `Turn1-Mid/Late=${fc.turn1_mid_late} (${pct(fc.turn1_mid_late, fcKnown)}), `
        + `Turn2+=${fc.turn2_plus} (${pct(fc.turn2_plus, fcKnown)})`,
      );
    }
    const rp = s.phase.all_calls_relative_position;
    const rpKnown = rp.opening_0_20 + rp.early_20_50 + rp.late_50_80 + rp.wrapup_80_100;
    if (rpKnown > 0) {
      lines.push(
        `  All-calls position: 0-20%=${rp.opening_0_20} (${pct(rp.opening_0_20, rpKnown)}) | `
        + `20-50%=${rp.early_20_50} (${pct(rp.early_20_50, rpKnown)}) | `
        + `50-80%=${rp.late_50_80} (${pct(rp.late_50_80, rpKnown)}) | `
        + `80-100%=${rp.wrapup_80_100} (${pct(rp.wrapup_80_100, rpKnown)}) | `
        + `Turn2+=${s.phase.turn2_plus_share_pct}%`,
      );
    }

    const q = s.quality;
    const latBits = [];
    if (q.elapsed_ms) latBits.push(`e2e p50=${q.elapsed_ms.p50}ms p90=${q.elapsed_ms.p90}ms mean=${q.elapsed_ms.mean}ms`);
    if (q.internal_fts_ms) latBits.push(`fts5 p50=${q.internal_fts_ms.p50}ms`);
    const lazyInfo = s.lazy_schema_only_sessions
      ? `${s.lazy_schema_sessions} (+${s.lazy_schema_only_sessions} idle)`
      : `${s.lazy_schema_sessions}`;
    lines.push(
      `  Quality: zero_hit=${q.zero_hit_calls} (${q.zero_hit_rate_pct}%), errors=${q.error_calls}, `
      + `lazy_schema_sessions=${lazyInfo}${latBits.length ? ` | ${latBits.join(' | ')}` : ''}`,
    );

    const sv = s.savings;
    const ep = sv.episodes_by_kind;
    lines.push(
      `  Episodes: total=${sv.total_episodes} (E1_docs=${ep.E1_docs_session}, E2_code=${ep.E2_code_search}, E3_read=${ep.E3_direct_read}) `
      + `| sync=${sv.sync_calls} | llm_step=${sv.llm_step_sec}s (${sv.llm_step_source})`,
    );
    for (const tier of ['conservative', 'baseline', 'optimistic']) {
      const t = sv.tiers[tier];
      lines.push(
        `    - ${tier.padEnd(12)}: net=${t.net_saved_min} min (${t.net_saved_sec_per_active_session}s/active session) `
        + `[gross=${t.gross_saved_sec}s - penalty=${t.penalty_sec}s]`,
      );
    }
  }
  return lines.join('\n');
}

function formatMarkdownReport(report) {
  const lines = [];
  lines.push('## gitea-search-mcp 使用审计与省时估算报表');
  lines.push('');
  lines.push(`- 生成时间：\`${report.generated_at}\`${report.since ? `（时间起点：\`${report.since}\`）` : ''}`);
  lines.push('');
  lines.push('| 数据源 | 活跃/总会话 | 覆盖率 | 总调用 | 工具调用次数 | 同步调用 | 均次/活跃会话 | 首轮开场触发 | 0 命中率 | 检索簇 (E1/E2/E3) | 净省时（保守 / 基线 / 乐观） |');
  lines.push('|---|---:|---:|---:|---|---:|---:|---:|---:|---|---|');
  for (const [key, s] of Object.entries(report.sources)) {
    const fc = s.phase.first_call_timing;
    const fcKnown = fc.turn1_opening + fc.turn1_mid_late + fc.turn2_plus;
    const openStr = fcKnown > 0 ? pct(fc.turn1_opening, fcKnown) : 'N/A';
    const ep = s.savings.episodes_by_kind;
    const t = s.savings.tiers;
    const tools = Object.entries(s.by_tool).map(([name, count]) => `${name}=${count}`).join(', ');
    lines.push(
      `| \`${key}\` | ${s.sessions_active}/${s.sessions_total} | ${s.adoption_rate_pct}% | ${s.calls_total} `
      + `| ${tools} | ${s.savings.sync_calls} `
      + `| ${s.avg_calls_per_active_session} | ${openStr} | ${s.quality.zero_hit_rate_pct}% `
      + `| ${s.savings.total_episodes} (${ep.E1_docs_session}/${ep.E2_code_search}/${ep.E3_direct_read}) `
      + `| ${t.conservative.net_saved_min}m / **${t.baseline.net_saved_min}m** / ${t.optimistic.net_saved_min}m |`,
    );
  }
  return lines.join('\n');
}

function parseCliArgs(argv) {
  const opts = {
    source: 'all',
    auditLogs: [],
    t3Dirs: [],
    dshHomes: [],
    codexHomes: [],
    since: null,
    episodeGap: 3,
    llmStepSec: null,
    format: 'text',
    noAuto: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--json') opts.format = 'json';
    else if (arg === '--markdown' || arg === '--md') opts.format = 'markdown';
    else if (arg === '--no-auto') opts.noAuto = true;
    else if (arg === '--source') opts.source = next();
    else if (arg === '--audit-log') opts.auditLogs.push(next());
    else if (arg === '--t3-dir') opts.t3Dirs.push(next());
    else if (arg === '--dsh-home') opts.dshHomes.push(next());
    else if (arg === '--codex-home') opts.codexHomes.push(next());
    else if (arg === '--since') opts.since = next();
    else if (arg === '--episode-gap') opts.episodeGap = Number(next());
    else if (arg === '--llm-step-sec') opts.llmStepSec = Number(next());
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

const HELP_TEXT = `Usage: gts-audit [options]

Audit gitea-search-mcp usage across server JSONL audit logs and local host session
transcripts (T3/Antigravity, DSH v4, Codex), and estimate net time saved.

Options:
  --source <list>       Comma-separated: all, audit, t3, dsh, codex (default: all)
  --audit-log <path>    Layer-1 MCP audit JSONL file or directory (repeatable)
  --t3-dir <dir>        T3/Antigravity providers or brain directory (repeatable)
  --dsh-home <dir>      DSH .dsh state directory or sessions directory (repeatable)
  --codex-home <dir>    Codex home or sessions directory (repeatable)
  --no-auto             Disable default path auto-discovery (only use explicit paths)
  --since <spec>        Filter by time window: YYYY-MM-DD, 7d, 24h, etc.
  --episode-gap <n>     Max tool-step gap to merge calls into one Search Episode (default: 3)
  --llm-step-sec <sec>  Override mean LLM round-trip step latency in seconds
  --json                Output structured JSON report
  --markdown, --md      Output Markdown summary table
  -h, --help            Show this help message
`;

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
}

if (isDirectRun()) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    const report = runAudit(opts);
    for (const src of Object.values(report.sources || {})) {
      if (Array.isArray(src.warnings) && src.warnings.length > 0) {
        process.stderr.write(`gts-audit warning: ${src.warnings[0]}${src.warnings.length > 1 ? ` (+${src.warnings.length - 1} more)` : ''}\n`);
      }
    }
    if (opts.format === 'json') {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (opts.format === 'markdown') {
      process.stdout.write(formatMarkdownReport(report) + '\n');
    } else {
      process.stdout.write(formatTextReport(report) + '\n');
    }
  } catch (err) {
    process.stderr.write(`gts-audit error: ${err?.message || err}\n`);
    process.exit(1);
  }
}

export {
  TIER_PARAMS,
  analyzeSessions,
  clusterEpisodes,
  decompressZstd,
  estimateSavings,
  formatMarkdownReport,
  formatTextReport,
  normalizeToolName,
  parseAuditLogs,
  parseCliArgs,
  parseCodexSession,
  parseDshSession,
  parseSinceArg,
  parseT3Transcript,
  runAudit,
};
